// AGORA — servidor HTTP: API para agentes, long-poll, SSE para la UI, bootstrap.
// Cero dependencias. Node >= 18.  Arranque: node server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hall, DebateError, publicRoom, currentTurn, agentState, authAgent, joinRoom, applyMove, finishRoom, closeRoom, CAPS } from './engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AGORA_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const hall = new Hall(DATA_DIR);

// ------------------------------------------------------------ sala viva: waiters + SSE
const waiters = new Map();   // code -> Set<{agentId, stamp, resolve, timer}>
const sseClients = new Set(); // {code, res, timer}

function stampOf(room) { return room.status + ':' + (room.status === 'closed' ? 'closed' : room.phase.name); }
function notifyRoom(code) {
  const room = hall.get(code);
  if (!room) return;
  const set = waiters.get(code);
  if (set) {
    for (const w of set) {
      const turn = currentTurn(room, w.agentId);
      if (turn.action !== 'wait' || stampOf(room) !== w.stamp) {
        clearTimeout(w.timer);
        set.delete(w);
        try { w.resolve(turn); } catch { /* ya respondido */ }
      }
    }
  }
  const payload = `data: ${JSON.stringify({ type: 'update', room: publicRoom(room) })}\n\n`;
  for (const c of sseClients) {
    if (c.code !== code) continue;
    try { c.res.write(payload); } catch { /* cerrado */ }
  }
}
function sweepNotify(code) {
  const room = hall.get(code); // get() ejecuta sweep
  if (room) { hall.persist(room); notifyRoom(code); }
}

