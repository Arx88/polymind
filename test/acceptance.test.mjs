import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliveryAcceptance } from '../server/engine/acceptance.mjs';
import { createRoom, joinRoom, attachScaffold, startWork, addReviewItems, closeReviewPhase, currentTurn, runVerify, git, maybeFinishWork, workIsFinished, workBacklog, setVerifyCommand } from '../server/engine/index.mjs';

function room(task = 'Construir un juego 3d navegable') {
  return { task, settings: {}, repo: { head: 'final' }, artifacts: {},
    work: { items: { w1: { status: 'integrated' } } } };
}
const page = { available: true, synthetic: false, entry: 'index.html' };
test('incident: integrated modules without a page are not a finished visual product', () => {
  const a = deliveryAcceptance(room(), { preview: { available: true, synthetic: true, entry: '__agora__.html' } });
  assert.equal(a.state, 'incomplete');
  assert.equal(a.preview.available, false);
  assert.deepEqual(a.blockers.map(b => b.code), ['preview', 'tests', 'capture', 'visual-review']);
});
test('a page alone does not prove execution or visual quality', () => {
  const a = deliveryAcceptance(room(), { preview: page });
  assert.equal(a.state, 'incomplete');
  assert.deepEqual(a.blockers.map(b => b.code), ['tests', 'capture', 'visual-review']);
});
test('a CLI does not need a made-up web interface; current final verification counts', () => {
  const r = room('Implementar un parser de CSV');
  r.artifacts.evidence = [{ kind: 'verify', ok: true, exitCode: 0, commit: 'final' }];
  assert.equal(deliveryAcceptance(r, { preview: { available: false } }).state, 'evidenced');
  r.artifacts.evidence[0].commit = 'old';
  assert.equal(deliveryAcceptance(r, { preview: page }).state, 'incomplete');
});
test('capture probes and per-patch tests cannot certify the final combined tree', () => {
  const r = room('Implementar un parser');
  for (const extra of [{ kind: 'visual' }, { itemId: 'w1' }, { dirty: true }]) {
    r.artifacts.evidence = [{ kind: 'verify', ok: true, exitCode: 0, commit: 'final', ...extra }];
    assert.equal(deliveryAcceptance(r, { preview: page }).verified, false);
  }
});
test('planning-only work is not incorrectly reported as missing code', () => {
  const r = room(); r.settings.planOnly = true;
  assert.equal(deliveryAcceptance(r).state, 'plan');
});
test('a visual rejection cannot disappear behind an approval', () => {
  const r = room();
  r.artifacts.visual = { shots: [{ id: 's1', commit: 'final' }] };
  r.artifacts.judgments = [
    { verdict: 'pasa', independence: 'ajeno', captures: [{ id: 's1' }] },
    { verdict: 'no-pasa', reason: 'Los controles no funcionan' },
  ];
  r.artifacts.evidence = [{ kind: 'verify', ok: true, exitCode: 0, commit: 'final' }];
  const a = deliveryAcceptance(r, { preview: page });
  assert.equal(a.state, 'incomplete');
  assert.ok(a.blockers.some(b => b.code === 'visual-rejected'));
});

