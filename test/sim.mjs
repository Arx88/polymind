// AGORA v2 — simulación de extremo a extremo.
// Agentes falsos ejecutan el protocolo REAL por HTTP contra el servidor real.
// Cubre: debate completo, indulgencia, ausencias con reemplazo, long-poll,
// bootstrap/manual/export, MCP por stdio y el runner local conduciendo CLIs.
//
//   node test/sim.mjs        (o: node --test test/sim.mjs)

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data-sim');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.AGORA_DATA = DATA;

// Las plantillas también en copia de trabajo: «guardar esta sala como plantilla» escribe un
// archivo, y esa escritura no debe caer en la carpeta del repositorio al correr las pruebas.
const TEMPLATES = path.join(DATA, 'templates');
fs.cpSync(path.join(ROOT, 'templates'), TEMPLATES, { recursive: true });
process.env.AGORA_TEMPLATES = TEMPLATES;

const { start } = await import('../server/index.mjs');

const SHORT = {
  phaseMs: { lobby: 90_000, frame: 90_000, proposal: 90_000, critique: 90_000, revise: 90_000, vote: 90_000, tiebreak: 90_000, objection: 90_000, repair: 90_000, synthesis: 90_000, verify: 90_000 },
  maxDurationMs: 300_000,
  joinQuietMs: 60_000,
};

let srv, base;
before(async () => {
  srv = await start(8891);
  base = `http://localhost:${srv.port}`;
});
after(async () => {
  await new Promise(resolve => srv.server.close(resolve));
});

