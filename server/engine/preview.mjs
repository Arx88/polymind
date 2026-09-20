// AGORA v2 — previsualización del trabajo.
//
// El registro dice QUÉ se hizo; esto enseña lo que se construyó, mientras se construye. Los
// agentes escriben archivos en el espacio de trabajo de la sala (un repo clonado o un proyecto
// nuevo) y aquí se sirven esas MISMAS rutas, en solo lectura y sin tocar el original, para que
// el panel pueda cargar el resultado en un iframe.
//
// Dos límites que no se negocian:
//   1. Solo se sirve lo que está DENTRO del árbol de trabajo de la sala (`resolveInsideRepo`),
//      nunca el `.git` ni nada de fuera. Se lee, no se escribe.
//   2. La página se carga en un iframe con `sandbox` y origen opaco: el código de los agentes
//      corre en su propio mundo y no alcanza el panel ni la sesión del humano.
//
// Tres cosas hacen que esto se comporte como un navegador de verdad y no como un visor:
//   · Un mapa de imports para los paquetes que el proyecto importa por NOMBRE (`import * as THREE
//     from 'three'`): el navegador no sabe resolver eso sin ayuda, y la página moría en blanco con
//     «Failed to resolve module specifier». El servidor escanea el proyecto y los mapea a un CDN
//     ESM con la versión que declara su propio `package.json`. El código de los agentes corre tal
//     cual, sin empaquetador.
//   · Una sonda que devuelve al panel los errores de la página (carga de módulos, promesas
//     rechazadas, `console.error`). Sin ella, una vista previa en blanco no explica nada.
//   · Y cuando el proyecto todavía no tiene página, una PÁGINA DE PRUEBA: carga sus módulos de
//     verdad y enseña cuáles entran y qué exportan. Es lo que convierte «no hay nada que ver» en
//     evidencia del trabajo en curso.

// Y una honestidad: un proyecto puede no tener nada que ver (una librería, un servicio, un
// script). Cuando no hay página NI módulos, se dice por qué y se enseña lo que sí hay (los
// archivos y las tareas en curso), en vez de dejar un hueco.

import fs from 'node:fs';
import path from 'node:path';
import { git, resolveInsideRepo } from './repo.mjs';

// Extensiones que un navegador puede pintar. El resto se sirve igual (el proyecto es suyo) pero
// no se anuncia como página.
const PAGE_RE = /\.html?$/i;
const ENTRY_RE = /^(index|main)\.html?$/i;
const MODULE_RE = /\.(mjs|js)$/i;
// Nombre reservado de la página de prueba: no puede venir de un archivo del proyecto.
const SYNTHETIC_ENTRY = '__agora__.html';
const HARNESS_MAX_MODULES = 12;
const SCAN_MAX_FILES = 240;
// CDN de módulos ESM: resuelve los paquetes por nombre Y sus dependencias internas.
const CDN = 'https://esm.sh/';
// Paquetes de Node que en un navegador no existen: no se mapean, se dejan fallar con su error.
const NODE_BUILTINS = new Set(['fs', 'path', 'http', 'https', 'url', 'os', 'crypto', 'util', 'zlib',
  'stream', 'events', 'buffer', 'child_process', 'assert', 'net', 'tls', 'vm', 'worker_threads',
  'readline', 'process', 'module', 'timers', 'string_decoder', 'querystring', 'perf_hooks']);
const MAX_FILE_BYTES = 12 * 1024 * 1024;
// Un archivo de código no se sirve entero para mirarlo: con la primera porción de líneas se ve
// perfectamente qué se está escribiendo, y el panel sigue siendo un panel.
const SOURCE_MAX_BYTES = 256 * 1024;
const SOURCE_MAX_LINES = 400;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

export function mimeOf(rel) {
  return MIME[path.extname(String(rel || '').toLowerCase())] || 'application/octet-stream';
}

