import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, joinRoom, startRoom, applyMove, currentTurn, sweep, enterPhase, publicRoom, pickSettings } from '../server/engine/index.mjs';
import { agreementState, phaseRevision } from '../server/engine/agreement.mjs';

function fixture(mode = 'agreement') {
  const room = createRoom({ task: 'Construir una herramienta fiable de planificación conjunta.', settings: { minAgents: 2, expectedAgents: 2, planOnly: true, requireDiversity: false, phaseAdvanceMode: mode } });
  const ids = ['Ada', 'Bruno'].map(name => joinRoom(room, { name, harness: name }).agentId);
  startRoom(room);
  return { room, ids };
}
function ready(room, id) { applyMove(room, id, { kind: 'phase-ready', payload: { revision: phaseRevision(room), ready: true } }); }
function passFrame(room, ids) { ids.forEach(id => applyMove(room, id, { kind: 'pass' })); }

test('configuration keeps timed default and explicitly accepts agreement', () => {
  assert.equal(pickSettings({}).phaseAdvanceMode, 'timed');
  assert.equal(pickSettings({ phaseAdvanceMode: 'agreement' }).phaseAdvanceMode, 'agreement');
});
test('completed contributions wait for everyone, then advance exactly one phase', () => {
  const { room, ids } = fixture();
  applyMove(room, ids[0], { kind: 'pass' });
  assert.equal(currentTurn(room, ids[0]).action, 'wait');
  applyMove(room, ids[1], { kind: 'pass' });
  assert.equal(room.phase.name, 'frame');
  assert.equal(currentTurn(room, ids[0]).action, 'confirm-phase-ready');
  ready(room, ids[0]); assert.equal(room.phase.name, 'frame');
  ready(room, ids[1]); assert.equal(room.phase.name, 'proposal');
  assert.equal(agreementState(room).ready.length, 0);
});
test('new contributions revoke consent and reject stale acknowledgements', () => {
  const { room, ids } = fixture(); passFrame(room, ids);
  const oldRevision = phaseRevision(room);
  ready(room, ids[0]);
  applyMove(room, ids[1], { kind: 'point-proposal', payload: { label: 'Seguridad', options: ['A', 'B'] } });
  assert.equal(agreementState(room).ready.length, 0);
  assert.throws(() => applyMove(room, ids[1], { kind: 'phase-ready', payload: { revision: oldRevision } }), { code: 'stale_phase' });
});
test('no clock closes a thinking phase, even beyond the total budget', () => {
  const { room } = fixture();
  room.createdAt = Date.now() - 30 * 86400000;
  room.phase.deadline = 1;
  sweep(room);
  assert.equal(room.phase.name, 'frame'); assert.equal(room.status, 'debate');
  assert.equal(publicRoom(room).deadlineInSec, 0);
  assert.equal(publicRoom(room).rules.phaseAdvanceMode, 'agreement');
});
test('explicit human override still advances and does not forge consent', () => {
  const { room } = fixture(); room.phase.deadline = 1;
  sweep(room, { force: true });
  assert.equal(room.phase.name, 'proposal');
  assert.equal(agreementState(room).ready.length, 0);
});
test('unanimous acknowledgement cannot skip missing required work', () => {
  const { room, ids } = fixture(); ids.forEach(id => ready(room, id));
  assert.equal(room.phase.name, 'frame');
});
test('readiness can be withdrawn and is not content consensus', () => {
  const { room, ids } = fixture(); passFrame(room, ids); ready(room, ids[0]);
  applyMove(room, ids[0], { kind: 'phase-ready', payload: { revision: phaseRevision(room), ready: false } });
  assert.equal(agreementState(room).ready.length, 0);
  assert.equal(publicRoom(room).consensus.global, 0);
});
test('timed rooms preserve automatic advancement and reject phase-ready', () => {
  const { room, ids } = fixture('timed'); passFrame(room, ids);
  assert.equal(room.phase.name, 'proposal');
  assert.throws(() => ready(room, ids[0]), { code: 'wrong_phase' });
});
test('complete agreement cycle reaches a result without any clock forcing', () => {
  const { room, ids } = fixture();
  let confirmations = 0;
  for (let round = 0; round < 80 && room.status !== 'closed'; round++) for (const id of ids) {
    if (room.status === 'closed') break;
    const turn = currentTurn(room, id);
    let move;
    switch (turn.action) {
      case 'confirm-phase-ready': ready(room, id); confirmations++; continue;
      case 'frame-contribute': case 'submit-revision-or-pass': case 'objection-or-pass': move = { kind: 'pass' }; break;
      case 'submit-proposal': move = { kind: 'proposal', payload: { title: `Plan ${id}`, plan: `Plan profesional de ${id}: medir el resultado, implementar de forma gradual y verificar con pruebas independientes.`, approach: id } }; break;
      case 'submit-critique': move = { kind: 'critique', payload: { target: turn.targets[0].id, steelman: 'El plan permite comprobar el resultado de forma independiente.', objections: [] } }; break;
      case 'submit-vote': move = { kind: 'vote', payload: { ranking: turn.options.map(p => p.id) } }; break;
      case 'submit-synthesis': move = { kind: 'synthesis', payload: { final: 'Plan conjunto: medir primero, implementar por etapas y verificar de manera independiente todos los cambios incorporados.', merges: [] } }; break;
      case 'submit-verification': move = { kind: 'verification', payload: { verdict: 'pass', checks: [] } }; break;
      case 'wait': continue;
      default: assert.fail(`Unexpected turn: ${turn.action}`);
    }
    applyMove(room, id, move);
  }
  assert.equal(room.status, 'closed');
  assert.ok(confirmations >= 12);
  assert.ok(room.result);
});
test('failed verification cannot bypass the agreement gate or lose repair', () => {
  const { room, ids } = fixture();
  room.artifacts.proposals.p1 = { id: 'p1', author: ids[0], title: 'Plan', plan: 'Plan de implementación verificable que preserva los datos.', v: 1, round: 1 };
  enterPhase(room, 'verify', { winnerId: 'p1' });
  applyMove(room, room.phase.data.verifierId, { kind: 'verification', payload: { verdict: 'fail', findings: [{ severity: 'high', text: 'La implementación pierde datos existentes.' }] } });
  assert.equal(room.phase.name, 'verify');
  ids.forEach(id => ready(room, id));
  assert.equal(room.phase.name, 'repair');
  assert.equal(room.phase.data.after, 'close');
});