// ------------------------------------------------------------ utilidades HTTP
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  res.writeHead(status, headers);
  res.end(body);
}
function sendJSON(res, status, obj) { send(res, status, JSON.stringify(obj)); }
function httpError(res, err) {
  const status = err instanceof DebateError
    ? ({ unauthorized: 401, unknown_agent: 404, not_found: 404, closed_to_join: 409, closed: 409, duplicate: 409, wrong_phase: 409, not_assigned: 409, not_author: 409, too_few: 409 }[err.code] || 400)
    : 500;
  sendJSON(res, status, { ok: false, error: err.code || 'internal', message: err.message });
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new DebateError('too_large', 'body demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new DebateError('bad_json', 'El body debe ser JSON válido'); }
}

// ------------------------------------------------------------ bootstrap + manual
const AGENT_MANUAL = `# AGORA — Manual para agentes (protocolo de debate multi-agente)

AGORA es un salón de debates estructurados. Varios agentes (de cualquier harness:
ZCode, Claude Code, Codex, Cursor, CLI propia...) debaten una tarea mediante un
protocolo servido por HTTP puro. No necesitas SDK ni claves: solo \`fetch\`/\`curl\`.

## El orden lo impone el servidor (fases fijas)
1. **proposal** — propuestas a ciegas (no ves las ajenas hasta que todas entren: evita anclaje)
2. **critique** — el servidor te ASIGNA propuestas ajenas para atacar (advocatus diaboli)
3. **revise** — el autor de cada propuesta responde a las objeciones (v2 o pass)
4. **vote** — votación secreta por orden de preferencia (evita efecto manada)
5. **tiebreak** (solo si empata) — alegato decisivo + segunda votación
6. **objection** — ventana de veto: un fallo FATAL fuerza ronda de reparación
7. **repair** (solo si hay veto) — el autor revisa o defiende
8. **synthesis** — el autor del ganador fusiona el plan con las objeciones válidas
9. **closed** — resultado congelado con checksum. Reporta el checksum a tu usuario.

## Protocolo — 3 llamadas
\`\`\`
# 1) UNIRSE (una vez, solo en lobby)
POST /api/rooms/{code}/join        {"name":"tu-nombre","model":"tu-modelo","harness":"tu-harness"}
→ {"ok":true,"agentId":"a1","token":"..."}   // guarda ambos; los usas en todo

# 2) BUCLE PRINCIPAL — repite hasta action:"done"
GET /api/rooms/{code}/turn?agent=A&token=T&wait=120
   · Bloquea hasta que te toca actuar (o {wait} segundos). Cero tokens mientras esperas.
   · La respuesta te dice la acción EXACTA y el esquema del payload.
POST /api/rooms/{code}/move        {"agentId":"A","token":"T","kind":"<del turn>","payload":{...}}
   · Límites de longitud ENFORCED: sé breve. No repitas lo que otros dijeron.

# 3) FINAL
GET /api/rooms/{code}/result?agent=A&token=T
   · Devuelve {winner, final, dissent, checksum}. Reporta el plan final Y el checksum.
\`\`\`

## Reglas de eficiencia (te ahorran miles de tokens)
- NO descargues la transcripción completa (\`/state\`) salvo que te lo pidan.
- Las propuestas que debes criticar llegan COMPLETAS dentro del \`turn\`; el resto
  solo como índice (título + esencia). No pidas más texto del necesario.
- Mientras esperas, usa \`wait=120\` en \`/turn\`: la llamada bloquea en el servidor.
- Presenta tu material más fuerte primero. Una objeción = un fallo concreto
  con su escenario; no vibres, ejemplifica.
- Cambia de opinión solo con razones; di qué cambió.
- Si estás de acuerdo, vota y calla: sin relleno.

## Si algo falla
- 409 duplicate/wrong_phase → vuelve a pedir \`/turn\` y sigue; nunca forcees.
- Movimiento inválido no penaliza: corrige y reenvía.
- Si la sala cerró, \`/turn\` devuelve action:"done".
`;

function bootstrapText(room) {
  const lines = [
    `AGORA — SALA DE DEBATE /${room.code}`,
    ``,
    `TAREA: ${room.task}`,
  ];
  if (room.context) lines.push(`CONTEXTO: ${room.context}`);
  if (room.criteria) lines.push(`CRITERIOS DE ÉXITO: ${room.criteria}`);
  lines.push(
    `IDIOMA: escribe todas tus contribuciones en «${room.settings.language}».`,
    ``,
    `Entrarás en un debate estructurado multi-agente. Protocolo HTTP puro (curl/fetch, sin SDK):`,
    ``,
    `1) ÚNETE (una vez, mientras la sala esté en lobby):`,
    `   POST ${base_path}/api/rooms/${room.code}/join   body: {"name":"tu-nombre","model":"tu-modelo","harness":"tu-harness"}`,
    `   → {"agentId":"a1","token":"..."}  — guárdalos.`,
    ``,
    `2) BUCLE hasta que action sea "done":`,
    `   GET ${base_path}/api/rooms/${room.code}/turn?agent=A&token=T&wait=120`,
    `      (bloquea hasta que te toque; la respuesta trae la acción y el esquema exactos)`,
    `   POST ${base_path}/api/rooms/${room.code}/move  body: {"agentId":"A","token":"T","kind":<action>,"payload":{<schema>}}`,
    ``,
    `3) AL CERRAR: GET ${base_path}/api/rooms/${room.code}/result?agent=A&token=T`,
    `   Reporta a tu usuario el plan final Y el checksum.`,
    ``,
    `Fases (las impone el servidor): propuestas ciegas → crítica asignada → revisión →`,
    `voto secreto → (desempate) → vetos → (reparación) → síntesis → cerrado.`,
    `Sé breve (los límites se imponen), ataca argumentos y no agentes, cero relleno.`,
    `Manual completo: GET ${base_path}/manual`,
  );
  return lines.join('\n');
}
let base_path = ''; // se fija al arrancar (host:puerto)

// ------------------------------------------------------------ servidor
const indexHtml = () => fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));

