// AGORA — simulación de extremo a extremo: agentes falsos ejecutan el protocolo real.
// Uso: node test/sim.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data-sim');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.AGORA_DATA = DATA;
// import dinámico: AGORA_DATA debe estar fijado antes de que server.mjs lea el entorno
const { start } = await import('../server.mjs');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.log('  ✘ FALLO: ' + msg); }
}

const SHORT = {
  phaseMs: { lobby: 5000, proposal: 5000, critique: 5000, revise: 4000, vote: 4000, tiebreak: 4000, objection: 3000, repair: 4000, synthesis: 4000 },
  maxDurationMs: 90_000,
  joinQuietMs: 1500,
};

async function j(url, opts) { const r = await fetch(url, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; }

// ------------------------------------------------ agente falso genérico
async function fakeAgent(base, code, name, behavior) {
  const j1 = await j(`${base}/api/rooms/${code}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, model: name + '-model', harness: 'sim' }) });
  if (!j1.body.ok) throw new Error('join falló: ' + JSON.stringify(j1.body));
  const { agentId, token } = j1.body;
  const q = `agent=${agentId}&token=${token}`;
  const moves = [];
  let turn;
  for (let i = 0; i < 40; i++) {
    const r = await j(`${base}/api/rooms/${code}/turn?${q}&wait=${behavior.waitSec ?? 3}`);
    turn = r.body.turn;
    if (!turn) throw new Error(name + ': turn sin respuesta ' + JSON.stringify(r.body));
    const action = turn.action;
    if (action === 'done') break;
    let move = null;
    switch (action) {
      case 'start-or-wait': if (behavior.mayStart) move = { kind: 'start' }; break;
      case 'submit-proposal':
        move = { kind: 'proposal', payload: behavior.proposal() }; break;
      case 'submit-critique': {
        const t = turn.targets[0];
        move = { kind: 'critique', payload: { target: t.id, steelman: 'Lo mejor de esta idea es ' + t.title, objections: behavior.critique(t) } };
        break;
      }
      case 'submit-revision-or-pass':
        move = behavior.revises ? { kind: 'revision', payload: { proposalId: turn.proposalId, plan: behavior.revised(turn), note: 'abordé las objeciones de severidad alta' } } : { kind: 'pass' };
        break;
      case 'submit-vote': {
        const ranking = behavior.rank(turn.options.map(o => o.id), turn);
        move = { kind: 'vote', payload: { ranking } };
        break;
      }
      case 'submit-argument':
        move = { kind: 'argument', payload: { target: turn.finalists[0], text: 'Decisivo: ' + turn.finalists[0] + ' porque escala y cuesta menos. ' + 'x'.repeat(50) } };
        break;
      case 'objection-or-pass':
        move = behavior.blocker ? { kind: 'objection', payload: { text: behavior.blocker, severity: 'blocker' } } : { kind: 'pass' };
        break;
      case 'submit-synthesis':
        move = { kind: 'synthesis', payload: { final: 'PLAN FINAL\n' + turn.winner.plan + '\n\nINCORPORA:\n' + turn.objections.map(o => `- ${o.text}`).join('\n'), merges: turn.objections.map(o => o.id) } };
        break;
      case 'wait': break;
    }
    if (move) {
      const mr = await j(`${base}/api/rooms/${code}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId, token, ...move }) });
      moves.push({ action, status: mr.status, ok: mr.body.ok, error: mr.body.error });
      if (!mr.body.ok && mr.body.error !== 'wrong_phase' && mr.body.error !== 'duplicate') {
        // los 409 por carrera son tolerables; los demás no
        throw new Error(`${name}: move ${move.kind} rechazado: ${JSON.stringify(mr.body)}`);
      }
    }
  }
  const res = await j(`${base}/api/rooms/${code}/result?${q}`);
  return { agentId, name, moves, result: res.body, lastTurn: turn };
}

function proposalFor(name) {
  return () => ({
    title: `Plan ${name}: arquitectura escalable`,
    plan: `1. ${name} propone módulo de caché con Redis + invalidación por eventos.\n2. Cola para escrituras.\n3. Métricas y alertas.\n` + 'Detalle suficiente para superar los 30 caracteres de mínimo.',
    risks: 'coste de Redis en picos',
  });
}
function critiqueFor(seed) {
  return (t) => ([
    { type: 'cost', severity: 'high', text: `(${seed}) Redis gestionado a 500rps con TLS + réplicas excede los $50/mes; escenario: pico de escrituras de madrugada.` },
    { type: 'risk', severity: 'med', text: `(${seed}) La invalidación por eventos pierde mensajes si la cola se satura; dato obsoleto servido como fresco.` },
    { type: 'missing-info', severity: 'low', text: `(${seed}) No define qué pasa si la cola cae más de 30s.` },
  ]);
}

