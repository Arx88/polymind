// AGORA v2 — evidencia visual: el servidor CAPTURA el artefacto de la sala y el juicio sobre lo
// que se ve deja de ser un adjetivo.
//
// El problema que resuelve: «se ve bien» / «no debe verse cutre» no tenía ni artefacto que mirar
// ni firma de quién lo miró. El servidor puede hacer las dos mitades que sí son mecánicas:
//
//   1. PRODUCIR la imagen. Chrome headless (sin dependencias: CDP por WebSocket nativo) abre la
//      página que la sala está construyendo —la misma que el panel carga en su vista previa—,
//      espera a que se estabilice y guarda un PNG con su hash, sus dimensiones y su luminancia
//      medida SOBRE EL ARCHIVO. Cada captura entra en el registro de evidencia atada al commit:
//      cuando la rama se mueve, la captura caduca sola y con ella el juicio que la citaba.
//   2. EXIGIR la firma. Un juicio no se acepta de quien escribió el artefacto: la independencia
//      la calcula el servidor desde las tareas y los parches, no la declara el agente. Un «no
//      pasa» de cualquiera abre bloqueo (el ojo contradice la promesa); un «pasa» solo cierra si
//      lo firma alguien que no escribió nada y citando una captura fresca y no negra.
//
// Lo que esto NO es (y se publica tal cual): no es una medida de rendimiento —headless renderiza
// por software, y los fps medidos así no valen— ni un aprobado. Es el material y la firma, con su
// procedencia declarada. Si no hay navegador, la sala dice `not-tested`, nunca `pass`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { now, clampStr, gist, plural, uid } from './util.mjs';
import { nameOf, log, activeAgents } from './state.mjs';
import { VISION_CAPABILITY } from './settings.mjs';
import { recordEvidence, evidenceList, evidenceStatus } from './ledger.mjs';

const MAX_JUDGMENTS = 80;
const MAX_SHOTS = 12;

// ---------------------------------------------------------------- configuración
export const VISUAL_DEFAULTS = {
  enabled: true,                 // se puede apagar por sala (settings.visual.enabled=false)
  // Dos mundos de pantalla por defecto: lo mismo que se mira en un escritorio no se ve igual en
  // una pantalla pequeña, y una sola toma no lo cuenta. Se pueden declarar más (o menos) con
  // `settings.visual.viewports`; `settings.visual.viewport` (singular) sigue valiendo y fija uno.
  viewports: [
    { id: 'escritorio', width: 1280, height: 720 },
    { id: 'pantalla-pequena', width: 640, height: 360 },
  ],
  settleMs: 1_500,               // margen tras `load` para que las animaciones se asienten
  // En un host lento (un contenedor de 0,1 CPU) Chromium tarda más en abrir el puerto de
  // depuración que en dibujar: el margen es generoso a propósito, y se puede bajar por entorno.
  timeoutMs: Number(process.env.AGORA_VISUAL_TIMEOUT_MS) || 90_000,
  shots: [],                     // [] = todas las páginas del artefacto, tal cual
  maxPages: 4,                   // páginas distintas que se retratan como máximo
};

// El servidor se anuncia a sí mismo dónde vive: el puerto real puede no ser el pedido (si estaba
// ocupado, el arranque prueba el siguiente) y una captura contra el puerto equivocado mide otra
// cosa. Esto es la cicatriz de un caso real: un puerto ajeno sirvió una versión vieja del
// artefacto y produjo números plausibles y falsos.
let serverBase = process.env.AGORA_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;

export function setServerBase(url) {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) serverBase = url.replace(/\/+$/, '');
  return serverBase;
}

export function captureBase() {
  return serverBase;
}

// Normaliza la configuración de una sala. `viewport` (singular) manda si está: es la forma vieja
// de declararlo y no puede dejar de funcionar por haber añadido varias pantallas.
export function visualConfig(room) {
  const cfg = room?.settings?.visual || {};
  const viewports = cfg.viewport
    ? [{ id: 'principal', ...VISUAL_DEFAULTS.viewports[0], ...cfg.viewport }]
    : (Array.isArray(cfg.viewports) && cfg.viewports.length ? cfg.viewports : VISUAL_DEFAULTS.viewports)
      .map((v, i) => ({
        id: clampStr(v?.id || `pantalla-${i + 1}`, 40).replace(/[^\w.-]+/g, '-'),
        width: Math.max(160, Math.min(3_840, Number(v?.width) || 1280)),
        height: Math.max(120, Math.min(2_160, Number(v?.height) || 720)),
      }));
  return {
    ...VISUAL_DEFAULTS,
    ...cfg,
    viewports,
    // Compatibilidad: quien mire `config.viewport` sigue viendo la primera pantalla.
    viewport: { width: viewports[0].width, height: viewports[0].height },
    shots: Array.isArray(cfg.shots) ? cfg.shots : [],
  };
}

// ---------------------------------------------------------------- navegador
// El motor NO instala navegadores: busca el que haya. Lo que sí hace es buscar en todos los sitios
// donde un navegador acaba de verdad —el PATH, el directorio que se le diga, el caché de
// puppeteer/playwright y una carpeta local— para que «no hay navegador» no sea la respuesta cuando
// sí lo hay a dos carpetas de distancia. Es la diferencia entre una función que existe y una que
// se usa: un despliegue con Chromium instalado y sin `AGORA_CHROME` no puede quedarse sin capturas.
const BROWSER_NAMES = [
  'chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'chrome-headless-shell', 'msedge', 'microsoft-edge',
];