async function reviewFixture({ cap = 12, round = 1 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymind-acceptance-'));
  const r = createRoom({ task: 'Construir un juego 3d navegable', settings: { visual: { enabled: false }, repo: { maxWorkItems: cap, reviewRounds: 2 } } });
  const author = joinRoom(r, { name: 'Builder', model: 'fixture' }).agentId;
  const reviewer = joinRoom(r, { name: 'Reviewer', model: 'fixture' }).agentId;
  await attachScaffold(r, { dataDir });
  r.artifacts.proposals.p1 = { id: 'p1', author, v: 1, title: 'Construcción', plan: 'Construir un juego 3d navegable.', positions: {} };
  startWork(r, 'p1');
  if (!r.work.order.length) addReviewItems(r, [{ title: 'Construir el motor', claim: 'Motor integrado', evidence: 'Fixture', action: 'Construir los módulos del motor', files: [] }]);
  // Freeze the test at the real failure boundary: all planned tasks were integrated.
  for (const id of r.work.order) Object.assign(r.work.items[id], { status: 'integrated', claimant: author });
  r.status = 'debate';
  r.lastWinnerId = 'p1';
  r.phase = { name: 'review', startedAt: Date.now(), deadline: Date.now() + 60000,
    data: { winnerId: 'p1', review: { round, revisados: { [reviewer]: Object.fromEntries(r.work.order.map(id => [id, { verdict: 'ok' }])) } } } };
  return { r, author };
}

test('review returns a missing visual product to construction even without extraordinary mode', async () => {
  const { r } = await reviewFixture();
  closeReviewPhase(r);
  assert.equal(r.phase.name, 'work');
  assert.equal(r.status, 'debate');
  assert.ok(r.work.order.some(id => r.work.items[id].status === 'open' && r.work.items[id].title.includes('vista previa')));
});

test('exhausted review rounds stop, preserving incomplete delivery in the agent handoff', async () => {
  const { r, author } = await reviewFixture({ round: 2 });
  closeReviewPhase(r);
  assert.equal(r.status, 'closed');
  assert.equal(r.result.delivery.acceptance.state, 'incomplete');
  const turn = currentTurn(r, author);
  assert.equal(turn.action, 'done');
  assert.match(turn.message, /ENTREGA INCOMPLETA/);
});

test('completed tasks do not consume the repair capacity', async () => {
  const { r } = await reviewFixture({ cap: 1 });
  const before = r.work.order.length;
  closeReviewPhase(r);
  assert.ok(r.work.order.length > before);
  assert.equal(r.phase.name, 'work');
  assert.ok(Object.values(r.work.items).some(i => i.title.includes('verificar')));
});

test('incident 462cra: approved scope drains in batches instead of stopping at 12 lifetime tasks', async () => {
  const { r } = await reviewFixture({ cap: 12 });
  r.artifacts.synthesis = { final: Array.from({ length: 24 }, (_, i) => `## Parte ${i + 1}\nImplementar requisito ${i + 1}`).join('\n') };
  startWork(r, 'p1');
  assert.equal(r.work.order.length, 12);
  assert.equal(workBacklog(r).length, 12);
  for (const i of Object.values(r.work.items)) i.status = 'integrated';
  assert.equal(workIsFinished(r), false);
  assert.ok(deliveryAcceptance(r).blockers.some(b => b.code === 'scope'));
  assert.equal(maybeFinishWork(r), false);
  assert.equal(r.work.order.length, 24);
  assert.equal(workBacklog(r).length, 0);
  maybeFinishWork(r);
  assert.equal(r.work.order.length, 24, 'polling does not duplicate scope');
  for (const i of Object.values(r.work.items)) i.status = 'integrated';
  assert.equal(maybeFinishWork(r), true);
});

test('a test suite introduced after scaffolding is discovered and actually executed', async () => {
  const { r } = await reviewFixture();
  fs.writeFileSync(path.join(r.repo.dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }));
  git(r.repo, ['add', 'package.json']);
  const measurement = await runVerify(r);
  assert.equal(measurement.ran, true);
  assert.equal(measurement.ok, false);
  assert.equal(r.repo.verify.command, 'npm test');
});

test('a measured patch tree certifies the identical final commit, not a later commit', async () => {
  const { r } = await reviewFixture();
  r.task = 'Implementar un parser';
  r.repo.verify = { command: 'node -e "process.exit(0)"', timeoutMs: 5000 };
  const id = r.work.order[0];
  const measurement = await runVerify(r, { kind: 'patch', itemId: id });
  assert.ok(measurement.verifiedTree);
  r.work.items[id].commit = r.repo.head;
  assert.equal(deliveryAcceptance(r).verified, true);
  fs.appendFileSync(path.join(r.repo.dir, 'README.md'), '\nNew code after the measurement\n');
  git(r.repo, ['add', 'README.md']);
  git(r.repo, ['-c', 'user.name=QA', '-c', 'user.email=qa@localhost', 'commit', '-m', 'Later change']);
  r.repo.head = git(r.repo, ['rev-parse', 'HEAD']).output.trim();
  assert.equal(deliveryAcceptance(r).verified, false);
});

test('a verification command that changes tracked code cannot certify HEAD', async () => {
  const { r } = await reviewFixture();
  r.repo.verify = { command: 'node -e "require(\'fs\').appendFileSync(\'README.md\',\'changed\')"', timeoutMs: 5000 };
  const measurement = await runVerify(r);
  assert.equal(measurement.ok, true);
  assert.equal(measurement.verifiedTree, null);
  assert.equal(deliveryAcceptance(r).verified, false);
});