// ------------------------------------------------ 1) debate completo
async function testFull(base) {
  console.log('\n— TEST 1: debate completo con 3 agentes, veto y reparación');
  const cr = await j(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Diseñar la capa de caché para una API de búsqueda a 500 rps con $50/mes.', context: 'Node.js + Postgres.', criteria: 'Coste, latencia p95 < 80ms, complejidad operativa.', settings: { ...SHORT, minAgents: 2, expectedAgents: 3 } }) });
  ok(cr.body.ok, 'sala creada: ' + cr.body.code);
  const code = cr.body.code;

  const [a, b, c] = await Promise.all([
    fakeAgent(base, code, 'Ana', { mayStart: false, proposal: proposalFor('Ana'), critique: critiqueFor('A'), revises: true, revised: t => t.proposalId ? `1. Redis auto-gestionado en VPS (no managed) para respetar $50.\n2. Invalidación con acks y reconciliación cada 30s.\n3. Fallback a Postgres si la cola cae >30s. Detalle extendido para el mínimo.` : '', rank: (ids, turn) => [...ids].sort(x => x === turn.options.find(o => o.author === 'Ana') ? -1 : 1) || ids, waitSec: 2 }),
    fakeAgent(base, code, 'Bruno', { mayStart: false, proposal: proposalFor('Bruno'), critique: critiqueFor('B'), revises: true, revised: t => t.proposalId ? `1. Caché en proceso LRU + shared dictionary.\n2. Sin cola: escrituras directas con lock optimista.\n3. Presupuesto $0 en infra extra. Detalle extendido para el mínimo.` : '', rank: ids => ids, waitSec: 2 }),
    fakeAgent(base, code, 'Ciro', { mayStart: false, proposal: proposalFor('Ciro'), critique: critiqueFor('C'), revises: false, rank: ids => ids, blocker: 'Ninguno de los planes define la política de invalidación del caché en proceso al escalar horizontalmente: con 3 réplicas servirán datos obsoletos de forma indeterminada.', waitSec: 2 }),
  ]);

  ok(a.result.closed && b.result.closed && c.result.closed, 'los 3 agentes vieron la sala cerrada');
  const res = a.result.result;
  ok(res && res.outcome === 'decided', 'resultado decidido (outcome=' + res?.outcome + ')');
  ok(res && res.winner && res.winner.plan.length > 30, 'plan ganador presente');
  ok(res && /^sha256:[0-9a-f]{64}$/.test(res.checksum), 'checksum válido: ' + (res?.checksum || '').slice(0, 24) + '…');
  ok(res && res.final && res.final.startsWith('PLAN FINAL'), 'síntesis final producida');
  ok(res && res.dissent.some(d => d.severity === 'blocker' && d.addressed), 'veto registrado y respondido en la síntesis');
  ok(res && res.stats.durationMin <= 2, `debate eficiente: ${res?.stats?.durationMin} min (máx 2)`);
  const statuses = [a, b, c].flatMap(x => x.moves.map(m => m.status));
  ok(statuses.every(s => s === 200), 'todos los movimientos aceptados sin errores de protocolo');
}

// ------------------------------------------------ 2) agente silencioso
async function testSilent(base) {
  console.log('\n— TEST 2: un agente se queda mudo; el debate avanza por plazos');
  const cr = await j(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Elegir base de datos para analítica de eventos de una app móvil.', settings: { ...SHORT, minAgents: 2, expectedAgents: 3 } }) });
  const code = cr.body.code;
  // mudo: solo entra, no habla
  await j(`${base}/api/rooms/${code}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Mudo', model: 'x', harness: 'sim' }) });
  const [a, b] = await Promise.all([
    fakeAgent(base, code, 'Dana', { proposal: proposalFor('Dana'), critique: critiqueFor('D'), revises: true, revised: t => t.proposalId ? `Revisado: añadí costes y fallback. ` + 'y'.repeat(60) : '', rank: ids => ids, waitSec: 2 }),
    fakeAgent(base, code, 'Elena', { proposal: proposalFor('Elena'), critique: critiqueFor('E'), revises: false, rank: ids => ids, waitSec: 2 }),
  ]);
  ok(a.result.closed && b.result.closed, 'sala cerrada pese al agente mudo');
  ok(a.result.result?.outcome === 'decided', 'resultado decidido sin el mudo');
  const publicRoom = await j(`${base}/api/rooms/${code}/public`);
  ok(publicRoom.body.room.log.some(l => l.kind === 'timeout'), 'el mudo fue marcado por plazo (transparencia)');
}

// ------------------------------------------------ 3) modo solo
async function testSolo(base) {
  console.log('\n— TEST 3: modo solo (un agente, autocrítica estructurada)');
  const cr = await j(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Plan de refactor del módulo de autenticación legacy.', settings: { ...SHORT, minAgents: 1, expectedAgents: 1 } }) });
  const code = cr.body.code;
  const a = await fakeAgent(base, code, 'Solo', { proposal: proposalFor('Solo'), critique: critiqueFor('S'), revises: true, revised: t => t.proposalId ? `Autocorregido tras autocrítica: ` + 'z'.repeat(80) : '', rank: ids => ids, waitSec: 2 });
  ok(a.result.closed && a.result.result?.outcome === 'decided', 'solo: debate cerrado con resultado');
  ok(a.result.result?.final && a.result.result.final.length > 50, 'solo: síntesis final presente');
}

// ------------------------------------------------ 4) long-poll
async function testLongPoll(base) {
  console.log('\n— TEST 4: long-poll bloquea y despierta');
  // sala en lobby (minAgents 2, solo entra 1): la acción es 'wait' → debe bloquear
  const cr = await j(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Prueba de long-poll del protocolo AGORA.', settings: { ...SHORT, minAgents: 2, expectedAgents: 0 } }) });
  const code = cr.body.code;
  const jn = await j(`${base}/api/rooms/${code}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'LP' }) });
  const q = `agent=${jn.body.agentId}&token=${jn.body.token}`;
  const t0 = Date.now();
  const r0 = await j(`${base}/api/rooms/${code}/turn?${q}&wait=2`);
  const dt = Date.now() - t0;
  ok(dt >= 1800 && r0.body.turn.action === 'wait', `long-poll esperó ~2s sin trabajo (${dt}ms, action=${r0.body.turn.action})`);
  // cuando hay acción: responde inmediatamente (sala solo → auto-arranque)
  const cr2 = await j(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Prueba de respuesta inmediata con acción pendiente.', settings: { ...SHORT, minAgents: 1, expectedAgents: 1 } }) });
  const jn2 = await j(`${base}/api/rooms/${cr2.body.code}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'LP2' }) });
  const q2 = `agent=${jn2.body.agentId}&token=${jn2.body.token}`;
  const t1 = Date.now();
  const r = await j(`${base}/api/rooms/${cr2.body.code}/turn?${q2}&wait=2`);
  ok(Date.now() - t1 < 500 && r.body.turn.action === 'submit-proposal', 'cuando hay acción responde inmediatamente');
}

// ------------------------------------------------ 5) persistencia + bootstrap
async function testMisc(base) {
  console.log('\n— TEST 5: bootstrap para agentes y persistencia');
  const rooms = JSON.parse(fs.readdirSync(DATA).length ? 'true' : 'false');
  ok(rooms, 'las salas se persisten en disco');
  const cr = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Verificación del bootstrap autoexplicativo para agentes.' }) }).then(r => r.json());
  const txt = await fetch(`${base}/r/${cr.code}`).then(r => r.text());
  ok(txt.includes('TAREA:') && txt.includes('/api/rooms/' + cr.code + '/join'), 'bootstrap de sala autoexplicativo (texto plano sin Accept: text/html)');
  const html = await fetch(`${base}/r/${cr.code}`, { headers: { Accept: 'text/html' } }).then(r => r.text());
  ok(html.includes('<!doctype html>'), 'navegadores reciben el panel (content negotiation)');
  const man = await fetch(`${base}/manual`).then(r => r.text());
  ok(man.includes('# AGORA'), 'manual de protocolo servido en /manual');
  // unauthorized
  const bad = await j(`${base}/api/rooms/${cr.code}/turn?agent=a9&token=nope`);
  ok(bad.status === 404 || bad.status === 401, 'tokens inválidos rechazados');
}

// ------------------------------------------------ main
const { port } = await start(8891);
const base = `http://localhost:${port}`;
try {
  await testFull(base);
  await testSilent(base);
  await testSolo(base);
  await testLongPoll(base);
  await testMisc(base);
} catch (e) {
  failed++;
  console.error('  ✘ EXCEPCIÓN:', e.message);
} finally {
  console.log(`\n═══ RESULTADO: ${passed} ok, ${failed} fallos ═══`);
  process.exit(failed ? 1 : 0);
}