function existsFile(p) {
  try { return !!p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

// Dentro de una carpeta de navegador instalado, el binario está en una ruta conocida por sistema.
function insideDir(dir, depth = 0) {
  if (depth > 3) return null;
  // Los nombres genéricos valen en cualquier sistema: una carpeta de instalación bajada por
  // puppeteer se llama `chrome-linux64/chrome` aunque el servidor corra en Windows, y mirar solo
  // los nombres nativos dejaba esa carpeta invisible.
  const direct = [
    'chrome', 'chromium', 'headless_shell', 'chrome-headless-shell', 'chrome.exe', 'msedge.exe',
    ...(process.platform === 'darwin'
      ? ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : []),
  ];
  for (const name of direct) {
    const p = path.join(dir, name);
    if (existsFile(p)) return p;
  }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // `chrome-linux64/chrome`, `chrome-linux/chrome`, `chrome-1234/chrome-linux64/chrome`…
    if (!/chrome|chromium|msedge|headless/i.test(e.name)) continue;
    const hit = insideDir(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

// De dónde puede salir un navegador, en orden de confianza: lo que el operador dijo, lo que el
// sistema tiene instalado, y por último los cachés que dejan puppeteer/playwright.
function searchTiers() {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const system = process.platform === 'win32'
    ? [
      'C:/Program Files/Google/Chrome/Application',
      'C:/Program Files (x86)/Google/Chrome/Application',
      'C:/Program Files/Microsoft/Edge/Application',
      'C:/Program Files (x86)/Microsoft/Edge/Application',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application') : null,
      ...pathDirs,
    ]
    : process.platform === 'darwin'
      ? [
        '/Applications/Google Chrome.app/Contents/MacOS',
        '/Applications/Chromium.app/Contents/MacOS',
        ...pathDirs,
      ]
      : [
        ...pathDirs,
        '/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome',
        '/usr/lib/chromium', '/usr/lib/chromium-browser', '/opt/chromium',
        '/run/current-system/sw/bin',
      ];
  const cache = [
    path.join(process.cwd(), '.browsers'),
    path.join(process.cwd(), 'node_modules', '.cache', 'puppeteer'),
    path.join(process.cwd(), 'node_modules', 'playwright-core', '.local-browsers'),
    process.env.HOME ? path.join(process.env.HOME, '.cache', 'puppeteer') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
  ];
  return {
    explicit: process.env.AGORA_CHROME_DIR ? [process.env.AGORA_CHROME_DIR] : [],
    system: [...new Set(system.filter(Boolean))],
    cache: [...new Set(cache.filter(Boolean))],
  };
}

// En una tier, primero el binario suelto y después la carpeta de una instalación.
function findIn(dirs, { nested = true } = {}) {
  for (const dir of dirs) {
    for (const n of BROWSER_NAMES) {
      const p = path.join(dir, n);
      if (existsFile(p)) return p;
    }
  }
  if (!nested) return null;
  for (const dir of dirs) {
    const hit = insideDir(dir);
    if (hit) return hit;
  }
  return null;
}

// El resultado se recuerda un rato: esto se llama en cada captura y en cada turno que ofrece el
// juicio, y recorrer directorios cada vez no aporta nada (pero el cache caduca, para que un
// navegador instalado con el servidor en marcha se encuentre sin reiniciarlo).
let chromeHit = { at: 0, path: null };
const CHROME_TTL = 15_000;

export function chromePath() {
  const env = process.env.AGORA_CHROME;
  if (env) return existsFile(env) ? env : (insideDir(env) || null);
  if (chromeHit.path && now() - chromeHit.at < CHROME_TTL) return chromeHit.path;
  const tiers = searchTiers();
  const found = findIn(tiers.explicit)
    || findIn(tiers.system, { nested: false })
    || findIn(tiers.system)
    || findIn(tiers.cache);
  chromeHit = { at: now(), path: found };
  return found;
}

// Cuándo hay que renunciar al sandbox: corriendo como root (Docker, por defecto) o dentro de un
// contenedor, Chromium se niega a arrancar sin `--no-sandbox`. Es un caso donde el servidor AVERIGUA
// en vez de pedir una variable de entorno más.
export function headlessArgs() {
  const explicit = process.env.AGORA_CHROME_NO_SANDBOX;
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  const container = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  const noSandbox = explicit === '1' || (explicit !== '0' && (root || container));
  // `--disable-dev-shm-usage` va SIEMPRE: en un contenedor `/dev/shm` suele ser de 64 MB, y Chrome
  // muere con «shared memory» a mitad de captura sin que nadie sepa por qué. En una máquina de
  // escritorio no cambia nada.
  const common = ['--disable-dev-shm-usage'];
  return noSandbox ? ['--no-sandbox', ...common] : common;
}

// ---------------------------------------------------------------- PNG
// La luminancia se mide DECODIFICANDO EL ARCHIVO, no leyendo el búfer vivo del navegador: ahí
// está el fallo que ya se pagó una vez (leer los píxeles justo después de redimensionar devuelve
// negro y hace parecer vacío lo que está perfecto). Decodificador mínimo: IHDR + IDAT con zlib y
// los cinco filtros del estándar. Sin dependencias.
export function pngStats(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8; let width = 0; let height = 0; let depth = 0; let color = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR' && data.length >= 10) {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height) return null;
  if (depth !== 8 || (color !== 2 && color !== 6)) return { width, height, unsupported: `bitDepth ${depth} colorType ${color}` };
  const channels = color === 6 ? 4 : 3;
  const stride = width * channels;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return { width, height, unsupported: 'IDAT ilegible' }; }
  if (raw.length < (stride + 1) * height) return { width, height, unsupported: 'datos incompletos' };
  const out = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p]; p += 1;
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  let sum = 0; let sum2 = 0; let alive = 0; let n = 0;
  const hist = new Set();
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = y * stride + x * channels;
      const r = out[i]; const g = out[i + 1]; const b = out[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum; sum2 += lum * lum; n += 1;
      hist.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      if (Math.max(r, g, b) - Math.min(r, g, b) > 10 || lum > 40) alive += 1;
    }
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return {
    width,
    height,
    brightness: Math.round(mean),
    contrast: Math.round(sd),
    // «Vivos»: píxeles con color o con luz suficiente. Una escena real casi siempre pasa del
    // 10%; una imagen negra da 0 y queda marcada como sospechosa, nunca como evidencia.
    alive: Math.round((alive / n) * 1000) / 10,
    colors: hist.size,
  };
}

function shotIsBlank(stats) {
  if (!stats || stats.unsupported) return false;
  return stats.brightness < 3 && stats.contrast < 3;
}

// ---------------------------------------------------------------- disparos
function entryUrl(room) {
  const entry = room?.artifacts?.previewEntry || null;
  return entry?.available ? entry.entry : null;
}

// Qué se captura. Lo que la sala declare manda; si no declara nada, se captura la vista principal
// del artefacto (la misma página que el panel carga): una sala sin configuración igual tiene
// material visual, que es de lo que se trata.
const slug = (text, fallback) => clampStr(String(text || fallback), 40).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;

// El producto de páginas × pantallas, que es lo que hace que una toma sea una toma y no una
// casualidad: cada página que el artefacto sirve, en cada mundo de pantalla declarado.
function crossShots(list, viewports) {
  const out = [];
  for (const base of list) {
    for (const vp of viewports) {
      if (out.length >= MAX_SHOTS) return out;
      out.push({
        ...base,
        id: viewports.length > 1 ? `${base.id}-${vp.id}` : base.id,
        label: viewports.length > 1 ? `${base.label} · ${vp.id} (${vp.width}×${vp.height})` : base.label,
        viewport: { id: vp.id, width: vp.width, height: vp.height },
      });
    }
  }
  return out;
}

export async function shotsFor(room) {
  // Si nadie abrió el panel todavía, el motor pregunta él mismo qué página hay: la evidencia
  // visual no puede depender de que alguien esté mirando la pestaña de vista previa.
  await refreshPreviewEntry(room);
  const cfg = visualConfig(room);
  const base = `${captureBase()}/api/rooms/${room.code}/preview/`;
  const declared = cfg.shots.slice(0, MAX_SHOTS).map((s, i) => {
    const url = typeof s === 'string' ? s : (s.url || '');
    const abs = /^https?:\/\//.test(url) ? url : `${base}${url.replace(/^\//, '')}`;
    return {
      id: slug((typeof s === 'object' && (s.id || s.slug)) || `toma-${i + 1}`, `toma-${i + 1}`),
      label: clampStr((typeof s === 'object' && s.label) || url || `toma ${i + 1}`, 120),
      url: abs,
      declared: true,
    };
  });
  if (declared.length) return crossShots(declared, cfg.viewports);

  // Sin tomas declaradas se retrata el artefacto ENTERO: todas las páginas que sirve la vista
  // previa (el índice primero), no solo la principal. Un entregable con dos pantallas se juzgaba
  // por una, y lo que no se retrata no se puede firmar.
  const info = room?.artifacts?.previewEntry || null;
  const pages = (info?.available ? [info.entry, ...(info.pages || [])] : [entryUrl(room)])
    .filter(Boolean)
    .filter((p, i, all) => all.indexOf(p) === i)
    .slice(0, Math.max(1, Number(cfg.maxPages) || VISUAL_DEFAULTS.maxPages));
  if (!pages.length) return [];
  const list = pages.map((page, i) => ({
    id: i === 0 ? 'principal' : slug(page.replace(/[^a-zA-Z0-9]+/g, '-'), `pagina-${i + 1}`),
    label: i === 0 ? `vista principal (${page})` : `página ${i + 1} (${page})`,
    url: `${base}${page}`,
    declared: false,
    page,
  }));
  return crossShots(list, cfg.viewports);
}

// Refresca lo que la vista previa sabe del artefacto. El panel lo hace por su cuenta al abrir la
// pestaña; el motor necesita saberlo sin que nadie mire el panel, así que lo pide él mismo.
export async function refreshPreviewEntry(room) {
  try {
    const mod = await import('./preview.mjs');
    const entry = mod.previewEntry(room);
    room.artifacts.previewEntry = entry;
    return entry;
  } catch {
    return room.artifacts.previewEntry || null;
  }
}

// ---------------------------------------------------------------- CDP
// Cliente mínimo del protocolo DevTools sobre el WebSocket nativo de Node (v22+). No hay
// dependencias: Chrome habla JSON y aquí se habla JSON.
async function launchChrome(chrome, { timeoutMs = 30_000 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-visual-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--hide-scrollbars', '--mute-audio',
    ...headlessArgs(),
    // Render por software: hace falta para que WebGL funcione donde no hay GPU, y es exactamente
    // por esto que ninguna cifra de rendimiento salida de aquí se cuenta como rendimiento.
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    'about:blank',
  ];
  const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('el navegador no abrió el puerto de depuración')), timeoutMs);
    const onData = chunk => {
      buf += String(chunk);
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`el navegador salió con código ${code}`)); });
  });
  return { child, wsUrl, profile };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = [];
    this.errors = [];
    ws.addEventListener('message', ev => {
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'error de CDP'));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(clampStr(msg.params?.exceptionDetails?.exception?.description
          || msg.params?.exceptionDetails?.text || 'excepción', 200));
      }
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        this.errors.push(clampStr(msg.params.entry.text, 200));
      }
      for (const w of [...this.waiters]) {
        if (w.method === msg.method) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg.params); }
      }
    });
    ws.addEventListener('error', () => { for (const w of [...this.waiters]) w.reject(new Error('el WebSocket del navegador falló')); });
  }

  send(method, params = {}, sessionId = null) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  wait(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { method, resolve, reject };
      this.waiters.push(w);
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);   // el plazo no es un error: la página puede no disparar el evento
      }, timeoutMs);
      const done = fn => v => { clearTimeout(timer); fn(v); };
      w.resolve = done(resolve);
      w.reject = done(reject);
    });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => `sha256:${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`;

