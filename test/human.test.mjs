// AGORA v2 — pruebas del juicio humano: SOLO sobre lo entregado, y solo al final.
//
// Lo que se comprueba aquí, y por qué cada cosa:
//   1. antes de la entrega no hay juicio humano: la sala no cerró y nadie acepta lo que no está;
//   2. «pedir cambios» exige decir QUÉ cambiar (un «no me gusta» no se puede convertir en tarea);
//   3. un cambio pedido se convierte en trabajo y REABRE la sala: la entrega no queda congelada con
//      una queja al pie;
//   4. cuando esas tareas se integran, el pedido pasa a «atendido» y deja de bloquear el veredicto;
//   5. aprobar no reabre nada, y el historial conserva los veredictos anteriores con su motivo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createRoom, joinRoom, attachRepo, runBaseline, startRoom, startWork,
  buildObligations, obligationsMarkdown, exportMarkdown, finishRoom,
  recordHumanReview, reopenForChanges, humanReviewReport, humanReviews, humanBrief, delivered,
  refreshFrozenResult,
} from '../server/engine/index.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-human-'));
const DATA = path.join(TMP, 'data');

const FAST = {
  phaseMs: Object.fromEntries(['lobby', 'frame', 'audit', 'proposal', 'critique', 'revise', 'vote',
    'tiebreak', 'objection', 'repair', 'synthesis', 'verify', 'work', 'review'].map(p => [p, 120_000])),
  joinQuietMs: 120_000,
  minAgents: 2,
  requireDiversity: false,
};

let origen = null;