// Cuántos niveles tiene una ruta: el punto de entrada suele estar arriba (`index.html` antes que
// `docs/ejemplos/demo.html`).
function depth(rel) {
  return String(rel).split('/').length;
}

// Archivos del árbol de trabajo: los seguidos por git Y los que los agentes acaban de escribir
// (todavía sin commitear). Es lo que hace que la previsualización sea del trabajo EN CURSO y no
// solo de lo ya integrado.
function workFiles(room, limit = 800) {
  const repo = room.repo;
  if (!repo?.dir) return [];
  const out = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard'], { timeoutMs: 8_000 });
  return out.output.split('\n').map(l => l.trim()).filter(Boolean).slice(0, limit);
}

// Lo que se está tocando AHORA: los cambios SIN commitear, con su marca, su tamaño y la hora en
// que se escribió cada archivo. Es la señal de trabajo en curso: un agente guarda un archivo y
// aparece aquí antes de que nadie lo commitee. Y la hora es lo que permite decir «hace 8 s» en el
// panel, que es la diferencia entre una foto y una vista en vivo.
function activity(room, limit = 60) {
  const repo = room.repo;
  if (!repo?.dir) return { changes: [], totals: { files: 0, insertions: 0, deletions: 0 }, signature: 'sin-arbol' };

  // `-uall`: los archivos nuevos se listan uno a uno, no como su carpeta. En una vista en vivo lo
  // que importa es el archivo que acaba de nacer, no el directorio que lo contiene.
  const status = git(repo, ['status', '--porcelain', '-uall'], { timeoutMs: 8_000 }).output;
  const counts = new Map();
  for (const line of git(repo, ['diff', '--numstat', 'HEAD'], { timeoutMs: 8_000 }).output.split('\n')) {
    const [ins, del, file] = line.split('\t');
    if (!file) continue;
    counts.set(file, {
      insertions: ins === '-' ? null : Number(ins) || 0,
      deletions: del === '-' ? null : Number(del) || 0,
    });
  }

  const changes = [];
  let insertions = 0;
  let deletions = 0;
  let newest = 0;
  for (const raw of status.split('\n')) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    // `git` entrecomilla las rutas raras y marca los renombrados con ` -> `: se queda el destino.
    let rel = raw.slice(3).trim().replace(/^"(.*)"$/s, '$1');
    const arrow = rel.lastIndexOf(' -> ');
    if (arrow !== -1) rel = rel.slice(arrow + 4);
    if (!rel) continue;
    const size = counts.get(rel) || { insertions: null, deletions: null };
    const abs = path.join(repo.dir, rel);
    let at = null;
    try { at = fs.statSync(abs).mtimeMs; } catch { at = null; }
    // Un archivo nuevo no está en ningún diff: sus líneas se cuentan aquí, si es texto y no es
    // enorme. Es el dato que hace visible que el archivo acaba de nacer, y con cuánto.
    if (size.insertions == null) {
      try {
        if (fs.statSync(abs).size <= 512 * 1024) {
          const body = fs.readFileSync(abs);
          if (!body.subarray(0, 8192).includes(0)) size.insertions = body.toString('utf8').split('\n').length;
        }
      } catch { /* ilegible o binario: se queda sin recuento, que es lo honesto */ }
    }
    if (typeof size.insertions === 'number') insertions += size.insertions;
    if (typeof size.deletions === 'number') deletions += size.deletions;
    if (at && at > newest) newest = at;
    changes.push({
      path: rel,
      code,
      status: code === '??' || code[0] === 'A' ? 'nuevo'
        : code.includes('D') ? 'borrado'
          : /[RC]/.test(code) ? 'renombrado' : 'editado',
      insertions: size.insertions,
      deletions: size.deletions,
      at,
    });
  }
  // Lo último escrito, primero: es el orden en el que se entiende un trabajo en vivo.
  changes.sort((a, b) => (b.at || 0) - (a.at || 0) || a.path.localeCompare(b.path));
  return {
    changes: changes.slice(0, limit),
    totals: { files: changes.length, insertions, deletions },
    // Firma del árbol AHORA MISMO. Un commit mueve la cabeza, pero escribir no: sin esta firma el
    // panel seguiría enseñando el estado de hace un minuto.
    signature: `${status.length}:${status.split('\n').length}:${newest}`,
  };
}