// Una toma: navegar, esperar, capturar. Devuelve el PNG y lo que la página dijo de sí misma.
export async function runCaptures(room, { shots, chrome = null, cfg = null, onShot = null } = {}) {
  const config = cfg || visualConfig(room);
  const list = (shots || []).slice(0, MAX_SHOTS);
  const browser = chrome || chromePath();
  if (!browser) {
    return { ok: false, reason: 'sin-navegador', message: 'No hay Chrome/Chromium/Edge en esta máquina: la evidencia visual queda `not-tested`, no aprobada.' };
  }
  if (!list.length) {
    return { ok: false, reason: 'sin-pagina', message: 'La sala no tiene una página que capturar (proyecto sin HTML, o vista previa no disponible).' };
  }
  // El cliente CDP habla por el WebSocket nativo de Node (22+). En un Node más viejo esto no es un
  // fallo de captura: es una versión, y se dice así en vez de devolver una imagen vacía.
  if (typeof WebSocket !== 'function') {
    return { ok: false, reason: 'sin-websocket', message: `Este Node (${process.version}) no trae WebSocket nativo: la captura headless necesita Node 22 o superior.` };
  }
  let launched = null;
  let cdp = null;
  const entries = [];
  let renderer = null;
  try {
    launched = await launchChrome(browser, { timeoutMs: Math.min(config.timeoutMs, 60_000) });
    const ws = new WebSocket(launched.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no se pudo conectar al navegador')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('no se pudo conectar al navegador')); });
    });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    for (const shot of list) {
      cdp.errors.length = 0;
      const errorsBefore = cdp.errors.length;
      // Cada toma fija su pantalla: es lo que hace que «escritorio» y «pantalla pequeña» sean dos
      // mundos de verdad y no dos nombres.
      const vp = shot.viewport || config.viewport;
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false,
        }, sessionId);
      } catch { /* si el navegador no lo acepta, se captura a la pantalla que tenga */ }
      let load = null;
      try { load = await Promise.all([
        cdp.wait('Page.loadEventFired', Math.min(20_000, config.timeoutMs)),
        cdp.send('Page.navigate', { url: shot.url }, sessionId),
      ]).then(([ev]) => ev); } catch (err) { load = null; entries.push({ ...shot, ok: false, error: clampStr(err.message, 200) }); continue; }
      await sleep(config.settleMs);
      const probe = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          try {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            const info = { title: document.title || '', ready: document.readyState, nodes: document.body ? document.body.getElementsByTagName('*').length : 0, webgl: !!gl };
            if (gl) {
              const dbg = gl.getExtension('WEBGL_debug_renderer_info');
              info.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
              info.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
            }
            return info;
          } catch (e) { return { error: String(e && e.message || e) }; }
        })()`,
        returnByValue: true,
      }, sessionId).then(r => r?.result?.value || null).catch(() => null);
      if (probe?.renderer && !renderer) renderer = clampStr(probe.renderer, 160);
      const shotResult = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      const buf = Buffer.from(shotResult.data, 'base64');
      const stats = pngStats(buf);
      const entry = {
        id: shot.id,
        label: shot.label,
        url: shot.url,
        declared: !!shot.declared,
        page: shot.page || null,
        viewport: vp,
        requestedViewport: shot.viewport || null,
        bytes: buf.length,
        hash: sha(buf),
        loaded: !!load,
        blank: shotIsBlank(stats),
        stats,
        probe,
        errors: cdp.errors.slice(errorsBefore).slice(0, 6),
        at: now(),
        buf,
      };
      entries.push(entry);
      if (typeof onShot === 'function') onShot(entry);
    }
    return { ok: entries.some(e => e.buf && !e.blank), renderer, chrome: browser, entries, errors: cdp.errors.slice(-6) };
  } catch (err) {
    return { ok: false, reason: 'fallo-de-captura', message: clampStr(err?.message || String(err), 300), entries, renderer };
  } finally {
    try { if (cdp) await cdp.send('Browser.close').catch(() => null); } catch { /* el navegador ya no está */ }
    try { launched?.child?.kill(); } catch { /* ya murió */ }
    try { if (launched?.profile) fs.rmSync(launched.profile, { recursive: true, force: true }); } catch { /* perfil temporal */ }
  }
}

// ---------------------------------------------------------------- registro
function capturesDir(room) {
  const repo = room.repo?.dir;
  if (!repo) return null;
  return path.join(path.dirname(repo), 'capturas');
}

export function visualState(room) {
  const v = room?.artifacts?.visual || null;
  if (!v) return { available: false, running: !!room?.artifacts?.visualRunning, shots: [], note: 'La sala todavía no capturó el artefacto.' };
  // La frescura se calcula al LEER: la misma toma deja de valer cuando la rama avanza, y quien
  // consulta la API (el panel, un agente) tiene que ver eso sin deducirlo de dos campos.
  return {
    ...v,
    running: !!room?.artifacts?.visualRunning,
    shots: (v.shots || []).map(s => ({ ...s, freshness: shotFreshness(room, s) })),
  };
}

// Una captura vale mientras el commit que retrató siga siendo el que hay. La misma regla que la
// evidencia ejecutable: si la rama se movió, la imagen es de otra cosa y el juicio que la citaba
// se cae con ella en vez de sobrevivir como si nada.
export function shotFreshness(room, shot) {
  const head = room?.repo?.head || null;
  if (!shot) return 'inexistente';
  if (shot.blank) return 'negra';
  if (shot.error) return 'fallida';
  if (!shot.commit) return 'provisional';
  if (!head) return 'caduca';
  return shot.commit === head ? 'fresca' : 'caduca';
}

// Cuánto puede RETENER una captura en vuelo a quien la espera. El trabajo no se retiene nunca; la
// puerta de salida de la revisión sí, porque el juicio de lo que se ve se firma sobre la imagen.
// Pero un navegador colgado no puede congelar una sala para siempre: pasado el doble del plazo de
// captura, la sala sigue como si no hubiera captura (y lo dirá: la afirmación queda sin imagen).
export function captureHoldMs(room) {
  const cfg = visualConfig(room);
  return Math.max(60_000, (Number(cfg.timeoutMs) || 90_000) * 2);
}

export function freshShots(room) {
  return visualState(room).shots.filter(s => shotFreshness(room, s) === 'fresca');
}

// Captura en segundo plano, con la promesa viva como marca (igual que la verificación): si el
// proceso muere, la marca desaparece con él y nada queda «capturando» para siempre.
export function captureInBackground(room, { by = null, reason = 'trabajo', force = false } = {}) {
  if (room?.__visualRun) return { started: false, because: 'ya hay una captura en curso' };
  if (!visualConfig(room).enabled) return { started: false, because: 'la evidencia visual está desactivada en esta sala' };
  if (!room.repo) return { started: false, because: 'la sala no escribe en ningún proyecto' };
  if (!chromePath()) {
    room.artifacts.visualNotTested = { at: now(), because: 'no hay Chrome/Chromium/Edge en esta máquina' };
    return { started: false, because: 'no hay navegador headless en esta máquina: la evidencia visual queda `not-tested`' };
  }
  if (!force && freshShots(room).length) return { started: false, because: 'ya hay capturas frescas de este commit' };
  room.artifacts.visualRunning = { at: now(), by, reason };
  const promise = captureRoom(room, { by, reason }).catch(() => null).finally(() => {
    delete room.artifacts.visualRunning;
    if (room.__visualRun === promise) delete room.__visualRun;
    // La captura retiene el cierre de la revisión (ver `reviewIsCovered`): al terminar hay que
    // despertar a quien espera turno, o la sala se queda mirando una promesa ya resuelta.
    room.__changed = true;
  });
  room.__visualRun = promise;
  return { started: true, because: `capturando el artefacto (${reason})` };
}

export async function captureRoom(room, { by = null, reason = 'trabajo', shots = null, runner = null } = {}) {
  await refreshPreviewEntry(room);
  const cfg = visualConfig(room);
  const list = shots || await shotsFor(room);
  if (!list.length) {
    room.artifacts.visual = {
      ...(room.artifacts.visual || {}),
      at: now(), reason, head: room.repo?.head || null, shots: [],
      note: 'Nada que capturar: la sala no tiene página (proyecto sin HTML) o su vista previa no está disponible.',
    };
    return { ok: false, reason: 'sin-pagina' };
  }
  const res = await (runner || runCaptures)(room, { shots: list, cfg });
  const dir = capturesDir(room);
  const head = room.repo?.head || null;
  const stored = [];
  if (res.entries?.length && dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ya existe */ }
  }
  for (const e of res.entries || []) {
    let file = null;
    if (e.buf && dir) {
      file = path.join(dir, `${e.id}.png`);
      try { fs.writeFileSync(file, e.buf); } catch { file = null; }
    }
    // Las medidas se recalculan SOBRE EL ARCHIVO guardado, no se aceptan del que capturó: si el
    // PNG es negro, da igual lo que diga quien lo trajo — no cuenta como evidencia. Es la
    // cicatriz de haber medido un búfer vacío y haber creído que la escena estaba negra.
    const stats = (e.buf ? pngStats(e.buf) : null) || e.stats || null;
    const blank = shotIsBlank(stats);
    const shot = {
      id: e.id, label: e.label, url: e.url, declared: !!e.declared,
      page: e.page || null,
      viewport: e.viewport || cfg.viewport,
      // El nombre del archivo, relativo a la carpeta de capturas de la sala (que vive FUERA del
      // árbol del repo a propósito: retratar el artefacto no puede ensuciar el repo que se
      // entrega). La carpeta viaja en el registro para que quien sirve la imagen resuelva sin
      // adivinar. Antes se guardaba relativo al repo —que está al lado— y la ruta quedaba como
      // `../capturas/x.png`, que la comprobación de contención leía como un escape.
      file: file ? path.basename(file) : null,
      bytes: e.buf ? e.buf.length : (e.bytes || 0), hash: e.hash || (e.buf ? sha(e.buf) : null),
      loaded: !!e.loaded, blank,
      stats, probe: e.probe ? { title: e.probe.title, webgl: !!e.probe.webgl, renderer: e.probe.renderer || null, nodes: e.probe.nodes ?? null } : null,
      errors: e.errors || [], error: e.error || null,
      commit: head, at: e.at || now(),
    };
    // Cada toma entra en el registro de evidencia con su hash: mismo contenido y mismo commit se
    // cita en vez de repetirse, y cualquier commit posterior la vuelve `caduca`.
    const ev = recordEvidence(room, {
      kind: 'capture',
      command: `capturar ${shot.id}`,
      exitCode: shot.error || (res.ok ? 0 : 1),
      ok: !shot.error && !shot.blank,
      output: `${shot.hash} ${shot.bytes}`,
      commit: head,
      by: 'servidor',
      itemId: null,
      note: clampStr(`captura ${shot.label}${shot.blank ? ' (imagen negra: no cuenta como evidencia)' : ''}`, 200),
    });
    shot.evidenceId = ev.entry?.id || null;
    stored.push(shot);
  }
  room.artifacts.visual = {
    at: now(), reason, head, branch: room.repo?.branch || null,
    dir,                       // dónde viven los PNG (fuera del repo)
    chrome: res.chrome || chromePath(),
    renderer: res.renderer || null,
    viewport: cfg.viewport,
    viewports: cfg.viewports,
    shots: stored,
    ok: !!res.ok,
    note: res.ok
      ? `Captura por software (${res.renderer || 'render por software'}): sirve para JUZGAR el aspecto, no para medir rendimiento — los fps medidos así no valen.`
      : (res.message || 'La captura no produjo imagen.'),
  };
  const fresh = stored.filter(s => shotFreshness(room, s) === 'fresca').length;
  log(room, by, 'visual',
    `${plural(stored.length, 'captura')} del artefacto en ${String(head || 'el árbol').slice(0, 8)}` +
    `${fresh ? ` (${fresh} fresca(s))` : ''}${res.ok ? '' : ` — sin imagen: ${gist(res.message || 'fallo de captura', 120)}`}` +
    `${stored.some(s => s.blank) ? ' · hay una imagen negra marcada como sospechosa' : ''}.`);
  return { ok: !!res.ok, shots: stored, renderer: res.renderer || null, message: res.message || null };
}

// ---------------------------------------------------------------- quién VE (y por eso debe juzgar)
// La capacidad «vision» la declara el agente en /join, y desde ahí es una OBLIGACIÓN, no un
// adorno: el servidor le entrega las capturas y espera su firma en cada afirmación de aspecto.
// El servidor no adivina quién puede ver: lo declara cada harness. Lo que sí calcula es lo que
// falta, que es la parte que un agente solo no puede darse (nadie se autoexige firmar).
export function visionJudges(room) {
  return activeAgents(room)
    .filter(id => (room.agents?.[id]?.capabilities || []).includes(VISION_CAPABILITY))
    .map(id => ({
      id,
      name: nameOf(room, id),
      harness: room.agents[id]?.harness || null,
      model: room.agents[id]?.model || null,
    }));
}

// La obligación de ver, medida: qué modelo que ve no ha firmado qué afirmación. Solo exige firma
// donde la firma es POSIBLE (hay una captura fresca del commit actual): si la imagen caducó, el
// problema es la imagen y ya se cuenta como tal, no una firma que nadie puede poner.
export function visionDuty(room, claims = []) {
  const judges = visionJudges(room).map(j => ({ ...j, pending: [], signed: 0 }));
  const juicios = (claims || []).filter(c => c.type === 'juicio');
  const fresh = visualState(room).shots.some(s => shotFreshness(room, s) === 'fresca');
  if (!judges.length) {
    return {
      judges, missing: 0, claims: [], fresh, total: 0, seers: 0,
      note: 'Ningún participante declaró la capacidad «vision»: nadie está obligado a mirar el artefacto. Quien pueda ver, que lo declare en /join — y entonces firmar será parte de su trabajo.',
    };
  }
  if (!fresh) {
    return {
      judges, missing: 0, claims: [], fresh, total: judges.length * juicios.length, seers: judges.length,
      note: `Hay ${plural(judges.length, 'modelo')} con visión declarada, pero ninguna captura fresca del commit actual: sin imagen no hay firma que exigir.`,
    };
  }
  const out = [];
  for (const c of juicios) {
    const js = judgmentsForClaim(room, c.id);
    const faltan = judges.filter(j => !js.some(x => x.judge === j.id));
    for (const j of faltan) j.pending.push(c.id);
    for (const j of judges) if (js.some(x => x.judge === j.id)) j.signed += 1;
    if (faltan.length) {
      out.push({
        claimId: c.id,
        text: c.text,
        missingIds: faltan.map(j => j.id),
        missing: faltan.map(j => j.name),
      });
    }
  }
  const missing = out.reduce((n, c) => n + c.missingIds.length, 0);
  return {
    judges, missing, claims: out, fresh, total: judges.length * juicios.length, seers: judges.length,
    note: missing
      ? `${plural(missing, 'firma')} obligatoria(s) sin poner: ${out.map(c => `${c.claimId} (${c.missing.join(', ')})`).join(' · ')}. Declararon visión: no cierran su parte hasta que firmen.`
      : `${plural(judges.length, 'modelo')} con visión declarada firmó cada afirmación de aspecto${juicios.length ? '' : ' (no había ninguna)'}.`,
  };
}

// ---------------------------------------------------------------- independencia
// Quién puede juzgar qué. NO lo declara el agente: se calcula desde las tareas y los parches.
//   autor   — escribió justamente esa tarea: su «pasa» no cierra nada (es el caso que el juicio
//             visual existía para evitar).
//   coautor — no escribió esa tarea pero sí otras partes del artefacto: tampoco cierra.
//   ajeno   — no escribió una línea del artefacto: el único que puede cerrar con un «pasa».
export function independenceOf(room, agentId, claim) {
  const work = room?.work;
  const item = claim?.ownerId ? work?.items?.[claim.ownerId] : null;
  const patches = Object.values(work?.patches || {});
  const mine = patches.filter(p => p.author === agentId);
  if (item && (item.claimant === agentId || mine.some(p => p.itemId === item.id))) {
    return { level: 'autor', because: `escribió la tarea ${item.id} que implementa esa afirmación`, patch: mine.find(p => p.itemId === item.id)?.id || null };
  }
  if (work?.items && Object.values(work.items).some(i => i.claimant === agentId)) {
    return { level: 'coautor', because: 'trabajó tareas del mismo artefacto: mira lo suyo, no es un ojo externo' };
  }
  if (mine.length) return { level: 'coautor', because: `entregó ${plural(mine.length, 'parche')} del mismo artefacto` };
  return { level: 'ajeno', because: 'no escribió nada del artefacto: es un ojo externo' };
}

// ---------------------------------------------------------------- juicio
export function judgmentsOf(room) {
  return Array.isArray(room?.artifacts?.judgments) ? room.artifacts.judgments : [];
}

export function judgmentsForClaim(room, claimId) {
  return judgmentsOf(room).filter(j => j.claimId === claimId);
}

// La captura citada por un juicio, resuelta contra las que existen ahora.
function resolveCaptures(room, cited) {
  const shots = visualState(room).shots;
  const list = Array.isArray(cited) ? cited : cited ? [cited] : [];
  const out = [];
  for (const c of list) {
    const key = String(typeof c === 'object' ? (c.id || c.hash) : c || '').trim();
    // Exacto por id, por huella (o su cola), y por PREFIJO: con varias pantallas los ids son
    // `principal-escritorio` y `principal-pantalla-pequena`, y citar `principal` (lo que dice la
    // documentación y lo que un harness escribe naturalmente) tiene que encontrar sus tomas en vez
    // de recibir «esa captura no existe».
    const shot = shots.find(s => s.id === key || s.hash === key || (s.hash || '').endsWith(key))
      || shots.find(s => key.length >= 4 && s.id.startsWith(`${key}-`));
    if (shot) out.push({ id: shot.id, hash: shot.hash, freshness: shotFreshness(room, shot) });
    else out.push({ id: key, hash: null, freshness: 'inexistente' });
  }
  return out;
}

// Si un juicio cierra eso no se guarda como verdad: se RE-CALCULA contra las capturas que hay
// ahora. Un «pasa» firmado sobre una imagen que después quedó vieja (la rama avanzó, el PNG se
// perdió) deja de cerrar, en vez de seguir cerrando para siempre por haber sido cierto una vez.
export function closesNow(room, judgment) {
  if (!judgment || judgment.verdict !== 'pasa' || judgment.independence !== 'ajeno') return false;
  const shots = visualState(room).shots;
  const cited = (judgment.captures || []).map(c => shots.find(s => s.id === c.id || (c.hash && s.hash === c.hash)) || null);
  if (!cited.length || cited.some(s => !s)) return false;
  return cited.some(s => shotFreshness(room, s) === 'fresca');
}

// La regla completa, en un solo sitio para que el veredicto, el resultado y el panel digan lo
// mismo. Devuelve el estado del juicio de una afirmación de tipo «juicio».
export function judgmentVerdictFor(room, claim) {
  const shots = visualState(room).shots;
  const js = judgmentsForClaim(room, claim.id);
  // Quien declaró visión y no firmó esta afirmación sigue debiendo la firma, incluso cuando otro
  // ojo ya la cerró: el registro se lo recuerda al veredicto y a su propio turno.
  const awaiting = visionJudges(room).filter(j => !js.some(x => x.judge === j.id)).map(j => j.name);
  if (!js.length) {
    return {
      awaiting,
      state: shots.length ? 'sin-juez' : 'sin-captura',
      because: shots.length
        ? `hay ${plural(shots.length, 'captura')} del artefacto (${shots.filter(s => shotFreshness(room, s) === 'fresca').length} fresca(s)) y nadie que no lo haya escrito ha dicho si cumple lo que promete`
        : 'nadie capturó el artefacto: no hay imagen que mirar (o esta máquina no tiene navegador headless)',
      independent: null, judgedBy: null, captures: [], blocks: false,
    };
  }
  const negatives = js.filter(j => j.verdict === 'no-pasa');
  const closes = js.find(j => closesNow(room, j));
  const cerradoPeroViejo = js.find(j => j.closes && !closesNow(room, j) && j.verdict === 'pasa' && j.independence === 'ajeno');
  if (negatives.length) {
    const n = negatives[0];
    return {
      awaiting,
      state: 'no-pasa',
      because: `${nameOf(room, n.judge)} miró el artefacto y dice que NO cumple: ${gist(n.reason, 160)}`,
      independent: n.independence,
      judgedBy: nameOf(room, n.judge),
      captures: n.captures || [],
      blocks: true,
    };
  }
  if (closes) {
    return {
      awaiting,
      state: 'juzgada',
      because: `la juzgó ${nameOf(room, closes.judge)}, que no escribió el artefacto (${closes.independence}), citando la captura ${(closes.captures || []).map(c => c.id).join(', ') || 'sin id'}`,
      independent: closes.independence,
      judgedBy: nameOf(room, closes.judge),
      captures: closes.captures || [],
      blocks: false,
    };
  }
  const last = js[js.length - 1];
  const consulted = last.captures || [];
  const stale = !!cerradoPeroViejo || consulted.some(c => c.freshness === 'caduca')
    || consulted.some(c => shotFreshness(room, (visualState(room).shots || []).find(s => s.id === c.id)) === 'caduca');
  return {
    awaiting,
    state: stale ? 'caducada' : (last.independence === 'ajeno' ? 'sin-captura' : 'juzgada-por-autor'),
    because: stale
      ? `${nameOf(room, last.judge)} la juzgó sobre un commit que ya no es el HEAD (o sobre una captura que ya no está): el juicio caduca con la imagen que citó`
      : last.independence === 'ajeno'
        ? `${nameOf(room, last.judge)} es ojo externo pero su juicio no cita una captura fresca del artefacto: no cierra la obligación`
        : `${nameOf(room, last.judge)} mira lo suyo (${last.independence}): su «pasa» no cierra una afirmación que él escribió`,
    independent: last.independence,
    judgedBy: nameOf(room, last.judge),
    captures: last.captures || [],
    blocks: false,
  };
}

// Firmar un juicio. Todo lo que decide si cierra lo calcula el servidor: el agente aporta el
// veredicto y el motivo, nada más.
export function recordJudgment(room, agentId, payload = {}, { claim = null } = {}) {
  if (!claim) throw new Error('recordJudgment necesita la afirmación que se juzga');
  if (!room.artifacts.visual?.shots?.length) {
    throw Object.assign(new Error(
      'No hay capturas del artefacto todavía. Pide una con {kind:"capture"} (el servidor abre el navegador y guarda los PNG); sin imagen no hay juicio visual, solo opinión.',
    ), { code: 'no_captures' });
  }
  const verdict = ['pasa', 'no-pasa', 'dudoso'].includes(payload.verdict) ? payload.verdict : null;
  if (!verdict) {
    throw Object.assign(new Error('payload:{claimId, verdict:"pasa"|"no-pasa"|"dudoso", reason:"qué viste", captures:["id o hash de la captura"]}'), { code: 'bad_payload' });
  }
  const reason = clampStr(payload.reason ?? payload.note ?? payload.notes ?? '', 600);
  if (verdict !== 'pasa' && reason.length < 10) {
    throw Object.assign(new Error('Decir que no cumple (o dudar) exige el motivo: qué ves en la captura y qué esperaba la afirmación.'), { code: 'bad_payload' });
  }
  const cited = resolveCaptures(room, payload.captures || payload.capture || []);
  const independence = independenceOf(room, agentId, claim);
  const fresh = cited.filter(c => c.freshness === 'fresca');
  const missing = cited.filter(c => c.freshness === 'inexistente');
  // Declarar «vision» es lo que hace de la firma una obligación; no declararlo no la invalida
  // (un ojo externo cierra igual), pero el registro dice que el servidor no puede dar por hecho
  // que ese agente miró la imagen.
  const sees = (room.agents?.[agentId]?.capabilities || []).includes(VISION_CAPABILITY);
  const warnings = [];
  if (!sees) warnings.push('no declaraste la capacidad «vision»: la firma se registra igual, pero el servidor no puede dar por hecho que miraste la imagen. Si puedes ver, declárala en /join');
  if (!cited.length) warnings.push('no citaste ninguna captura: sin imagen mirada, el juicio queda registrado pero no cierra nada');
  if (missing.length) warnings.push(`citaste capturas que no existen: ${missing.map(m => m.id).join(', ')}`);
  if (independence.level !== 'ajeno') warnings.push(`miras lo tuyo (${independence.because}): un «pasa» tuyo no cierra la obligación`);
  if (verdict === 'pasa' && !fresh.length) warnings.push('ninguna captura citada es fresca (el commit cambió o la imagen es negra)');
  const closes = verdict === 'pasa' && independence.level === 'ajeno' && !!fresh.length && !missing.length;
  const entry = {
    id: uid('j'),
    claimId: claim.id,
    judge: agentId,
    verdict,
    reason,
    independence: independence.level,
    independenceBecause: independence.because,
    visionDeclared: sees,
    captures: cited,
    fresh: fresh.map(c => c.id),
    head: room.repo?.head || null,
    closes,
    at: now(),
  };
  const list = judgmentsOf(room).filter(j => !(j.claimId === claim.id && j.judge === agentId));
  list.push(entry);
  room.artifacts.judgments = list.slice(-MAX_JUDGMENTS);
  log(room, agentId, 'juicio',
    `${nameOf(room, agentId)} juzga «${gist(claim.text, 90)}» → ${verdict.toUpperCase()}` +
    `${cited.length ? ` sobre ${cited.map(c => c.id).join(', ')}` : ' sin citar captura'}` +
    `${verdict === 'pasa' ? (closes ? ' (cierra: ojo externo y captura fresca)' : ' (no cierra)') : ''}` +
    `${reason ? `: ${gist(reason, 130)}` : ''}.`);
  return { judgment: entry, closes, independence, warnings };
}

// ---------------------------------------------------------------- lo que va a los turnos
// El material del juicio, tal como se le entrega a quien puede firmarlo: las imágenes con su id
// (que es lo que hay que citar), su hash, si son frescas y qué se ve en ellas.
export function visualBrief(room, agentId, claims = []) {
  const st = visualState(room);
  const declaresVision = (room.agents?.[agentId]?.capabilities || []).includes(VISION_CAPABILITY);
  const duty = visionDuty(room, claims);
  const mios = duty.judges.find(j => j.id === agentId) || null;
  const you = {
    declaresVision,
    owed: mios ? mios.pending : [],
    signed: mios ? mios.signed : 0,
    note: declaresVision
      ? (mios?.pending?.length
        ? `Declaraste visión: la obligación no cierra hasta que firmes ${plural(mios.pending.length, 'afirmación', 'afirmaciones')} de aspecto (${mios.pending.join(', ')}). Mirá las capturas y firma una por una con {kind:"judgment"}.`
        : 'Declaraste visión y ya firmaste todas las afirmaciones de aspecto: tu parte está puesta.')
      : 'No declaraste la capacidad «vision» en /join. Si puedes mirar imágenes, declárala: con eso el servidor te exige firmar las capturas en vez de dejarlas pasar.',
  };
  const shots = st.shots.map(s => ({
    id: s.id,
    label: s.label,
    url: `/api/rooms/${room.code}/visual/${encodeURIComponent(s.id)}`,
    hash: s.hash,
    commit: s.commit ? String(s.commit).slice(0, 8) : null,
    freshness: shotFreshness(room, s),
    // En qué pantalla se tomó: dos tomas de la misma página en dos mundos distintos son dos
    // preguntas distintas («¿se lee en un escritorio?», «¿se lee en una pantalla pequeña?»).
    viewport: s.viewport ? `${s.viewport.id || ''} ${s.viewport.width}×${s.viewport.height}`.trim() : null,
    page: s.page || null,
    brightness: s.stats?.brightness ?? null,
    colors: s.stats?.colors ?? null,
    blank: !!s.blank,
    error: s.error || null,
    errors: s.errors || [],
  }));
  const targets = claims
    .filter(c => c.type === 'juicio')
    .map(c => {
      const verdict = judgmentVerdictFor(room, c);
      const mine = judgmentsForClaim(room, c.id).find(j => j.judge === agentId) || null;
      return {
        claimId: c.id,
        text: c.text,
        owner: c.ownerTitle,
        ownerByMe: !!c.ownerId && room.work?.items?.[c.ownerId]?.claimant === agentId,
        alreadyJudgedByMe: mine ? { verdict: mine.verdict, closes: closesNow(room, mine), at: mine.at } : null,
        state: verdict.state,
        because: verdict.because,
        independence: independenceOf(room, agentId, c).level,
        // Si declaraste visión y no firmaste, esta afirmación sigue siendo tuya aunque otro ojo
        // ya la haya cerrado: el servidor te la vuelve a poner delante.
        owesSignature: !!(you?.declaresVision && !mine),
        awaiting: verdict.awaiting || [],
      };
    })
    .filter(t => !['juzgada'].includes(t.state) || t.owesSignature);
  if (!st.shots.length && !st.running && !room.artifacts.visualNotTested) return null;
  return {
    available: !!st.shots.length,
    running: !!st.running,
    head: room.repo?.head ? String(room.repo.head).slice(0, 8) : null,
    renderer: st.renderer || null,
    viewport: st.viewport || null,
    note: st.note || null,
    notTested: room.artifacts.visualNotTested?.because || null,
    shots,
    targets,
    // Tu parte de la obligación de ver, dicha en tu turno: qué firmaste, qué te falta y por qué.
    you,
    // Y la de la sala entera: quién declaró visión y cuántas firmas faltan en total.
    vision: {
      seers: duty.judges.map(j => ({ name: j.name, harness: j.harness, signed: j.signed, pending: j.pending })),
      missing: duty.missing,
      note: duty.note,
    },
    move: {
      kind: 'judgment',
      payload: '{claimId:"o3", verdict:"pasa"|"no-pasa"|"dudoso", reason:"qué ves y qué esperaba la afirmación", captures:["principal"]}',
      rule: 'Un «pasa» solo cierra la obligación si quien lo firma no escribió nada del artefacto y cita una captura fresca. Un «no-pasa» abre bloqueo aunque venga del autor. Los fps no se juzgan aquí: la captura es render por software.',
    },
    refresh: { kind: 'capture', payload: '{}  → el servidor vuelve a capturar el artefacto y te dice cuándo está' },
    message: st.shots.length
      ? (you.declaresVision && you.owed.length
        ? `Declaraste visión: mirá las capturas y firmá ${plural(you.owed.length, 'afirmación', 'afirmaciones')} (${you.owed.join(', ')}). La obligación no cierra sin tu veredicto.`
        : `Mira las capturas antes de firmar: ${plural(targets.length, 'afirmación', 'afirmaciones')} de tipo juicio esperan un veredicto.`)
      : `Todavía no hay capturas${room.artifacts.visualNotTested ? ' (esta máquina no tiene navegador headless: la evidencia visual queda como no comprobada)' : ''}.`,
  };
}

// ---------------------------------------------------------------- acta
// La obligación de ver, escrita: quién declaró visión, cuántas firmas puso de las que le tocaban
// y qué sigue debiendo. Sin esto, «todos los que ven miran» sería una promesa de la sala y no un
// hecho del acta.
export function visionMarkdown(room, claims = []) {
  const juicios = (claims || []).filter(c => c.type === 'juicio');
  const duty = visionDuty(room, claims);
  if (!duty.judges.length && !juicios.length) return [];
  const L = ['', '### Quién tenía que mirar (visión declarada)', ''];
  if (!duty.judges.length) {
    L.push('_Nadie declaró la capacidad `vision`: ninguna afirmación de aspecto tenía un ojo obligado a mirarla, así que quedan sin juez. Quien pueda ver, que lo declare al entrar._');
    return L;
  }
  for (const j of duty.judges) {
    L.push(`- **${j.name}**${j.harness ? ` (${j.harness}${j.model ? ` · ${j.model}` : ''})` : ''} · ` +
      `firmó **${j.signed}/${juicios.length}**${j.pending.length ? ` · debe ${j.pending.map(p => `\`${p}\``).join(', ')}` : ' · al día'}`);
  }
  L.push('');
  L.push(`_${duty.note}_`);
  return L;
}

