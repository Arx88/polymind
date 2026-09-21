// Deja un navegador headless disponible para la evidencia visual, en un host que no use la imagen
// de `Dockerfile` (una máquina propia, un PaaS sin contenedor, un servidor de CI).
//
// No inventa nada: primero pregunta si ya hay uno (el motor busca en el PATH, en los cachés de
// puppeteer/playwright y en la carpeta local `.browsers`), y solo si no hay intenta instalarlo.
// Dos vías, en este orden:
//   1. `apt-get install chromium` cuando se puede (Linux, con root y apt): trae el navegador Y sus
//      bibliotecas, que es lo que suele faltar cuando el binario existe y no arranca;
//   2. la descarga de Chrome for Testing a `.browsers/` con el CLI de `@puppeteer/browsers` (sin
//      añadir dependencias a package.json: se usa `npx`), que es lo que funciona en un contenedor
//      ajeno sin permisos.
// Si nada de eso es posible, lo dice con el comando exacto en vez de fingir que todo está listo.
//
// Uso:
//   node scripts/ensure-chromium.mjs            # busca e instala si hace falta
//   node scripts/ensure-chromium.mjs --check    # solo informa (sale con 1 si no hay navegador)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const method = process.env.AGORA_CHROMIUM_METHOD || '';
const engine = await import(new URL('../server/engine/visual.mjs', import.meta.url).href);

function say(ok, message, extra = []) {
  console.log(`${ok ? '✔' : '·'} ${message}`);
  for (const line of extra) console.log(`  ${line}`);
}

// Ya hay uno: no se toca nada.
const existing = engine.chromePath();
if (existing) {
  say(true, `ya hay un navegador: ${existing}`, [`Para fijarlo en el arranque: AGORA_CHROME=${existing}`]);
  process.exit(0);
}

say(false, 'no hay navegador headless en este host: la evidencia visual quedaría «no comprobada».');
if (checkOnly) {
  console.log('  (--check: no instalo nada)');
  process.exit(1);
}

const has = cmd => {
  try { return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
};
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const linux = process.platform === 'linux';

// ---------------------------------------------------------------- 1. apt (Debian/Ubuntu)
if ((method === '' || method === 'apt') && linux && isRoot && has('apt-get')) {
  console.log('· instalando chromium con apt-get (trae también sus bibliotecas)…');
  spawnSync('apt-get', ['update', '-qq'], { stdio: 'inherit' });
  const install = spawnSync('apt-get', ['install', '-y', '--no-install-recommends', 'chromium'], { stdio: 'inherit' });
  if (install.status === 0) {
    delete process.env.AGORA_CHROME;
    const found = engine.chromePath();
    if (found) {
      say(true, `navegador instalado: ${found}`);
      process.exit(0);
    }
    console.log('· apt terminó sin error pero el motor no lo encuentra; sigo con la descarga.');
  } else {
    console.log('· apt no pudo instalarlo; sigo con la descarga.');
  }
} else if (method === '' && linux && !isRoot) {
  console.log('· sin root no puedo usar apt-get (esa vía sería: apt-get install -y chromium).');
}

// ---------------------------------------------------------------- 2. descarga de Chrome for Testing
if (method === '' || method === 'download') {
  const target = path.join(ROOT, '.browsers');
  console.log(`· descargando Chrome for Testing en ${path.relative(ROOT, target)}…`);
  fs.mkdirSync(target, { recursive: true });
  const dl = spawnSync('npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome@stable', `--path=${target}`], {
    stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32',
  });
  const found = dl.status === 0 ? engine.chromePath() : null;   // el motor mira `.browsers` por su cuenta
  if (found) {
    say(true, `navegador listo: ${found}`, [
      'El motor lo encuentra solo (carpeta .browsers).',
      'Ojo: en un sistema sin las bibliotecas de Chromium puede faltar algún .so — la imagen de Dockerfile ya las trae.',
    ]);
    process.exit(0);
  }
  console.log(dl.status === 0
    ? '· la descarga terminó pero el motor no encontró el binario; revisá el contenido de .browsers.'
    : '· la descarga falló (¿sin red o sin npm?).');
}

// ---------------------------------------------------------------- nada funcionó
say(false, 'no pude dejar un navegador en este host', [
  'Opciones, en orden de comodidad:',
  '  1) desplegar con la imagen incluida:  docker build -t polymind . && docker run -p 10000:10000 polymind',
  '  2) Debian/Ubuntu:                     apt-get install -y chromium   (y AGORA_CHROME=/usr/bin/chromium)',
  '  3) macOS:                             brew install --cask chromium',
  '  4) Windows:                           instalar Chrome o Edge (el motor los busca en Archivos de programa)',
  'Sin navegador la sala sigue funcionando: la evidencia visual se publica como no comprobada, nunca como aprobada.',
]);
process.exit(1);
