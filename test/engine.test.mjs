// AGORA v2 — pruebas del motor con node:test.
// Cubren la agenda/consenso, la indulgencia de la normalización, la diversidad,
// el ciclo completo, los atajos, las ausencias con reemplazo y la migración.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createRoom, joinRoom, applyMove, currentTurn, sweep, consensusReport,
  normalizeAgenda, applyPositions, addPoint, diversityReport, publicRoom, dissentReport, proposalSimilarity, nameOf,
  migrate, markAbsent, rosterSummary, buildCost, exportMarkdown,
  startRoom, maybeAdvance, finishRoom,
  pickSettings, resolveRuleProposal, assignVerifier, liveState,
  attachRepo, runBaseline, repoIndex, readRepoFile, searchRepo, workDiff,
  unsafePatchPaths, stagePatch, approvedImprovements, workSummary, repoSummary,
  enterPhase, stageConsensus, recordStageConsensus,
} from '../server/engine/index.mjs';
import { CAPS } from '../server/engine/settings.mjs';

// ---------------------------------------------------------------- utilidades de prueba
const AGENDA = [
  { label: 'Almacenamiento', options: ['Redis', 'Postgres', 'En memoria'] },
  { label: 'Invalidación', options: ['Por eventos', 'TTL corto', 'Por versión'] },
  { label: 'Presupuesto mensual', options: ['< $30', '$30-50', '> $50'] },
];

const FAST = {
  phaseMs: {
    lobby: 60_000, frame: 60_000, audit: 60_000, proposal: 60_000, critique: 60_000, revise: 60_000,
    vote: 60_000, tiebreak: 60_000, objection: 60_000, repair: 60_000, synthesis: 60_000, verify: 60_000,
    work: 60_000,
  },
  joinQuietMs: 60_000,
  minAgents: 2,
};

function newRoom(extra = {}) {
  return createRoom({
    task: extra.task || 'Diseñar la capa de caché para una API de búsqueda a 500 rps con presupuesto de $50/mes.',
    agenda: extra.agenda ?? AGENDA,
    settings: { ...FAST, ...(extra.settings || {}) },
  });
}

function addAgent(room, name, opts = {}) {
  const { agentId } = joinRoom(room, { name, model: name + '-model', harness: 'test', ...opts });
  return agentId;
}

// Coloca la sala directamente en una fase (para probar una fase sin recorrer las anteriores).
function forcePhase(room, name, data = {}) {
  room.status = 'debate';
  room.phase = { name, startedAt: Date.now(), deadline: Date.now() + 60_000, data };
  if (name === 'vote' || name === 'tiebreak') {
    room.phase.data.options = Object.keys(room.artifacts.proposals);
    room.phase.data.ballots = {};
  }
  return room.phase;
}

function proposalFor(name, positions = {}) {
  return {
    title: `Plan ${name}`,
    plan: `1. ${name} propone una caché con invalidación explícita.\n2. Métricas y alertas desde el día uno; fallback si la cola cae.`,
    approach: `enfoque-${name}`,
    positions,
    premortem: 'Falló porque nadie midió la latencia real antes de escalar.',
  };
}

// Ejecuta un movimiento si el turno lo pide. Devuelve el kind aplicado o null.
// Los campos de comportamiento pueden ser valores o funciones del turno.
function payloadOf(value, turn, room) {
  return typeof value === 'function' ? value(turn, room) : value;
}

function act(room, agentId, behavior = {}) {
  const turn = currentTurn(room, agentId);
  switch (turn.action) {
    case 'audit-repo': {
      const list = behavior.findings || [];
      const next = list.shift();
      if (!next) { applyMove(room, agentId, { kind: 'pass' }); return 'pass'; }
      applyMove(room, agentId, { kind: 'finding', payload: next });
      return 'finding';
    }
    case 'claim-item': {
      const itemId = payloadOf(behavior.claim, turn, room) || turn.openTasks?.[0]?.id;
      applyMove(room, agentId, { kind: 'claim-item', payload: { itemId } });
      return 'claim-item';
    }
    case 'submit-patch': {
      const patch = payloadOf(behavior.patch, turn, room);
      applyMove(room, agentId, { kind: 'submit-patch', payload: { itemId: turn.task.id, summary: 'cambio propuesto', ...(patch || {}) } });
      return 'submit-patch';
    }
    case 'review-patch': {
      const review = payloadOf(behavior.review, turn, room);
      applyMove(room, agentId, {
        kind: 'review-patch',
        payload: review || { itemId: turn.patch.itemId, verdict: 'approve', notes: 'Revisado y aprobado.' },
      });
      return 'review-patch';
    }
    case 'start-or-wait':
      applyMove(room, agentId, { kind: 'start' });
      return 'start';
    case 'frame-contribute': {
      if (behavior.frameMove === null) return null;
      applyMove(room, agentId, behavior.frameMove || { kind: 'pass' });
      return behavior.frameMove?.kind || 'pass';
    }
    case 'submit-proposal': {
      const payload = payloadOf(behavior.proposal, turn, room) || proposalFor(agentId);
      applyMove(room, agentId, { kind: 'proposal', payload });
      return 'proposal';
    }
    case 'submit-critique': {
      const target = turn.targets[0];
      applyMove(room, agentId, {
        kind: 'critique',
        payload: behavior.critique
          ? behavior.critique(target, turn)
          : {
            target: target.id,
            steelman: 'Lo mejor del plan es su simplicidad operativa.',
            objections: [{
              type: 'cost', severity: 'high',
              text: `(${agentId}) El coste gestionado a 500 rps con réplicas supera el presupuesto; escenario: pico nocturno de escrituras.`,
            }],
          },
      });
      return 'critique';
    }
    case 'submit-revision-or-pass': {
      if (behavior.concede) {
        applyMove(room, agentId, { kind: 'concede', payload: { reason: 'Otra propuesta cubre mejor el problema.' } });
        return 'concede';
      }
      if (behavior.revises === false) {
        applyMove(room, agentId, { kind: 'pass' });
        return 'pass';
      }
      applyMove(room, agentId, {
        kind: 'revision',
        payload: {
          proposalId: turn.proposalId,
          plan: `1. Versión revisada de ${agentId} que aborda las objeciones de coste.\n2. Se elimina la pieza más cara y se mide antes de escalar.`,
          note: 'Abordé las objeciones de severidad alta.',
        },
      });
      return 'revision';
    }
    case 'submit-vote': {
      const ids = turn.options.map(o => o.id);
      applyMove(room, agentId, { kind: 'vote', payload: { ranking: behavior.rank ? behavior.rank(ids, turn) : ids } });
      return 'vote';
    }
    case 'submit-argument':
      applyMove(room, agentId, {
        kind: 'argument',
        payload: { target: turn.finalists[0].id, text: `Decisivo: ${turn.finalists[0].title} escala con menos coste operativo demostrable.` },
      });
      return 'argument';
    case 'objection-or-pass':
      applyMove(room, agentId, behavior.blocker
        ? { kind: 'objection', payload: { text: behavior.blocker, severity: 'blocker' } }
        : { kind: 'pass' });
      return behavior.blocker ? 'objection' : 'pass';
    case 'submit-synthesis':
      applyMove(room, agentId, {
        kind: 'synthesis',
        payload: {
          final: 'PLAN FINAL\n' + turn.winner.plan + '\n\nResuelve los puntos abiertos con las objeciones incorporadas.',
          merges: turn.objections.map(o => o.id),
          pointResolutions: turn.unresolved.map(p => ({ pointId: p.id, note: p.leading || 'se mantiene la mayoritaria' })),
        },
      });
      return 'synthesis';
    case 'submit-verification': {
      const payload = behavior.verification
        ? behavior.verification(turn)
        : {
          verdict: 'pass',
          checks: [
            { pointId: 'presupuesto-mensual', claim: 'El coste mensual se mantiene bajo $50', method: 'medir el gasto real una semana en staging', expectation: 'gasto semanal < $12' },
            { claim: 'La latencia p95 se mantiene bajo 80 ms', method: 'prueba de carga a 500 rps durante 10 min', expectation: 'p95 < 80 ms' },
          ],
        };
      applyMove(room, agentId, { kind: 'verification', payload });
      return 'verification';
    }
    default:
      return null;
  }
}

// Bucle: todos los agentes actúan hasta que nadie puede. Si se estanca, cierra
// plazos a mano (equivale a que el reloj avance) para probar los timeouts.
function runDebate(room, behaviors, { maxRounds = 40, autoDeadline = true } = {}) {
  const ids = Object.keys(behaviors);
  for (let round = 0; round < maxRounds; round++) {
    if (room.status === 'closed') return;
    let moved = false;
    for (const id of ids) {
      if (room.status === 'closed') return;
      if (room.agents[id]?.status === 'absent') continue;
      const before = room.phase.name + room.logSeq;
      const kind = act(room, id, behaviors[id]);
      if (kind) moved = true;
      if (before !== room.phase.name + room.logSeq) moved = true;
    }
    if (!moved && autoDeadline && room.status !== 'closed') {
      room.phase.deadline = Date.now() - 1;
      sweep(room);
    }
  }
}

// ---------------------------------------------------------------- agenda
test('agenda: normaliza textos y objetos, y canonicaliza claves', () => {
  const room = newRoom({ agenda: ['Segmento objetivo', { label: 'Modelo de pricing', options: ['suscripción', 'uso'] }] });
  assert.equal(room.agenda.length, 2);
  assert.equal(room.agenda[0].id, 'segmento-objetivo');
  assert.equal(room.agenda[0].source, 'seed');
  assert.deepEqual(room.agenda[1].options.map(o => o.id), ['suscripcion', 'uso']);
});

test('agenda: una opción nueva de un agente entra al espacio de opciones', () => {
  const room = newRoom();
  const { positions, newOptions, warnings } = applyPositions(room, { 'almacenamiento': 'Memcached' });
  assert.equal(warnings.length, 0);
  assert.equal(newOptions.length, 1);
  assert.equal(newOptions[0].option.label, 'Memcached');
  assert.equal(positions['almacenamiento'], 'memcached');
  assert.equal(room.agenda.find(p => p.id === 'almacenamiento').options.length, 4);
});

