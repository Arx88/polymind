// Polymind — registro operativo.
//
// Por qué existe: cuando una sala «no avanza», el servidor no dejaba rastro. Ni de qué
// agentes pidieron turno, ni de qué se les entregó, ni de qué llegó y falló. Y en un host
// gestionado (Render) el disco es efímero: escribir un archivo dentro del proyecto no sirve,
// porque se borra al dormirse o redesplegar. Por eso el destino principal es **stdout** en
// líneas JSON: eso lo captura el host, sobrevive a los reinicios y se lee después.
//
// Tres destinos, ninguno obligatorio y ninguno crítico:
//   1) stdout, una línea JSON por evento  → el registro durable (Render, systemd, docker…)
//   2) un anillo en memoria (últimos N)   → GET /api/logs lo sirve al instante, sin disco
//   3) un archivo opcional (AGORA_LOG_FILE) → para trabajar en local con `tail -f`
//
// Reglas de convivencia:
//   - Nunca lanza: un fallo del registro jamás puede tumbar el debate.
//   - Nunca escribe secretos: los campos con pinta de token se tachan, también dentro de URLs.
//   - Nunca bloquea: escrituras síncronas y cortas a stdout, sin esperas ni buffers grandes.

import fs from 'node:fs';
import path from 'node:path';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const MAX_STRING = 400;      // una línea de log no es el sitio para un plan entero
const MAX_ARRAY = 12;
const MAX_DEPTH = 4;
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|apikey|api_key/i;
const SECRET_QS = /([?&](?:token|admin|adminToken|access_token)=)[^&\s]*/gi;

export function levelValue(name) {
  const v = LEVELS[String(name || '').toLowerCase()];
  return Number.isFinite(v) ? v : LEVELS.info;
}

// ---------------------------------------------------------------- redacción
// Un token que acaba en un log acaba en el historial del host, en el buffer del panel y en
// cualquier captura de pantalla. Aquí se tacha antes de que salga, no después.
function mask(value) {
  const s = String(value);
  return s.length <= 4 ? '***' : `***${s.slice(-4)}`;
}

export function redact(value, depth = 0, seen = new WeakSet()) {
  try {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'bigint') return Number(value);
    if (t === 'string') {
      const cut = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING})` : value;
      return cut.replace(SECRET_QS, '$1***');
    }
    if (t === 'function') return '[función]';
    if (t === 'symbol') return String(value);
    if (value instanceof Error) {
      return { message: redact(value.message), code: value.code ?? null, name: value.name };
    }
    if (depth >= MAX_DEPTH) return '[profundo]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ARRAY).map(v => redact(v, depth + 1, seen));
      if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY})`);
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (SECRET_KEY.test(k)) { out[k] = mask(v); continue; }
      out[k] = redact(v, depth + 1, seen);
    }
    return out;
  } catch {
    return '[ilegible]';
  }
}

