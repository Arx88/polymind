import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoom, joinRoom, attachScaffold, previewFile, sweep } from '../server/engine/index.mjs';
import { authAgent, rosterSummary } from '../server/engine/roster.mjs';
import { recoverWorkParticipants, workflowHealth } from '../server/engine/recovery.mjs';
import { forceFinish } from '../server/engine/phases.mjs';

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