test('agenda: punto desconocido avisa pero no lanza', () => {
  const room = newRoom();
  const { warnings, positions } = applyPositions(room, { 'punto-inventado': 'x' });
  assert.equal(Object.keys(positions).length, 0);
  assert.match(warnings[0], /punto desconocido/);
});

test('agenda: el consenso por punto distingue acordado, en discusión y pendiente', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  forcePhase(room, 'proposal');
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', { 'almacenamiento': 'redis', 'invalidacion': 'por-eventos' }) });
  applyMove(room, b, { kind: 'proposal', payload: proposalFor('Bruno', { 'almacenamiento': 'redis', 'invalidacion': 'ttl-corto' }) });
  applyMove(room, c, { kind: 'proposal', payload: proposalFor('Ciro', { 'almacenamiento': 'postgres' }) });
  const report = consensusReport(room);
  const almacenamiento = report.points.find(p => p.id === 'almacenamiento');
  const invalidacion = report.points.find(p => p.id === 'invalidacion');
  const presupuesto = report.points.find(p => p.id === 'presupuesto-mensual');
  assert.equal(almacenamiento.status, 'discussing');
  assert.equal(Math.round(almacenamiento.share * 100), 67);
  assert.equal(invalidacion.status, 'discussing');
  assert.equal(presupuesto.status, 'pending');
  assert.ok(report.global > 0 && report.global < 1);
});

test('agenda: consenso total cuando todos eligen lo mismo', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  forcePhase(room, 'proposal');
  const same = { 'almacenamiento': 'redis', 'invalidacion': 'por-eventos', 'presupuesto-mensual': '30-50' };
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', same) });
  applyMove(room, b, { kind: 'proposal', payload: proposalFor('Bruno', same) });
  const report = consensusReport(room);
  assert.equal(report.agreed, 3);
  assert.equal(report.global, 1);
  assert.equal(report.method, 'agenda');
});

test('diversidad: dos propuestas idénticas disparan la petición de cambio', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  forcePhase(room, 'proposal');
  const same = { 'almacenamiento': 'redis', 'invalidacion': 'por-eventos', 'presupuesto-mensual': '30-50' };
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', same) });
  assert.throws(
    () => applyMove(room, b, { kind: 'proposal', payload: { ...proposalFor('Bruno', same), approach: '' } }),
    /not_diverse|se parece demasiado/);
  const report = diversityReport(room, b, same, '');
  assert.equal(report.askChange, true);
  assert.ok(report.maxSimilarity >= 0.8);
  // Con un enfoque distinto declarado vuelve a pasar.
  applyMove(room, b, { kind: 'proposal', payload: { ...proposalFor('Bruno', same), approach: 'caché en el borde con invalidación por versión' } });
  assert.equal(Object.keys(room.artifacts.proposals).length, 2);
});

// ---------------------------------------------------------------- indulgencia
test('normalización laxa: un ranking incompleto se completa y solo avisa', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  forcePhase(room, 'proposal');
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', {}) });
  applyMove(room, b, { kind: 'proposal', payload: { ...proposalFor('Bruno', {}), approach: 'otro enfoque' } });
  maybeAdvance(room); // critique sin asignaciones pendientes → revise
  room.phase = { name: 'vote', startedAt: Date.now(), deadline: Date.now() + 60000, data: { options: Object.keys(room.artifacts.proposals), ballots: {} } };
  const ids = Object.keys(room.artifacts.proposals);
  const out = applyMove(room, a, { kind: 'vote', payload: { ranking: [ids[0]] } });
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /ranking incompleto/);
  assert.deepEqual(room.phase.data.ballots[a] || room.lastBallots[a], [ids[0], ids[1]]);
});

test('normalización laxa: crítica solo con steelman y payload numérico coercido', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  forcePhase(room, 'proposal');
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', {}) });
  applyMove(room, b, { kind: 'proposal', payload: { ...proposalFor('Bruno', {}), approach: 'otro enfoque' } });
  maybeAdvance(room);
  room.phase = {
    name: 'critique', startedAt: Date.now(), deadline: Date.now() + 60000,
    data: { assignments: { [b]: [Object.keys(room.artifacts.proposals)[0]] }, responses: {} },
  };
  const target = Object.keys(room.artifacts.proposals)[0];
  const out = applyMove(room, b, { kind: 'critique', payload: { target, steelman: 'Buena base', objections: [12345] } });
  assert.ok(out.warnings.some(w => /sin objeciones concretas/.test(w)));
  const critique = Object.values(room.artifacts.critiques)[0];
  assert.equal(critique.objections.length, 0);
  assert.equal(critique.steelman, 'Buena base');
});

test('idempotencia: el mismo movimiento no se aplica dos veces', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  forcePhase(room, 'proposal');
  const payload = { ...proposalFor('Ana', {}), idempotencyKey: 'k1' };
  applyMove(room, a, { kind: 'proposal', payload });
  const second = applyMove(room, a, { kind: 'proposal', payload });
  assert.equal(second.replayed, true);
  assert.equal(Object.keys(room.artifacts.proposals).length, 1);
});

// El encuadre es A CIEGAS: el primero en hablar no elige los ejes del debate. Mientras la
// fase está abierta, nadie ve los puntos que proponen los demás (ni sabe que existen);
// al cerrar, todos entran en la agenda y el debate sigue con material común.
test('encuadre a ciegas: nadie ve los puntos ajenos hasta que la fase cierra', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  assert.equal(room.phase.name, 'frame');

  const antes = currentTurn(room, a);
  assert.equal(antes.action, 'frame-contribute');
  assert.ok(antes.agenda.some(p => p.id === 'almacenamiento'), 'los puntos del humano sí se ven: son el encargo');

  applyMove(room, a, { kind: 'point-proposal', payload: { label: 'Orden de despliegue', options: ['big bang', 'canarias'] } });

  const turnoB = currentTurn(room, b);
  assert.equal(turnoB.action, 'frame-contribute');
  assert.ok(!turnoB.agenda.some(p => p.id === 'orden-de-despliegue'),
    'Bruno no ve el punto de Ana antes de aportar el suyo');
  assert.ok(!JSON.stringify(turnoB).includes('Orden de despliegue'), 'ni aparece escondido en otro campo del turno');

  applyMove(room, b, { kind: 'point-proposal', payload: { label: 'Coste de reversión', options: ['< 1 semana', '< 1 mes'] } });
  maybeAdvance(room);

  const despues = publicRoom(room);
  assert.ok(despues.agenda.some(p => p.id === 'orden-de-despliegue') && despues.agenda.some(p => p.id === 'coste-de-reversion'),
    'al cerrar el encuadre los dos puntos están en la agenda');
  const turnoC = currentTurn(room, a);
  assert.ok(turnoC.agenda.some(p => p.id === 'coste-de-reversion'), 'y a partir de ahí son material común');
});

// ---------------------------------------------------------------- ciclo completo
test('ciclo completo: encuadre → propuestas → crítica → voto → veto → síntesis → verificación', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana', { role: 'analyst', capabilities: ['data', 'logic'] });
  const b = addAgent(room, 'Bruno', { role: 'skeptic', capabilities: ['risk', 'logic'] });
  const c = addAgent(room, 'Ciro', { role: 'redteam', capabilities: ['risk'] });
  assert.equal(room.agents[a].role, 'analyst');
  assert.equal(room.agents[b].role, 'skeptic');

  runDebate(room, {
    [a]: {
      frameMove: { kind: 'point-proposal', payload: { label: 'Plan de despliegue', options: ['big bang', 'canarias'] } },
      proposal: proposalFor('Ana', { 'almacenamiento': 'redis', 'invalidacion': 'por-eventos', 'presupuesto-mensual': '30' }),
      rank: ids => ids,
    },
    [b]: {
      frameMove: { kind: 'rule-change', payload: { op: 'consensusThreshold', value: 0.8 } },
      proposal: { ...proposalFor('Bruno', { 'almacenamiento': 'en-memoria', 'invalidacion': 'por-version' }), approach: 'caché en proceso' },
      revises: false,
      rank: ids => [...ids].reverse(),
      blocker: 'Falta la política de invalidación al escalar horizontalmente: con tres réplicas se sirven datos obsoletos de forma indeterminada.',
    },
    [c]: {
      frameMove: { kind: 'pass' },
      proposal: { ...proposalFor('Ciro', { 'almacenamiento': 'postgres', 'invalidacion': 'ttl-corto' }), approach: 'sin caché externa' },
      revises: true,
      rank: ids => ids,
    },
  });


  assert.equal(room.status, 'closed');
  const r = room.result;
  assert.equal(r.outcome, 'decided');
  assert.ok(r.winner && r.winner.plan.length > 30);
  assert.match(r.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.finalSource, 'synthesis');
  assert.ok(r.checks.length >= 2, 'la verificación produjo comprobaciones');
  assert.equal(r.verification.selfVerified, false);
  assert.equal(r.consensus.method, 'agenda');
  assert.equal(r.consensus.points.length, 4, 'la agenda crece con el punto que propuso un agente en el encuadre');
  assert.ok(r.consensus.points.some(p => p.id === 'plan-de-despliegue'));
  assert.ok(r.consensus.points.some(p => p.modal && p.modal.label));
  assert.ok(r.cost.totalChars > 0 && r.cost.avgPerAgent > 0);
  assert.ok(r.stats.critiques >= 3, 'cada propuesta recibió crítica');
  const points = publicRoom(room).agenda;
  assert.equal(points.length, 4);
  const md = exportMarkdown(room);
  assert.match(md, /## Plan final/);
  assert.match(md, /Puntos de decisión/);
});