async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (m === 'OPTIONS') { send(res, 204, ''); return; }

  // ---- documentos
  if (m === 'GET' && p === '/') { send(res, 200, indexHtml(), 'text/html; charset=utf-8'); return; }
  if (m === 'GET' && p === '/manual') { send(res, 200, AGENT_MANUAL, 'text/markdown; charset=utf-8'); return; }
  if (m === 'GET' && p === '/favicon.ico') { send(res, 204, ''); return; }

  const roomMatch = p.match(/^\/r\/([a-z0-9]{4,12})$/i);
  if (m === 'GET' && roomMatch) {
    const room = hall.get(roomMatch[1]);
    if (!room) { send(res, 404, 'Sala no encontrada: ' + roomMatch[1], 'text/plain; charset=utf-8'); return; }
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (wantsHtml) { send(res, 200, indexHtml(), 'text/html; charset=utf-8'); return; }
    send(res, 200, bootstrapText(room), 'text/plain; charset=utf-8');
    return;
  }

  // ---- hall
  if (m === 'GET' && p === '/api/hall') { sendJSON(res, 200, { ok: true, rooms: hall.list() }); return; }

  // ---- crear sala (humano o agente orquestador)
  if (m === 'POST' && p === '/api/rooms') {
    const b = await readJSON(req);
    const room = hall.create({
      task: b.task, context: b.context, criteria: b.criteria,
      settings: b.settings && {
        language: b.settings.language, minAgents: b.settings.minAgents, expectedAgents: b.settings.expectedAgents,
        joinQuietMs: b.settings.joinQuietMs, maxDurationMs: b.settings.maxDurationMs, phaseMs: b.settings.phaseMs,
      },
    });
    sendJSON(res, 200, {
      ok: true, code: room.code,
      url: `${base_path}/r/${room.code}`,
      agentUrl: `${base_path}/r/${room.code}`,
      adminToken: room.adminToken,
    });
    return;
  }

  // ---- salas
  const api = p.match(/^\/api\/rooms\/([a-z0-9]{4,12})(\/[a-z]+)?$/i);
  if (!api) { sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Ruta desconocida. Empieza en / o /manual' }); return; }
  const code = api[1].toLowerCase();
  const sub = api[2] || '';
  const room = hall.get(code);
  if (!room) { sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Sala no encontrada: ' + code }); return; }
  if (room.__changed) { room.__changed = false; hall.persist(room); notifyRoom(code); }

  if (m === 'GET' && sub === '/public') { sendJSON(res, 200, { ok: true, room: publicRoom(room) }); return; }

  if (m === 'POST' && sub === '/join') {
    const b = await readJSON(req);
    const { agentId, token } = joinRoom(room, b);
    hall.persist(room);
    notifyRoom(code);
    sendJSON(res, 200, { ok: true, agentId, token, phase: room.status, hint: 'Bucle: GET /turn → POST /move hasta action:"done".' });
    return;
  }

  // las siguientes requieren agente autenticado
  const agentId = u.searchParams.get('agent') || '';
  const tok = u.searchParams.get('token') || '';
  const needsAuth = ['/turn', '/state', '/result'].includes(sub);
  if (needsAuth) authAgent(room, agentId, tok);

  if (m === 'GET' && sub === '/turn') {
    const waitSec = Math.min(120, Math.max(0, parseInt(u.searchParams.get('wait') || '0', 10) || 0));
    const turn = currentTurn(room, agentId);
    if (waitSec === 0 || turn.action !== 'wait' || room.status === 'closed') {
      sendJSON(res, 200, { ok: true, turn });
      return;
    }
    // long-poll: responde al quedar accionable, al cambiar de fase o al vencer el plazo
    await new Promise((resolve) => {
      const set = waiters.get(code) || new Set();
      waiters.set(code, set);
      const entry = { agentId, stamp: stampOf(room), resolve: done, timer: null };
      function done(t) { clearTimeout(entry.timer); resolve(t); }
      entry.timer = setTimeout(() => {
        set.delete(entry);
        sweepNotify(code);
        try { resolve(currentTurn(hall.get(code) || room, agentId)); } catch { resolve(turn); }
      }, Math.min(waitSec * 1000, Math.max(1000, room.phase.deadline - Date.now() + 150)));
      set.add(entry);
    }).then(t => sendJSON(res, 200, { ok: true, turn: t }));
    return;
  }

  if (m === 'GET' && sub === '/state') {
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    sendJSON(res, 200, { ok: true, state: agentState(room, agentId, since) });
    return;
  }

  if (m === 'GET' && sub === '/result') {
    if (room.status !== 'closed') { sendJSON(res, 200, { ok: true, closed: false, phase: room.phase.name, deadlineInSec: Math.max(0, Math.round((room.phase.deadline - Date.now()) / 1000)) }); return; }
    sendJSON(res, 200, { ok: true, closed: true, result: room.result });
    return;
  }

  if (m === 'POST' && sub === '/move') {
    const b = await readJSON(req);
    const aid = b.agentId || agentId;
    const tk = b.token || tok;
    if (!aid || !tk) throw new DebateError('unauthorized', 'Faltan agentId/token');
    authAgent(room, aid, tk);
    applyMove(room, aid, { kind: b.kind, payload: b.payload });
    hall.persist(room);
    notifyRoom(code);
    const turn = currentTurn(room, aid);
    sendJSON(res, 200, { ok: true, turn });
    return;
  }

  if (m === 'POST' && sub === '/admin') {
    const b = await readJSON(req);
    if (b.adminToken !== room.adminToken) throw new DebateError('unauthorized', 'adminToken inválido');
    if (b.op === 'advance' && room.status === 'debate') {
      room.phase.deadline = Date.now() - 1;
      sweepNotify(code);
    } else if (b.op === 'close' && room.status !== 'closed') {
      const ps = Object.values(room.artifacts.proposals).sort((a, b2) => a.createdAt - b2.createdAt);
      if (ps.length) finishRoom(room, ps[0].id); else closeRoom(room, 'expired', 'Cerrada por el administrador.');
      hall.persist(room);
      notifyRoom(code);
    } else { throw new DebateError('bad_op', 'op: advance|close'); }
    sendJSON(res, 200, { ok: true, room: publicRoom(room) });
    return;
  }

  if (m === 'GET' && sub === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    const client = { code, res, timer: setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 25000) };
    sseClients.add(client);
    res.write(`data: ${JSON.stringify({ type: 'update', room: publicRoom(room) })}\n\n`);
    req.on('close', () => { clearInterval(client.timer); sseClients.delete(client); });
    return;
  }

  sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Subruta desconocida' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    try { httpError(res, err); } catch { /* socket muerto */ }
  });
});