// La detección cuesta dos `git` por consulta: no se repite mientras el árbol no cambie. La clave
// es la cabeza (un commit nuevo la mueve) MÁS la firma del trabajo sin commitear (un archivo
// escrito la mueve).
const cache = new Map();

// El código del archivo más reciente, tal cual.
//
// Sin página que cargar (una librería, un módulo de shader, un servicio), «la vista previa» es
// esto: lo que se está escribiendo ahora mismo. Antes el panel solo podía enseñar el NOMBRE del
// archivo, que dice muy poco; con su contenido se ve el trabajo en curso de verdad.
// Un binario o un archivo enorme no se enseñan a medias: se dice por qué no se pueden leer.
function sourceOf(room, rel) {
  if (!rel) return null;
  const target = resolveInsideRepo(room, rel);
  if (!target) return null;
  let stat;
  try { stat = fs.statSync(target.abs); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > SOURCE_MAX_BYTES) {
    return { path: rel, code: null, reason: 'demasiado-grande', bytes: stat.size, lines: null, at: stat.mtimeMs };
  }
  let body;
  try { body = fs.readFileSync(target.abs); } catch { return null; }
  if (body.subarray(0, 8192).includes(0)) {
    return { path: rel, code: null, reason: 'binario', bytes: stat.size, lines: null, at: stat.mtimeMs };
  }
  const all = body.toString('utf8').split('\n');
  const shown = Math.min(all.length, SOURCE_MAX_LINES);
  return {
    path: rel,
    code: all.slice(0, shown).join('\n'),
    lines: all.length,
    shown,
    truncated: all.length > shown,
    bytes: stat.size,
    at: stat.mtimeMs,
  };
}

// ---------------------------------------------------------------- módulos y paquetes

// Los archivos que un navegador puede cargar como módulo. Un `.ts` queda fuera a propósito: sin
// compilar no es un módulo, y fingir que sí lo es sería mentir en la vista previa.
function browserModules(room, act) {
  const order = new Map((act?.changes || []).map((c, i) => [c.path, i]));
  return workFiles(room)
    .filter(f => MODULE_RE.test(f) && !/(^|\/)node_modules\//.test(f) && !/\.d\.ts$/.test(f))
    // Lo recién escrito primero: es lo que el humano quiere ver cargarse.
    .sort((a, b) => (order.has(a) ? order.get(a) : 999) - (order.has(b) ? order.get(b) : 999)
      || a.localeCompare(b));
}

const SPEC_PATTERNS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,          // import x from 'paquete' / export ... from 'paquete'
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // import('paquete')
  /\bimport\s+['"]([^'"\n]+)['"]/g,        // import 'paquete'
];