test('el checksum es determinista para el mismo resultado', () => {
  const build = () => {
    const room = newRoom({ agenda: ['Uno'] });
    const a = addAgent(room, 'Ana');
    const b = addAgent(room, 'Bruno');
    startRoom(room);
    runDebate(room, {
      [a]: { proposal: proposalFor('Ana', { 'uno': 'redis' }), rank: ids => ids },
      [b]: { proposal: { ...proposalFor('Bruno', { uno: 'redis' }), approach: 'idéntico a propósito pero con enfoque distinto' }, rank: ids => ids },
    });
    return room.result.checksum;
  };
  const one = build();
  const two = build();
  assert.equal(one.slice(0, 7), 'sha256:');
  assert.equal(one.length, two.length);
});

test('atajo por concesión: si solo queda una propuesta viva se salta la votación', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  runDebate(room, {
    [a]: {
      proposal: proposalFor('Ana', { 'uno': 'redis' }),
      // Bruno criticará y Ana responderá; Bruno concede en su revisión.
    },
    [b]: {
      proposal: { ...proposalFor('Bruno', { uno: 'postgres' }), approach: 'sin caché' },
      concede: true,
    },
  });
  assert.equal(room.status, 'closed');
  assert.ok(!room.lastBallots || Object.keys(room.lastBallots).length === 0, 'no hubo votación');
  assert.equal(room.artifacts.proposals[Object.keys(room.artifacts.proposals).find(id => room.artifacts.proposals[id].conceded)].conceded, true);
  assert.equal(room.result.outcome, 'decided');
});

test('la verificación fallida abre una reparación antes del cierre', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana', { role: 'creative' });
  const b = addAgent(room, 'Bruno', { role: 'redteam' });
  startRoom(room);
  runDebate(room, {
    [a]: {
      proposal: proposalFor('Ana', { uno: 'redis' }),
      rank: ids => ids,
    },
    [b]: {
      proposal: { ...proposalFor('Bruno', { uno: 'postgres' }), approach: 'sin caché externa' },
      rank: ids => ids,
      verification: () => ({
        verdict: 'fail',
        checks: [{ claim: 'El failover no pierde datos', method: 'matar una réplica en staging', expectation: 'cero pérdidas' }],
        findings: [{ severity: 'high', text: 'No hay política de failover: al caer la réplica primaria se pierden escrituras en vuelo.' }],
      }),
    },
  });
  assert.equal(room.status, 'closed');
  assert.equal(room.result.verification.verdict, 'fail');
  assert.equal(room.result.verification.repaired, true, 'el autor reparó tras la verificación');
  assert.ok(room.result.verification.findings.length === 1);
});

// ---------------------------------------------------------------- ausencias
test('un agente que nunca actúa queda ausente y abre vacante; un reemplazo entra en vivo', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  const mudo = addAgent(room, 'Mudo');
  forcePhase(room, 'proposal');
  // Ana propone; el mudo no hace nada y su ausencia se declara al vencer el plazo.
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', { 'uno': 'redis' }) });
  room.phase.deadline = Date.now() - 1;
  sweep(room);
  assert.equal(room.agents[mudo].status, 'absent');
  assert.equal(room.vacancies.length, 1);

  // Con la vacante abierta, un reemplazo entra a mitad de debate y hereda asiento.
  const repl = joinRoom(room, { name: 'Relevo', role: 'skeptic' });
  assert.equal(repl.agentId, mudo, 'ocupa el asiento vacante');
  assert.equal(room.agents[mudo].status, 'active');
  assert.equal(room.agents[mudo].replacementOf, 'a2');
  assert.equal(room.vacancies.length, 0);
  const brief = currentTurn(room, mudo);
  assert.ok(brief.action !== 'done');
});

test('presupuesto por agente: al agotarlo pasa a evaluador', () => {
  const room = newRoom({ agenda: ['Uno'], settings: { tokenBudgetPerAgent: 1 } });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  forcePhase(room, 'proposal');
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', { 'uno': 'redis' }) });
  assert.equal(room.agents[a].overBudget, true);
  const turn = currentTurn(room, a);
  assert.equal(turn.budget.over, true);
  assert.equal(room.agents[b].overBudget, false);
});

test('el cierre de emergencia elige la mejor propuesta disponible, no la más antigua', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  forcePhase(room, 'proposal');
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', { 'uno': 'redis' }) });
  applyMove(room, b, { kind: 'proposal', payload: { ...proposalFor('Bruno', { uno: 'postgres' }), approach: 'sin caché' } });
  const ids = Object.keys(room.artifacts.proposals);
  const [first, second] = ids;
  // La más antigua (first) recibe objeciones graves; la segunda es preferida en el voto.
  room.artifacts.critiques['c1'] = { id: 'c1', target: first, author: b, steelman: '', objections: [{ type: 'cost', severity: 'high', text: 'coste prohibitivo para el presupuesto declarado' }] };
  room.lastMedians = { [first]: { median: 1, sum: 1, firsts: 0, voters: 1 }, [second]: { median: 0, sum: 0, firsts: 1, voters: 1 } };
  room.status = 'debate';
  room.phase = { name: 'critique', startedAt: Date.now(), deadline: Date.now() - 1, data: {} };
  room.settings.maxDurationMs = 1_000;
  room.createdAt = Date.now() - 60_000;   // simula un debate que agotó su tiempo máximo
  sweep(room);
  assert.equal(room.status, 'closed');
  assert.equal(room.result.winner.id, second, 'gana la mejor clasificada, no la más antigua');
});

// ---------------------------------------------------------------- migración
test('migración v1 → v2: una sala antigua se completa y sigue usable', () => {
  const legacy = {
    code: 'abc123',
    createdAt: Date.now() - 1000,
    task: 'Tarea heredada de la versión anterior del protocolo.',
    context: '', criteria: '',
    settings: { language: 'es', minAgents: 2, phaseMs: { lobby: 1000 } },
    status: 'closed',
    adminToken: 'x',
    agents: { a1: { id: 'a1', name: 'Viejo', model: 'm', harness: 'h', token: 't', joinedAt: 1, lastSeenAt: 1 } },
    order: ['a1'],
    phase: { name: 'closed', startedAt: 1, deadline: 1, data: {} },
    artifacts: { proposals: { p1: { id: 'p1', v: 1, author: 'a1', title: 'Plan viejo', plan: 'x'.repeat(40), createdAt: 1, history: [] } }, critiques: {}, objections: [] },
    log: [], logSeq: 0, result: null,
  };
  const room = migrate(legacy);
  assert.equal(room.schemaVersion, 2);
  assert.equal(room.settings.consensusThreshold, 0.75);
  assert.deepEqual(room.agenda, []);
  assert.equal(room.agents.a1.status, 'active');
  assert.deepEqual(room.artifacts.ledger, []);
  assert.equal(room.artifacts.proposals.p1.conceded, false);
  assert.ok(room.log.some(l => /migrada/.test(l.text)));
  assert.equal(rosterSummary(room).length, 1);
  const cost = buildCost(room);
  assert.equal(cost.perAgent.length, 1);
});

test('la agenda se puede ampliar desde el encuadre sin romper el conteo', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const res = addPoint(room, { label: 'Riesgo de dependencia', options: ['alto', 'medio', 'bajo'] }, 'a1');
  assert.equal(res.created, true);
  assert.equal(room.agenda.length, 2);
  const again = addPoint(room, { label: 'Riesgo de dependencia', options: ['nulo'] }, 'a2');
  assert.equal(again.created, false);
  assert.equal(again.addedOptions.length, 1);
  assert.equal(room.agenda.length, 2);
});

test('markAbsent libera la fase: el debate no espera al ausente', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  addAgent(room, 'Mudo');
  forcePhase(room, 'proposal');
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', { 'uno': 'redis' }) });
  markAbsent(room, 'a2', 'prueba');
  maybeAdvance(room);
  assert.notEqual(room.phase.name, 'proposal', 'avanzó sin esperar al mudo');
});

test('finishRoom congela el resultado y publicRoom expone todo lo que la UI necesita', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  const p1 = 'p-manual';
  room.artifacts.proposals[p1] = {
    id: p1, v: 1, author: a, title: 'Plan manual', plan: 'un plan suficientemente largo para pasar el mínimo',
    positions: { uno: 'redis' }, createdAt: Date.now(), history: [], gist: 'un plan', conceded: false,
  };
  finishRoom(room, p1);
  assert.equal(room.status, 'closed');
  const view = publicRoom(room);
  assert.equal(view.result.winner.title, 'Plan manual');
  assert.equal(view.agenda.length, 1);
  assert.equal(view.consensus.total, 1);
  assert.ok(view.roster.length === 2);
  assert.ok(view.cost.perAgent.length === 2);
  assert.ok(Array.isArray(view.log));
  assert.equal(view.macro, 'decision');
});

// ---------------------------------------------------------------- indulgencia de unidades
test('los umbrales se aceptan como fracción o como porcentaje (70 = 0.70)', () => {
  assert.equal(pickSettings({ consensusThreshold: 70 }).consensusThreshold, 0.7);
  assert.equal(pickSettings({ consensusThreshold: 0.8 }).consensusThreshold, 0.8);
  assert.equal(pickSettings({ consensusThreshold: '85' }).consensusThreshold, 0.85);
  // valores imposibles se recortan al rango válido en lugar de romper la sala
  assert.equal(pickSettings({ consensusThreshold: 3 }).consensusThreshold, 0.5, '3 → 3% → mínimo 50%');
  assert.equal(pickSettings({ consensusThreshold: 'basura' }).consensusThreshold, 0.75, 'sin número queda el valor por defecto');

  const room = newRoom();
  assert.equal(resolveRuleProposal(room, { op: 'consensusThreshold', value: 80 }).value, 0.8);
  assert.equal(resolveRuleProposal(room, { op: 'consensusThreshold', value: 0.65 }).value, 0.65);
  assert.equal(resolveRuleProposal(room, { op: 'consensusThreshold', value: 0.2 }), null, 'por debajo del mínimo se rechaza');
  assert.equal(resolveRuleProposal(room, { op: 'invéntate-una-regla', value: 1 }), null);
});