// ---------------------------------------------------------------- logger
export function createLogger(opts = {}) {
  const threshold = levelValue(opts.level ?? process.env.AGORA_LOG_LEVEL ?? 'info');
  const capacity = Math.max(10, Number(opts.memory ?? process.env.AGORA_LOG_MEMORY ?? 400) || 400);
  const buffer = [];
  let dropped = 0;
  let written = 0;

  const stdout = opts.stdout ?? process.stdout;
  const emitLine = (line) => {
    try { stdout.write(line); } catch { /* stdout cerrado: nada que hacer */ }
  };

  // Archivo opcional (AGORA_LOG_FILE): para trabajar en local con `tail -f`, y para un servicio
  // que sí tenga disco persistente. Se escribe con `appendFileSync` a propósito: una línea
  // escrita es una línea que sobrevive a un cierre brusco, y no hay cola que se pierda al
  // matar el proceso. Si el archivo falla, se sigue sin él (stdout nunca falla).
  let filePath = null;
  if (opts.file ?? process.env.AGORA_LOG_FILE) {
    try {
      filePath = path.resolve(String(opts.file ?? process.env.AGORA_LOG_FILE));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, '', 'utf8');
    } catch { filePath = null; }
  }
  let fileFailed = false;

  function record(levelName, ev, fields = {}, bindings = null) {
    if (LEVELS[levelName] < threshold) return null;
    const event = {
      ts: new Date().toISOString(),
      level: levelName,
      ev: String(ev),
      ...(bindings ? redact(bindings) : null),
      ...(fields ? redact(fields) : null),
    };
    let line;
    try { line = `${JSON.stringify(event)}\n`; } catch { return null; }
    written += 1;
    buffer.push(event);
    if (buffer.length > capacity) { buffer.splice(0, buffer.length - capacity); dropped += 1; }
    emitLine(line);
    if (filePath && !fileFailed) {
      try { fs.appendFileSync(filePath, line, 'utf8'); }
      catch { fileFailed = true; /* disco lleno o solo lectura: el debate sigue */ }
    }
    return event;
  }

  function child(bindings) {
    return {
      debug: (ev, fields) => record('debug', ev, fields, bindings),
      info: (ev, fields) => record('info', ev, fields, bindings),
      warn: (ev, fields) => record('warn', ev, fields, bindings),
      error: (ev, fields) => record('error', ev, fields, bindings),
      child: more => child({ ...bindings, ...more }),
    };
  }

  return {
    level: Object.keys(LEVELS).find(k => LEVELS[k] === threshold) || 'info',
    enabled: levelName => LEVELS[levelName] >= threshold,
    debug: (ev, fields) => record('debug', ev, fields),
    info: (ev, fields) => record('info', ev, fields),
    warn: (ev, fields) => record('warn', ev, fields),
    error: (ev, fields) => record('error', ev, fields),
    child,
    // Lectura para /api/logs: del más reciente al más viejo, filtrable y acotada.
    recent({ limit = 200, level = null, room = null, ev: prefix = null } = {}) {
      const min = level ? levelValue(level) : 0;
      let out = buffer;
      if (min) out = out.filter(e => LEVELS[e.level] >= min);
      if (room) out = out.filter(e => e.room === room);
      if (prefix) out = out.filter(e => String(e.ev).startsWith(prefix));
      return out.slice(-Math.max(1, Math.min(2000, Number(limit) || 200))).reverse();
    },
    stats() {
      return { level: this.level, buffered: buffer.length, capacity, written, dropped, file: filePath || null };
    },
    close() { /* no hay nada que cerrar: cada línea se escribió al vuelo */ },
  };
}

// Un único registro para todo el proceso.
export const log = createLogger();

// ---------------------------------------------------------------- puente de console
// El motor y sus módulos ya avisan por `console.warn`/`console.error` (una copia atrasada en
// disco, una persistencia que falla…). Esas líneas también son parte del registro: se copian al
// JSONL conservando la salida original. Se escribe por `stdout.write` para no recursar.
export function bridgeConsole(logger = log) {
  if (bridgeConsole.__done) return;
  bridgeConsole.__done = true;
  const pairs = [['warn', 'console.warn'], ['error', 'console.error']];
  for (const [level, label] of pairs) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        logger[level]('console', {
          text: args.map(a => (typeof a === 'string' ? a : (a instanceof Error ? a.message : String(a)))).join(' '),
        });
      } catch { /* el registro nunca interrumpe */ }
      try { original(...args); } catch { /* stdout roto */ }
    };
    void label;
  }
}

// ---------------------------------------------------------------- campos estándar
// Qué se apunta del proceso: en un host gestionado esto es lo que permite saber, al leer el
// registro, si el contenedor es nuevo (y por tanto si el estado en disco se perdió) y con qué
// versión del código arrancó.
export function runtimeInfo() {
  const env = process.env;
  const info = {
    node: process.version,
    pid: process.pid,
    platform: process.platform,
  };
  if (env.RENDER) {
    info.host = 'render';
    info.serviceId = env.RENDER_SERVICE_ID || null;
    info.instanceId = env.RENDER_INSTANCE_ID || null;
    info.commit = env.RENDER_GIT_COMMIT ? env.RENDER_GIT_COMMIT.slice(0, 8) : null;
    info.branch = env.RENDER_GIT_BRANCH || null;
    info.region = env.RENDER_REGION || null;
  }
  return info;
}