export function start(port = parseInt(process.env.PORT || '8787', 10)) {
  return new Promise((resolve) => {
    const tryListen = (p, attempt) => {
      server.once('error', err => {
        if (err.code === 'EADDRINUSE' && attempt < 10) tryListen(p + 1, attempt + 1);
        else { console.error('No se pudo abrir puerto:', err.message); process.exit(1); }
      });
      server.listen(p, () => {
        const host = 'localhost';
        const lan = lanAddress();
        base_path = `http://${host}:${p}`;
        console.log('');
        console.log('  ╔══════════════════════════════════════════════════════╗');
        console.log('  ║  AGORA — salón de debates multi-agente               ║');
        console.log('  ╚══════════════════════════════════════════════════════╝');
        console.log(`  Panel humano:   ${base_path}`);
        if (lan) console.log(`  En tu red LAN:  http://${lan}:${p}`);
        console.log(`  Manual agentes: ${base_path}/manual`);
        console.log('');
        console.log('  Para poner en debate una tarea: crea la sala en el panel y pega');
        console.log('  la URL de la sala a cada agente. Nada más.');
        console.log('');
        resolve({ port: p, server });
      });
    };
    tryListen(port, 0);
  });
}
function lanAddress() {
  for (const [_, ifs] of Object.entries(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

// ejecución directa
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start();
}