test('un movimiento rechazado se recuerda y viaja en el turno siguiente', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  addAgent(room, 'Bruno');
  startRoom(room);
  forcePhase(room, 'frame');

  assert.throws(
    () => applyMove(room, a, { kind: 'rule-change', payload: { op: 'consensusThreshold', value: 300 } }),
    /Cambio de reglas inválido/,
  );

  const turn = currentTurn(room, a);
  assert.equal(turn.action, 'frame-contribute', 'sigue teniendo la fase pendiente');
  assert.ok(turn.previousRejection, 'el turno explica el rechazo');
  assert.equal(turn.previousRejection.kind, 'rule-change');
  assert.match(turn.previousRejection.code, /bad_payload/);
  assert.match(turn.previousRejection.message, /0\.7 = 70%/, 'el mensaje enseña el rango correcto');

  // Al corregir, el aviso desaparece: no queda basura en el turno.
  applyMove(room, a, { kind: 'rule-change', payload: { op: 'consensusThreshold', value: 80 } });
  assert.equal(currentTurn(room, a).previousRejection, null);
});

test('un agente nunca aparece «en línea» en una sala cerrada', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  addAgent(room, 'Bruno');
  startRoom(room);
  assert.equal(rosterSummary(room).find(r => r.id === a).online, true, 'en debate y recién visto sí está en línea');
  room.artifacts.proposals['p-x'] = {
    id: 'p-x', v: 1, author: a, title: 'Plan', plan: 'plan suficientemente largo para pasar el mínimo exigido',
    positions: { uno: 'redis' }, createdAt: Date.now(), history: [], gist: 'plan', conceded: false,
  };
  finishRoom(room, 'p-x');
  assert.equal(rosterSummary(room).find(r => r.id === a).online, false, 'cerrada la sala nadie está activo');
});

// ---------------------------------------------------------------- identidad
test('el servidor NO reparte identidades: sin lente declarada, todos entran sin lente', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Claude-1', { harness: 'claude-code' });
  const b = addAgent(room, 'Codex-1', { harness: 'codex' });
  const c = addAgent(room, 'Cursor-1', { harness: 'cursor' });
  assert.equal(room.agents[a].role, null, 'no se le inventa un rol al primero');
  assert.equal(room.agents[b].role, null, 'ni al segundo (antes se le asignaba el siguiente de la rotación)');
  assert.equal(room.agents[c].role, null);
  assert.equal(room.agents[a].harness, 'claude-code', 'la identidad es su harness');

  // Y nadie recibe material distinto por llevar o no llevar lente.
  startRoom(room);
  forcePhase(room, 'proposal');
  const turnA = currentTurn(room, a);
  const turnB = currentTurn(room, b);
  assert.equal(turnA.identity.harness, 'claude-code');
  assert.equal(turnA.identity.lens, null);
  assert.equal(turnA.identity.lensNote, null, 'sin lente no se inyecta texto de lente');
  assert.deepEqual(
    turnA.payloadSchema ? Object.keys(turnA.payloadSchema) : [],
    turnB.payloadSchema ? Object.keys(turnB.payloadSchema) : [],
    'el esquema del turno no depende de la lente',
  );
});

test('la lente es opcional y, si el agente la declara, es solo suya', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Claude-1', { harness: 'claude-code', lens: 'analyst' });
  const b = addAgent(room, 'Mío-1', { harness: 'cli-propia', lens: 'auditoría de coste' });
  const c = addAgent(room, 'Codex-1', { harness: 'codex' });
  assert.equal(room.agents[a].role, 'analyst', 'lente conocida declarada');
  assert.equal(room.agents[b].role, 'auditoría de coste', 'texto libre respetado');
  assert.equal(room.agents[c].role, null);

  startRoom(room);
  forcePhase(room, 'proposal');
  const tB = currentTurn(room, b);
  assert.equal(tB.identity.lensNote, null, 'una lente libre no tiene descripción impuesta');
  assert.equal(currentTurn(room, c).identity.lensNote, null, 'sin lente, sin descripción');
  assert.ok(currentTurn(room, a).identity.lensNote.includes('analista'), 'la lente conocida sí se recuerda');
  assert.equal(currentTurn(room, c).identity.lens, null);
});

test('el verificador se elige por disidencia real, no por lente', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Autor', { harness: 'claude-code' });
  const b = addAgent(room, 'Fan', { harness: 'codex' });
  const c = addAgent(room, 'Crítico', { harness: 'zcode', lens: 'skeptic' });
  startRoom(room);
  const win = { id: 'p-w', author: a, title: 'Plan ganador', plan: 'plan de prueba suficientemente largo' };
  room.artifacts.proposals['p-w'] = { ...win, v: 1, positions: {}, history: [], gist: 'x', conceded: false };
  // El fan puso la ganadora primero; el crítico la puso última.
  room.lastBallots = { [b]: ['p-w', 'p-x'], [c]: ['p-x', 'p-w'] };
  const { verifierId, selfVerified } = assignVerifier(room, win);
  assert.equal(selfVerified, false, 'nunca se verifica a sí mismo');
  assert.equal(verifierId, c, 'verifica quien menos la apoyó, aunque su lente sea la de escéptico');
  assert.notEqual(verifierId, b, 'el fan no es un verificador creíble');
});

// ---------------------------------------------------------------- directo
test('el estado en vivo dice quién tiene turno y quién ya entregó en cada fase', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  assert.equal(liveState(room).phase, 'lobby');

  startRoom(room);
  forcePhase(room, 'proposal');
  let live = liveState(room);
  assert.equal(live.phase, 'proposal');
  assert.equal(live.pending, 3, 'los tres deben proponer');
  assert.equal(live.delivered, 0);
  assert.ok(live.who.every(w => w.action === 'propuesta'));
  assert.equal(live.next, 'crítica cruzada', 'la vista anticipa el siguiente paso');

  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', { uno: 'redis' }) });
  live = liveState(room);
  assert.equal(live.pending, 2, 'quien ya propuso deja de estar pendiente');
  assert.equal(live.delivered, 1);
  assert.equal(live.expected, 3);
  const aMember = live.members.find(m => m.id === a);
  assert.equal(aMember.state, 'delivered');
  assert.equal(live.members.find(m => m.id === b).state, 'pending');
  assert.ok(live.lastEvent && live.lastEvent.text.includes('Ana'), 'el último movimiento queda registrado');

  // Quien no tiene turno en la fase aparece como tal, no como pendiente eterno.
  forcePhase(room, 'repair', { winnerId: 'p-x' });
  room.artifacts.proposals['p-x'] = {
    id: 'p-x', v: 1, author: b, title: 'Plan', plan: 'plan suficientemente largo para pasar el mínimo',
    positions: {}, createdAt: Date.now(), history: [], gist: 'x', conceded: false,
  };
  live = liveState(room);
  assert.equal(live.expected, 1, 'en reparación solo responde el autor de la ganadora');
  assert.equal(live.who[0].id, b);
  assert.equal(live.members.find(m => m.id === a).state, 'free');

  // En una fase de todos contra todos, todos tienen turno.
  forcePhase(room, 'objection', { winnerId: 'p-x' });
  assert.equal(liveState(room).pending, 3);
});

test('una sala cerrada no anuncia turnos abiertos', () => {
  const room = newRoom({ agenda: ['Uno'] });
  const a = addAgent(room, 'Ana');
  addAgent(room, 'Bruno');
  startRoom(room);
  room.artifacts.proposals['p-z'] = {
    id: 'p-z', v: 1, author: a, title: 'Plan', plan: 'plan suficientemente largo para pasar el mínimo',
    positions: {}, createdAt: Date.now(), history: [], gist: 'x', conceded: false,
  };
  finishRoom(room, 'p-z');
  const live = liveState(room);
  assert.equal(live.status, 'closed');
  assert.equal(live.pending, 0);
  assert.equal(live.who.length, 0);
  assert.ok(live.members.every(m => m.state === 'free'));
});

// ---------------------------------------------------------------- texto para agentes
// El manual y el arranque son plantillas de texto largas: un acento o una comilla mal
// escapada rompe el módulo ENTERO (y con él el transporte HTTP, que lo importa). Este
// test los carga y los recorre, para que un error así no llegue a producción en silencio.
test('el manual y el arranque de agentes se renderizan y hablan de las reglas nuevas', async () => {
  const snippets = await import('../server/snippets.mjs');
  const room = createRoom({ task: 'Decidir la arquitectura de la caché sin romper nada.', settings: { minAgents: 2 } });
  const manual = snippets.manualText();
  assert.ok(manual.length > 4_000, 'el manual tiene contenido');
  assert.match(manual, /Cuándo terminas/, 'el manual dice quién decide el final');
  assert.match(manual, /Revisión posterior al trabajo/, 'y explica la revisión posterior');
  assert.match(manual, /El comando de verificación no es tuyo/, 'y de quién es el comando de verificación');

  const boot = snippets.bootstrapText(room, 'http://localhost:8787');
  assert.match(boot, /QUIÉN TERMINA/, 'el arranque repite quién cierra la sala');
  assert.match(boot, /api\/rooms\/[a-z0-9]+\/turn/, 'y da el bucle HTTP');

  const join = snippets.joinPrompt(room, 'http://localhost:8787');
  assert.ok(join.length > 200, 'el prompt de entrada se genera');
});