// Un especificador «por nombre» que el navegador no sabe resolver: `three`, `three/ejemplos/x.js`,
// `@scope/pkg/sub`. Lo relativo (`./x.js`), lo absoluto y lo que trae esquema (`node:fs`, `https:`)
// no se tocan: el navegador los resuelve solo, o no existen en un navegador.
function packageOf(spec) {
  if (!spec || /^[./]/.test(spec)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return null;
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  if (!name || NODE_BUILTINS.has(name)) return null;
  return name;
}

// Los paquetes que el proyecto importa por nombre, mapeados a un CDN ESM con la versión que declara
// su `package.json`. El navegador no puede resolver un import por nombre sin esto; el CDN sí, y
// además resuelve las dependencias internas del paquete (que es lo que un import map casero no
// hace). Se cachea con la firma de la actividad: escanear es leer archivos.
const importCache = new Map();

export function importMapFor(room, signature) {
  const hit = importCache.get(room.code);
  if (hit && hit.key === signature) return hit.value;

  let deps = {};
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(room.repo.dir, 'package.json'), 'utf8'));
    deps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}), ...(pj.peerDependencies || {}) };
  } catch { /* sin package.json: se usa la última versión del CDN */ }
  const versionOf = pkg => {
    const m = String(deps[pkg] || '').match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  };

  const modules = browserModules(room).slice(0, SCAN_MAX_FILES);
  const found = new Map();
  for (const rel of modules) {
    let body;
    try {
      const abs = path.join(room.repo.dir, rel);
      if (fs.statSync(abs).size > SOURCE_MAX_BYTES) continue;
      body = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    for (const re of SPEC_PATTERNS) {
      re.lastIndex = 0;
      for (const m of body.matchAll(re)) {
        const pkg = packageOf(m[1]);
        if (pkg) found.set(m[1], pkg);
      }
    }
  }

  const imports = {};
  const packages = [];
  for (const [spec, pkg] of found) {
    const version = versionOf(pkg);
    const sub = spec.slice(pkg.length).replace(/^\//, '');
    imports[spec] = `${CDN}${pkg}${version ? `@${version}` : ''}${sub ? `/${sub}` : ''}`;
    if (!packages.includes(pkg)) packages.push(pkg);
  }
  const value = { imports, packages, modules: modules.length };
  importCache.set(room.code, { key: signature, value });
  return value;
}

// La sonda que devuelve al panel lo que la página sufre. El iframe va con origen opaco, así que el
// panel no puede leer su interior; la página habla por `postMessage` y eso es suficiente para que
// una pantalla en blanco deje de ser un misterio. Los mensajes repetidos se cuentan una vez.
const PROBE = `<script>(function(){var send=function(o){try{parent.postMessage(Object.assign({\nagoraPreview:1},o),'*')}catch(e){}};var visto={};var add=function(level,args){var t='';try{t=Array.prototype.map.call(args,function(a){return typeof a==='string'?a:(a&&a.message)||JSON.stringify(a)}).join(' ')}catch(e){t=String(args)};if(t.length>600)t=t.slice(0,600)+'…';if(!t)return;var k=level+'|'+t;if(visto[k])return;visto[k]=1;send({level:level,text:t,at:Date.now()})};
window.addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.tagName){add('error',['no se pudo cargar '+e.target.tagName.toLowerCase()+' '+String(e.target.src||e.target.href||'')]);return}add('error',[e.message||'error',e.filename?('en '+e.filename+':'+e.lineno):''])},true);
window.addEventListener('unhandledrejection',function(e){add('error',['promesa rechazada: '+((e.reason&&e.reason.message)||e.reason)])});
var ce=console.error,cw=console.warn;console.error=function(){add('error',arguments);ce.apply(console,arguments)};console.warn=function(){add('warn',arguments);cw.apply(console,arguments)};
send({ready:true,title:document.title||null});})()</script>`;

// Los `<` se escapan para que un `</script>` dentro de una cadena no corte el documento.
function escapeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// El mapa de imports solo se inyecta si la página no trae el suyo: si el proyecto declara uno, el
// suyo manda. Y la sonda va SIEMPRE, lo antes posible, para atrapar también los errores de carga
// que ocurren antes que el código de la página.
function injectKit(html, kit) {
  const block = [];
  if (kit?.packages?.length && !/<script[^>]+type=["']importmap["']/i.test(html)) {
    block.push(`<script type="importmap">${escapeJson({ imports: kit.imports })}</script>`);
  }
  block.push(PROBE);
  const joined = block.join('\n');
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head) return html.replace(head[0], `${head[0]}\n${joined}`);
  const htmlTag = html.match(/<html(\s[^>]*)?>/i);
  if (htmlTag) return html.replace(htmlTag[0], `${htmlTag[0]}\n${joined}`);
  return `${joined}\n${html}`;
}

// La página de prueba: el proyecto se carga de verdad en el navegador. Cada módulo se importa por
// separado y con su propio try: un módulo roto no esconde a los demás, y lo que exporta se ve. Es
// evidencia del trabajo en curso cuando todavía no hay página que enseñar — y el informe vuelve al
// panel, que así puede decir «9/12 módulos entran» sin leer dentro del iframe.
function harnessPage(room, { kit, modules }) {
  const mapa = kit?.packages?.length ? `<script type="importmap">${escapeJson({ imports: kit.imports })}</script>` : '';
  const paquetes = kit?.packages?.length
    ? kit.packages.map(p => kit.imports[p] || p).join(' · ')
    : 'ninguno (el proyecto no importa paquetes por nombre)';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Prueba del proyecto — sala ${room.code}</title>
${mapa}
${PROBE}
<style>
  :root { color-scheme: dark }
  body { margin: 0; padding: 22px; background: #0b0f14; color: #e6edf3;
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif }
  .k { margin: 0 0 4px; text-transform: uppercase; letter-spacing: .08em; font-size: 11px; color: #7d8794 }
  h1 { margin: 0 0 8px; font-size: 19px; font-weight: 600 }
  .sub { margin: 0 0 18px; max-width: 72ch; color: #9aa4b2 }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px }
  .resumen { margin: 0 0 10px; font-weight: 600 }
  .resumen.ok { color: #4ade80 } .resumen.mal { color: #fbbf24 }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px }
  li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 10px; align-items: baseline;
       padding: 8px 10px; border: 1px solid #232a34; border-radius: 10px; background: #0f141b }
  .punto { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; align-self: center }
  .punto.ok { background: #22c55e } .punto.mal { background: #ef4444 }
  .estado { color: #9aa4b2; font-size: 12px; white-space: nowrap }
  .detalle { grid-column: 2 / -1; color: #8b95a3; font-size: 12.5px; word-break: break-word }
  .pie { margin-top: 16px; color: #7d8794; font-size: 12px }
</style>
</head>
<body>
<header>
  <p class="k">Vista previa automática</p>
  <h1>El proyecto todavía no tiene una página</h1>
  <p class="sub">Esto no es un marcador: son los módulos del proyecto cargándose en este navegador,
  uno por uno, con lo que exportan. Cuando los agentes escriban un <code>.html</code>, la vista
  previa cargará ese archivo en su lugar.</p>
</header>
<p id="resumen" class="resumen">Cargando ${modules.length} módulo(s)…</p>
<ul id="lista"></ul>
<p class="pie">Paquetes por nombre resueltos desde el CDN: ${paquetes}</p>
<script type="module">
const modulos = ${escapeJson(modules)};
const lista = document.getElementById('lista');
const resumen = document.getElementById('resumen');
const informe = [];
let ok = 0;
const fila = rel => {
  const li = document.createElement('li');
  li.innerHTML = '<span class="punto"></span><code></code><span class="estado">cargando…</span><div class="detalle"></div>';
  li.querySelector('code').textContent = rel;
  lista.appendChild(li);
  return li;
};
for (const rel of modulos) {
  const li = fila(rel);
  const punto = li.querySelector('.punto');
  const estado = li.querySelector('.estado');
  const detalle = li.querySelector('.detalle');
  try {
    const m = await import('./' + rel);
    const nombres = Object.keys(m).filter(n => n !== 'default');
    ok += 1;
    punto.className = 'punto ok';
    estado.textContent = nombres.length ? nombres.length + ' export(s)' : 'cargado, sin exports';
    detalle.textContent = nombres.length
      ? nombres.slice(0, 12).join(', ') + (nombres.length > 12 ? ' …' : '')
      : (m.default === undefined ? '' : 'solo export default');
    informe.push({ path: rel, ok: true, exports: nombres });
  } catch (err) {
    punto.className = 'punto mal';
    estado.textContent = 'no carga';
    detalle.textContent = String((err && err.message) || err);
    informe.push({ path: rel, ok: false, error: String((err && err.message) || err) });
  }
}
resumen.textContent = ok + '/' + modulos.length + ' módulo(s) entran en el navegador';
resumen.className = 'resumen ' + (ok === modulos.length ? 'ok' : 'mal');
try { parent.postMessage({ agoraPreview: 1, report: { modules: informe, packages: ${escapeJson(kit?.packages || [])} } }, '*'); } catch (e) {}
</script>
</body>
</html>`;
}

// Qué se puede previsualizar en esta sala y por qué no, cuando no se puede. Incluye SIEMPRE la
// actividad en curso: así el panel puede enseñar archivos apareciendo aunque todavía no haya
// página (una librería, un servicio o un script no tienen por qué tener una).
export function previewEntry(room, { fresh = false } = {}) {
  const repo = room.repo;
  const empty = { changes: [], changed: { files: 0, insertions: 0, deletions: 0 }, lastWrite: null };
  if (!repo) {
    return { available: false, reason: room.settings?.planOnly ? 'solo-planificacion' : 'sin-proyecto', ...empty };
  }
  const act = activity(room);
  const key = `${repo.head}|${act.signature}`;
  const hit = fresh ? null : cache.get(room.code);
  if (hit && hit.key === key) return hit.value;

  const files = workFiles(room);
  const written = new Set(act.changes.map(c => c.path));
  const pages = files.filter(f => PAGE_RE.test(f))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const entry = pages.length ? (pages.find(p => ENTRY_RE.test(path.basename(p))) || pages[0]) : null;
  // Sin nada sin commitear, la última señal es la propia página servida.
  let lastWrite = act.changes[0]?.at ? { path: act.changes[0].path, at: act.changes[0].at } : null;
  if (!lastWrite && entry) {
    try { lastWrite = { path: entry, at: fs.statSync(path.join(repo.dir, entry)).mtimeMs }; } catch { lastWrite = null; }
  }
  const kit = importMapFor(room, act.signature);
  const modules = browserModules(room, act);
  const base = {
    files: files.length,
    branch: repo.branch || null,
    head: repo.head || null,
    changes: act.changes,
    changed: act.totals,
    lastWrite,
    // Los paquetes que el panel tuvo que resolver por su cuenta (los que el proyecto importa por
    // nombre). El panel lo dice: es la diferencia entre «no carga» y «no carga porque no hay red».
    imports: kit.packages,
  };
  const value = entry
    ? { available: true, entry, pages: pages.slice(0, 12), synthetic: false, source: sourceOf(room, lastWrite?.path), ...base }
    : modules.length
      // Sin página, pero con módulos: la vista previa carga una PÁGINA DE PRUEBA con el proyecto
      // de verdad dentro. Un proyecto de módulos ya no deja la pestaña en blanco ni se queda en
      // una lista de nombres de archivo.
      ? {
        available: true,
        entry: SYNTHETIC_ENTRY,
        synthetic: true,
        pages: [],
        modules: modules.slice(0, HARNESS_MAX_MODULES),
        sample: [...act.changes.map(c => c.path), ...files.filter(f => !written.has(f))].slice(0, 30),
        source: sourceOf(room, act.changes.find(c => modules.includes(c.path) && c.at === lastWrite?.at)?.path || lastWrite?.path || modules[0]),
        ...base,
      }
      : {
        available: false,
        reason: 'sin-pagina',
        // Lo recién escrito primero: en un proyecto sin página, «qué se está tocando» ES la vista.
        sample: [...act.changes.map(c => c.path), ...files.filter(f => !written.has(f))].slice(0, 30),
        // Y de lo más reciente, su código: el panel enseña el archivo escribiéndose, no un hueco.
        source: sourceOf(room, [...act.changes.map(c => c.path), ...files.filter(f => !written.has(f))][0]),
        ...base,
      };
  cache.set(room.code, { key, value });
  return value;
}

// Un archivo del árbol de trabajo, para el iframe. Nada fuera del árbol, nada del `.git`.
// Las páginas HTML salen con el mapa de imports y la sonda inyectados (a menos que traigan su
// propio mapa): es lo que hace que el proyecto corra aquí igual que en un navegador de verdad.
export function previewFile(room, rel) {
  if (rel === SYNTHETIC_ENTRY) {
    const act = activity(room);
    const kit = importMapFor(room, act.signature);
    const modules = browserModules(room, act).slice(0, HARNESS_MAX_MODULES);
    if (!modules.length) return { status: 404, error: 'el proyecto no tiene módulos que probar' };
    const body = Buffer.from(harnessPage(room, { kit, modules }), 'utf8');
    return { status: 200, rel, mime: 'text/html; charset=utf-8', body, bytes: body.length, synthetic: true };
  }
  const target = resolveInsideRepo(room, rel);
  if (!target) return { status: 403, error: 'ruta inválida: solo se sirve el interior del árbol de trabajo' };
  let stat;
  try { stat = fs.statSync(target.abs); } catch { return { status: 404, error: 'no existe en el proyecto' }; }
  if (!stat.isFile()) return { status: 404, error: 'no es un archivo' };
  if (stat.size > MAX_FILE_BYTES) return { status: 413, error: `archivo demasiado grande (${Math.round(stat.size / 1024 / 1024)} MB)` };
  let body;
  try { body = fs.readFileSync(target.abs); } catch { return { status: 404, error: 'no se pudo leer' }; }
  if (PAGE_RE.test(target.rel)) {
    const kit = importMapFor(room, activity(room).signature);
    // Root-relative assets belong to this project's root, not the Polymind UI.
    const prefix = `/api/rooms/${encodeURIComponent(room.code)}/preview/`;
    const html = body.toString('utf8').replace(/\b(src|href|poster)\s*=\s*(["'])\/(?!\/)([^"']*)\2/gi,
      (_, attr, quote, resource) => `${attr}=${quote}${prefix}${resource}${quote}`);
    body = Buffer.from(injectKit(html, kit), 'utf8');
  }
  return { status: 200, rel: target.rel, mime: mimeOf(target.rel), body, bytes: body.length };
}

// Cabeceras de una respuesta de previsualización. `Access-Control-Allow-Origin: *` no es un
// descuido: el iframe va con origen opaco (sandbox sin allow-same-origin), así que sus módulos y
// sus `fetch` relativos son peticiones cross-origin y sin esto no cargarían.
// `origin` (el del propio servidor) va explícito en la política porque un documento con origen
// opaco no puede casar `'self'`: sin esto, la página se sirve pero sus módulos y sus imágenes se
// quedan por el camino — que es exactamente una vista previa en blanco.
export function previewHeaders(rel, origin) {
  const self = origin ? ` ${origin}` : '';
  return {
    'Content-Type': mimeOf(rel),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    // El código de los agentes puede usar CDN, blobs y workers, pero no puede incrustar el panel
    // ni pedir la cámara/micrófono de nadie.
    'Content-Security-Policy': `default-src 'self'${self} data: blob: https: http://localhost:* ; `
      + `script-src 'self'${self} 'unsafe-inline' 'unsafe-eval' data: blob: https: http://localhost:* ; `
      + `style-src 'self'${self} 'unsafe-inline' data: https: ; `
      + `img-src 'self'${self} data: blob: https: ; `
      + `font-src 'self'${self} data: https: ; `
      + `connect-src 'self'${self} data: blob: https: http://localhost:* http://127.0.0.1:* ; `
      + `worker-src 'self'${self} blob: ; media-src 'self'${self} data: blob: https: ; frame-ancestors 'self'`,
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
}