export function visualMarkdown(room) {
  const st = visualState(room);
  const L = [];
  if (!st.shots.length && !st.note && !room.artifacts.visualNotTested) return L;
  L.push('');
  L.push('## Evidencia visual (capturada por el servidor)');
  L.push('');
  if (st.shots.length) {
    L.push(`Head \`${String(st.head || '').slice(0, 8)}\` · navegador ${st.chrome ? path.basename(st.chrome) : 'headless'}` +
      `${st.renderer ? ` · render \`${st.renderer}\`` : ''} · ${st.viewport ? `${st.viewport.width}×${st.viewport.height}` : ''}` +
      `${st.running ? ' · (re)capturando' : ''}.`);
    L.push('');
    for (const s of st.shots) {
      L.push(`- \`${s.id}\` · **${s.label}**${s.viewport ? ` · ${s.viewport.width}×${s.viewport.height}` : ''} · \`${s.hash}\` · ${shotFreshness(room, s)}` +
        `${s.stats ? ` · luminancia ${s.stats.brightness}/255, contraste ${s.stats.contrast}, ${s.stats.alive}% de píxeles con contenido` : ''}` +
        `${s.blank ? ' · **imagen negra: no cuenta como evidencia**' : ''}` +
        `${s.error ? ` · falló: ${s.error}` : ''}`);
      L.push(`  - ${s.url}`);
    }
    L.push('');
    L.push(`_${st.note || ''}_`);
  } else {
    L.push(`Sin capturas: ${room.artifacts.visualNotTested?.because || st.note || 'la sala no tiene página que capturar.'}`);
  }
  const js = judgmentsOf(room);
  if (js.length) {
    L.push('');
    L.push(`### Juicios sobre lo que se ve (${js.length})`);
    L.push('');
    for (const j of js) {
      L.push(`- **${j.verdict.toUpperCase()}** por ${nameOf(room, j.judge)} (${j.independence}) sobre ` +
        `${(j.captures || []).map(c => `\`${c.id}\``).join(', ') || '—'}` +
        `${closesNow(room, j) ? ' · **cierra la obligación**' : (j.closes ? ' · cerraba, y su captura ya no es la del HEAD' : ' · no cierra')}` +
        `${j.reason ? `: ${j.reason}` : ''}`);
    }
    L.push('');
    L.push('_Un juicio no sube solo por venir de un agente: la independencia y la frescura de la captura las calcula el servidor._');
  }
  return L;
}