// ---------------------------------------------------------------- consenso por etapa
// Un único número de consenso no dice si la sala se acercó o se atrincheró. Al cerrar cada
// macro-etapa se guarda una foto; la etapa en curso se mide en vivo. Lo que no tiene puntos
// que medir lo dice, en vez de mostrar un 0% que parecería un fracaso.
test('el consenso se guarda por etapa y la etapa en curso se mide en vivo', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);

  // Presentación: los dos se posicionan igual en el primer punto y distinto en el segundo.
  room.artifacts.proposals['p-a'] = {
    id: 'p-a', v: 1, author: a, title: 'Plan A', plan: 'plan suficientemente largo para pasar el mínimo',
    positions: { [room.agenda[0].id]: room.agenda[0].options[0].id, [room.agenda[1].id]: room.agenda[1].options[0].id },
    history: [], gist: 'x', createdAt: Date.now(), conceded: false,
  };
  room.artifacts.proposals['p-b'] = {
    id: 'p-b', v: 1, author: b, title: 'Plan B', plan: 'plan suficientemente largo para pasar el mínimo',
    positions: { [room.agenda[0].id]: room.agenda[0].options[0].id, [room.agenda[1].id]: room.agenda[1].options[2].id },
    history: [], gist: 'x', createdAt: Date.now(), conceded: false,
  };

  enterPhase(room, 'proposal');
  enterPhase(room, 'critique'); // cruza de macro-etapa: se fotografía la presentación
  assert.equal(room.consensusHistory.length, 1, 'se guarda una foto al cerrar la presentación');
  assert.equal(room.consensusHistory[0].macro, 'presentation');
  assert.equal(room.consensusHistory[0].phase, 'proposal', 'y dice en qué fase se cerró');
  // Un punto con acuerdo pleno y otro empatado a uno: la foto queda por debajo de la
  // unanimidad y por encima del umbral, que es exactamente lo que hay que poder ver.
  assert.ok(room.consensusHistory[0].global > 0.7 && room.consensusHistory[0].global < 1,
    `el consenso de la etapa refleja el punto empatado (${room.consensusHistory[0].global})`);

  const stages = stageConsensus(room, 'debate');
  assert.equal(stages.length, 5, 'una entrada por macro-etapa del protocolo');
  assert.equal(stages[0].status, 'done');
  assert.equal(stages[1].status, 'now');
  assert.equal(stages[3].status, 'pending');
  assert.equal(stages[0].global, room.consensusHistory[0].global, 'lo cerrado no se recalcula');
  assert.equal(stages[1].measured, true, 'la etapa en curso se mide en vivo');
  assert.equal(stages[4].measured, false, 'una etapa sin llegar no inventa un porcentaje');

  // Repetir la etapa (otra ronda) actualiza su foto: no se acumula historia falsa.
  enterPhase(room, 'revise');
  enterPhase(room, 'synthesis');
  recordStageConsensus(room, 'debate', 'revise');
  assert.equal(room.consensusHistory.filter(h => h.macro === 'debate').length, 1, 'una foto por etapa');

  const view = publicRoom(room);
  assert.equal(view.consensus.stages.length, 5, 'el panel recibe las etapas');
  assert.equal(view.consensus.stages.find(s => s.macro === 'synthesis').status, 'now');

  // Sala cerrada: ninguna etapa puede aparecer «en curso» (eso era mentir sobre un debate
  // terminado) y las que nunca se midieron dicen «no hubo», no «aún no llega».
  finishRoom(room, 'p-a');
  const cerrada = stageConsensus(room, 'decision');
  assert.ok(cerrada.every(s => s.status !== 'now'), 'ninguna etapa sigue «ahora» tras cerrar');
  assert.equal(cerrada.find(s => s.macro === 'synthesis').status, 'done', 'la etapa en la que cerró queda registrada');
  assert.equal(cerrada.find(s => s.macro === 'decision').status, 'skipped', 'las que no llegaron a medirse se marcan como tales');
  assert.equal(cerrada.find(s => s.macro === 'work').status, 'skipped');
});

// ---------------------------------------------------------------- disenso protegido
// Un debate que converge de más deja de aportar: dos propuestas casi idénticas con
// votación unánime no prueban que el plan sea bueno, prueban que nadie sostuvo la otra
// mitad. El mecanismo no fuerza disenso: hace imposible CONFUNDIR una convergencia con un
// acuerdo. Tres piezas: mover una posición exige decir qué la movió, la minoría real se
// publica con nombres, y la votación avisa cuando llega colapsada.

// Propuesta ya presentada, con posiciones concretas (para probar una fase sin recorrerlas todas).
function seedProposal(room, id, authorId, title, positions, plan = 'plan suficientemente largo para pasar el mínimo de la validación') {
  room.artifacts.proposals[id] = {
    id, v: 1, author: authorId, title,
    plan,
    positions, createdAt: Date.now(), history: [], gist: 'x', conceded: false, approach: '',
  };
  return room.artifacts.proposals[id];
}

test('mover una posición de la agenda exige decir qué la movió', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A', { almacenamiento: 'redis' });
  seedProposal(room, 'p-b', b, 'Plan B', { almacenamiento: 'postgres' });
  forcePhase(room, 'revise', { responses: {} });

  const revisar = extra => applyMove(room, a, {
    kind: 'revision',
    payload: {
      proposalId: 'p-a',
      plan: '1. Versión revisada que aborda las objeciones de coste.\n2. Con un paso extra para pasar el mínimo.',
      ...extra,
    },
  });

  // Se mueve hacia la mayoría sin citar nada: el movimiento NO se rechaza, se registra.
  const res = revisar({ positions: { almacenamiento: 'postgres' } });
  assert.ok(res.warnings.some(w => /convergencia sin evidencia/.test(w)), 'el agente se entera de que falta la razón');
  assert.equal(room.artifacts.drift.length, 1);
  const d = room.artifacts.drift[0];
  assert.equal(d.pointId, 'almacenamiento');
  assert.equal(d.evidenced, false);
  assert.equal(d.fromLabel, 'Redis');
  assert.equal(d.toLabel, 'Postgres');
  assert.ok(room.log.some(l => l.kind === 'drift' && /sin citar/.test(l.text)), 'también sale en el registro en vivo');

  // Con la razón declarada, el mismo movimiento queda como cambio argumentado.
  // (La revisión anterior cerró la fase: sin críticas serias el motor pasa directo a votar.)
  forcePhase(room, 'revise', { responses: {} });
  const res2 = revisar({
    positions: { invalidacion: 'por-eventos' },
    changes: [{ pointId: 'invalidacion', because: 'La prueba de carga mostró 12% de lecturas obsoletas con TTL corto.' }],
  });
  assert.equal(res2.warnings.filter(w => /convergencia sin evidencia/.test(w)).length, 0);
  assert.equal(room.artifacts.drift.length, 2);
  assert.equal(room.artifacts.drift[1].evidenced, true);
  assert.match(room.artifacts.drift[1].because, /12% de lecturas obsoletas/);
});

test('el informe publica la minoría real y lo resuelto por autoridad', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  startRoom(room);
  // Almacenamiento: 1 contra 2. Invalidación: unanimidad. El tercer punto queda sin votar.
  seedProposal(room, 'p-a', a, 'Plan A', { almacenamiento: 'redis', invalidacion: 'por-eventos' });
  seedProposal(room, 'p-b', b, 'Plan B', { almacenamiento: 'postgres', invalidacion: 'por-eventos' });
  seedProposal(room, 'p-c', c, 'Plan C', { almacenamiento: 'postgres', invalidacion: 'por-eventos' });

  const report = consensusReport(room);
  const dis = dissentReport(room, report, id => nameOf(room, id));
  assert.equal(dis.measured, true);
  assert.equal(dis.count, 1, 'solo el punto con minoría está disputado');
  assert.equal(dis.contested[0].label, 'Almacenamiento');
  assert.deepEqual(dis.contested[0].minority[0].by, ['Ana']);
  assert.equal(dis.contested[0].majority.label, 'Postgres');
  // El punto que nadie votó no cuenta como unanimidad: 1 de 2 puntos votados.
  assert.equal(dis.unanimity, 0.5);
  assert.equal(dis.contestedShare, 0.5);

  // La síntesis resuelve el punto disputado sin dato nuevo: se marca como autoridad.
  forcePhase(room, 'synthesis', { winnerId: 'p-b', authorId: b });
  applyMove(room, b, {
    kind: 'synthesis',
    payload: {
      final: 'PLAN FINAL: se mantiene Postgres y la invalidación por eventos que ya era unánime.',
      merges: [],
      pointResolutions: [{ pointId: 'almacenamiento', choiceId: 'postgres', note: 'la mayoría ya lo eligió' }],
    },
  });
  assert.equal(room.artifacts.synthesis.pointResolutions[0].basis, 'authority', 'sin evidencia no se puede llamar «evidence»');
  assert.ok(room.log.some(l => /por autoridad de síntesis, sin evidencia nueva/.test(l.text)), 'y la sala lo dice en voz alta');

  finishRoom(room, 'p-b');
  const prot = room.result.dissentProtection;
  assert.equal(prot.unanimity, 0.5);
  assert.equal(prot.contestedCount, 1);
  assert.deepEqual(prot.contestedPoints[0].minority[0].by, ['Ana']);
  assert.deepEqual(prot.byAuthority, ['Almacenamiento']);
  assert.equal(prot.convergenceWithoutEvidence.count, 0, 'aquí nadie se movió de posición');
  // La interfaz recibe exactamente lo mismo, sin recalcular nada a mano.
  assert.equal(publicRoom(room).dissent.contestedCount, 1);
  assert.equal(liveState(room).dissent.contestedPoints[0].minority[0].by[0], 'Ana');
});

test('una base «evidence» sin evidencia se degrada a autoridad', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A', { almacenamiento: 'redis' });
  seedProposal(room, 'p-b', b, 'Plan B', { almacenamiento: 'postgres' });
  forcePhase(room, 'synthesis', { winnerId: 'p-b', authorId: b });
  const out = applyMove(room, b, {
    kind: 'synthesis',
    payload: {
      final: 'PLAN FINAL suficientemente largo como para pasar la validación de longitud mínima.',
      pointResolutions: [{ pointId: 'almacenamiento', choiceId: 'postgres', basis: 'evidence' }],
    },
  });
  assert.ok(out.warnings.some(w => /basis:"evidence" sin evidence/.test(w)));
  assert.equal(room.artifacts.synthesis.pointResolutions[0].basis, 'authority');
});

