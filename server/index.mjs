// AGORA v2 — punto de entrada del servidor.
//   node server/index.mjs            → panel + API de agentes
//   PORT=8790 node server/index.mjs  → otro puerto
//
// En producción sirve la SPA ya compilada (app/dist). En desarrollo usa Vite
// (npm run dev) con proxy hacia esta API.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgora, lanAddress } from './transports/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.AGORA_DATA || path.join(ROOT, 'data');

// ---------------------------------------------------------------- un solo escritor
// Dos servidores sobre el MISMO directorio de datos no comparten estado: cada uno tiene su copia
// de cada sala en memoria y guarda el archivo entero. El último que guarda borra lo del otro —
// así desapareció un debate ya terminado, que reapareció como «plazo de lobby agotado, 0
// agentes» y un archivo de 2,8 KB donde había 182 KB. El motor ya impide que una copia atrasada
// pise una más avanzada (ver `progressOf` en engine/state.mjs), pero arrancar dos veces sobre la
// misma carpeta sigue siendo un error de configuración: aquí se detecta y se dice qué hacer.
const LOCK_FILE = '.polymind-server.json';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}

// Toma el directorio de datos en exclusiva. Devuelve la función que lo suelta al parar.
function acquireDataLock(dir, port) {
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const release = () => {
    try {
      const held = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (held?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch { /* no había cerradura que soltar */ }
  };
  const claim = extra => {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, startedAt: Date.now(), ...extra }));
    return release;
  };
  // Escape explícito para quien de verdad quiere dos instancias (pruebas de carga, un panel de
  // solo lectura): se avisa pero no se impide. Nunca heredado en silencio.
  if (process.env.AGORA_ALLOW_SHARED_DATA === '1') return claim({ shared: true });
  let held = null;
  try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { held = null; }
  if (held && held.pid !== process.pid && pidAlive(held.pid)) {
    const cuando = held.startedAt ? new Date(held.startedAt).toLocaleString() : 'antes';
    throw Object.assign(
      new Error(
        `El directorio de datos ya lo usa otro servidor (proceso ${held.pid}`
        + `${held.port ? `, puerto ${held.port}` : ''}, desde ${cuando}).\n`
        + `  Dos servidores sobre la misma carpeta se borran las salas entre sí. Cierra el otro,\n`
        + '  arranca con otro directorio (AGORA_DATA=./data-2) o, si sabes lo que haces,\n'
        + '  AGORA_ALLOW_SHARED_DATA=1.',
      ),
      { code: 'data_dir_busy' },
    );
  }
  return claim({});
}

export function start(port = parseInt(process.env.PORT || '8787', 10), opts = {}) {
  const releaseDataLock = acquireDataLock(DATA_DIR, port);
  const agora = createAgora({ dataDir: DATA_DIR, ...opts });
  return new Promise((resolve, reject) => {
    const tryListen = (p, attempt) => {
      agora.server.once('error', err => {
        if (err.code === 'EADDRINUSE' && attempt < 10) tryListen(p + 1, attempt + 1);
        else { releaseDataLock(); reject(err); }
      });
      agora.server.listen(p, () => {
        const lan = lanAddress();
        const base = `http://localhost:${p}`;
        console.log('');
        console.log('  ╔══════════════════════════════════════════════════════════╗');
        console.log('  ║  AGORA — salón de debates multi-agente                   ║');
        console.log('  ╚══════════════════════════════════════════════════════════╝');
        console.log(`  Panel humano:    ${base}`);
        if (lan) console.log(`  En tu red LAN:   http://${lan}:${p}`);
        console.log(`  Manual agentes:  ${base}/manual`);
        console.log('');
        console.log('  Entrada de agentes (tres carriles):');
        console.log(`   1) MCP      node server/transports/mcp.mjs --room CODE --name "Analista-1" --url ${base}`);
        console.log(`   2) HTTP     pega ${base}/r/CODE en el agente (devuelve su bootstrap)`);
        console.log(`   3) Runner   node server/runner/index.mjs --room CODE --roster roster.json --url ${base}`);
        console.log('');
        resolve({
          port: p,
          server: agora.server,
          hall: agora.hall,
          hub: agora.hub,
          tournaments: agora.tournaments,
          // Soltar el candado forma parte de parar: si no, la siguiente instancia se encontraría
          // el directorio ocupado por un proceso que ya no existe.
          stop: () => { releaseDataLock(); return agora.stop(); },
        });
      });
    };
    tryListen(port, 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().catch(err => {
    console.error('No se pudo arrancar AGORA:', err.message);
    process.exit(1);
  });
}