async function j(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function createRoom(input) {
  const r = await post(`${base}/api/rooms`, { task: 'Tarea de prueba suficientemente larga para el protocolo.', settings: SHORT, ...input });
  assert.equal(r.body.ok, true, 'crear sala: ' + JSON.stringify(r.body));
  return r.body;
}

function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

test('heartbeat keeps transport presence without model turns or fake progress', async () => {
  const room = await createRoom({settings: {...SHORT, planOnly: true, minAgents: 3, expectedAgents: 3}});
  const joined = (await post(`${base}/api/rooms/${room.code}/join`, {name:'Heartbeat test'})).body;
  const read = async () => (await j(`${base}/api/rooms/${room.code}/public`)).body.room;
  const before = await read();
  const beat = await post(`${base}/api/rooms/${room.code}/heartbeat`, {agentId:joined.agentId, token:joined.token});
  assert.equal(beat.status, 200); assert.equal(beat.body.turn, undefined);
  const after = await read();
  assert.equal(after.phase, before.phase); assert.equal(after.log.length, before.log.length);
  assert.equal(after.roster[0].tokens, before.roster[0].tokens);
  assert.ok(after.roster[0].lastSeenAt >= before.roster[0].lastSeenAt);
  const bad = await post(`${base}/api/rooms/${room.code}/heartbeat`, {agentId:joined.agentId, token:'invalid'});
  assert.equal(bad.status, 401);
});

// El registro es la memoria del servidor. Sin él, «la sala no avanzó» solo se puede contar de
// memoria; con él, se lee quién entró, quién pidió turno y qué contestó el servidor.
test('el registro cuenta el alta, la entrada y las peticiones — y no publica tokens', async () => {
  const room = await createRoom({ settings: { ...SHORT, planOnly: true, minAgents: 2, expectedAgents: 2 } });
  const joined = (await post(`${base}/api/rooms/${room.code}/join`, { name: 'Bitácora', harness: 'log-test', model: 'modelo-x' })).body;
  await j(`${base}/api/rooms/${room.code}/turn?agent=${joined.agentId}&token=${joined.token}&wait=1`);

  const logs = await j(`${base}/api/logs?room=${room.code}&limit=60`);
  assert.equal(logs.body.ok, true);
  const evs = logs.body.events.map(e => e.ev);
  assert.ok(evs.includes('room.create'), 'el alta debe quedar registrada: ' + evs.join(','));
  assert.ok(evs.includes('agent.join'), 'la entrada de un agente debe quedar registrada');
  assert.ok(evs.includes('http.req'), 'cada petición debe quedar registrada');
  assert.ok(logs.body.events.some(e => e.ev === 'http.req' && e.agent === joined.agentId && typeof e.ms === 'number'),
    'la petición del agente debe llevar su identificador y su duración');

  const joinEv = logs.body.events.find(e => e.ev === 'agent.join');
  assert.equal(joinEv.harness, 'log-test', 'el registro tiene que decir con qué harness entró');
  assert.equal(joinEv.name, 'Bitácora');

  const raw = JSON.stringify(logs.body);
  assert.equal(raw.includes(joined.token), false, 'el token del agente no puede salir en el registro');
  assert.equal(raw.includes(room.adminToken), false, 'el token de administración tampoco');
});

// Cuando la sala se perdió (el host durmió, se redesplegó o alguien la cerró), el harness sigue
// llamando a una puerta que ya no existe. Eso tiene que verse en el registro, con su 404.
test('una sala que ya no existe deja rastro en el registro', async () => {
  const gone = await j(`${base}/api/rooms/zzzzzz/public`);
  assert.equal(gone.status, 404);
  const logs = await j(`${base}/api/logs?level=warn&limit=40`);
  const hit = logs.body.events.find(e => e.path === '/api/rooms/zzzzzz/public');
  assert.ok(hit, 'la petición a una sala inexistente debe aparecer en el registro');
  assert.equal(hit.status, 404);
  assert.equal(hit.level, 'warn');
});

// Decide un movimiento a partir del turno real (equivalente a lo que haría un agente).
function decide(turn, behavior, name) {
  const seed = hash(name);
  switch (turn.action) {
    case 'start-or-wait':
      return behavior.mayStart === false ? null : { kind: 'start' };
    case 'frame-contribute':
      return behavior.frameMove === undefined ? { kind: 'pass' } : behavior.frameMove;
    case 'contrast-agenda':
      // El contraste es la vuelta corta e informada del encuadre: por defecto nadie toca los
      // ejes, y cada test decide si añade uno o impugna el que sobra.
      return behavior.contrastMove === undefined ? { kind: 'pass' } : behavior.contrastMove(turn);
    case 'submit-proposal': {
      const positions = [];
      for (const point of turn.agenda || []) {
        const options = point.options || [];
        if (!options.length) continue;
        positions.push({ pointId: point.id, choiceId: options[(seed + behavior.bias) % options.length].id });
      }
      return {
        kind: 'proposal',
        payload: {
          title: `Plan ${name}`,
          approach: `${name}-enfoque`,
          plan: `1. ${name} propone una secuencia concreta con hitos semanales.\n2. Medir antes de escalar; nada se añade sin métrica.\n3. Plan de reversión explícito.`,
          premortem: 'Falló porque nadie midió el coste real del primer mes.',
          positions,
          risks: 'dependencia de una métrica',
        },
      };
    }
    case 'submit-critique': {
      const target = (turn.targets || [])[0];
      if (!target) return null;
      return {
        kind: 'critique',
        payload: {
          target: target.id,
          steelman: `Lo mejor de «${target.title}» es que arranca esta semana.`,
          objections: behavior.critique
            ? behavior.critique(target)
            : [
              { type: 'cost', severity: 'high', text: `(${name}) El plan no cuantifica el coste del primer mes; escenario: se duplica en dos semanas.` },
              { type: 'missing-info', severity: 'med', text: `(${name}) No define el indicador que decide continuar o revertir.` },
            ],
        },
      };
    }
    case 'submit-revision-or-pass':
      if (behavior.concede) return { kind: 'concede', payload: { reason: 'Otra propuesta cubre mejor el problema.', ...(behavior.endorse ? { endorse: behavior.endorse } : {}) } };
      if (behavior.revises === false) return { kind: 'pass' };
      // Revisión a medida: sirve para probar la convergencia con y sin evidencia declarada.
      if (behavior.revision) return { kind: 'revision', payload: behavior.revision(turn) };
      return {
        kind: 'revision',
        payload: {
          proposalId: turn.proposalId,
          plan: `1. Versión revisada que aborda el coste señalado.\n2. Añade umbral de reversión y medición semanal.\n3. Reduce el alcance del primer mes.`,
          note: 'Incorporé el umbral y recorté coste.',
        },
      };
    case 'submit-vote': {
      const ids = (turn.options || []).map(o => o.id);
      if (behavior.bottom) return { kind: 'vote', payload: { ranking: [...ids].reverse() } };
      if (behavior.partial) return { kind: 'vote', payload: { ranking: ids.slice(0, 1) } };
      return { kind: 'vote', payload: { ranking: ids } };
    }
    case 'claim-item': {
      const itemId = behavior.itemId || turn.openTasks?.[0]?.id;
      return itemId ? { kind: 'claim-item', payload: { itemId } } : null;
    }
    case 'submit-patch': {
      if (!behavior.patch) return null;
      const p = typeof behavior.patch === 'function' ? behavior.patch(turn) : behavior.patch;
      return { kind: 'submit-patch', payload: { itemId: turn.task.id, ...p } };
    }
    case 'review-patch':
      return behavior.review === false
        ? null
        : { kind: 'review-patch', payload: { itemId: turn.patch.itemId, verdict: 'approve', notes: 'El parche hace lo que dice y el archivo compila.' } };
    case 'postwork-review': {
      // Revisión posterior: aquí se juzga el trabajo YA integrado contra el diff real.
      const next = (turn.assign || [])[0];
      if (!next) return { kind: 'pass' };
      const pega = behavior.reviewImprove ? behavior.reviewImprove(next) : null;
      if (pega) {
        return {
          kind: 'recheck',
          payload: {
            itemId: next.id, verdict: 'improve',
            claim: pega.claim, action: pega.action, evidence: pega.evidence || `(${name}) el diff no cubre el caso límite`,
            file: next.files?.[0], severity: pega.severity || 'med',
          },
        };
      }
      return {
        kind: 'recheck',
        payload: {
          itemId: next.id, verdict: 'ok',
          evidence: `(${name}) el diff hace lo que el plan decía y la verificación quedó en verde`,
        },
      };
    }
    case 'submit-argument':
      return { kind: 'argument', payload: { target: turn.finalists[0].id, text: `Decisivo: ${turn.finalists[0].title} explicita el umbral de reversión.` } };
    case 'objection-or-pass':
      return behavior.blocker
        ? { kind: 'objection', payload: { text: behavior.blocker, severity: 'blocker' } }
        : { kind: 'pass' };
    case 'submit-synthesis':
      if (behavior.synthesis) return { kind: 'synthesis', payload: behavior.synthesis(turn) };
      return {
        kind: 'synthesis',
        payload: {
          final: `PLAN FINAL\n${turn.winner.plan}\n\nResuelve los puntos abiertos con las objeciones incorporadas.`,
          merges: (turn.objections || []).map(o => o.id),
          pointResolutions: (turn.unresolved || []).map(p => ({ pointId: p.id, note: `se adopta «${p.leading || 'la mayoritaria'}»` })),
        },
      };
    case 'submit-verification':
      return {
        kind: 'verification',
        payload: behavior.verification ? behavior.verification(turn) : {
          verdict: 'pass',
          checks: [
            { claim: 'El coste del primer mes respeta el presupuesto', method: 'medir el gasto dos semanas', expectation: 'por debajo de un tercio del presupuesto' },
            { claim: 'El indicador principal mejora', method: 'comparar antes y después del primer hito', expectation: 'mejora sostenida dos semanas' },
          ],
        },
      };
    default:
      return null;
  }
}

// Agente falso: se une y ejecuta el bucle real del protocolo.
async function fakeAgent(code, name, behavior = {}) {
  behavior.bias = behavior.bias || 0;
  const j1 = await post(`${base}/api/rooms/${code}/join`, {
    name, model: name + '-model', harness: 'sim', role: behavior.role, capabilities: behavior.capabilities,
  });
  if (!j1.body.ok) throw new Error(`${name}: join falló ${JSON.stringify(j1.body)}`);
  const { agentId, token, role } = j1.body;
  const q = `agent=${agentId}&token=${token}`;
  const moves = [];
  let turn = null;
  for (let i = 0; i < 60; i++) {
    const r = await j(`${base}/api/rooms/${code}/turn?${q}&wait=${behavior.waitSec ?? 3}`);
    turn = r.body.turn;
    if (!turn) throw new Error(`${name}: turn vacío ${JSON.stringify(r.body)}`);
    if (turn.action === 'done') break;
    const move = decide(turn, behavior, name);
    if (!move) continue;
    let mr = await post(`${base}/api/rooms/${code}/move`, { agentId, token, ...move });
    // Dos agentes pueden reclamar la misma tarea a la vez: el que llega segundo no rompe la sala,
    // reintenta con la siguiente que siga libre (el servidor la nombra en el motivo).
    if (!mr.body.ok && move.kind === 'claim-item' && mr.body.error === 'bad_payload') {
      const libre = String(mr.body.message || '').match(/Libres:\s*([^.]*)/);
      const siguiente = libre ? libre[1].split(',')[0].trim() : '';
      if (siguiente) mr = await post(`${base}/api/rooms/${code}/move`, { agentId, token, kind: 'claim-item', payload: { itemId: siguiente } });
    }
    moves.push({ action: turn.action, kind: move.kind, status: mr.status, ok: mr.body.ok, warnings: mr.body.warnings || [] });
    // `busy` es un estado legítimo del protocolo (hay un parche del árbol esperando revisión o
    // verificación): el agente vuelve a pedir turno y lo reintenta, no es un fallo de la sala.
    if (!mr.body.ok && !['wrong_phase', 'duplicate', 'busy'].includes(mr.body.error)) {
      throw new Error(`${name}: ${move.kind} rechazado → ${JSON.stringify(mr.body)}`);
    }
  }
  const res = await j(`${base}/api/rooms/${code}/result?${q}`);
  return { agentId, token, name, role, moves, result: res.body, lastTurn: turn, query: q };
}

const AGENDA = [
  { label: 'Segmento objetivo', options: ['PYME', 'Mid-market', 'Enterprise'] },
  { label: 'Canal principal', options: ['Venta directa', 'Autoservicio', 'Partners'] },
  { label: 'Modelo de precio', options: ['Suscripción', 'Uso medido', 'Freemium'] },
  { label: 'Riesgo principal', options: ['Adquisición cara', 'Churn temprano', 'Competencia'] },
];

// ---------------------------------------------------------------- 1
test('1 · debate completo con agenda, veto, síntesis y verificación', async () => {
  // Sala de decisión, no de código: se pide explícitamente (antes era el comportamiento por
  // defecto de cualquier sala sin repo; ahora sin repo la sala crea su propio proyecto).
  const room = await createRoom({ task: 'Diseña la estrategia de lanzamiento del producto con presupuesto limitado.', agenda: AGENDA, settings: { ...SHORT, minAgents: 2, expectedAgents: 3, planOnly: true } });
  const code = room.code;

  const [a, b, c] = await Promise.all([
    fakeAgent(code, 'Ana', { bias: 0, role: 'analyst', capabilities: ['data', 'logic'] }),
    fakeAgent(code, 'Bruno', { bias: 1, role: 'skeptic', capabilities: ['logic', 'risk'], bottom: true, revises: false, blocker: 'Vetо: el plan no explica qué ocurre si el indicador principal no mejora en dos semanas.' }),
    fakeAgent(code, 'Ciro', { bias: 2, role: 'redteam', capabilities: ['risk'] }),
  ]);

  assert.ok(a.result.closed && b.result.closed && c.result.closed, 'los 3 agentes vieron la sala cerrada');
  const res = a.result.result;
  assert.equal(res.outcome, 'decided', 'resultado decidido');
  assert.ok(res.winner?.plan?.length > 30, 'plan ganador presente');
  assert.match(res.checksum, /^sha256:[0-9a-f]{64}$/, 'checksum válido');
  assert.equal(res.consensus.method, 'agenda');
  assert.equal(res.consensus.total, AGENDA.length);
  assert.ok(res.consensus.points.every(p => ['agreed', 'discussing', 'open', 'pending'].includes(p.status)));
  assert.ok(res.checks.length >= 2, 'la verificación aportó comprobaciones');
  assert.equal(res.verification.selfVerified, false, 'verificó otro agente, no el autor');
  assert.ok(res.stats.critiques >= 3, 'cada propuesta recibió crítica');
  assert.ok(res.cost.estTokens > 0 && res.cost.avgPerAgent > 0, 'coste medido');
  assert.ok(res.stats.durationMin <= 3, `debate rápido (${res.stats.durationMin} min)`);

  // Marcador por harness: identidad declarada, hechos contados.
  assert.equal(res.scoreboard.byAgent.length, 3, 'una fila por agente');
  // Acertar es haber puesto al ganador primero en el voto secreto: se comprueba contra
  // las papeletas publicadas, no contra una impresión.
  for (const row of res.scoreboard.byAgent) {
    const ballot = res.ballots[row.name];
    assert.equal(row.votedWinner, !!ballot && ballot[0] === res.winner.title, `${row.name}: el acierto cuadra con su voto`);
  }
  assert.ok(res.scoreboard.byAgent.some(r => r.votedWinner), 'quien puso al ganador primero queda marcado');
  assert.equal(res.scoreboard.byAgent.reduce((s, r) => s + r.dissentPoints, 0),
    res.consensus.points.reduce((s, p) => s + p.choices.filter(c => c.label !== p.modal?.label).reduce((n, c) => n + c.count, 0), 0),
    'el disenso del marcador cuadra con las posiciones registradas');
  assert.ok(res.scoreboard.highlights.length >= 1, 'el marcador destaca algo sin inventarse nada');

  // Disenso protegido: el informe dice qué unanimidad real hubo, qué puntos quedaron con
  // minoría y con qué base se cerró cada punto abierto. Sin esto, un debate unánime y uno
  // donde la diversidad se disolvió se leían igual.
  const prot = res.dissentProtection;
  assert.ok(prot && prot.measured, 'el informe trae el disenso protegido medido');
  assert.ok(typeof prot.unanimity === 'number' && prot.unanimity >= 0 && prot.unanimity <= 1);
  assert.ok(Array.isArray(prot.contestedPoints) && Array.isArray(prot.byAuthority));
  assert.ok(prot.resolutions.length >= 1, 'la síntesis resolvió al menos un punto');
  assert.ok(prot.resolutions.every(r => ['evidence', 'adopted-dissent', 'authority'].includes(r.basis)),
    'cada resolución declara una base válida');
  assert.equal(prot.convergenceWithoutEvidence.total, prot.convergenceWithoutEvidence.moves.length,
    'los movimientos sin evidencia contados cuadran con los listados');

  const all = [...a.moves, ...b.moves, ...c.moves];
  assert.ok(all.every(m => m.status === 200), 'ningún movimiento rechazado');
  assert.ok(all.every(m => m.warnings.length === 0), 'sin avisos de normalización en el camino feliz');

  const phases = new Set(all.map(m => m.action));
  assert.ok(phases.has('submit-proposal') && phases.has('submit-critique') && phases.has('submit-vote'), 'pasó por propuesta, crítica y voto');
  assert.ok(phases.has('submit-synthesis'), 'hubo síntesis');
  assert.ok(phases.has('submit-verification'), 'hubo verificación');
});

// ---------------------------------------------------------------- 2
test('2 · indulgencia: un ranking parcial se completa y solo avisa', async () => {
  const room = await createRoom({ task: 'Elegir base de datos para analítica de eventos de una app móvil.', agenda: AGENDA.slice(0, 3), settings: { ...SHORT, planOnly: true } });
  const code = room.code;
  const [a] = await Promise.all([
    fakeAgent(code, 'Dana', { bias: 0, partial: true }),
    fakeAgent(code, 'Elena', { bias: 2 }),
  ]);
  const warnings = a.moves.filter(m => m.warnings.length).flatMap(m => m.warnings);
  assert.ok(warnings.some(w => /ranking incompleto/.test(w)), 'avisó del ranking incompleto en lugar de rechazarlo');
  assert.ok(a.moves.filter(m => m.kind === 'vote').every(m => m.status === 200), 'el voto parcial fue aceptado');
});

// ---------------------------------------------------------------- 3
test('3 · agente mudo: queda ausente, abre vacante y entra un reemplazo en vivo', async () => {
  const room = await createRoom({ task: 'Plan de refactor del módulo de autenticación legacy, por partes.', settings: { ...SHORT, minAgents: 2, expectedAgents: 2 } });
  const code = room.code;
  const mudo = await post(`${base}/api/rooms/${code}/join`, { name: 'Mudo', harness: 'sim' });
  assert.equal(mudo.body.ok, true);
  const activo = await post(`${base}/api/rooms/${code}/join`, { name: 'Activo', harness: 'sim' });
  assert.equal(activo.body.ok, true);

  const pub0 = await j(`${base}/api/rooms/${code}/public`);
  assert.equal(pub0.body.room.phase, 'frame', 'arrancó al reunir los mínimos');

  await post(`${base}/api/rooms/${code}/admin`, { adminToken: room.adminToken, op: 'advance' }); // frame → proposal
  const pub1 = await j(`${base}/api/rooms/${code}/public`);
  assert.equal(pub1.body.room.phase, 'proposal');

  const turn = await j(`${base}/api/rooms/${code}/turn?agent=${mudo.body.agentId}&token=${mudo.body.token}`);
  assert.equal(turn.body.turn.action, 'submit-proposal');

  // El activo presenta su propuesta; el mudo no hará nada.
  const activoQ = `agent=${activo.body.agentId}&token=${activo.body.token}`;
  const activoTurn = await j(`${base}/api/rooms/${code}/turn?${activoQ}`);
  const move = decide(activoTurn.body.turn, {}, 'Activo');
  const moved = await post(`${base}/api/rooms/${code}/move`, { agentId: activo.body.agentId, token: activo.body.token, ...move });
  assert.equal(moved.body.ok, true, 'la propuesta del activo se aceptó: ' + JSON.stringify(moved.body).slice(0, 200));

  await post(`${base}/api/rooms/${code}/admin`, { adminToken: room.adminToken, op: 'advance' }); // proposal → critique (mudo ausente)
  const pub2 = await j(`${base}/api/rooms/${code}/public`);
  const estado = pub2.body.room;
  assert.equal(estado.roster.find(r => r.name === 'Mudo').status, 'absent', 'el mudo quedó ausente al vencer su plazo');
  assert.equal(estado.vacancies.length, 1, 'se abrió una vacante');
  assert.notEqual(estado.phase, 'lobby');

  const repl = await post(`${base}/api/rooms/${code}/join`, { name: 'Relevo', harness: 'sim', role: 'skeptic' });
  assert.equal(repl.body.ok, true);
  assert.equal(repl.body.replacement, true, 'entró como reemplazo, no como observador');
  assert.equal(repl.body.agentId, mudo.body.agentId, 'ocupa el asiento vacante');
  const pub3 = await j(`${base}/api/rooms/${code}/public`);
  assert.equal(pub3.body.room.vacancies.length, 0, 'la vacante quedó cubierta');
  assert.equal(pub3.body.room.roster.find(r => r.id === mudo.body.agentId).status, 'active');
  await post(`${base}/api/rooms/${code}/admin`, { adminToken: room.adminToken, op: 'close' });
});

// ---------------------------------------------------------------- 4
test('4 · long-poll: bloquea sin trabajo y responde al instante cuando toca', async () => {
  const room = await createRoom({ task: 'Prueba de long-poll del protocolo con un solo agente esperando.', settings: { ...SHORT, minAgents: 2, expectedAgents: 0 } });
  const joined = await post(`${base}/api/rooms/${room.code}/join`, { name: 'LP' });
  const q = `agent=${joined.body.agentId}&token=${joined.body.token}`;
  const t0 = Date.now();
  const r0 = await j(`${base}/api/rooms/${room.code}/turn?${q}&wait=2`);
  const dt = Date.now() - t0;
  assert.ok(dt >= 1800 && dt < 4000, `esperó ~2 s sin trabajo (${dt} ms)`);
  assert.equal(r0.body.turn.action, 'wait');

  const room2 = await createRoom({ task: 'Prueba de respuesta inmediata con acción pendiente.', settings: { ...SHORT, minAgents: 1, expectedAgents: 1 } });
  const j2 = await post(`${base}/api/rooms/${room2.code}/join`, { name: 'LP2' });
  const q2 = `agent=${j2.body.agentId}&token=${j2.body.token}`;
  const t1 = Date.now();
  const r1 = await j(`${base}/api/rooms/${room2.code}/turn?${q2}&wait=2`);
  assert.ok(Date.now() - t1 < 600, 'con acción pendiente responde de inmediato');
  assert.equal(r1.body.turn.action, 'frame-contribute', 'la primera fase es el encuadre');
  assert.ok(r1.body.turn.agenda !== undefined);
});

// ---------------------------------------------------------------- 5
test('5 · documentos: bootstrap, manual, plantillas, export y rechazo de token inválido', async () => {
  const room = await createRoom({ task: 'Verificación del bootstrap autoexplicativo y de los documentos.', template: 'estrategia-lanzamiento' });
  const txt = await fetch(`${base}/r/${room.code}`).then(r => r.text());
  assert.ok(txt.includes('TAREA:') && txt.includes('/api/rooms/' + room.code + '/join'), 'bootstrap de sala en texto plano');
  assert.ok(txt.includes('PUNTOS DE DECISIÓN'), 'el bootstrap incluye la agenda');
  const html = await fetch(`${base}/r/${room.code}`, { headers: { Accept: 'text/html' } }).then(r => r.text());
  assert.ok(html.includes('<!doctype html>'), 'los navegadores reciben la interfaz');

  const man = await fetch(`${base}/manual`).then(r => r.text());
  assert.ok(man.includes('# Polymind') && man.includes('verify'), 'manual Polymind servido');
  assert.ok(man.includes('phase-ready') && man.includes('contributionResponses'), 'manual documenta acuerdo y construcción compartida');
  const tpls = await j(`${base}/api/templates`);
  assert.ok(tpls.body.templates.length >= 5, 'plantillas disponibles');
  assert.ok(tpls.body.templates.some(t => t.id === 'estrategia-lanzamiento'));

  const created = await post(`${base}/api/rooms`, { template: 'estrategia-lanzamiento', task: 'Tarea creada desde plantilla para comprobar la agenda heredada.' });
  assert.equal(created.body.ok, true);
  assert.ok(created.body.agenda.length >= 4, 'la plantilla aportó agenda');
  assert.ok(created.body.bootstrap.includes('PUNTOS DE DECISIÓN'));

  const md = await fetch(`${base}/api/rooms/${created.body.code}/export.md`).then(r => r.text());
  assert.ok(md.includes('#') && md.includes('Sin resultado todavía'), 'export markdown antes de cerrar');

  const snip = await j(`${base}/api/snippets?harness=claude&room=${created.body.code}`);
  assert.equal(snip.body.ok, true);
  assert.ok(snip.body.files[0].content.includes('mcpServers'), 'snippet MCP para Claude Code');

  const bad = await j(`${base}/api/rooms/${created.body.code}/turn?agent=a9&token=nope`);
  assert.ok(bad.status === 404 || bad.status === 401, 'tokens inválidos rechazados');

  const meta = await j(`${base}/api/meta`);
  assert.ok(meta.body.phases.includes('verify') && meta.body.phases.includes('frame'));
  assert.ok(Object.keys(meta.body.lenses).length === 6, 'el catálogo de lentes opcionales está disponible');
  assert.equal(meta.body.phases.length, 16, 'se añaden las fases de repo (audit, work, review) y el contraste de ejes');
  assert.ok(meta.body.phases.includes('audit') && meta.body.phases.includes('work'));
  assert.ok(meta.body.phases.includes('contrast'), 'el contraste de ejes es una fase de primera clase');
  assert.ok(meta.body.phases.includes('review'), 'el panel sabe que existe la revisión posterior al trabajo');
});

// ---------------------------------------------------------------- 9 · repo y trabajo
// Fixture git mínimo para auditar y parchear por HTTP (nada de npm: node a secas).
// Cada prueba que necesita un repo se hace el suyo: compartir una carpeta dejaba el
// segundo test con el árbol ya commiteado («nothing to commit») y con los parches del
// primero encima.
function makeWorkFixture() {
  const dir = fs.mkdtempSync(path.join(DATA, 'fixture-work-'));
  fs.writeFileSync(path.join(dir, 'calc.mjs'), [
    'export function total(items) {',
    '  let t = 0;',
    '  for (const item of items) t += item.price;',
    '  return t;',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'check.mjs'), [
    "import { total } from './calc.mjs';",
    'if (typeof total !== "function") { console.error("falta total"); process.exit(1); }',
    'console.log("check ok");',
    '',
  ].join('\n'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-q', '-m', 'estado inicial');
  return dir;
}

test('9 · repo por HTTP: crear sala con repositorio, auditar y leer código con credenciales', async () => {
  const fixture = makeWorkFixture();
  const room = await createRoom({
    task: 'Auditar el proyecto de ejemplo y mejorar el cálculo de totales con parches revisados.',
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1 },
    repo: { path: fixture, verify: 'node check.mjs' },
  });
  const code = room.code;
  assert.equal(room.repo.kind, 'path', 'la sala declara el repo adjunto');
  assert.ok(room.repo.branch.startsWith('agora/'), 'el trabajo va en una rama de la sala');
  assert.equal(room.repoWarning, null, 'el clon salió bien');

  // Adjuntar un repo inexistente no tumba la sala: avisa y sigue como debate normal.
  const broken = await post(`${base}/api/rooms`, { task: 'Sala con repo roto para comprobar que no revienta.', repo: { path: path.join(DATA, 'no-existe-esta-ruta') } });
  assert.equal(broken.body.ok, true);
  assert.match(broken.body.repoWarning, /no existe/);
  assert.equal(broken.body.repo, null);

  // Sin credenciales no se sirve el código del proyecto.
  const noAuth = await j(`${base}/api/rooms/${code}/repo`);
  assert.equal(noAuth.status, 401, 'el repo exige token de agente o de administración');

  const asAdmin = await j(`${base}/api/rooms/${code}/repo?admin=${room.adminToken}`);
  assert.equal(asAdmin.body.ok, true, 'el panel lee el índice con su token');
  assert.ok(asAdmin.body.files.includes('calc.mjs'));
  assert.equal(asAdmin.body.branch, room.repo.branch);

  // La línea base se mide en segundo plano al crear la sala.
  let baseline = asAdmin.body.baseline;
  for (let i = 0; i < 40 && baseline?.status !== 'done'; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    baseline = (await j(`${base}/api/rooms/${code}/repo?admin=${room.adminToken}`)).body.baseline;
  }
  assert.equal(baseline?.status, 'done', 'el sondeo inicial termina y queda publicado');
  assert.equal(baseline.ok, true, 'la línea base dice si el repo arranca en verde');

  // Un agente entra, el debate arranca solo y llega a la auditoría.
  const join = await post(`${base}/api/rooms/${code}/join`, { name: 'HTTP-1', harness: 'curl' });
  const { agentId, token } = join.body;
  const readTurn = async () => (await j(`${base}/api/rooms/${code}/turn?agent=${agentId}&token=${token}&wait=15`)).body.turn;
  const move = async (kind, payload) => {
    const r = await post(`${base}/api/rooms/${code}/move`, { agentId, token, kind, payload });
    assert.equal(r.body.ok, true, `move ${kind}: ${JSON.stringify(r.body)}`);
    return r.body.turn;
  };

  let turn = await readTurn();
  for (let i = 0; i < 6 && ['start-or-wait', 'wait'].includes(turn.action); i++) {
    await new Promise(resolve => setTimeout(resolve, 400));
    turn = await readTurn();
  }
  assert.equal(turn.action, 'frame-contribute', 'el debate arranca solo con los mínimos reunidos');
  turn = await move('pass');
  assert.equal(turn.action, 'audit-repo', 'con repo, el encuadre va seguido de la auditoría');
  assert.equal(turn.repo.verify, 'node check.mjs', 'el agente ve el comando de verificación de la sala');
  assert.match(turn.repoAccess.file, /\/repo\?path=/, 'el turno explica cómo leer el código');
  assert.equal(turn.repo.branch, room.repo.branch);

  // Leer código con el token del agente (y pagarlo en su coste).
  const before = (await j(`${base}/api/rooms/${code}/state?agent=${agentId}&token=${token}`)).body.state;
  const file = await j(`${base}/api/rooms/${code}/repo?path=calc.mjs&from=1&lines=3&agent=${agentId}&token=${token}`);
  assert.equal(file.body.kind, 'file');
  assert.match(file.body.text, /item\.price/);
  assert.equal(file.body.startLine, 1);
  const search = await j(`${base}/api/rooms/${code}/repo?q=item.price&agent=${agentId}&token=${token}`);
  assert.ok(search.body.matches.some(m => m.path === 'calc.mjs' && m.line === 3), 'la búsqueda dice archivo y línea');
  const after = (await j(`${base}/api/rooms/${code}/state?agent=${agentId}&token=${token}`)).body.state;
  assert.ok(after.log.length >= before.log.length, 'leer el repo no rompe el estado del agente');
  const roster = (await j(`${base}/api/rooms/${code}/public`)).body.room.roster[0];
  assert.ok(roster.tokens > 0, 'lo que el agente lee cuenta como su coste');

  // Hallazgo por HTTP: crea el punto de agenda del que saldrá la tarea.
  turn = await move('finding', {
    file: 'calc.mjs', line: 3, severity: 'high',
    claim: 'El total ignora la cantidad de cada línea y cobra de menos al cliente.',
    evidence: 'calc.mjs:3 suma solo item.price, sin multiplicar por qty.',
    action: 'multiplicar price por qty con valor por defecto 1',
  });
  assert.equal(turn.action, 'submit-proposal', 'la auditoría cerró y el debate pasa a propuestas');
  assert.ok(turn.repoPlan.improvements.some(i => i.file === 'calc.mjs'), 'el plan de cambio trae la mejora auditada');
  const pub = (await j(`${base}/api/rooms/${code}/public`)).body.room;
  assert.equal(pub.findings.length, 1);
  assert.equal(pub.agenda.filter(p => p.source === 'finding').length, 1);
  assert.deepEqual(pub.agenda[0].options.map(o => o.id), ['aplicar', 'aplazar', 'descartar']);

  // El diff de trabajo vacío se dice con claridad, no con un 404.
  const diff = await fetch(`${base}/api/rooms/${code}/work.diff?admin=${room.adminToken}`).then(r => r.text());
  assert.match(diff, /sin cambios/);

  fs.rmSync(fixture, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 6
test('6 · MCP por stdio: initialize, tools/list y un debate en solitario completo', async () => {
  const room = await createRoom({ task: 'Debate en solitario dirigido por el cliente MCP para comprobar el carril.', settings: { ...SHORT, minAgents: 1, expectedAgents: 1, planOnly: true } });
  const mcp = new McpClient(['server/transports/mcp.mjs', '--room', room.code, '--name', 'MCP-1', '--url', base]);
  try {
    const init = await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sim', version: '1' } });
    assert.equal(init.serverInfo.name, 'agora');
    const tools = await mcp.request('tools/list', {});
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['debate_join', 'debate_repo', 'debate_result', 'debate_submit', 'debate_turn']);
    assert.match(tools.tools.find(t => t.name === 'debate_submit').inputSchema.properties.kind.description,
      /finding.*claim-item.*submit-patch.*review-patch/s, 'el esquema declara también los movimientos del repo');

    // Sin rol asignado: el servidor NO inventa identidades, solo acepta la que declara el agente.
    const joined = mcp.parse(await mcp.call('debate_join', { name: 'MCP-1', harness: 'sim-mcp' }));
    assert.ok(joined.agentId, 'se unió');
    assert.equal(joined.lens, null, 'sin lente declarada, no hay rol que repartir');
    assert.equal(joined.harness, 'sim-mcp', 'la identidad es el harness declarado');

    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      const turn = mcp.parse(await mcp.call('debate_turn', { wait: 5 }));
      if (!turn || turn.action === 'done') break;
      const move = decide(turn, {}, 'MCP-1');
      if (!move) break;
      const out = mcp.parse(await mcp.call('debate_submit', { kind: move.kind, payload: move.payload }));
      void out;
    }
    const result = mcp.parse(await mcp.call('debate_result', {}));
    closed = !!result.checksum;
    assert.ok(closed, 'el debate cerró por MCP: ' + JSON.stringify(result).slice(0, 200));
    assert.equal(result.outcome, 'decided');
    assert.ok(result.verification.selfVerified === true, 'en solitario la verificación es propia y se declara como tal');
    assert.match(result.checksum, /^sha256:/);

    const err = await mcp.callRaw('tools/call', { name: 'debate_submit', arguments: { kind: 'invento' } });
    assert.equal(err.result.isError, true, 'un movimiento inválido devuelve isError en lugar de caer');
  } finally {
    mcp.kill();
  }
});

// ---------------------------------------------------------------- 11
test('11 · MCP sobre un repo: el agente lee el código y el diff sin salir del carril MCP', async () => {
  const fixture = makeWorkFixture();
  const room = await createRoom({
    task: 'Auditar este proyecto de ejemplo y dejar constancia de lo que se puede mejorar.',
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1 },
    repo: { path: fixture, verify: 'node check.mjs' },
  });
  const mcp = new McpClient(['server/transports/mcp.mjs', '--room', room.code, '--name', 'MCP-repo', '--harness', 'sim-mcp', '--url', base]);
  try {
    await mcp.call('debate_join', { name: 'MCP-repo', harness: 'sim-mcp' });
    const idx = mcp.parse(await mcp.call('debate_repo', {}));
    assert.ok((idx.files || []).includes('calc.mjs'), 'el índice del repo llega por MCP');
    assert.equal(idx.branch, room.repo.branch, 'el índice dice en qué rama se trabaja');

    const file = mcp.parse(await mcp.call('debate_repo', { path: 'calc.mjs', lines: 3 }));
    assert.equal(file.kind, 'file');
    assert.match(file.text, /item\.price/);
    assert.equal(file.truncated, true, 'lee solo lo que se le pide');

    const found = mcp.parse(await mcp.call('debate_repo', { query: 'item.price' }));
    assert.ok(found.matches.some(m => m.path === 'calc.mjs'), 'la búsqueda por MCP dice archivo y línea');
    const rx = mcp.parse(await mcp.call('debate_repo', { query: 'tot.l', regex: true }));
    assert.ok(rx.matches.length >= 1, 'y admite expresión regular');

    const outside = mcp.parse(await mcp.call('debate_repo', { path: '../fuera.mjs' }));
    assert.match(String(outside.error || ''), /inválid|no existe/, 'el guardia de rutas vale también aquí');

    const diff = mcp.parse(await mcp.call('debate_repo', { diff: true }));
    assert.match(String(diff.diff || ''), /sin cambios/, 'sin trabajo integrado lo dice, no devuelve un 404');
  } finally {
    mcp.kill();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 10
test('10 · runner sobre un repo: audita el código, parchea, revisa y commitea sin intervención', async () => {
  const fixture = makeWorkFixture();
  const room = await createRoom({
    task: 'Auditar el proyecto de ejemplo y dejar aplicada y verificada la mejora que apruebe el debate.',
    settings: { ...SHORT, minAgents: 2, expectedAgents: 2, phaseMs: { audit: 60_000, work: 120_000 } },
    repo: { path: fixture, verify: 'node check.mjs' },
  });

  const out = await runProcess('node', [
    'server/runner/index.mjs', '--room', room.code, '--cli', 'mock', '--agents', '2', '--url', base,
  ], 120_000);
  assert.equal(out.code, 0, `el runner terminó bien: ${out.stdout.slice(-500)}${out.stderr.slice(-500)}`);

  const pub = await j(`${base}/api/rooms/${room.code}/public`);
  const r = pub.body.room;
  assert.equal(r.status, 'closed', `la sala cerró: ${JSON.stringify(r.phase)}`);
  assert.ok(r.findings.length >= 1, 'los CLIs auditados dejaron hallazgos anclados a archivos');
  assert.ok(r.agenda.some(p => p.source === 'finding'), 'los hallazgos entraron en la agenda');

  const w = r.result.work;
  assert.ok(w, 'el resultado incluye el trabajo hecho sobre la rama');
  assert.equal(w.stats.integrated, w.stats.items, 'todo lo aprobado se integró');
  assert.ok(w.commits.length >= 1, 'hay commits en la rama de la sala');
  assert.ok(w.items.every(i => (i.verify || {}).ok === true), 'cada tarea integrada pasó la verificación');
  assert.ok(w.patches.some(p => p.review), 'nadie aprobó su propio parche: hay revisión de otro CLI');

  const diff = await fetch(`${base}/api/rooms/${room.code}/work.diff?admin=${room.adminToken}`).then(x => x.text());
  assert.match(diff, /revisado en la auditoría/, 'el diff llevaba el cambio real de los CLIs');

  fs.rmSync(fixture, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 13
test('13 · publicar la rama: solo si el humano declaró el remoto, y solo si el debate movió la rama', async () => {
  const fixture = makeWorkFixture();
  const remote = path.join(fs.mkdtempSync(path.join(DATA, 'remote-')), 'destino.git');
  const bare = spawnSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
  assert.equal(bare.status, 0, 'remoto desnudo: ' + (bare.stderr || ''));
  const inRemote = (...args) => spawnSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' }).stdout.trim();

  const room = await createRoom({
    task: 'Auditar el proyecto de ejemplo, dejar aplicada la mejora aprobada y publicarla en la rama.',
    settings: { ...SHORT, minAgents: 2, expectedAgents: 2, phaseMs: { audit: 60_000, work: 120_000 } },
    repo: { path: fixture, verify: 'node check.mjs', pushTo: remote },
  });
  assert.equal(room.repo.pushTo, remote, 'la sala recuerda el destino declarado, sin adivinarlo');
  assert.deepEqual(inRemote('branch', '--list'), '', 'el remoto empieza vacío');

  // Publicar el punto de partida no aporta nada: se avisa en vez de empujar por empujar.
  const early = await post(`${base}/api/rooms/${room.code}/admin`, { adminToken: room.adminToken, op: 'push' });
  assert.equal(early.status, 400, JSON.stringify(early.body).slice(0, 200));
  assert.match(String(early.body.message || ''), /punto de partida/);
  assert.deepEqual(inRemote('branch', '--list'), '', 'y el remoto sigue intacto');

  const out = await runProcess('node', [
    'server/runner/index.mjs', '--room', room.code, '--cli', 'mock', '--agents', '2', '--url', base,
  ], 120_000);
  assert.equal(out.code, 0, `el runner terminó bien: ${out.stdout.slice(-400)}${out.stderr.slice(-400)}`);

  const r = (await j(`${base}/api/rooms/${room.code}/public`)).body.room;
  assert.equal(r.status, 'closed', 'la sala cerró: ' + JSON.stringify(r.phase));
  assert.ok(r.work.stats.integrated >= 1 && r.work.stats.integrated === r.work.stats.items, 'todo lo aprobado quedó integrado');
  assert.notEqual(r.repo.head, r.repo.baseCommit, 'la rama de la sala avanzó');

  const pushed = await post(`${base}/api/rooms/${room.code}/admin`, { adminToken: room.adminToken, op: 'push' });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body).slice(0, 300));
  assert.equal(pushed.body.ok, true);
  assert.equal(pushed.body.branch, r.repo.branch, 'se publica la rama de la sala, no otra');
  assert.match(inRemote('branch', '--list'), new RegExp(`agora/${room.code}`), 'la rama llegó al remoto');
  assert.equal(inRemote('rev-parse', `refs/heads/${r.repo.branch}`), r.repo.head, 'lo publicado es exactamente el head de la sala');

  const again = await post(`${base}/api/rooms/${room.code}/admin`, { adminToken: room.adminToken, op: 'push' });
  assert.equal(again.body.ok, true, 'publicar dos veces no falla: ya está todo arriba');
  assert.equal(inRemote('rev-parse', `refs/heads/${r.repo.branch}`), r.repo.head, 'y no reescribe el remoto');

  const after = (await j(`${base}/api/rooms/${room.code}/public`)).body.room;
  assert.deepEqual(after.repo.pushed, [r.repo.branch], 'el panel sabe que ya se publicó');

  // Sin destino declarado no hay push: se dice por qué, no se inventa un remoto.
  const plain = await createRoom({
    task: 'Sala con repo pero sin destino de publicación declarado por el humano.',
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1 },
    repo: { path: fixture, verify: 'node check.mjs' },
  });
  const noTarget = await post(`${base}/api/rooms/${plain.code}/admin`, { adminToken: plain.adminToken, op: 'push' });
  assert.equal(noTarget.status, 400);
  assert.match(String(noTarget.body.message || ''), /pushTo/, 'el motivo nombra lo que falta declarar');

  const noRepo = await createRoom({ task: 'Sala sin repositorio, para comprobar que publicar tampoco se inventa aquí.', settings: { planOnly: true } });
  const nowhere = await post(`${base}/api/rooms/${noRepo.code}/admin`, { adminToken: noRepo.adminToken, op: 'push' });
  assert.equal(nowhere.status, 400);
  assert.match(String(nowhere.body.message || ''), /no tiene repositorio/);

  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(path.dirname(remote), { recursive: true, force: true });
});

// ---------------------------------------------------------------- 14
test('14 · deshacer por HTTP: el humano revierte una mejora integrada y el informe deja de contarla', async () => {
  const fixture = makeWorkFixture();
  const room = await createRoom({
    task: 'Auditar el proyecto de ejemplo y dejar aplicada la mejora que apruebe el debate.',
    settings: { ...SHORT, minAgents: 2, expectedAgents: 2, phaseMs: { audit: 60_000, work: 120_000 } },
    repo: { path: fixture, verify: 'node check.mjs' },
  });
  const out = await runProcess('node', [
    'server/runner/index.mjs', '--room', room.code, '--cli', 'mock', '--agents', '2', '--url', base,
  ], 120_000);
  assert.equal(out.code, 0, `el runner terminó bien: ${out.stdout.slice(-400)}${out.stderr.slice(-400)}`);

  const admin = (body) => post(`${base}/api/rooms/${room.code}/admin`, { adminToken: room.adminToken, ...body });
  const r = (await j(`${base}/api/rooms/${room.code}/public`)).body.room;
  assert.equal(r.status, 'closed');
  assert.equal(r.work.stats.integrated, 1);
  const diffBefore = await fetch(`${base}/api/rooms/${room.code}/work.diff?admin=${room.adminToken}`).then(x => x.text());
  assert.match(diffBefore, /revisado en la auditoría/);

  // El token manda, y una tarea que no existe no se deshace «por si acaso».
  const foreign = await post(`${base}/api/rooms/${room.code}/admin`, { adminToken: 'no-es-el-token', op: 'revert' });
  assert.equal(foreign.status, 401);
  const unknown = await admin({ op: 'revert', itemId: 'w-que-no-existe' });
  assert.equal(unknown.status, 409);
  assert.match(String(unknown.body.message || ''), /no existe en esta sala/);

  const undone = await admin({ op: 'revert', reason: 'la mejora cambia el comportamiento que el equipo ya daba por bueno' });
  assert.equal(undone.status, 200, JSON.stringify(undone.body).slice(0, 300));
  assert.equal(undone.body.ok, true);
  assert.ok(undone.body.of && undone.body.commit, 'dice qué commit se revirtió y con cuál');

  const after = undone.body.room;
  const item = after.work.items[0];
  assert.equal(item.status, 'reverted');
  assert.equal(after.work.stats.integrated, 0);
  assert.equal(after.work.stats.reverted, 1);
  assert.match(item.revert.reason, /comportamiento que el equipo/);
  assert.equal(item.revert.of, undone.body.of);
  assert.equal(after.result.work.stats.reverted, 1, 'el informe congelado deja de contarla como integrada');
  assert.equal(after.result.work.stats.integrated, 0);
  assert.equal(after.result.scoreboard.byAgent.reduce((s, row) => s + row.reverted, 0), 1, 'y el marcador lo dice');

  const diffAfter = await fetch(`${base}/api/rooms/${room.code}/work.diff?admin=${room.adminToken}`).then(x => x.text());
  assert.doesNotMatch(diffAfter, /revisado en la auditoría/, 'el cambio ya no está en la rama');
  const commits = after.result.work.commits;
  assert.ok(commits.length >= 2, 'el commit original sigue ahí: solo se añade la reversión');
  assert.match(commits[0].subject, /deshace/, 'la reversión queda en el historial, no se borra nada');
  assert.ok(undone.body.commit.startsWith(commits[0].sha) || commits[0].sha.startsWith(undone.body.commit.slice(0, 8)), 'y es el commit que dice la respuesta');
  const acta = await fetch(`${base}/api/rooms/${room.code}/export.md`).then(x => x.text());
  assert.match(acta, /Mejoras deshechas después del debate/, 'el acta explica qué se deshizo');
  assert.match(acta, /deshecha/, 'y la tabla de tareas no la sigue llamando «integrada»');

  // La verificación posterior corre en segundo plano: el informe congelado no puede
  // quedarse diciendo «verificando» para siempre.
  let frozen = null;
  for (let i = 0; i < 25; i++) {
    const pub = (await j(`${base}/api/rooms/${room.code}/public`)).body.room;
    frozen = pub.result.work.items[0].revert.verify;
    if (frozen.status === 'done') break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(frozen.status, 'done', 'la verificación tras deshacer termina y el informe lo refleja');
  assert.equal(frozen.ok, true, 'y el resultado dice si el proyecto sigue en verde');

  const twice = await admin({ op: 'revert' });
  assert.equal(twice.status, 409, 'no se deshace dos veces lo mismo');

  // Y el botón se puede deshacer: la reversión se revierte y la mejora vuelve a la rama.
  const back = await admin({ op: 'reapply', reason: 'se revisó y la mejora vuelve tal cual' });
  assert.equal(back.status, 200, JSON.stringify(back.body).slice(0, 300));
  const revived = back.body.room;
  assert.equal(revived.work.items[0].status, 'integrated');
  assert.equal(revived.work.stats.integrated, 1);
  assert.equal(revived.work.stats.reverted, 0);
  assert.equal(revived.work.items[0].reapplied.of, undone.body.commit, 'se revirtió exactamente la reversión');
  assert.match(revived.work.items[0].reapplied.reason, /vuelve tal cual/);
  assert.equal(revived.result.work.stats.integrated, 1, 'y el informe congelado vuelve a contarla');
  const diffBack = await fetch(`${base}/api/rooms/${room.code}/work.diff?admin=${room.adminToken}`).then(x => x.text());
  assert.match(diffBack, /revisado en la auditoría/, 'el cambio está otra vez en la rama');
  const actaBack = await fetch(`${base}/api/rooms/${room.code}/export.md`).then(x => x.text());
  assert.match(actaBack, /Vuelta a aplicar/, 'el acta cuenta las dos vueltas');

  const reapplyTwice = await admin({ op: 'reapply' });
  assert.equal(reapplyTwice.status, 409, 'ni se vuelve a aplicar dos veces');

  fs.rmSync(fixture, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 7
test('7 · runner local: conduce dos CLIs simulados sin intervención', async () => {
  const room = await createRoom({ task: 'Debate conducido por el runner local con dos CLIs simulados.', agenda: AGENDA, settings: { ...SHORT, minAgents: 2, expectedAgents: 2 } });
  const out = await runProcess('node', ['server/runner/index.mjs', '--room', room.code, '--cli', 'mock', '--agents', '2', '--url', base], 90_000);
  assert.equal(out.code, 0, 'el runner terminó bien: ' + out.stdout.slice(-400) + out.stderr.slice(-400));
  const pub = await j(`${base}/api/rooms/${room.code}/public`);
  assert.equal(pub.body.room.status, 'closed', 'el debate cerró: ' + JSON.stringify(pub.body.room.phase));
  const res = pub.body.room.result;
  assert.equal(res.outcome, 'decided');
  assert.ok(res.checks.length >= 2, 'la verificación pasó por el runner');
  assert.ok(res.cost.estTokens > 0, 'coste medido');
  assert.ok(out.stdout.includes('RESULTADO'), 'el runner imprimió el resultado');
});

// ---------------------------------------------------------------- 12
test('12 · torneo con repo: cada ángulo clona el proyecto y audita el mismo código', async () => {
  const fixture = makeWorkFixture();
  const t = await post(`${base}/api/tournaments`, {
    task: 'Auditar el proyecto de ejemplo desde tres ángulos y decidir qué mejora se queda.',
    angles: 3,
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1 },
    repo: { path: fixture, verify: 'node check.mjs' },
  });
  assert.equal(t.body.ok, true, JSON.stringify(t.body).slice(0, 300));
  assert.deepEqual(t.body.repoWarnings, [], 'los tres clones salieron bien');
  assert.equal(t.body.repo.source, fixture);

  const codes = t.body.rooms.map(r => r.code);
  for (const code of codes) {
    const room = (await j(`${base}/api/rooms/${code}/public`)).body.room;
    assert.ok(room.repo, `la sala ${code} tiene su clon`);
    assert.notEqual(room.repo.source, undefined);
    assert.equal(room.repo.verify, 'node check.mjs');
    assert.ok(room.repo.branch.startsWith('agora/'), 'rama propia por sala: los clones no se pisan');
  }
  // Cada sala trabaja en un clon distinto del mismo origen.
  const branches = new Set();
  for (const code of codes) {
    const room = (await j(`${base}/api/rooms/${code}/public`)).body.room;
    branches.add(room.repo.branch);
  }
  assert.equal(branches.size, 3, 'tres ramas distintas');

  // Un repo que no existe deja el torneo en pie (como debate) y lo dice.
  const broken = await post(`${base}/api/tournaments`, {
    task: 'Torneo con un repo inexistente para comprobar que no revienta.',
    angles: 2,
    repo: { path: path.join(DATA, 'no-existe-torneo') },
  });
  assert.equal(broken.body.ok, true);
  assert.equal(broken.body.repoWarnings.length, 2);
  assert.match(broken.body.repoWarnings[0].warning, /no existe/);

  fs.rmSync(fixture, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 8
test('8 · torneo: salas por ángulos y final con los ganadores', async () => {
  const t = await post(`${base}/api/tournaments`, {
    task: 'Decidir cómo lanzar el producto al mercado con recursos limitados.',
    agenda: AGENDA,
    angles: 3,
    settings: { ...SHORT, minAgents: 2, expectedAgents: 2 },
  });
  assert.equal(t.body.ok, true);
  assert.equal(t.body.rooms.length, 3, 'tres salas por ángulos');
  const codes = t.body.rooms.map(r => r.code);

  for (const code of codes) {
    await Promise.all([fakeAgent(code, 'Torneo-A', { bias: 0 }), fakeAgent(code, 'Torneo-B', { bias: 2 })]);
  }

  const view = await waitFor(async () => {
    const v = await j(`${base}/api/tournaments/${t.body.id}`);
    return ['final', 'closed'].includes(v.body.tournament.status) ? v : null;
  }, 12_000);
  assert.ok(view, 'el torneo abrió la final');
  assert.ok(view.body.tournament.rooms.some(r => r.round === 2), 'existe la sala final');
  const finalCode = view.body.tournament.rooms.find(r => r.round === 2).code;
  const finalPub = await j(`${base}/api/rooms/${finalCode}/public`);
  assert.ok(finalPub.body.room.context.includes('FINALISTA'), 'la final recibe los planes finalistas');
  assert.ok(finalPub.body.room.agenda.length >= 1, 'la final conserva la agenda');
  // Los jueces debaten la final y el torneo se cierra con su resultado.
  await Promise.all([fakeAgent(finalCode, 'Juez-A', { bias: 0 }), fakeAgent(finalCode, 'Juez-B', { bias: 1 })]);
  const done = await waitFor(async () => {
    const v = await j(`${base}/api/tournaments/${t.body.id}`);
    return v.body.tournament.status === 'closed' ? v : null;
  }, 12_000);
  assert.ok(done, 'el torneo se cierra con el resultado de la final');
  assert.ok(done.body.tournament.winner, 'el torneo registra el ganador');
});

// ---------------------------------------------------------------- 16
// Trabajo extraordinario de punta a punta: la revisión ve algo mejorable, lo que propone
// vuelve a la cola, se ejecuta con la misma disciplina (otro revisa, el servidor verifica) y
// solo entonces la sala cierra. El CLI de mentira exige la vuelta con AGORA_MOCK_REVIEW.
test('16 · trabajo extraordinario: la revisión devuelve a la cola y el ciclo se cierra', async () => {
  const fixture = makeWorkFixture();
  const room = await createRoom({
    task: 'Auditar el proyecto de ejemplo y dejar aplicada y revisada la mejora que apruebe el debate.',
    settings: {
      ...SHORT, minAgents: 2, expectedAgents: 2, extraordinary: true, repo: { reviewRounds: 2 },
      phaseMs: { audit: 60_000, work: 120_000, review: 120_000 },
    },
    repo: { path: fixture, verify: 'node check.mjs' },
  });

  const out = await runProcess('node', [
    'server/runner/index.mjs', '--room', room.code, '--cli', 'mock', '--agents', '2', '--url', base,
  ], 150_000, { AGORA_MOCK_REVIEW: 'improve' });
  assert.equal(out.code, 0, `el runner terminó bien: ${out.stdout.slice(-400)}${out.stderr.slice(-400)}`);

  const r = (await j(`${base}/api/rooms/${room.code}/public`)).body.room;
  assert.equal(r.status, 'closed', `la sala cerró: ${r.phase}`);
  assert.equal(r.work.review.extraordinary, true, 'el resultado dice que la sala exigía trabajo extraordinario');
  assert.ok(r.work.items.filter(i => i.from === 'review').length >= 1, 'la mejora de la revisión entró como tarea nueva');
  assert.equal(r.work.stats.integrated, r.work.stats.items, 'y se ejecutó: todo lo propuesto quedó integrado');
  assert.ok(r.work.review.round >= 2, `hubo una segunda ronda de revisión (${r.work.review.round})`);
  assert.equal(r.work.review.pending.length, 0, 'nadie quedó sin revisar');
  // El tope de rondas evita el bucle infinito: en la ronda final se cierra aunque el CLI
  // vuelva a pedir más, y lo que no se ejecutó queda escrito en el resultado.
  assert.equal(r.work.review.maxRounds, 2, 'el tope de rondas viaja en el resultado');
  const md = await fetch(`${base}/api/rooms/${room.code}/export.md`).then(x => x.text());
  assert.match(md, /revisi[oó]n posterior/i, 'el acta lo cuenta');
  assert.match(md, /trabajo extraordinario/i, 'y dice que la sala lo exigía');

  fs.rmSync(fixture, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 15
// El bug que rompió textos en producción: un CLI mandaba los acentos en latin-1 y el
// servidor los guardaba como �. Ahora se detecta y se recupera el texto tal cual.
// Bytes tal y como los escribiría una consola de Windows (cp1252): un byte por carácter,
// con la franja 0x80..0x9F puesta en puntuación en vez de en controles.
function toCp1252(str) {
  const map = {
    '\u20ac': 0x80, '\u201a': 0x82, '\u0192': 0x83, '\u201e': 0x84, '\u2026': 0x85, '\u2020': 0x86,
    '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95,
    '\u2013': 0x96, '\u2014': 0x97, '\u2122': 0x99,
  };
  const bytes = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    bytes.push(map[ch] ?? (code < 256 ? code : 0x3f));
  }
  return Buffer.from(bytes);
}

test('15 · codificación: un cuerpo en latin-1 no convierte los acentos en �', async () => {
  const task = 'Decidir si conviene migrar el almacén de sesiones durante el trimestre.';
  const title = 'Migración de sesiones: decisión';
  const punto = '¿Qué criterio define el éxito?';
  const latin1 = Buffer.from(JSON.stringify({
    task, title, agenda: [{ label: punto, options: ['latencia', 'coste', 'ninguna'] }],
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1 },
  }), 'latin1');

  // Sin charset declarado y con bytes latin-1: el caso exacto que llegaba desde los CLIs.
  const r = await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: latin1,
  });
  const out = await r.json();
  assert.equal(out.ok, true, 'la sala se crea igual: ' + JSON.stringify(out).slice(0, 200));
  assert.equal(out.agenda[0].label, punto, 'los acentos vuelven tal cual se escribieron');
  assert.equal(out.agenda[0].options[0].label ?? out.agenda[0].options[0], 'latencia');
  assert.ok(!JSON.stringify(out).includes('\uFFFD'), 'ni un solo carácter de reemplazo en la respuesta');

  const pub = await j(`${base}/api/rooms/${out.code}/public`);
  assert.equal(pub.body.room.task, task, 'el texto sobrevive al guardado');
  assert.equal(pub.body.room.title, title, 'el título tampoco se corrompe');
  assert.ok(!JSON.stringify(pub.body).includes('\uFFFD'), 'tampoco en lo que lee el panel');

  // La raya y las comillas tipográficas solo existen en cp1252, no en ISO-8859-1: si el
  // servidor las leyera como latin-1 puro serían controles y el JSON no se podría ni abrir.
  const cp = toCp1252(JSON.stringify({
    task: 'Lanzamiento — fase «piloto» del 20€', title: 'Raya tipográfica — y comillas “raras”',
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1 },
  }));
  const r3 = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cp });
  const out3 = await r3.json();
  assert.equal(out3.ok, true, 'el cuerpo en cp1252 se acepta: ' + JSON.stringify(out3).slice(0, 200));
  const pub3 = await j(`${base}/api/rooms/${out3.code}/public`);
  assert.equal(pub3.body.room.task, 'Lanzamiento — fase «piloto» del 20€', 'la raya y el euro vuelven tal cual');
  assert.equal(pub3.body.room.title, 'Raya tipográfica — y comillas “raras”', 'y las comillas tipográficas también');

  // Y un charset declarado de verdad manda: si dice latin-1, se lee latin-1.
  const declared = Buffer.from(JSON.stringify({ task: 'Sala con charset explícito: ñandú, ácido.', title: 'Acentos', settings: { ...SHORT, minAgents: 1, expectedAgents: 1 } }), 'latin1');
  const r2 = await fetch(`${base}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=latin-1' }, body: declared,
  });
  const out2 = await r2.json();
  const pub2 = await j(`${base}/api/rooms/${out2.code}/public`);
  assert.equal(pub2.body.room.task, 'Sala con charset explícito: ñandú, ácido.', 'el charset declarado se respeta');
});

// Espera a que una condición se cumpla (para procesos que avanzan con el reloj).
async function waitFor(fn, timeoutMs = 10_000, everyMs = 200) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, everyMs));
  }
  return null;
}

// ---------------------------------------------------------------- utilidades
class McpClient {
  constructor(argv) {
    this.proc = spawn('node', argv, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const resolver = this.pending.get(msg.id);
        if (resolver) { this.pending.delete(msg.id); resolver(msg); }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.stderr = '';
    this.proc.stderr.on('data', d => { this.stderr += d; });
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout en ${method}: ${this.stderr.slice(0, 200)}`)), 20_000);
      this.pending.set(id, msg => { clearTimeout(timer); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); });
      this.proc.stdin.write(payload);
    });
  }

  call(name, args) { return this.request('tools/call', { name, arguments: args }); }

  callRaw(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP timeout')), 20_000);
      this.pending.set(id, msg => { clearTimeout(timer); resolve({ result: msg.result, error: msg.error }); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  parse(response) {
    const text = response?.content?.[0]?.text;
    if (response?.isError) throw new Error('MCP devolvió error: ' + text);
    return text ? JSON.parse(text) : null;
  }

  kill() { try { this.proc.kill(); } catch { /* ya murió */ } }
}

function runProcess(cmd, args, timeoutMs, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, shell: false, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout ${timeoutMs} ms: ${stdout.slice(-300)} ${stderr.slice(-300)}`)); }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ---------------------------------------------------------------- 17
// Disenso protegido, de punta a punta por HTTP: un agente que se mueve hacia la mayoría
// sin decir qué lo movió queda registrado (aviso en su movimiento y en el informe), y un
// punto disputado que la síntesis no menciona sigue abierto en vez de cerrarse por omisión.
test('17 · disenso protegido: converger sin evidencia queda escrito y el punto olvidado sigue abierto', async () => {
  const room = await createRoom({
    task: 'Decidir el segmento y el canal de lanzamiento sin gastar de más.',
    agenda: [
      { label: 'Segmento', options: ['PYME', 'Enterprise'] },
      { label: 'Canal', options: ['Directo', 'Autoservicio'] },
    ],
    settings: { ...SHORT, minAgents: 2, expectedAgents: 2, planOnly: true },
  });
  const code = room.code;

  // La síntesis resuelve todo menos el último punto abierto: se «olvida» de uno.
  const sintesis = (turn) => {
    const abiertos = turn.unresolved || [];
    return {
      final: `PLAN FINAL\n${turn.winner.plan}\n\nCierra los puntos abiertos salvo el último, que queda dicho.`,
      merges: [],
      pointResolutions: abiertos.slice(0, -1).map(p => ({ pointId: p.id, note: `se adopta «${p.leading || 'la mayoritaria'}»` })),
    };
  };

  const [a, b] = await Promise.all([
    fakeAgent(code, 'Ana', {
      bias: 0, synthesis: sintesis,
      // Se mueve de PYME a Enterprise (la opción de Bruno) y NO dice qué la movió.
      revision: (turn) => ({
        proposalId: turn.proposalId,
        plan: '1. Versión revisada: se adopta Enterprise como segmento objetivo.\n2. Se mantiene la medición semanal antes de escalar.',
        note: 'Ajusto el segmento tras la crítica.',
        positions: [{ pointId: 'segmento', choiceId: 'enterprise' }],
      }),
    }),
    fakeAgent(code, 'Bruno', { bias: 1, revises: false, synthesis: sintesis }),
  ]);

  // 1) El movimiento se aceptó, pero la falta de argumento viaja en los avisos.
  const revision = a.moves.find(m => m.action === 'submit-revision-or-pass');
  assert.ok(revision, 'Ana revisó su propuesta');
  assert.ok(revision.warnings.some(w => /convergencia sin evidencia/.test(w)),
    'el aviso de convergencia sin evidencia llega en la respuesta del movimiento');

  const res = a.result.result;
  const prot = res.dissentProtection;

  // 2) La deriva queda en el informe con nombres, opciones y sin evidencia.
  assert.equal(prot.convergenceWithoutEvidence.count, 1, 'una posición se movió sin evidencia');
  assert.equal(prot.convergenceWithoutEvidence.total, 1);
  const move = prot.convergenceWithoutEvidence.moves[0];
  assert.equal(move.by, 'Ana', 'con nombre');
  assert.equal(move.point, 'Segmento');
  assert.equal(move.from, 'PYME');
  assert.equal(move.to, 'Enterprise');
  assert.equal(move.evidenced, false);
  assert.equal(move.because, null, 'no citó nada');

  // 3) El punto donde siguen discrepando se publica con su minoría, y el que la síntesis
  //    no tocó sigue abierto (no se cierra por omisión).
  assert.ok(prot.contestedCount >= 1, 'hay al menos un punto con minoría real');
  assert.ok(prot.unresolved.length >= 1, 'la síntesis dejó un punto abierto y se publica');
  assert.ok(prot.unresolved.some(u => u.label === 'Canal'), 'y es el que se olvidó: Canal');

  // 4) La interfaz recibe lo mismo, y el registro dice en voz alta lo que pasó.
  const pub = await j(`${base}/api/rooms/${code}/public`);
  assert.equal(pub.body.room.dissent.convergenceWithoutEvidence.count, 1, 'el panel humano lo ve en vivo');
  assert.ok(pub.body.room.log.some(l => /sin citar qué evidencia|movimiento sin evidencia|sin citar qué la movió/.test(l.text)) ||
    pub.body.room.log.some(l => /se mueve su posición/.test(l.text)),
    'el movimiento queda en el registro con su nombre');
  assert.ok(pub.body.room.log.some(l => /SIN resolver en la síntesis/.test(l.text)),
    'y la sala avisa de que un punto quedó sin resolver');
});

// ---------------------------------------------------------------- 18
// Un harness de verdad manda trabajo grande. El cuerpo HTTP tenía un techo de 512 KB y
// devolvía «body demasiado grande»: el movimiento se perdía entero. Aquí se comprueba que
// cientos de KB llegan íntegros y que el plan se guarda tal cual se escribió.
test('18 · un movimiento de cientos de KB pasa entero (el cuerpo ya no se corta en 512 KB)', async () => {
  const room = await createRoom({
    task: 'Comprueba el tamaño de movimiento que acepta el transporte en una sala de un solo agente.',
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1, requireDiversity: false },
  });
  const code = room.code;
  const j1 = await post(`${base}/api/rooms/${code}/join`, { name: 'Grande', harness: 'sim' });
  const { agentId, token } = j1.body;
  const q = `agent=${agentId}&token=${token}`;
  const move = (kind, payload = {}) => post(`${base}/api/rooms/${code}/move`, { agentId, token, kind, payload });
  const turn = async () => (await j(`${base}/api/rooms/${code}/turn?${q}&wait=3`)).body.turn;

  await move('start');
  let t = await turn();
  for (let i = 0; i < 12 && t?.action === 'frame-contribute'; i++) {
    await move('pass');
    t = await turn();
  }
  assert.equal(t?.action, 'submit-proposal', `la sala llegó a propuestas (${t?.action})`);

  const plan = '# Plan con detalle real\n\n' + 'Paso con cifras, criterio medible y plan de reversión explícito.\n'.repeat(6_000);
  assert.ok(plan.length > 300_000, `el plan supera los 300 KB (${plan.length})`);
  const r = await move('proposal', { title: 'Plan enorme', approach: 'detallado', plan });
  assert.equal(r.body.ok, true, 'el transporte acepta el movimiento: ' + JSON.stringify(r.body).slice(0, 220));
  assert.deepEqual(r.body.warnings || [], [], 'y no recorta nada: cero avisos');

  const pub = await j(`${base}/api/rooms/${code}/public`);
  const stored = pub.body.room.proposals.find(p => p.title === 'Plan enorme');
  // El motor solo recorta espacios de los extremos (normalización de prosa), nunca texto.
  assert.equal(stored.plan, plan.trim(), 'el plan llega entero al motor y a la interfaz');
  assert.ok(stored.plan.endsWith('plan de reversión explícito.'), 'con su final intacto, no cortado por el camino');
});

// ---------------------------------------------------------------- 19
// Contraste de ejes por HTTP: el encuadre a ciegas no puede cubrirlo todo, y el contraste es la
// vuelta corta donde entra el eje que faltó y se impugna el que sobra. Al cerrar, el informe
// audita el encuadre con nombres: quién abrió el marco y qué ejes llegaron tarde.
test('19 · contraste de ejes: el eje que faltó entra, el que sobra queda impugnado y el encuadre se audita', async () => {
  const room = await createRoom({
    task: 'Decidir la arquitectura de la cola de trabajos sin gastar de más.',
    agenda: [{ label: 'Broker', options: ['Redis', 'Postgres'] }],
    settings: { ...SHORT, minAgents: 2, expectedAgents: 2, planOnly: true },
  });
  const code = room.code;

  const [a, b] = await Promise.all([
    fakeAgent(code, 'Ana', {
      bias: 0,
      // En el encuadre (a ciegas) añade un eje propio…
      frameMove: { kind: 'point-proposal', payload: { label: 'Coste operativo mensual', options: ['< $50', '> $50'] } },
      // …y en el contraste impugna el ajeno, ya con la agenda a la vista.
      contrastMove: () => ({
        kind: 'point-challenge',
        payload: { pointId: 'broker', because: 'el coste operativo ya lo cubre el otro eje', mergeInto: 'coste-operativo-mensual' },
      }),
    }),
    fakeAgent(code, 'Bruno', {
      bias: 1, revises: false,
      contrastMove: () => ({ kind: 'point-proposal', payload: { label: 'Reintentos e idempotencia', options: ['Sí', 'No'] } }),
    }),
  ]);

  assert.ok(a.result.closed && b.result.closed, 'la sala cerró con los dos agentes');
  const review = a.result.result.agendaReview;
  assert.ok(review, 'el informe audita el encuadre');

  // El eje que abrió el marco, con nombre y sin fingir anclaje (nadie lo objetó).
  assert.equal(review.opened.by, 'Ana');
  assert.equal(review.opened.label, 'Coste operativo mensual');
  assert.equal(review.opened.mostObjected, false);
  assert.equal(review.anchored, false);
  assert.match(review.note, /Ana/);

  // El eje que el encuadre no vio: entró en el contraste y se dice.
  assert.equal(review.addedLate.length, 1);
  assert.equal(review.addedLate[0].label, 'Reintentos e idempotencia');
  assert.equal(review.addedLate[0].by, 'Bruno');

  // Impugnado sin mayoría: sigue en pie y con su motivo escrito.
  const broker = review.challenged.find(c => c.label === 'Broker');
  assert.ok(broker, 'el eje impugnado se publica');
  assert.deepEqual(broker.by, ['Ana']);
  assert.match(broker.because[0], /coste operativo/);
  assert.equal(review.merged.length, 0, 'una sola petición no fusiona nada');

  // Y la interfaz recibe lo mismo: contraste en vivo y el punto marcado como impugnado.
  const pub = await j(`${base}/api/rooms/${code}/public`);
  assert.ok(pub.body.room.contrast, 'el panel recibe el contraste');
  assert.equal(pub.body.room.agenda.find(p => p.id === 'broker').contested, true,
    'el punto impugnado se marca en la tabla, para no posicionarse sin saberlo');
  assert.equal(pub.body.room.agenda.find(p => p.id === 'broker').challenged[0].by, 'Ana');
  assert.match(pub.body.room.log.map(l => l.text).join('\n'), /Ana pide fusionar «Broker» con «Coste operativo mensual»/);
});

// Antes, la configuración de una sala solo existía repartida por el panel (o dentro del JSON
// en disco) y no había forma de volver a abrir un debate con la misma configuración: se
// perdía al cerrarse la sala. Ahora se ve entera en un sitio, se guarda como plantilla y se
// reabre heredando todo lo que no se pise.
test('20 · configuración de sala: se ve entera, se guarda como plantilla y se reabre igual', async () => {
  const fixture = makeWorkFixture();
  const origin = await createRoom({
    title: 'Cálculo de totales',
    task: 'Auditar el módulo de precios y dejar los cambios aplicados y verificados con parches revisados.',
    context: 'Proyecto de ejemplo con un bug real en total().',
    criteria: 'Coste, claridad y que la comprobación quede en verde.',
    agenda: [{ label: '¿Cortamos por precisión o por coste?', options: ['precisión', 'coste'] }],
    settings: { ...SHORT, minAgents: 2, expectedAgents: 2, tone: 'directo y técnico', extraordinary: true },
    repo: { path: fixture, verify: 'node check.mjs' },
  });
  const code = origin.code;

  // 1) La configuración se ve entera en un solo sitio, prompt incluido y sin secretos.
  const cfg = await j(`${base}/api/rooms/${code}/config`);
  assert.equal(cfg.body.ok, true);
  const c = cfg.body.config;
  assert.equal(c.from, code);
  assert.equal(c.task, 'Auditar el módulo de precios y dejar los cambios aplicados y verificados con parches revisados.');
  assert.equal(c.context, 'Proyecto de ejemplo con un bug real en total().');
  assert.equal(c.criteria, 'Coste, claridad y que la comprobación quede en verde.');
  assert.equal(c.title, 'Cálculo de totales');
  assert.equal(c.tone, 'directo y técnico');
  assert.equal(c.settings.extraordinary, true);
  assert.equal(c.settings.expectedAgents, 2);
  assert.deepEqual(c.agenda.map(p => p.label), ['¿Cortamos por precisión o por coste?']);
  assert.deepEqual(c.agenda[0].options, ['precisión', 'coste']);
  assert.equal(path.resolve(c.repo.path), path.resolve(fixture), 'apunta al proyecto original, no al clon de trabajo');
  assert.equal(c.repo.verify, 'node check.mjs');
  assert.match(c.prompt, /TAREA:/, 'el prompt para agentes viaja con la configuración');
  assert.equal(JSON.stringify(c).includes(origin.adminToken), false, 'la configuración no lleva el token de administración');

  // 2) Guardar la sala como plantilla: queda en Plantillas sin editar JSON a mano.
  const saved = await post(`${base}/api/rooms/${code}/template`, { adminToken: origin.adminToken, name: 'Precios: total y descuento' });
  assert.equal(saved.body.ok, true, 'se guarda con el token de la sala');
  assert.equal(saved.body.template.savedFrom, code);
  assert.equal(saved.body.template.task, c.task);
  const listed = await j(`${base}/api/templates`);
  assert.ok(listed.body.templates.some(t => t.id === saved.body.template.id), 'la plantilla guardada se lista');

  // Sin token no se escribe nada.
  const forbidden = await post(`${base}/api/rooms/${code}/template`, { name: 'sin permiso' });
  assert.equal(forbidden.status, 401, 'guardar una plantilla exige el token de la sala');

  // 3) Reabrir con la configuración de otra sala.
  const reopened = await post(`${base}/api/rooms`, {
    from: code,
    task: 'Reabrir: auditar el mismo módulo con las reglas de la sala anterior.',
  });
  assert.equal(reopened.body.ok, true);
  assert.equal(reopened.body.from, code, 'la respuesta dice de qué sala se heredó');
  const clone = (await j(`${base}/api/rooms/${reopened.body.code}/config`)).body.config;
  assert.equal(clone.task, 'Reabrir: auditar el mismo módulo con las reglas de la sala anterior.', 'lo que trae el cuerpo manda');
  assert.equal(clone.context, c.context, 'lo que no se pisa se hereda');
  assert.equal(clone.criteria, c.criteria);
  assert.equal(clone.tone, 'directo y técnico');
  assert.equal(clone.settings.extraordinary, true);
  assert.equal(clone.settings.expectedAgents, 2);
  assert.deepEqual(clone.agenda.map(p => p.label), c.agenda.map(p => p.label), 'la agenda se hereda entera');
  assert.equal(path.resolve(clone.repo.path), path.resolve(fixture), 'y el repo del origen se vuelve a clonar');
  assert.equal(reopened.body.repo.kind, 'path', 'la sala nueva abre con su propio clon, no con el de la anterior');
  assert.notEqual(reopened.body.repo.branch, origin.repo.branch, 'rama propia de la sala nueva');

  // Una regla suelta no borra las demás: `settings` se fusiona con lo heredado.
  const unaRegla = await post(`${base}/api/rooms`, { from: code, settings: { consensusThreshold: 0.9 } });
  assert.equal((await j(`${base}/api/rooms/${unaRegla.body.code}/config`)).body.config.settings.planOnly, false,
    'una sala normal no es de solo planificación');
  const conRegla = (await j(`${base}/api/rooms/${unaRegla.body.code}/config`)).body.config;
  assert.equal(conRegla.settings.consensusThreshold, 0.9, 'la regla enviada manda');
  assert.equal(conRegla.settings.extraordinary, true, 'y no arrastra consigo las demás reglas heredadas');
  assert.equal(conRegla.settings.expectedAgents, 2);
  assert.equal(conRegla.tone, 'directo y técnico');

  // Reabrir sin repo es posible: `repo: null` explícito no hereda el del origen. Y sin repo la
  // sala NO se queda en plan: se le crea un proyecto nuevo donde los agentes escriben código.
  const sinRepo = await post(`${base}/api/rooms`, { from: code, repo: null });
  assert.equal(sinRepo.body.ok, true);
  assert.equal(sinRepo.body.repo.kind, 'scaffold', 'sin repo la sala crea su propio proyecto');
  assert.equal(sinRepo.body.repo.source, 'proyecto nuevo');
  assert.equal(sinRepo.body.delivery.kind, 'code');
  assert.equal(sinRepo.body.delivery.reason, 'proyecto-nuevo');
  assert.match(sinRepo.body.repo.branch, /^agora\//, 'el proyecto nuevo trae rama propia de la sala');

  // Solo planificación: lo único que hace que una sala acabe sin archivos, y lo pide el humano.
  const soloPlan = await post(`${base}/api/rooms`, { from: code, repo: null, settings: { planOnly: true } });
  assert.equal(soloPlan.body.repo, null, 'con solo planificación no se crea proyecto');
  assert.equal(soloPlan.body.delivery.kind, 'plan');
  assert.equal(soloPlan.body.delivery.reason, 'solo-planificacion');

  // Y un origen inexistente no crea una sala a medias.
  const bogus = await post(`${base}/api/rooms`, { from: 'zzzz99', task: 'Sala que no debe existir nunca.' });
  assert.equal(bogus.status, 404);

  // 4) Las plantillas son archivos editables a mano: añadir o borrar un JSON en la carpeta
  //    tiene que verse al momento. Antes la lista se cacheaba para siempre y una plantilla
  //    borrada del disco seguía apareciendo en el panel hasta reiniciar el servidor.
  fs.rmSync(path.join(TEMPLATES, `${saved.body.template.id}.json`));
  const trasBorrar = await j(`${base}/api/templates`);
  assert.equal(trasBorrar.body.templates.some(t => t.id === saved.body.template.id), false,
    'una plantilla borrada del disco desaparece de la lista');
  fs.writeFileSync(path.join(TEMPLATES, 'escrita-a-mano.json'),
    JSON.stringify({ name: 'Escrita a mano', task: 'Una tarea puesta directamente en la carpeta.', order: 90 }));
  const trasAnadir = await j(`${base}/api/templates`);
  assert.equal(trasAnadir.body.templates.some(t => t.id === 'escrita-a-mano'), true,
    'una plantilla nueva en disco se lista sin reiniciar');
});

// ---------------------------------------------------------------- 21
test('21 · sin repo la sala entrega código: proyecto propio, no un plan', async () => {
  const room = await createRoom({
    task: 'Construye el módulo de totales del proyecto y déjalo verificable.',
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1 },
  });
  assert.equal(room.repo.kind, 'scaffold', 'sin repo la sala se crea su propio proyecto');
  assert.equal(room.repo.source, 'proyecto nuevo');
  assert.match(room.repo.branch, /^agora\//, 'el proyecto nuevo trae rama propia de la sala');
  assert.equal(room.delivery.kind, 'code', 'la creación ya dice que se entrega código');
  assert.equal(room.delivery.reason, 'proyecto-nuevo');

  // El proyecto existe de verdad en el espacio de trabajo: git dentro y punto de partida escrito.
  const dir = path.join(DATA, 'workspaces', room.code, 'repo');
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'el proyecto nace con git dentro');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /Proyecto nuevo de la sala/, 'y con un README que dice qué es');
  assert.ok(readme.includes('Construye el módulo de totales'), 'y con la tarea dentro');

  const view = await j(`${base}/api/rooms/${room.code}/public`);
  assert.equal(view.body.room.delivery.kind, 'code');
  assert.equal(view.body.room.repo.kind, 'scaffold');

  // Sin código que auditar, el debate no pasa por auditoría: encuadre → propuestas.
  const join = await post(`${base}/api/rooms/${room.code}/join`, { name: 'Ana', harness: 'sim', model: 'test' });
  assert.equal(join.body.ok, true);
  const move = body => post(`${base}/api/rooms/${room.code}/move`, {
    agentId: join.body.agentId, token: join.body.token, ...body,
  });
  await move({ kind: 'start' });
  await move({ kind: 'pass' });
  const turn = (await j(`${base}/api/rooms/${room.code}/turn?agent=${join.body.agentId}&token=${join.body.token}&wait=1`)).body.turn;
  assert.equal(turn.phase, 'proposal', 'sin código que auditar se pasa directo a proponer');
  const log = (await j(`${base}/api/rooms/${room.code}/public`)).body.room.log.map(l => l.text).join('\n');
  assert.match(log, /entrega CÓDIGO/, 'el contrato de entrega se dice desde el encuadre');

  // Solo planificación: lo único que acaba sin código, y lo pide el humano a propósito.
  const soloPlan = await createRoom({
    task: 'Decide la estrategia del producto sin escribir una línea de código.',
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1, planOnly: true },
  });
  assert.equal(soloPlan.repo, null, 'con solo planificación no se crea proyecto');
  assert.equal(soloPlan.delivery.kind, 'plan');
  assert.equal(soloPlan.delivery.reason, 'solo-planificacion');
});

// ---------------------------------------------------------------- 22
test('22 · una tarea sin repo termina de extremo a extremo: archivos, verificación y commits', async () => {
  const room = await createRoom({
    task: 'Construye el módulo de totales y deja una comprobación que lo valide.',
    criteria: 'La comprobación tiene que pasar sobre el módulo escrito.',
    settings: { ...SHORT, minAgents: 2, expectedAgents: 2, repo: { verifyCommand: 'node check.mjs' } },
  });
  assert.equal(room.repo.kind, 'scaffold');
  assert.equal(room.repo.verify, 'node check.mjs', 'la verificación declarada sin repo se aplica al proyecto');

  // Cada tarea escribe SU archivo (y la comprobación que el servidor ejecutará): así dos agentes
  // trabajan a la vez sin pisarse y todas las partes del plan acaban integradas.
  const patch = turn => ({
    summary: `crea la parte ${turn.task.id} del proyecto`,
    files: [
      { path: `src/${turn.task.id}.mjs`, content: `export const ${turn.task.id} = 'listo';\n` },
      { path: 'check.mjs', content: "console.log('ok');\n" },
    ],
  });
  const [a, b] = await Promise.all([
    fakeAgent(room.code, 'Ana', { bias: 0, role: 'analyst', capabilities: ['data'], patch }),
    fakeAgent(room.code, 'Bruno', { bias: 1, role: 'skeptic', capabilities: ['risk'], patch }),
  ]);

  assert.ok(a.result.closed && b.result.closed, 'la sala cierra sola');
  const res = a.result.result;
  assert.equal(res.outcome, 'decided');
  assert.equal(res.delivery.kind, 'code', 'el informe entrega código, no un plan');
  assert.equal(res.delivery.reason, 'proyecto-nuevo');
  assert.ok(res.delivery.integrated >= 1, 'al menos una parte del plan integrada');
  assert.equal(res.delivery.integrated, res.delivery.items, 'todas las partes se trabajaron hasta el final');
  assert.ok(res.delivery.files >= 3, 'el proyecto acaba con los archivos escritos');
  assert.ok(res.work.commits.length >= 1, 'y con un commit de la sala');
  assert.ok(res.work.items.every(i => i.verify?.ok !== false), 'la verificación declarada pasó en todo lo integrado');

  const dir = path.join(DATA, 'workspaces', room.code, 'repo');
  assert.ok(fs.existsSync(path.join(dir, 'check.mjs')), 'la comprobación existe de verdad en el proyecto');
  assert.ok(fs.readdirSync(path.join(dir, 'src')).length >= 1, 'y los módulos escritos por los agentes');
  const log = (await j(`${base}/api/rooms/${room.code}/public`)).body.room.log.map(l => l.text).join('\n');
  assert.match(log, /Entrega:/, 'el acta dice qué se entrega');
});

// ---------------------------------------------------------------- 23
test('23 · vista previa: sirve el proyecto de la sala y nada más', async () => {
  const room = await createRoom({
    task: 'Construye la página del proyecto para poder verla en vivo.',
    settings: { ...SHORT, minAgents: 1, expectedAgents: 1 },
  });
  assert.equal(room.repo.kind, 'scaffold');

  // Sin página propia pero con módulos: la vista previa NO se queda en blanco. El servidor sirve
  // una PÁGINA DE PRUEBA que carga los módulos de verdad en el navegador, y lo declara (`synthetic`)
  // para que nadie confunda la prueba con el entregable. Además se enseña el código que se está
  // escribiendo: un proyecto de módulos no tiene por qué tener un `index.html`.
  const dirModulo = path.join(DATA, 'workspaces', room.code, 'repo');
  fs.mkdirSync(path.join(dirModulo, 'src/ocean'), { recursive: true });
  fs.writeFileSync(path.join(dirModulo, 'package.json'), JSON.stringify({ dependencies: { three: '^0.160.4' } }));
  fs.writeFileSync(path.join(dirModulo, 'src/ocean/WaterMaterial.js'),
    "import * as THREE from 'three';\nexport const agua = 1;\nexport const sal = 2;\n");
  const sinPagina = await j(`${base}/api/rooms/${room.code}/preview`);
  assert.equal(sinPagina.body.ok, true);
  assert.equal(sinPagina.body.preview.available, true, 'un módulo se puede probar: no se deja un hueco');
  assert.equal(sinPagina.body.preview.synthetic, true, 'y se dice que la página es de prueba, no del proyecto');
  assert.equal(sinPagina.body.preview.entry, '__agora__.html');
  assert.deepEqual(sinPagina.body.preview.modules, ['src/ocean/WaterMaterial.js']);
  assert.deepEqual(sinPagina.body.preview.imports, ['three'], 'los paquetes que el navegador no sabe resolver solo');
  assert.equal(sinPagina.body.preview.source.path, 'src/ocean/WaterMaterial.js', 'el módulo más reciente');
  assert.match(sinPagina.body.preview.source.code, /export const agua/);
  assert.equal(sinPagina.body.preview.source.truncated, false);

  // Y esa página de prueba se sirve por HTTP, con los módulos dentro y el informe de vuelta.
  const prueba = await fetch(`${base}/api/rooms/${room.code}/preview/__agora__.html`);
  assert.equal(prueba.status, 200);
  assert.match(prueba.headers.get('content-type') || '', /text\/html/);
  const pruebaHtml = await prueba.text();
  assert.match(pruebaHtml, /src\/ocean\/WaterMaterial\.js/);
  assert.match(pruebaHtml, /agoraPreview/, 'el informe de carga vuelve al panel');
  assert.match(pruebaHtml, /esm\.sh\/three@0\.160\.4/, 'y el paquete que el navegador no resolvería solo');

  // Se retira para que el resto de la prueba siga contando solo lo de después.
  fs.rmSync(path.join(dirModulo, 'src/ocean'), { recursive: true, force: true });
  fs.rmSync(path.join(dirModulo, 'package.json'), { force: true });

  // Los agentes escriben la página en el espacio de trabajo de la sala. Aquí se escribe a mano
  // porque lo que se prueba es el servidor de la vista previa, no el protocolo del trabajo.
  const dir = path.join(DATA, 'workspaces', room.code, 'repo');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Preview</title></head><body><h1>ola</h1><script type="module" src="./src/app.js"></script></body></html>\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/app.js'), "import * as THREE from 'three';\nexport const ola = 1;\n");
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { three: '^0.160.4' } }));

  const info = await j(`${base}/api/rooms/${room.code}/preview`);
  assert.equal(info.body.preview.available, true, 'con una página ya hay vista previa');
  assert.equal(info.body.preview.entry, 'index.html');
  assert.equal(info.body.preview.head, room.repo.head, 'dice de qué commit se está hablando');

  // Y dice lo que se está tocando AHORA: sin commitear, con su hora. Es lo que el panel pinta como
  // «escribiendo» y lo que hace que el iframe se recargue sin que nadie commitee nada.
  assert.equal(info.body.preview.changed.files, 3, 'la página, el módulo y su manifiesto recién escritos cuentan');
  assert.deepEqual(info.body.preview.changes.map(c => c.path).sort(), ['index.html', 'package.json', 'src/app.js']);
  assert.ok(info.body.preview.changes.every(c => c.status === 'nuevo' && c.at > 0));
  assert.ok(info.body.preview.lastWrite.at > 0, 'la última escritura viene con su hora');

  // Escribir un archivo YA rastreado mueve la firma: la vista se rehace sin commit ni reinicio.
  await new Promise(r => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Tarea\n\nreescrito en vivo\n');
  const tocado = await j(`${base}/api/rooms/${room.code}/preview`);
  assert.equal(tocado.body.preview.lastWrite.path, 'README.md');
  assert.notEqual(tocado.body.preview.lastWrite.at, info.body.preview.lastWrite.at, 'el árbol de trabajo se movió');
  assert.equal(tocado.body.preview.changes.find(c => c.path === 'README.md').status, 'editado');

  const page = await fetch(`${base}/api/rooms/${room.code}/preview/index.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
  // El origen del propio servidor va explícito en la política: el iframe tiene origen opaco y
  // `'self'` no le casa, así que sin esto la página se sirve pero sus módulos no cargan.
  assert.ok((page.headers.get('content-security-policy') || '').includes(`script-src 'self' ${new URL(base).origin}`), 'la política usa el origen real de la petición');
  assert.equal(page.headers.get('access-control-allow-origin'), '*', 'los módulos del iframe son cross-origin');
  const pageHtml = await page.text();
  assert.match(pageHtml, /ola/);
  // La página sale con el mapa de imports y la sonda de errores: así el proyecto corre igual que en
  // un navegador de verdad y una pantalla en blanco puede explicarse.
  assert.match(pageHtml, /<script type="importmap">/);
  assert.match(pageHtml, /agoraPreview/);
  assert.ok(pageHtml.indexOf('importmap') < pageHtml.indexOf('</head>'), 'el mapa va en el head, antes de los módulos');

  const mod = await fetch(`${base}/api/rooms/${room.code}/preview/src/app.js`);
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type') || '', /javascript/);

  // Fuera del árbol de trabajo no se sirve nada: ni saliendo con .., ni el .git.
  assert.equal((await fetch(`${base}/api/rooms/${room.code}/preview/..%2F..%2Fdata%2Fno.json`)).status, 403);
  assert.equal((await fetch(`${base}/api/rooms/${room.code}/preview/.git/config`)).status, 403);
  assert.equal((await fetch(`${base}/api/rooms/${room.code}/preview/no-existe.js`)).status, 404);

  // Solo planificación: sin proyecto no hay nada que previsualizar, y se dice con ese motivo.
  const plan = await createRoom({ task: 'Solo decide, sin escribir código.', settings: { ...SHORT, planOnly: true } });
  const sinProyecto = await j(`${base}/api/rooms/${plan.code}/preview`);
  assert.equal(sinProyecto.body.preview.available, false);
  assert.equal(sinProyecto.body.preview.reason, 'solo-planificacion');
});

// Borrar un trabajo tiene que borrarlo de verdad: la sala desaparece (404, fuera de la lista y
// sin archivo en disco) y no basta un clic — se pide el código como confirmación. Y a quien está
// dentro se le respeta: con un agente con señal reciente el servidor frena, y solo borra si se
// insiste a propósito.
test('un trabajo se borra de verdad — y con gente dentro hay que insistir a propósito', async () => {
  const vacia = await createRoom({ task: 'Un trabajo que ya no sirve para nada.', settings: { ...SHORT, planOnly: true } });
  const sinConfirmar = await post(`${base}/api/rooms/${vacia.code}/admin`, { adminToken: vacia.adminToken, op: 'delete', confirm: 'otro-codigo' });
  assert.equal(sinConfirmar.status, 400, 'sin el código exacto no se borra');
  const malToken = await post(`${base}/api/rooms/${vacia.code}/admin`, { adminToken: 'no-es-el-token', op: 'delete', confirm: vacia.code });
  assert.equal(malToken.status, 401);

  const borrada = await post(`${base}/api/rooms/${vacia.code}/admin`, { adminToken: vacia.adminToken, op: 'delete', confirm: vacia.code });
  assert.equal(borrada.status, 200, JSON.stringify(borrada.body));
  assert.equal(borrada.body.deleted.code, vacia.code);
  assert.equal((await j(`${base}/api/rooms/${vacia.code}/public`)).status, 404, 'la sala ya no existe');
  assert.ok(!(await j(`${base}/api/hall`)).body.rooms.some(r => r.code === vacia.code), 'y no aparece en la lista');
  assert.equal(fs.existsSync(path.join(DATA, `${vacia.code}.json`)), false, 'su archivo tampoco está');

  const viva = await createRoom({ task: 'Un trabajo con gente dentro que se quiere borrar.', settings: { ...SHORT, planOnly: true, minAgents: 1, expectedAgents: 1 } });
  const agente = (await post(`${base}/api/rooms/${viva.code}/join`, { name: 'Dentro', harness: 'test', model: 'test' })).body;
  assert.ok(agente.agentId);
  const ocupada = await post(`${base}/api/rooms/${viva.code}/admin`, { adminToken: viva.adminToken, op: 'delete', confirm: viva.code });
  assert.equal(ocupada.status, 409, 'no se borra un trabajo con alguien dentro sin querer');
  assert.match(ocupada.body.message || '', /señal reciente/);
  const forzada = await post(`${base}/api/rooms/${viva.code}/admin`, { adminToken: viva.adminToken, op: 'delete', confirm: viva.code, force: true });
  assert.equal(forzada.status, 200, JSON.stringify(forzada.body));
  assert.equal((await j(`${base}/api/rooms/${viva.code}/public`)).status, 404);

  // Y queda en el registro: un borrado no es un misterio.
  const logs = await j(`${base}/api/logs?room=${vacia.code}&limit=40`);
  assert.ok(logs.body.events.some(e => e.ev === 'room.delete'), 'el borrado queda registrado: ' + logs.body.events.map(e => e.ev).join(','));
});