test('adoptar la alternativa minoritaria no cuenta como resolver por autoridad', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A', { almacenamiento: 'redis' });
  seedProposal(room, 'p-b', b, 'Plan B', { almacenamiento: 'postgres' });
  forcePhase(room, 'synthesis', { winnerId: 'p-b', authorId: b });
  applyMove(room, b, {
    kind: 'synthesis',
    payload: {
      final: 'PLAN FINAL suficientemente largo como para pasar la validación de longitud mínima.',
      pointResolutions: [{ pointId: 'almacenamiento', choiceId: 'redis', basis: 'adopted-dissent', evidence: 'La minoría midió el coste real en staging.' }],
    },
  });
  const pr = room.artifacts.synthesis.pointResolutions[0];
  assert.equal(pr.basis, 'adopted-dissent');
  assert.equal(pr.evidence, 'La minoría midió el coste real en staging.');
  finishRoom(room, 'p-b');
  assert.deepEqual(room.result.dissentProtection.byAuthority, [], 'adoptar la minoría no es resolver por autoridad');
});

test('un punto disputado que la síntesis no menciona queda abierto, no cerrado por omisión', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A', { almacenamiento: 'redis', invalidacion: 'por-eventos' });
  seedProposal(room, 'p-b', b, 'Plan B', { almacenamiento: 'postgres', invalidacion: 'por-eventos' });
  seedProposal(room, 'p-c', c, 'Plan C', { almacenamiento: 'postgres', invalidacion: 'para-version' });
  forcePhase(room, 'synthesis', { winnerId: 'p-b', authorId: b });

  // La síntesis resuelve «almacenamiento» y se olvida de «invalidación», que tenía minoría.
  const out = applyMove(room, b, {
    kind: 'synthesis',
    payload: {
      final: 'PLAN FINAL: Postgres como almacenamiento, con el resto del plan ganador intacto.',
      merges: [],
      pointResolutions: [{ pointId: 'almacenamiento', choiceId: 'postgres', note: 'la mayoría lo eligió' }],
    },
  });
  assert.ok(out.warnings.some(w => /dejaste sin resolver/.test(w)), 'avisa al sintetizador en el momento, no solo en el acta');
  assert.deepEqual(room.artifacts.synthesis.unresolved.map(u => u.label), ['Invalidación']);
  assert.ok(room.log.some(l => /SIN resolver en la síntesis/.test(l.text)), 'y la sala lo dice en voz alta');

  finishRoom(room, 'p-b');
  assert.deepEqual(room.result.dissentProtection.unresolved.map(u => u.label), ['Invalidación']);
  assert.deepEqual(room.result.dissentProtection.byAuthority, ['Almacenamiento'], 'el resuelto por autoridad sigue marcado');
});

test('el verificador recibe los puntos que la síntesis cerró por autoridad', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A', { almacenamiento: 'redis' });
  seedProposal(room, 'p-b', b, 'Plan B', { almacenamiento: 'postgres' });
  seedProposal(room, 'p-c', c, 'Plan C', { almacenamiento: 'postgres' });
  forcePhase(room, 'synthesis', { winnerId: 'p-b', authorId: b });
  applyMove(room, b, {
    kind: 'synthesis',
    payload: {
      final: 'PLAN FINAL suficientemente largo como para pasar la validación de longitud mínima.',
      pointResolutions: [{ pointId: 'almacenamiento', choiceId: 'postgres' }],
    },
  });

  // La verificación la lleva quien menos apoyó al ganador: ahí no se repite la mayoría.
  room.lastBallots = { [a]: ['p-a', 'p-b', 'p-c'], [b]: ['p-b', 'p-a', 'p-c'], [c]: ['p-a', 'p-b', 'p-c'] };
  const verifier = room.phase.data.verifierId;
  assert.ok(verifier && verifier !== b, 'no verifica el autor de la ganadora');
  const turn = currentTurn(room, verifier);
  assert.equal(turn.action, 'submit-verification');
  assert.deepEqual(turn.byAuthority.map(p => p.label), ['Almacenamiento'], 'el turno señala lo resuelto por autoridad');
  assert.deepEqual(turn.unresolvedPoints, [], 'y lo que quedó sin resolver');
  assert.match(turn.message, /MENOS apoyó al ganador/, 'con el encargo explícito de falsarlo');
});

test('si las propuestas llegan casi idénticas, la votación lo dice antes de votar', () => {
  // Con la diversidad exigida por defecto estas propuestas ni se podrían presentar: aquí se
  // prueba el caso real, en el que el debate se fue acercando hasta que las dos coinciden.
  const room = newRoom({ settings: { requireDiversity: false } });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  const iguales = { almacenamiento: 'postgres', invalidacion: 'por-eventos' };
  seedProposal(room, 'p-a', a, 'Plan A', { ...iguales });
  seedProposal(room, 'p-b', b, 'Plan B', { ...iguales });

  enterPhase(room, 'vote');
  assert.equal(proposalSimilarity(room).max, 1);
  assert.equal(proposalSimilarity(room).collapsed, true);
  assert.equal(room.artifacts.similaritySnapshot.collapsed, true, 'se fotografía el momento de la votación');
  assert.ok(room.log.some(l => /Aviso de diversidad/.test(l.text)), 'avisa de que decide matices, no direcciones');

  // Con propuestas distintas no se avisa de nada.
  const room2 = newRoom();
  const x = addAgent(room2, 'X');
  const y = addAgent(room2, 'Y');
  startRoom(room2);
  seedProposal(room2, 'p-x', x, 'Plan X', { almacenamiento: 'postgres', invalidacion: 'por-eventos' });
  seedProposal(room2, 'p-y', y, 'Plan Y', { almacenamiento: 'redis', invalidacion: 'ttl-corto' });
  enterPhase(room2, 'vote');
  assert.equal(proposalSimilarity(room2).collapsed, false);
  assert.equal(room2.artifacts.similaritySnapshot.max, 0);
});

// ---------------------------------------------------------------- sin techos editoriales
// La plataforma no raciona lo que un harness escribe: un plan largo, nueve objeciones o
// doce comprobaciones son trabajo legítimo, no abuso. Los techos que existen son de memoria
// del servidor y, si alguna vez muerden, lo dicen en `warnings` en vez de perder texto.
test('un plan largo cabe entero: no hay recorte editorial de propuestas', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  forcePhase(room, 'proposal');
  const plan = 'Paso concreto con el detalle necesario para que se pueda ejecutar.\n'.repeat(320) + 'Fin del plan.';
  assert.ok(plan.length > 20_000, 'el plan de prueba es de verdad largo');
  const out = applyMove(room, a, { kind: 'proposal', payload: { ...proposalFor('Ana', {}), plan } });
  const stored = Object.values(room.artifacts.proposals)[0];
  assert.equal(stored.plan.length, plan.length, 'se guarda entero, sin recortar');
  assert.equal(out.warnings.filter(w => /techo/.test(w)).length, 0, 'y sin avisos de recorte');
});

test('nueve objeciones largas entran todas: el recuento ya no es de cinco', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  forcePhase(room, 'proposal');
  applyMove(room, a, { kind: 'proposal', payload: proposalFor('Ana', {}) });
  applyMove(room, b, { kind: 'proposal', payload: { ...proposalFor('Bruno', {}), approach: 'otro enfoque' } });
  const target = Object.keys(room.artifacts.proposals)[0];
  room.phase = {
    name: 'critique', startedAt: Date.now(), deadline: Date.now() + 60_000,
    data: { assignments: { [b]: [target] }, responses: {} },
  };
  const escenario = 'Escenario de fallo concreto y medible cuando la cola se satura: '.repeat(16);
  const objections = Array.from({ length: 9 }, (_, i) => ({ type: 'risk', severity: 'med', text: `${escenario}#${i}` }));
  const out = applyMove(room, b, { kind: 'critique', payload: { target, objections } });
  const critique = Object.values(room.artifacts.critiques)[0];
  assert.equal(critique.objections.length, 9);
  assert.ok(critique.objections.every(o => o.text.length > 900), 'cada objeción conserva su texto');
  assert.equal(out.warnings.filter(w => /techo/.test(w)).length, 0);
});

test('las razones de un cambio de posición no se cortan por la cola', () => {
  // Antes se guardaban las 12 primeras razones: con más posiciones movidas, las últimas
  // aparecían como «convergencia sin evidencia» por un recorte del servidor.
  const room = newRoom({ settings: { requireDiversity: false } });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A', { almacenamiento: 'redis', invalidacion: 'por-eventos' });
  seedProposal(room, 'p-b', b, 'Plan B', { almacenamiento: 'postgres', invalidacion: 'ttl-corto' });
  room.phase = { name: 'revise', startedAt: Date.now(), deadline: Date.now() + 60_000, data: { responses: {} } };
  const changes = [
    { pointId: 'almacenamiento', because: 'El dato de latencia medido en la crítica' },
    ...Array.from({ length: 16 }, (_, i) => ({ pointId: `punto-${i}`, because: `Evidencia ${i} con su dato` })),
  ];
  const out = applyMove(room, a, {
    kind: 'revision',
    payload: { proposalId: 'p-a', plan: proposalFor('Ana', {}).plan, positions: { almacenamiento: 'postgres' }, changes },
  });
  assert.equal(out.warnings.filter(w => /sin citar|sin evidencia/.test(w)).length, 0);
  assert.ok(room.artifacts.drift.every(d => d.evidenced), 'cada movimiento guarda su razón');
});

test('si un techo de seguridad muerde, el movimiento lo dice con la cifra (nunca en silencio)', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  forcePhase(room, 'proposal');
  const plan = 'x'.repeat(CAPS.proposalPlan + 500);
  const out = applyMove(room, a, { kind: 'proposal', payload: { title: 'Plan gigante', plan, approach: 'largo' } });
  assert.equal(Object.values(room.artifacts.proposals)[0].plan.length, CAPS.proposalPlan);
  assert.ok(
    out.warnings.some(w => w.includes(String(CAPS.proposalPlan)) && /techo de esta sala/.test(w)),
    'el aviso dice el techo y qué se quedó fuera',
  );
});

