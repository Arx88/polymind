import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoom, joinRoom, attachScaffold, previewFile, sweep, currentTurn, applyMove, enterPhase } from '../server/engine/index.mjs';
import { authAgent, rosterSummary } from '../server/engine/roster.mjs';
import { recoverWorkParticipants, workflowHealth } from '../server/engine/recovery.mjs';
import { forceFinish } from '../server/engine/phases.mjs';
import { activeAgents } from '../server/engine/state.mjs';
import { maybeAutoStart } from '../server/engine/phases.mjs';

function fixture(mode = 'timed') {
  const room = createRoom({ task: 'Producir un mar verificable y recuperar agentes desconectados', settings: { planOnly: true, phaseAdvanceMode: mode } });
  const seats = ['Autor', 'Revisor', 'Alternativo'].map(name => joinRoom(room, { name }));
  room.status = 'debate'; room.phase = { name: 'work', deadline: 1, data: {} };
  room.work = { order: ['w1'], items: { w1: { id: 'w1', status: 'in-review', claimant: seats[0].agentId, reviewer: seats[1].agentId } }, patches: { g1: { id: 'g1', itemId: 'w1', author: seats[0].agentId, reviewer: seats[1].agentId, at: Date.now(), review: null } }, pending: 'g1' };
  return { room, seats, patch: room.work.patches.g1 };
}
const stale = (room, seat) => { room.agents[seat.agentId].lastSeenAt = Date.now() - 86400000; };

test('assignment cannot claim an agent is connected', () => {
  const {room, seats} = fixture(); stale(room, seats[1]);
  const a = rosterSummary(room).find(a => a.id === seats[1].agentId);
  assert.equal(a.online, false); assert.equal(a.presence, 'offline'); assert.ok(a.holding);
});
test('room starts with the minimum and late harness enters at the next phase', () => {
  const room = createRoom({ task: 'Un equipo empieza y otro aporta en la ronda siguiente', settings: { planOnly: true, minAgents: 1, expectedAgents: 0, startAsSoonAsReady: true } });
  const first = joinRoom(room, { name: 'Primer harness', harness: 'uno' });
  assert.equal(maybeAutoStart(room), true);
  assert.equal(room.phase.name, 'frame');
  const late = joinRoom(room, { name: 'Segundo harness', harness: 'dos' });
  assert.equal(late.joiningNextPhase, true);
  assert.deepEqual(activeAgents(room), [first.agentId]);
  assert.equal(currentTurn(room, late.agentId).action, 'wait');
  assert.throws(() => applyMove(room, late.agentId, { kind: 'pass' }), { code: 'next_phase' });
  enterPhase(room, 'proposal');
  assert.ok(activeAgents(room).includes(late.agentId));
  assert.equal(currentTurn(room, late.agentId).action, 'submit-proposal');
});
test('a new harness can rescue a blocked work phase without taking a vacancy', () => {
  const { room, seats, patch } = fixture();
  stale(room, seats[1]); stale(room, seats[2]);
  const late = joinRoom(room, { name: 'Visual reviewer', harness: 'otro' });
  assert.equal(late.joiningNextPhase, false);
  assert.equal(recoverWorkParticipants(room), true);
  assert.equal(patch.reviewer, late.agentId);
  assert.ok(activeAgents(room).includes(late.agentId));
});
test('an abandoned agreement room reaches an explicit terminal state', () => {
  const room = createRoom({ task: 'Acordar una entrega sin arneses que respondan', settings: { planOnly: true, minAgents: 1, phaseAdvanceMode: 'agreement', startAsSoonAsReady: true } });
  const seat = joinRoom(room, { name: 'Solo' });
  maybeAutoStart(room);
  stale(room, seat);
  sweep(room);
  sweep(room);
  assert.equal(room.status, 'closed');
  assert.equal(room.result.outcome, 'expired');
});
test('unresponsive reviewer can be reassigned despite heartbeat traffic', () => {
  const { room, seats, patch } = fixture();
  patch.reviewAssignedAt = Date.now() - 86400000;
  assert.equal(recoverWorkParticipants(room), true);
  assert.equal(patch.reviewer, seats[2].agentId);
  assert.equal(room.work.pending, patch.id);
});
test('stale reviewer opens vacancy and review moves without discarding patch', () => {
  const {room, seats, patch} = fixture(); stale(room, seats[1]);
  assert.equal(recoverWorkParticipants(room), true);
  assert.equal(patch.reviewer, seats[2].agentId); assert.equal(room.work.pending, 'g1');
  assert.equal(room.vacancies.length, 1); assert.equal(patch.review, null);
  assert.equal(recoverWorkParticipants(room), false);
});
test('no independent reviewer is explicit blocked state, never self approval', () => {
  const {room, seats, patch} = fixture(); stale(room, seats[1]); stale(room, seats[2]);
  recoverWorkParticipants(room);
  assert.equal(workflowHealth(room).state, 'blocked');
  sweep(room); assert.equal(room.phase.name, 'work'); assert.equal(room.status, 'debate');
  assert.equal(patch.review, null); assert.equal(room.work.pending, 'g1');
});
test('reconnection reclaims only a seat that has not been replaced', () => {
  const {room, seats} = fixture(); stale(room, seats[1]); recoverWorkParticipants(room);
  authAgent(room, seats[1].agentId, seats[1].token);
  assert.equal(room.agents[seats[1].agentId].status, 'active'); assert.equal(room.vacancies.length, 0);
  stale(room, seats[1]); recoverWorkParticipants(room);
  const replacement = joinRoom(room, {name:'Replacement'});
  assert.equal(replacement.agentId, seats[1].agentId);
  assert.throws(() => authAgent(room, seats[1].agentId, seats[1].token), {code:'unauthorized'});
});
test('agreement removes disconnected work participants, not a thinking deadline', () => {
  const {room, seats} = fixture('agreement'); stale(room, seats[1]);
  recoverWorkParticipants(room);
  assert.equal(room.agents[seats[1].agentId].status, 'absent');
  assert.equal(room.phase.name, 'work');
});
test('heartbeats alone cannot hide a stalled review', () => {
  const {room, patch} = fixture(); patch.at = Date.now() - 86400000;
  assert.equal(workflowHealth(room).state, 'stalled');
  patch.review = {verdict:'approve'}; assert.equal(workflowHealth(room), null);
});
test('duration ceiling offers a final review instead of immediately closing work', () => {
  const { room } = fixture();
  room.work.pending = null;
  room.work.items.w1.status = 'integrated';
  forceFinish(room);
  assert.equal(room.phase.name, 'review'); assert.equal(room.status, 'debate');
  assert.ok(room.finalReviewDeadline > Date.now());
  sweep(room); assert.equal(room.phase.name, 'review');
});
test('preview scopes root-relative resources without changing external resources', async () => {
  const room = createRoom({task:'Crear la escena del mar en un proyecto de prueba'});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polymind-preview-recovery-'));
  await attachScaffold(room, {dataDir: tmp});
  fs.writeFileSync(path.join(room.repo.dir, 'index.html'), '<html><head></head><body><script src="/src/main.js"></script><img src="//cdn.example/a.png"><a href="https://example.com/">external</a></body></html>');
  const body = previewFile(room, 'index.html').body.toString();
  assert.ok(body.includes(`/api/rooms/${room.code}/preview/src/main.js`));
  assert.ok(body.includes('src="//cdn.example/a.png"')); assert.ok(body.includes('href="https://example.com/"'));
});