function fixture() {
  if (origen) return origen;
  const dir = path.join(TMP, 'barco');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'mar.js'), 'export function ola(t) { return Math.sin(t); }\n');
  fs.writeFileSync(path.join(dir, 'check.mjs'), [
    "import { ola } from './src/mar.js';",
    "if (Math.abs(ola(0)) > 1e-9) { console.error('esperado 0'); process.exit(1); }",
    "console.log('check ok');",
    '',
  ].join('\n'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-q', '-m', 'inicial');
  origen = dir;
  return dir;
}

// Una sala que ya entregó: repo de verdad, plan ganador, una mejora integrada y el resultado
// congelado. Es el único estado desde el que el humano puede juzgar.
async function deliveredRoom() {
  const room = createRoom({ task: 'Mar procedural con oleaje y casco legible.', settings: FAST });
  const ids = ['Ana', 'Bruno'].map(n => joinRoom(room, { name: n, harness: n.toLowerCase(), model: 'test' }).agentId);
  await attachRepo(room, { dataDir: DATA, source: fixture(), verify: 'node check.mjs', verifyTimeoutMs: 20_000, baseline: false });
  room.repo.baseline = await runBaseline(room);
  startRoom(room);
  room.phase = { name: 'work', startedAt: Date.now(), deadline: Date.now() + 600_000, data: { winnerId: 'p1' } };
  room.repo.greenfield = true;
  room.rounds = 1;
  room.artifacts.proposals.p1 = {
    id: 'p1', author: ids[0], round: 1, v: 1, title: 'Plan del mar',
    plan: 'El mar se calcula con un espectro de olas.\nLa suite `node check.mjs` queda en verde.',
    positions: {},
  };
  room.lastWinnerId = 'p1';
  room.artifacts.synthesis = { by: ids[0], final: room.artifacts.proposals.p1.plan, pointResolutions: [], merges: [] };
  startWork(room, 'p1');
  const item = room.work.items[room.work.order[0]];
  item.status = 'integrated';
  item.commit = room.repo.head;
  item.claimant = ids[0];
  finishRoom(room, 'p1');
  return { room, ids };
}

// ---------------------------------------------------------------- 1. cuándo se puede juzgar
test('humano: sin entrega no hay juicio humano, y se dice por qué', async () => {
  const room = createRoom({ task: 'Mar procedural.', settings: FAST });
  joinRoom(room, { name: 'Ana', harness: 'a', model: 'test' });
  joinRoom(room, { name: 'Bruno', harness: 'b', model: 'test' });
  startRoom(room);
  assert.equal(delivered(room), false);
  assert.throws(() => recordHumanReview(room, { verdict: 'aprobado' }), /sobre lo ENTREGADO/);
  assert.equal(humanBrief(room), null, 'tampoco se le ofrece al humano antes de tiempo');
  assert.equal(humanReviews(room).length, 0);
});

test('humano: una entrega congelada sí se puede juzgar, y el resultado trae su informe', async () => {
  const { room } = await deliveredRoom();
  assert.equal(delivered(room), true);
  assert.ok(humanBrief(room)?.available);
  const { review, warnings, canReopen } = recordHumanReview(room, { verdict: 'aprobado', reason: 'sirve así', by: 'Juan' });
  assert.equal(review.verdict, 'aprobado');
  assert.equal(canReopen, false, 'aprobar no reabre nada');
  assert.equal(review.deliveredChecksum, room.result.checksum, 'el veredicto queda atado a la entrega que juzgó');
  assert.ok(Array.isArray(warnings));
  const rep = humanReviewReport(room);
  assert.equal(rep.verdict, 'aprobado');
  assert.equal(rep.by, 'Juan');
  assert.equal(room.result.humanReview.verdict, 'aprobado', 'el informe congelado se actualiza al firmar');
  assert.match(exportMarkdown(room), /### Revisión humana \(al final, sobre la entrega\)/);
  assert.match(exportMarkdown(room), /APROBADO\*\* por Juan/);
});

// ---------------------------------------------------------------- 2. pedir cambios
test('humano: pedir cambios exige decir qué cambiar', async () => {
  const { room, ids } = await deliveredRoom();
  assert.throws(() => recordHumanReview(room, { verdict: 'cambios' }), /petición concreta/);
  assert.throws(() => recordHumanReview(room, { verdict: 'cambios', requests: ['mal'] }), /qué cambiar/);
  assert.throws(() => recordHumanReview(room, { verdict: 'cualquiera' }), /verdict/);
  // Y nada de eso tocó el trabajo de la sala.
  assert.equal(room.work.order.length, 1);
  assert.equal(humanReviews(room).length, 0);
  assert.equal(ids.length, 2);
});

test('humano: un cambio pedido se convierte en trabajo y REABRE la sala', async () => {
  const { room } = await deliveredRoom();
  const antes = room.work.order.length;
  const { review, canReopen } = recordHumanReview(room, {
    verdict: 'cambios',
    reason: 'a 200 m el casco se pierde contra el agua',
    requests: [
      'Subir la luz de contorno del casco para que se lea contra el mar a 200 m.',
      'Endurecer el contraste de la espuma en el temporal.',
    ],
  });
  assert.equal(canReopen, true, 'la sala escribió código: puede ejecutar los cambios');
  const out = await reopenForChanges(room, review);
  assert.equal(out.reopened, true);
  assert.equal(room.status, 'debate', 'la entrega deja de estar congelada');
  assert.equal(room.phase.name, 'work', 'y la sala vuelve al trabajo, no a discutir');
  assert.equal(room.work.order.length, antes + 2, 'dos cambios, dos tareas');
  const nuevas = out.items.map(id => room.work.items[id]);
  assert.ok(nuevas.every(i => i.from === 'humano'), 'las tareas nacen de la revisión humana');
  assert.ok(nuevas.every(i => /luz de contorno|contraste de la espuma/i.test(i.claim)));
  // Cada pedido recuerda qué tarea lo ejecuta, y el informe lo dice.
  const rep = humanReviewReport(room);
  assert.equal(rep.verdict, 'cambios');
  assert.equal(rep.open.length, 2);
  assert.ok(rep.requests.every(r => r.status === 'en-curso' && r.itemIds.length === 1));
  assert.equal(rep.rounds, 1);
  // Y el acta lo cuenta como obligación abierta, no como un comentario.
  const led = buildObligations(room);
  assert.ok(led.blockers.some(b => b.kind === 'humano-pide-cambios'));
  assert.equal(led.human.verdict, 'cambios');
  assert.match(obligationsMarkdown(room).join('\n'), /CAMBIOS PEDIDOS/);
});

test('humano: cuando las tareas entran, el pedido pasa a atendido y deja de bloquear', async () => {
  const { room } = await deliveredRoom();
  const { review } = recordHumanReview(room, {
    verdict: 'cambios',
    requests: ['Subir la luz de contorno del casco a 200 m de distancia.'],
  });
  const out = await reopenForChanges(room, review);
  assert.ok(buildObligations(room).blockers.some(b => b.kind === 'humano-pide-cambios'));
  for (const id of out.items) {
    room.work.items[id].status = 'integrated';
    room.work.items[id].commit = room.repo.head;
  }
  const rep = humanReviewReport(room);
  assert.equal(rep.requests[0].status, 'atendido');
  assert.equal(rep.open.length, 0);
  assert.ok(!buildObligations(room).blockers.some(b => b.kind === 'humano-pide-cambios'));
});

test('humano: aprobar después de los cambios no reabre y conserva el historial', async () => {
  const { room } = await deliveredRoom();
  const primera = recordHumanReview(room, { verdict: 'cambios', requests: ['Endurecer la espuma del temporal para que se lea.'] });
  const out = await reopenForChanges(room, primera.review);
  for (const id of out.items) room.work.items[id].status = 'integrated';
  // La sala vuelve a cerrar: el segundo cierre trae el informe humano con lo pedido y su estado.
  room.status = 'debate';
  room.phase = { name: 'review', startedAt: Date.now(), deadline: Date.now() + 60_000, data: { winnerId: 'p1' } };
  finishRoom(room, 'p1');
  assert.equal(room.status, 'closed');
  assert.equal(room.result.humanReview.verdict, 'cambios');
  assert.equal(room.result.humanReview.requests[0].status, 'atendido');

  const segunda = recordHumanReview(room, { verdict: 'aprobado', reason: 'ahora sí se lee', by: 'Juan' });
  assert.equal(segunda.canReopen, false);
  assert.equal(room.status, 'closed', 'aprobar no reabre la sala');
  const rep = humanReviewReport(room);
  assert.equal(rep.verdict, 'aprobado');
  assert.equal(rep.reviewed, 2);
  assert.equal(rep.history.length, 2);
  assert.equal(rep.history[0].verdict, 'cambios');
  assert.equal(rep.history[0].reopened, true);
  assert.equal(rep.open.length, 0);
});

test('humano: avisa de lo que el acta dice de la entrega que se aprueba', async () => {
  const { room } = await deliveredRoom();
  // El informe congelado dice que quedaron firmas de visión sin poner: aprobar así se puede, pero
  // el aviso viaja en el veredicto en lugar de desaparecer.
  room.result.obligations.visual = {
    ...(room.result.obligations.visual || {}),
    vision: { seers: [{ name: 'Vera', harness: 'v', model: 'm', signed: 0, pending: ['o3'] }], missing: 1, note: 'falta una firma' },
  };
  const { warnings } = recordHumanReview(room, { verdict: 'aprobado', by: 'Juan' });
  assert.ok(warnings.some(w => /firmas de modelos con visión declarada sin poner/.test(w) && /Vera/.test(w)));
});

test('humano: en una sala sin código los cambios quedan registrados y se dice por qué no se ejecutan', async () => {
  const room = createRoom({ task: 'Solo planificar el mar.', settings: { ...FAST, planOnly: true } });
  const ids = ['Ana', 'Bruno'].map(n => joinRoom(room, { name: n, harness: n.toLowerCase(), model: 'test' }).agentId);
  startRoom(room);
  room.artifacts.proposals.p1 = { id: 'p1', author: ids[0], round: 1, v: 1, title: 'Plan', plan: 'Un plan sin código.', positions: {} };
  room.lastWinnerId = 'p1';
  room.artifacts.synthesis = { by: ids[0], final: 'Un plan sin código.', pointResolutions: [], merges: [] };
  finishRoom(room, 'p1');
  assert.equal(room.status, 'closed');
  const { review, canReopen } = recordHumanReview(room, { verdict: 'cambios', requests: ['Añadir oleaje con espectro al plan.'] });
  assert.equal(canReopen, false, 'sin repo no hay ronda que ejecute nada');
  const out = await reopenForChanges(room, review);
  assert.equal(out.reopened, false);
  assert.match(review.because, /no escribió código/);
  const rep = humanReviewReport(room);
  assert.equal(rep.requests[0].status, 'sin-tarea');
  assert.equal(rep.open.length, 1);
  assert.ok(buildObligations(room).blockers.some(b => b.kind === 'humano-pide-cambios'));
  // El resultado sigue congelado: no se finge una reapertura que no puede ocurrir.
  assert.equal(room.status, 'closed');
  refreshFrozenResult(room);
  assert.equal(room.result.humanReview.open.length, 1);
});