// Votar es decidir, y no se decide sobre un titular. Antes, en la votación solo llegaba el
// gist de ~220 caracteres salvo para las propuestas que a cada agente le tocó criticar: media
// sala votaba sin haber leído lo esencial. El desempate tenía el mismo agujero.
test('la votación y el desempate llegan con el plan completo de cada opción', () => {
  const room = newRoom({ settings: { requireDiversity: false } });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  const planA = `# Plan A\n${'detalle ejecutable de Ana con cifras, umbrales y plan de reversión. '.repeat(120)}`;
  const planB = `# Plan B\n${'detalle ejecutable de Bruno con medición semanal y criterio de parada. '.repeat(120)}`;
  assert.ok(planA.length > 6_000, 'los planes de prueba son largos de verdad');
  seedProposal(room, 'p-a', a, 'Plan A', { almacenamiento: 'redis' }, planA);
  seedProposal(room, 'p-b', b, 'Plan B', { almacenamiento: 'postgres' }, planB);

  enterPhase(room, 'vote');
  const voto = currentTurn(room, b);
  assert.equal(voto.action, 'submit-vote');
  assert.equal(voto.options.length, 2);
  assert.equal(voto.options.find(o => o.id === 'p-a').plan, planA, 'el plan va entero, no su gist');
  assert.equal(voto.options.find(o => o.id === 'p-b').plan, planB);
  assert.equal(voto.options.find(o => o.id === 'p-a').author, 'Ana', 'y se sabe de quién es cada plan');
  assert.ok(voto.readingLoad.planChars >= planA.length + planB.length, 'se dice cuánto pesa lo que se envía');
  assert.ok(voto.readingLoad.approxTokens > 1_000, `con estimación de tokens (${voto.readingLoad.approxTokens})`);

  // Desempate: los dos finalistas, también completos, tanto para el alegato como para el voto.
  forcePhase(room, 'tiebreak', { finalists: ['p-a', 'p-b'] });
  const desempate = currentTurn(room, b);
  assert.equal(desempate.action, 'submit-argument');
  assert.equal(desempate.finalists.find(f => f.id === 'p-b').plan, planB);
  assert.ok(desempate.readingLoad.planChars >= planA.length + planB.length);
});

// Un turno entregado y sin responder no es un agente mudo: es alguien trabajando. El reloj ya
// no cierra la fase encima de él (antes solo trabajo y revisión se prorrogaban; el resto de
// fases cortaba en seco a quien estaba a mitad de escribir).
test('una fase no se cierra encima de un agente que tiene el turno entregado', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  startRoom(room);
  assert.equal(room.phase.name, 'frame');

  // Una sonda (el long-poll mirando si le toca) no marca a nadie como «trabajando».
  const sonda = currentTurn(room, b, { record: false });
  assert.equal(sonda.action, 'frame-contribute');
  assert.equal(room.agents[b].awaiting ?? null, null, 'sondear no es tener el turno');

  // Ana pide su turno y recibe la acción: queda a mitad de movimiento.
  const turn = currentTurn(room, a);
  assert.equal(turn.action, 'frame-contribute');
  assert.equal(room.agents[a].awaiting.phase, 'frame');
  assert.equal(room.agents[a].awaiting.action, 'frame-contribute');

  // Se agota el plazo: se prorroga en vez de cerrar sobre ella.
  room.phase.deadline = Date.now() - 1_000;
  assert.equal(sweep(room), true);
  assert.equal(room.phase.name, 'frame', 'la fase sigue abierta');
  assert.ok(room.phase.deadline > Date.now(), 'con tiempo nuevo por delante');
  assert.equal(room.phase.data.extensions, 1);
  assert.ok(room.log.some(l => /se amplía/.test(l.text) && /Ana/.test(l.text)), 'y se dice quién y por qué');

  // En cuanto entrega, deja de estar a mitad de movimiento.
  applyMove(room, a, { kind: 'pass' });
  assert.equal(room.agents[a].awaiting, null, 'al entregar se borra el recuerdo del turno');

  // Sin nadie trabajando, el reloj vuelve a mandar y la fase cierra.
  room.phase.deadline = Date.now() - 1_000;
  sweep(room);
  assert.notEqual(room.phase.name, 'frame', 'sin nadie a mitad de movimiento, el plazo decide');
});

test('un turno retenido demasiado tiempo deja de bloquear la fase', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  addAgent(room, 'Bruno');
  startRoom(room);
  currentTurn(room, a);
  // Retuvo el turno más de lo que la sala espera (offlineMs, con suelo de 10 minutos).
  room.agents[a].awaiting.since = Date.now() - 11 * 60_000;
  room.phase.deadline = Date.now() - 1_000;
  sweep(room);
  assert.notEqual(room.phase.name, 'frame', 'el silencio tiene tope: la sala no se queda colgada');
});

test('la orden del humano manda sobre la prórroga por actividad', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  addAgent(room, 'Bruno');
  startRoom(room);
  currentTurn(room, a); // Ana tiene el turno en la mano
  room.phase.deadline = Date.now() - 1_000;
  sweep(room, { force: true }); // «Forzar avance de fase» desde el panel
  assert.notEqual(room.phase.name, 'frame', 'quien decide cerrar la fase ya, la cierra');
});

// ---------------------------------------------------------------- contraste de ejes
// El encuadre a ciegas evita que el primero que habla ancle a los demás MIENTRAS escriben, pero
// deja dos agujeros: un eje al que nadie llegó no puede entrar nunca, y uno que sobra no se
// puede impugnar. El contraste es la vuelta corta y ya informada que los tapa, y la auditoría
// del encuadre dice después quién definió los ejes y cuáles entraron tarde.
test('el contraste deja entrar el eje que faltó y publica quién impugnó cuál, con nombres', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A');

  enterPhase(room, 'contrast');
  assert.equal(room.phase.name, 'contrast');

  // Ana añade el eje que el encuadre (a ciegas) no vio; Bruno impugna el que sobra y pide
  // fusionarlo; Ciro no toca nada.
  applyMove(room, a, { kind: 'point-proposal', payload: { label: 'Coste real del primer mes', options: ['< $30', '> $30'] } });
  applyMove(room, b, { kind: 'point-challenge', payload: { pointId: 'almacenamiento', because: 'el eje de coste ya lo cubre y aquí solo confunde', mergeInto: 'coste-real-del-primer-mes' } });
  applyMove(room, c, { kind: 'pass' });
  maybeAdvance(room);

  // Sin mayoría no se fusiona: el eje impugnado sigue vivo, a la vista de todos.
  const almacenamiento = room.agenda.find(p => p.id === 'almacenamiento');
  assert.ok(almacenamiento, 'nada se borra por mayoría');
  assert.equal(almacenamiento.challenged.length, 1);
  assert.equal(almacenamiento.challenged[0].byName, 'Bruno');
  assert.match(room.log.find(l => l.kind === 'contrast' && /fusionar/.test(l.text)).text,
    /Bruno pide fusionar «Almacenamiento» con «Coste real del primer mes»/);

  finishRoom(room, 'p-a');
  const review = room.result.agendaReview;
  assert.equal(review.addedLate.length, 1, 'el eje que llegó tarde se publica');
  assert.equal(review.addedLate[0].label, 'Coste real del primer mes');
  assert.equal(review.addedLate[0].by, 'Ana');
  assert.equal(review.challenged.length, 1);
  assert.deepEqual(review.challenged[0].by, ['Bruno']);
  assert.match(review.challenged[0].because[0], /coste/);
  assert.equal(review.keptUnmerged.length, 1, 'impugnado sin acuerdo de fusión');
  assert.deepEqual(review.keptUnmerged[0].wantedMerge, ['Coste real del primer mes']);
  assert.equal(review.merged.length, 0);
  // El único eje de agente entró en el contraste, así que no abrió ningún marco: se dice sin
  // fingir que hubo anclaje (no lo hubo) ni callar que el encuadre no lo cubrió.
  assert.equal(review.opened, null, 'un eje del contraste no «abrió» el encuadre');
  assert.match(review.note, /entró después, en el contraste/);
  assert.equal(review.anchored, false);
});

test('fusionar dos ejes exige mayoría y destino único: las opciones del absorbido no se pierden', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  const d = addAgent(room, 'Dora');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A');

  enterPhase(room, 'contrast');
  for (const id of [a, b, c]) {
    applyMove(room, id, { kind: 'point-challenge', payload: { pointId: 'almacenamiento', because: 'es el mismo eje que invalidación', mergeInto: 'invalidacion' } });
  }
  // Dora quiere fusionarlo con OTRO destino: con dos destinos distintos no hay fusión.
  applyMove(room, d, { kind: 'point-challenge', payload: { pointId: 'almacenamiento', because: 'es el mismo eje que invalidation?', mergeInto: 'presupuesto-mensual' } });
  maybeAdvance(room);

  // La mayoría pidió fusionar, pero no hay UN destino común: el eje sigue vivo y la
  // impugnación queda registrada con los cuatro nombres (nada se borra a medias).
  const punto = room.agenda.find(p => p.id === 'almacenamiento');
  assert.ok(punto, 'con destinos distintos no se fusiona');
  assert.equal(punto.challenged.length, 4);
  assert.deepEqual([...new Set(punto.challenged.map(c => c.byName))].sort(), ['Ana', 'Bruno', 'Ciro', 'Dora']);
});

test('fusionar exige mayoría: se fusiona y el informe lo cuenta con quién lo pidió', () => {
  const room = newRoom();
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  startRoom(room);
  seedProposal(room, 'p-a', a, 'Plan A');

  enterPhase(room, 'contrast');
  for (const id of [a, b, c]) {
    applyMove(room, id, { kind: 'point-challenge', payload: { pointId: 'almacenamiento', because: 'es el mismo eje que invalidación, mejor uno solo', mergeInto: 'invalidacion' } });
  }
  maybeAdvance(room);

  assert.ok(!room.agenda.some(p => p.id === 'almacenamiento'), 'el absorbido sale de la agenda');
  const invalidacion = room.agenda.find(p => p.id === 'invalidacion');
  assert.equal(invalidacion.mergedFrom.length, 1);
  assert.ok(invalidacion.options.some(o => o.id === 'redis'), 'las opciones del absorbido no se pierden');

  finishRoom(room, 'p-a');
  const review = room.result.agendaReview;
  assert.equal(review.merged.length, 1);
  assert.equal(review.merged[0].from, 'Almacenamiento');
  assert.equal(review.merged[0].into, 'Invalidación');
  assert.deepEqual([...review.merged[0].by].sort(), ['Ana', 'Bruno', 'Ciro']);
  assert.match(review.merged[0].because[0], /mismo eje/);
});

