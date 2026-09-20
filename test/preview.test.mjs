// AGORA v2 — pruebas de la previsualización del trabajo.
//
// Lo que se comprueba aquí no es «se ve algo», es que se sirve EXACTAMENTE lo que está dentro del
// árbol de trabajo de la sala: ni el `.git`, ni una ruta que salga del proyecto, ni un archivo que
// no exista. Y que cuando no hay página, se dice por qué en vez de dejar un hueco.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createRoom, attachScaffold, previewEntry, previewFile, previewHeaders, pickSettings, importMapFor,
} from '../server/engine/index.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-preview-'));
const DATA = path.join(TMP, 'data');

async function scaffoldRoom(settings = {}) {
  const room = createRoom({ task: 'Construye el visor de marea con olas y clima.', settings: pickSettings(settings) });
  await attachScaffold(room, { dataDir: DATA });
  return room;
}

function write(room, rel, content = 'x') {
  const file = path.join(room.repo.dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('sin página no hay previsualización, y se dice por qué', async () => {
  const room = await scaffoldRoom();
  const info = previewEntry(room, { fresh: true });
  assert.equal(info.available, false);
  assert.equal(info.reason, 'sin-pagina');
  assert.equal(info.files, 1, 'el proyecto nace con su README');

  // Un proyecto sin repo (solo planificación) lo dice con su propio motivo.
  const planOnly = createRoom({ task: 'Decide la estrategia sin escribir código.', settings: pickSettings({ planOnly: true }) });
  assert.equal(previewEntry(planOnly, { fresh: true }).reason, 'solo-planificacion');
  assert.equal(previewEntry(planOnly, { fresh: true }).available, false);
});

// Sin página propia, la vista ya no es una lista de nombres: el proyecto se carga de verdad (su
// página de prueba) y, junto a ella, el código que se está escribiendo. El nombre dice qué se toca;
// el código dice qué se está haciendo.
test('sin página propia se prueba el módulo y se enseña el código que se está escribiendo', async () => {
  const room = await scaffoldRoom();
  write(room, 'src/ocean/WaterMaterial.js', 'export const agua = 1;\nexport const sal = 2;\n');

  const info = previewEntry(room, { fresh: true });
  assert.equal(info.available, true, 'un módulo se puede probar en el navegador: no se deja en blanco');
  assert.equal(info.synthetic, true, 'y se dice que la página es del servidor, no del proyecto');
  assert.equal(info.entry, '__agora__.html');
  assert.deepEqual(info.modules, ['src/ocean/WaterMaterial.js']);
  assert.equal(info.source.path, 'src/ocean/WaterMaterial.js', 'lo más reciente primero');
  assert.match(info.source.code, /export const agua/);
  assert.equal(info.source.lines, 3);
  assert.equal(info.source.truncated, false);
  assert.ok(info.source.at > 0, 'con su hora, para poder decir «escribiéndose ahora»');
});

// Un archivo enorme o binario no se enseña a medias: se dice por qué, en vez de romper el panel.
test('un archivo enorme se recorta y un binario no se enseña', async () => {
  const room = await scaffoldRoom();
  write(room, 'src/muchas.js', Array.from({ length: 500 }, (_, i) => `const l${i} = ${i};`).join('\n'));
  let info = previewEntry(room, { fresh: true });
  assert.equal(info.source.shown, 400, 'se enseñan las primeras 400 líneas');
  assert.equal(info.source.lines, 500);
  assert.equal(info.source.truncated, true);

  write(room, 'src/bin.dat', Buffer.from([0, 1, 2, 3]));
  info = previewEntry(room, { fresh: true });
  assert.equal(info.source.code, null);
  assert.equal(info.source.reason, 'binario');
});

test('detecta la página de entrada, incluso recién escrita sin commitear', async () => {
  const room = await scaffoldRoom();
  write(room, 'app.js', 'console.log(1);');
  write(room, 'docs/ejemplo.html', '<h1>ejemplo</h1>');
  // Sin commitear: el trabajo EN CURSO también se puede ver.
  let info = previewEntry(room, { fresh: true });
  assert.equal(info.available, true);
  assert.equal(info.entry, 'docs/ejemplo.html', 'con una sola página, esa es la entrada');

  write(room, 'index.html', '<h1>hola</h1>');
  info = previewEntry(room, { fresh: true });
  assert.equal(info.entry, 'index.html', 'un index.html manda sobre cualquier otra página');
  assert.deepEqual(info.pages, ['index.html', 'docs/ejemplo.html'], 'las páginas se listan de arriba abajo');
  assert.equal(info.files, 4);
});

test('sirve lo de dentro del árbol y nada más', async () => {
  const room = await scaffoldRoom();
  write(room, 'index.html', '<h1>hola</h1>\n');
  write(room, 'src/app.js', 'export const x = 1;\n');

  const page = previewFile(room, 'index.html');
  assert.equal(page.status, 200);
  assert.equal(page.mime, 'text/html; charset=utf-8');
  assert.match(String(page.body), /hola/);

  const mod = previewFile(room, 'src/app.js');
  assert.equal(mod.status, 200);
  assert.equal(mod.mime, 'text/javascript; charset=utf-8', 'un módulo tiene que servirse como JS o el navegador lo rechaza');

  // Fuera del proyecto: ni con rutas relativas, ni con las del sistema, ni el .git.
  for (const bad of ['../secreto.txt', '../../etc/passwd', '.git/config', '.git/HEAD', '/etc/hosts']) {
    const out = previewFile(room, bad);
    assert.equal(out.status, 403, `no se sirve ${bad}`);
  }
  assert.equal(previewFile(room, 'src').status, 404, 'un directorio no es un archivo');
  assert.equal(previewFile(room, 'no-existe.js').status, 404);
});

test('las cabeceras de la vista previa dejan cargar módulos y dejan claro el límite', () => {
  const headers = previewHeaders('src/app.js');
  assert.equal(headers['Content-Type'], 'text/javascript; charset=utf-8');
  // El iframe va con origen opaco (sandbox sin allow-same-origin), así que sus módulos son
  // peticiones cross-origin: sin esto no cargarían.
  assert.equal(headers['Access-Control-Allow-Origin'], '*');
  assert.equal(headers['Cache-Control'], 'no-store', 'una vista EN VIVO no se cachea');
  const csp = headers['Content-Security-Policy'];
  assert.match(csp, /default-src 'self'/, 'por defecto, lo que hay dentro del proyecto');
  assert.match(csp, /script-src [^;]*https:/, 'un CDN (three.js y compañía) tiene que poder cargar');
  assert.match(csp, /frame-ancestors 'self'/, 'nadie incrusta esto fuera del panel');
  // Con el origen del servidor explícito: un iframe con origen opaco no puede casar `'self'`, y sin
  // esto la página se sirve pero sus módulos e imágenes se quedan por el camino.
  const withOrigin = previewHeaders('index.html', 'http://127.0.0.1:8919')['Content-Security-Policy'];
  assert.match(withOrigin, /script-src 'self' http:\/\/127\.0\.0\.1:8919/, 'el propio servidor entra en la política');
  assert.match(withOrigin, /img-src 'self' http:\/\/127\.0\.0\.1:8919/, 'y sus imágenes también');
  assert.equal(previewHeaders('texturas/agua.png')['Content-Type'], 'image/png');
  assert.equal(previewHeaders('modelo.glb')['Content-Type'], 'model/gltf-binary');
});

test('la actividad del trabajo se ve mientras se escribe, sin esperar a un commit', async () => {
  const room = await scaffoldRoom();
  write(room, 'index.html', '<h1>hola</h1>\n');
  write(room, 'src/olas.js', 'export const ola = 1;\nexport const viento = 2;\n');

  const info = previewEntry(room, { fresh: true });
  assert.equal(info.changed.files, 2, 'lo recién escrito cuenta como trabajo en curso');
  assert.deepEqual(info.changes.map(c => c.path).sort(), ['index.html', 'src/olas.js'], 'se listan los archivos, no su carpeta');
  assert.ok(info.changes.every(c => c.status === 'nuevo'), 'un archivo que nace es «nuevo»');
  assert.ok(info.changes.every(c => typeof c.at === 'number' && c.at > 0), 'cada archivo dice cuándo se escribió');
  assert.equal(info.lastWrite.path, info.changes[0].path, 'lo último escrito encabeza la lista');
  // Git no cuenta las líneas de lo que no rastrea: las cuenta la vista previa, para que un archivo
  // recién nacido no aparezca sin tamaño.
  assert.equal(info.changes.find(c => c.path === 'index.html').insertions, 2);

  // Un archivo YA rastreado trae además el tamaño real del cambio, que es lo que git sí sabe.
  await new Promise(r => setTimeout(r, 20));
  write(room, 'README.md', '# Tarea\n\nreescrito por un agente\n');
  const edited = previewEntry(room, { fresh: true });
  const readme = edited.changes.find(c => c.path === 'README.md');
  assert.equal(readme.status, 'editado');
  assert.ok(readme.insertions >= 1 && readme.deletions >= 1, 'una edición dice cuánto entra y cuánto sale');
  assert.equal(edited.lastWrite.path, 'README.md', 'la última escritura manda, sin importar el orden de git');
  assert.ok(edited.changed.insertions >= 3, 'los totales suman lo de todos los archivos');

  // Nada de esto necesita un commit: la firma del árbol se mueve con cada escritura, y eso es lo
  // que hace que el panel se rehaga solo (en vez de esperar a que alguien commitee).
  await new Promise(r => setTimeout(r, 20));
  write(room, 'README.md', '# Tarea\n\nreescrito por un agente\n\nuna línea más\n');
  const again = previewEntry(room);
  assert.notEqual(again.lastWrite.at, edited.lastWrite.at, 'la edición mueve la firma del árbol');
});

test('el proyecto enseña lo que se está tocando aunque no tenga página propia', async () => {
  const room = await scaffoldRoom();
  write(room, 'lib/olas.mjs', 'export const ola = 1;\n');
  const info = previewEntry(room, { fresh: true });
  assert.equal(info.synthetic, true, 'una librería se prueba cargando sus módulos');
  assert.equal(info.sample[0], 'lib/olas.mjs', 'lo recién escrito encabeza la muestra');
  assert.equal(info.lastWrite.path, 'lib/olas.mjs');
});

// El navegador no sabe resolver `import * as THREE from 'three'` por sí solo: sin este mapa, la
// página del proyecto muere en «Failed to resolve module specifier» y la vista previa queda en
// blanco sin decir por qué. El CDN resuelve además las dependencias internas del paquete.
test('los paquetes que el proyecto importa por nombre se resuelven para el navegador', async () => {
  const room = await scaffoldRoom();
  write(room, 'package.json', JSON.stringify({ dependencies: { three: '^0.160.4' } }));
  write(room, 'src/ocean/WaterMaterial.js', [
    "import * as THREE from 'three';",
    "import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';",
    "import fs from 'node:fs';",
    "import './local.js';",
    "import 'https://ejemplo.test/x.js';",
    'export const agua = 1;',
  ].join('\n'));

  const kit = importMapFor(room, 'firma-1');
  assert.equal(kit.imports.three, 'https://esm.sh/three@0.160.4', 'con la versión que declara el proyecto');
  assert.equal(kit.imports['three/examples/jsm/loaders/GLTFLoader.js'],
    'https://esm.sh/three@0.160.4/examples/jsm/loaders/GLTFLoader.js', 'los subcaminos también');
  assert.deepEqual(kit.packages, ['three']);
  assert.equal(kit.imports['node:fs'], undefined, 'un módulo de Node no se mapea: no existe en un navegador');
  assert.equal(kit.imports['./local.js'], undefined, 'lo relativo lo resuelve el navegador solo');
  assert.equal(kit.imports['https://ejemplo.test/x.js'], undefined, 'una URL absoluta ya está resuelta');

  // Y la página servida sale con el mapa inyectado Y con la sonda de errores, en ese orden.
  write(room, 'index.html', '<!doctype html><html><head><title>x</title></head>'
    + '<body><script type="module" src="./src/ocean/WaterMaterial.js"></script></body></html>');
  const html = String(previewFile(room, 'index.html').body);
  assert.match(html, /<script type="importmap">/);
  assert.match(html, /https:\/\/esm\.sh\/three@0\.160\.4/);
  assert.match(html, /agoraPreview/, 'la sonda devuelve los errores al panel');
  assert.ok(html.indexOf('importmap') < html.indexOf('src="./src/ocean/WaterMaterial.js"'),
    'el mapa va antes que el módulo que lo necesita');

  // Si el proyecto trae su propio mapa, el suyo manda: el servidor no le impone su CDN.
  write(room, 'propia.html', '<html><head><script type="importmap">'
    + '{"imports":{"three":"/vendor/three.js"}}</script></head><body></body></html>');
  const own = String(previewFile(room, 'propia.html').body);
  assert.match(own, /\/vendor\/three\.js/);
  assert.equal(own.includes('esm.sh'), false, 'el mapa del proyecto manda sobre el del servidor');
});

// La página de prueba: el proyecto cargándose de verdad en el navegador, módulo a módulo y con su
// informe de vuelta al panel, en vez de una lista de nombres o una pantalla en blanco.
test('sin página propia se sirve una página de prueba que carga los módulos de verdad', async () => {
  const room = await scaffoldRoom();
  write(room, 'lib/olas.mjs', 'export const ola = 1;\n');
  write(room, 'lib/arena.js', 'export const arena = 1;\n');

  const info = previewEntry(room, { fresh: true });
  assert.deepEqual([...info.modules].sort(), ['lib/arena.js', 'lib/olas.mjs']);

  const page = previewFile(room, '__agora__.html');
  assert.equal(page.status, 200);
  assert.equal(page.mime, 'text/html; charset=utf-8', 'una página tiene que servirse como HTML');
  const html = String(page.body);
  assert.match(html, /import\('\.\/' \+ rel\)/, 'la página importa los módulos de verdad');
  assert.match(html, /"lib\/olas\.mjs"/);
  assert.match(html, /agoraPreview/, 'y devuelve el informe al panel');

  // El nombre de la página de prueba es del servidor: un proyecto no puede taparlo desde fuera.
  assert.equal(previewFile(room, 'src/__agora__.html').status, 404, 'el nombre reservado no es un archivo del proyecto');
  assert.equal(previewFile(room, 'secreto/../__agora__').status, 404);
});

test('la página elegida se conserva mientras exista', async () => {
  const room = await scaffoldRoom();
  write(room, 'index.html', '<h1>uno</h1>');
  write(room, 'otra.html', '<h1>dos</h1>');
  const info = previewEntry(room, { fresh: true });
  assert.ok(info.pages.includes('index.html') && info.pages.includes('otra.html'));
});
