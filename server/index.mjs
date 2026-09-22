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
// El capturador visual necesita la dirección REAL del servidor: el puerto pedido puede estar
// ocupado y el arranque prueba el siguiente, así que una captura contra el puerto equivocado
// retrataría otro proceso (pasa de verdad: sirvió una versión vieja del artefacto y produjo
// números plausibles y falsos).
import { setServerBase } from './engine/index.mjs';
import { log, bridgeConsole, runtimeInfo } from './log.mjs';

// Todo lo que ya avisaba por consola entra también en el registro estructurado.
bridgeConsole(log);

// Un servidor que muere en silencio deja la sala sin avanzar y sin explicación. Aquí se
// registra el motivo antes de caer (y el host lo guarda, aunque el proceso desaparezca).
process.on('uncaughtException', err => {
  log.error('process.uncaught', { message: err?.message, code: err?.code, stack: String(err?.stack || '').split('\n')[1]?.trim() });
  process.exitCode = 1;
});
process.on('unhandledRejection', reason => {
  const err = reason instanceof Error ? reason : null;
  log.error('process.unhandled', { message: err ? err.message : String(reason), code: err?.code });
});

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

// Cuántas salas hay en el directorio de datos AHORA. Al arrancar, esta cifra es la que dice si
// el proceso hereda el trabajo anterior o si el host lo borró (Render: «cualquier cambio en el
// sistema de archivos se pierde cuando el servicio se duerme, reinicia o redespliega»).
export function roomsOnDisk(dir = DATA_DIR) {
  try {
    return fs.readdirSync(dir).filter(f => /^[a-z0-9]{4,12}\.json$/i.test(f)).length;
  } catch { return 0; }
}

export function start(port = parseInt(process.env.PORT || '8787', 10), opts = {}) {
  const releaseDataLock = acquireDataLock(DATA_DIR, port);
  const agora = createAgora({ dataDir: DATA_DIR, ...opts });
  return new Promise((resolve, reject) => {
    // Con el puerto DICHO por el entorno (un contenedor, Render, Fly, un PaaS cualquiera) no se
    // prueba el siguiente: la plataforma enruta a ESE puerto, y escuchar en 8788 «porque 8787
    // estaba ocupado» es un despliegue que arranca y no responde a nada. El rodeo de puertos es
    // para la máquina de uno, donde abrir el 8788 es más útil que morir por un EADDRINUSE.
    const portIsGiven = !!(process.env.PORT || '').trim();
    const tryListen = (p, attempt) => {
      agora.server.once('error', err => {
        if (err.code === 'EADDRINUSE' && !portIsGiven && attempt < 10) tryListen(p + 1, attempt + 1);
        else { releaseDataLock(); reject(err); }
      });
      agora.server.listen(p, () => {
        const lan = lanAddress();
        const base = `http://localhost:${p}`;
        setServerBase(`http://127.0.0.1:${p}`);
        console.log('');
        console.log('  ╔══════════════════════════════════════════════════════════╗');
        console.log('  ║  POLYMIND — colaboración entre harnesses                ║');
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
        // La huella del arranque: si el host durmió, reinició o redesplegó, aquí queda dicho
        // —con instancia y commit— junto a cuántas salas sobrevivieron en disco. Es la línea
        // que permite leer el registro después y saber qué se perdió y cuándo.
        log.info('server.boot', {
          ...runtimeInfo(),
          port: p,
          dataDir: DATA_DIR,
          localUrl: base,
          lanUrl: lan ? `http://${lan}:${p}` : null,
          roomsOnDisk: roomsOnDisk(DATA_DIR),
          roomsInMemory: agora.hall.list().length,
          waitSecMax: Number(process.env.AGORA_MAX_WAIT_SEC || 120),
          memoryRepo: agora.memory?.enabled ? agora.memory.repo : null,
        });
        // La memoria durable se rehidrata en segundo plano: el servidor responde ya (los health
        // checks del host no esperan) y las salas van apareciendo desde el repo a medida que llegan.
        if (agora.memory?.enabled) {
          console.log(`  Memoria:         ${agora.memory.repo} (rehidratando)`);
          agora.memory.hydrate().then(s => {
            if (!s || s.skipped) return;
            console.log(`  Memoria lista:   ${s.rooms} salas repuestas · ${s.workspaces} workspaces · remoto ${s.remote ? 'alcanzado' : 'sin respuesta'}`);
          });
        }
        resolve({
          port: p,
          server: agora.server,
          hall: agora.hall,
          hub: agora.hub,
          tournaments: agora.tournaments,
          memory: agora.memory,
          // Soltar el candado forma parte de parar: si no, la siguiente instancia se encontraría
          // el directorio ocupado por un proceso que ya no existe.
          stop: () => {
            log.info('server.stop', { port: p, uptimeSec: Math.round(process.uptime()), rooms: agora.hall.list().length });
            releaseDataLock();
            return agora.stop();
          },
        });
      });
    };
    tryListen(port, 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().then(app => {
    // Un despliegue o un Ctrl-C piden la parada: antes de morir, la memoria se vacía. Sin esto,
    // el trabajo del último minuto se queda en un disco que el host va a borrar.
    let closing = false;
    const bye = signal => {
      if (closing) return;
      closing = true;
      log.info('server.signal', { signal });
      const limit = setTimeout(() => process.exit(0), 10_000);
      limit.unref?.();
      Promise.resolve(app.stop()).catch(() => null).finally(() => {
        clearTimeout(limit);
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => bye('SIGTERM'));
    process.on('SIGINT', () => bye('SIGINT'));
  }).catch(err => {
    log.error('server.boot_failed', { message: err?.message, code: err?.code, dataDir: DATA_DIR });
    console.error('No se pudo arrancar AGORA:', err.message);
    process.exit(1);
  });
}