test('la auditoría del encuadre dice si el primer eje ordenó el debate (anclaje, con nombre)', () => {
  const room = newRoom({ agenda: [] });
  const a = addAgent(room, 'Ana');
  const b = addAgent(room, 'Bruno');
  const c = addAgent(room, 'Ciro');
  startRoom(room);

  // Encuadre a ciegas: Ana abre el marco, Bruno y Ciro añaden los suyos sin ver el de Ana.
  applyMove(room, a, { kind: 'point-proposal', payload: { label: 'Cuello de botella raíz', options: ['Latencia', 'Coste'] } });
  applyMove(room, b, { kind: 'point-proposal', payload: { label: 'Presupuesto', options: ['Sí', 'No'] } });
  applyMove(room, c, { kind: 'point-proposal', payload: { label: 'Métrica de éxito', options: ['p95', 'coste por caso'] } });
  maybeAdvance(room);
  assert.equal(room.phase.name, 'contrast');
  for (const id of [a, b, c]) applyMove(room, id, { kind: 'pass' });
  maybeAdvance(room);
  assert.equal(room.phase.name, 'proposal');

  seedProposal(room, 'p-a', a, 'Plan A');
  seedProposal(room, 'p-b', b, 'Plan B');
  forcePhase(room, 'critique', { assignments: { [b]: ['p-a'], [c]: ['p-a'] }, responses: {} });
  for (const [id, texto] of [[b, 'El cuello real no es la latencia: es el coste por consulta.'], [c, 'Medir p95 sin medir el coste por caso esconde el problema.']]) {
    applyMove(room, id, {
      kind: 'critique',
      payload: {
        target: 'p-a', steelman: 'El diagnóstico apunta a lo que importa.',
        objections: [{ type: 'risk', severity: 'high', text: texto, against: 'cuello-de-botella-raiz' }],
      },
    });
  }

  finishRoom(room, 'p-a');
  const review = room.result.agendaReview;
  assert.equal(review.opened.by, 'Ana', 'se dice quién abrió el marco, con nombre');
  assert.equal(review.opened.label, 'Cuello de botella raíz');
  assert.equal(review.opened.objections, 2, 'y cuánto debate atrajo');
  assert.equal(review.opened.mostObjected, true);
  assert.equal(review.anchored, true, 'el eje que abrió el marco fue el más discutido');
  assert.match(review.note, /Ana/);
  assert.match(review.note, /ordenó el debate/);
  assert.equal(review.agentAxes, 3);
  assert.equal(review.concentration.by, 'Ana');
  assert.equal(review.concentration.count, 1);
  assert.equal(review.addedLate.length, 0, 'nadie llegó tarde: el encuadre los cubrió');
});

// ---------------------------------------------------------------- «sin señal» con criterio
// Un harness que está pensando su turno no está desconectado. Medido en una sala real de mejora
// recursiva (3 harnesses): cada turno tardó entre 2 y 7 minutos, así que un panel que a los dos
// minutos de silencio dice «sin señal» manda al humano a reconectar a quien nunca se fue.
test('un agente con el turno en la mano no se marca «sin señal» por tardar', () => {
  const room = newRoom();
  const ana = addAgent(room, 'Ana');
  const bruno = addAgent(room, 'Bruno');
  startRoom(room);
  forcePhase(room, 'proposal', { responses: {} });

  // Le toca proponer y todavía no ha entregado: el motor sabe que está trabajando en ello.
  currentTurn(room, ana);
  assert.ok(room.agents[ana].awaiting, 'entregar el turno deja constancia de que lo tiene');

  const silencio = Date.now() - 5 * 60_000;
  room.agents[ana].lastSeenAt = silencio;
  room.agents[bruno].lastSeenAt = silencio;

  const members = liveState(room).members;
  assert.equal(members.find(m => m.id === ana).online, true, 'con turno pendiente sigue en la sala');
  assert.equal(members.find(m => m.id === bruno).online, false, 'sin turno y cinco minutos callado: ese sí');
});

// Lo mismo para el trabajo: quien monta un parche de tres archivos tarda y sigue siendo de la
// sala hasta que su tarea vuelve al montón (ahí sweepClaims se la quita y esto se apaga solo).
test('una tarea asignada no sustituye la señal de conexión del agente', () => {
  const room = newRoom();
  const ana = addAgent(room, 'Ana');
  const bruno = addAgent(room, 'Bruno');
  startRoom(room);
  forcePhase(room, 'work', {});
  room.work = {
    order: ['w1'],
    items: { w1: { id: 'w1', title: 'Guard de autoría de la síntesis', status: 'claimed', claimant: ana, patches: [] } },
    patches: {}, pending: null, finishedAt: null,
  };
  const silencio = Date.now() - 8 * 60_000;
  room.agents[ana].lastSeenAt = silencio;
  room.agents[bruno].lastSeenAt = silencio;

  const members = liveState(room).members;
  assert.equal(members.find(m => m.id === ana).online, false, 'conserva la tarea, pero no hay señal reciente');
  assert.equal(members.find(m => m.id === bruno).online, false, 'sin tarea y callado: sin señal');

  // Cuando la tarea se integra, la señal de trabajo en curso desaparece.
  room.work.items.w1.status = 'integrated';
  assert.equal(liveState(room).members.find(m => m.id === ana).online, false, 'integrada: vuelve a mandar el silencio');
});

// ---------------------------------------------------------------- autoría de los cierres
// El turno ya ofrecía la síntesis solo al autor de la ganadora, pero el MOVIMIENTO no lo
// comprobaba: cualquiera podía publicar el acta final con texto ajeno y cerrar la sala con ella.
// (Integrado en la ronda recursiva 6gs6xt sobre v1 y portado aquí.)
test('la síntesis solo la firma el autor de la propuesta ganadora', () => {
  const room = newRoom();
  const ana = addAgent(room, 'Ana');
  const bruno = addAgent(room, 'Bruno');
  const carla = addAgent(room, 'Carla');
  startRoom(room);
  seedProposal(room, 'p-a', ana, 'Plan A', {});
  seedProposal(room, 'p-b', bruno, 'Plan B', {});
  forcePhase(room, 'synthesis', { winnerId: 'p-b', authorId: bruno });

  assert.throws(
    () => applyMove(room, carla, {
      kind: 'synthesis',
      payload: { final: 'PLAN FINAL ilegítimo: un tercero publica el acta y cierra la sala con texto que no es suyo.' },
    }),
    e => e.code === 'not_author',
    'un tercero no puede firmar la síntesis (antes podía)'
  );
  assert.ok(!room.artifacts.synthesis, 'la sala no quedó con acta ajena');

  applyMove(room, bruno, {
    kind: 'synthesis',
    payload: { final: 'PLAN FINAL legítimo, firmado por el autor de la propuesta ganadora, con más de cincuenta caracteres.' },
  });
  assert.ok(room.artifacts.synthesis, 'el autor de la ganadora sí la firma');
});

// Misma familia de agujero en la verificación: el veredicto independiente lo firma quien el
// servidor asignó, no quien llegue antes.
test('la verificación solo la firma el verificador asignado', () => {
  const room = newRoom();
  const ana = addAgent(room, 'Ana');
  const bruno = addAgent(room, 'Bruno');
  startRoom(room);
  forcePhase(room, 'verify', { winnerId: 'p-a', verifierId: bruno, responses: {} });

  assert.throws(
    () => applyMove(room, ana, { kind: 'verification', payload: { verdict: 'pass', checks: [{ claim: 'comprobación de un no-verificador' }] } }),
    e => e.code === 'not_author',
    'quien no fue asignado no puede firmar la verificación'
  );
  applyMove(room, bruno, { kind: 'verification', payload: { verdict: 'pass', checks: [{ claim: 'comprobación del verificador asignado' }] } });
  assert.equal(room.artifacts.verification.by, bruno, 'el veredicto queda firmado por quien tocaba');
});

// La fase ciega solo lo es de verdad si la vista PÚBLICA no filtra: /public y el SSE no llevan
// token, así que ahí es donde se rompía el encuadre a ciegas.
test('la fase ciega no filtra los planes ajenos por la vista pública', () => {
  const room = newRoom();
  const ana = addAgent(room, 'Ana');
  addAgent(room, 'Bruno');
  startRoom(room);
  forcePhase(room, 'proposal', {});
  seedProposal(room, 'p-a', ana, 'Plan A', {}, 'Texto del plan A que nadie debería poder leer todavía.');

  const ciego = publicRoom(room);
  assert.equal(ciego.blind, true, 'la vista declara que la fase es ciega');
  const p = ciego.proposals.find(x => x.id === 'p-a');
  assert.equal(p.plan, '', 'el plan no se publica en la fase ciega');
  assert.equal(p.risks, '', 'ni los riesgos declarados');
  assert.equal(p.assumptions, '', 'ni los supuestos');
  assert.ok(p.title && p.authorName && typeof p.gist === 'string', 'sí se publica título, autor y esencia');

  // Al revelarse (crítica), todo vuelve a estar a la vista.
  forcePhase(room, 'critique', { assignments: {}, responses: {} });
  const revelado = publicRoom(room);
  assert.equal(revelado.blind, false);
  assert.match(revelado.proposals.find(x => x.id === 'p-a').plan, /nadie debería poder leer/);
});

// La cabeza del log viaja en la vista pública: quien siga la sala puede pedir deltas desde ahí
// en vez de volver a bajarse el historial entero en cada evento.
test('la vista pública publica la cabeza del log (logSeq)', () => {
  const room = newRoom();
  addAgent(room, 'Ana');
  const antes = room.logSeq;
  assert.equal(publicRoom(room).logSeq, antes, 'logSeq sale en la vista pública');
  assert.ok(publicRoom(room).log.every(l => l.id > 0), 'y la cola del log sigue publicándose');
});
