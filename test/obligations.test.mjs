// AGORA v2 — pruebas del libro de obligaciones: lo que el plan AFIRMA contra lo que el servidor
// MIDIÓ, más el alcance y los conflictos que se comprueban antes de trabajar.
//
// Cubren las cuatro piezas que hacen que el acta no sea prosa:
//   1. tipado de afirmaciones (medible / juicio / cifra declarada);
//   2. el encargo original contra el plan (derivación independiente: «debe ser navegable» no
//      aparece en el plan y el veredicto lo dice);
//   3. evidencia generada por el servidor, con huella, reutilizable y atada al árbol;
//   4. alcance («manda crear lo que ya existe») y conflictos de archivos entre tareas.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createRoom, joinRoom, attachRepo, runBaseline, startRoom, startWork,
  classifyClaim, claimsInPlan, askClauses, coverageOf, evidenceOf, evidenceStatus, recordEvidence,
  vacuousChecks, scopeVerdict, fileConflicts, isCreating, claimRefs,
  buildObligations, obligationsBrief, obligationsMarkdown, annotateItems,
  planText, workFrom, exportMarkdown, finishRoom, claimItem, runVerify, currentTurn,
} from '../server/engine/index.mjs';

// Un fixture de git por sala no hace falta: `attachRepo` clona, así que el mismo repositorio de
// origen sirve para todas las salas de esta prueba.
let galeon = null;

// ---------------------------------------------------------------- fixture git
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-oblig-'));
const DATA = path.join(TMP, 'data');

const FAST = {
  phaseMs: Object.fromEntries(['lobby', 'frame', 'audit', 'proposal', 'critique', 'revise', 'vote',
    'tiebreak', 'objection', 'repair', 'synthesis', 'verify', 'work', 'review'].map(p => [p, 120_000])),
  joinQuietMs: 120_000,
  minAgents: 2,
  requireDiversity: false,
};

function fixture(name) {
  const dir = path.join(TMP, name);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(path.join(dir, 'src', 'ship'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ship', 'hull.js'),
    'export function buildHull() { return { ok: true }; }\n');
  fs.writeFileSync(path.join(dir, 'src', 'calc.mjs'),
    'export function total(items) { return items.reduce((s, i) => s + i.price * (i.qty ?? 1), 0); }\n');
  fs.writeFileSync(path.join(dir, 'check.mjs'), [
    "import { total } from './src/calc.mjs';",
    "if (total([{ price: 2, qty: 3 }]) !== 6) { console.error('esperado 6'); process.exit(1); }",
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
  return dir;
}

// Una sala con repo de verdad, ya en fase de trabajo, con el plan sembrado como si el debate
// hubiera terminado. Es lo mínimo para probar el libro sin repetir el debate entero.
const PLAN = [
  'Añadir src/ship/hull.js con el casco procedural.',
  'La suite `node check.mjs` debe quedar en verde tras el cambio.',
].join('\n');

async function workRoom({ task = 'Añadir el casco procedural y dejar la suite en verde.' } = {}) {
  const room = createRoom({ task, settings: FAST });
  const ids = ['Ana', 'Bruno'].map(n => joinRoom(room, { name: n, harness: n.toLowerCase(), model: 'test' }).agentId);
  galeon = galeon || fixture('galeon');
  await attachRepo(room, {
    dataDir: DATA, source: galeon,
    verify: 'node check.mjs', verifyTimeoutMs: 20_000, baseline: false,
  });
  room.repo.baseline = await runBaseline(room);
  startRoom(room);
  room.phase = { name: 'work', startedAt: Date.now(), deadline: Date.now() + 600_000, data: { winnerId: 'p1' } };
  // Proyecto nuevo: el plan aprobado ES el trabajo (así llega una sala de proyecto nuevo).
  room.repo.greenfield = true;
  room.rounds = 1;
  room.artifacts.proposals.p1 = { id: 'p1', author: ids[0], round: 1, v: 1, title: 'Plan del casco', plan: PLAN, positions: {} };
  room.lastWinnerId = 'p1';
  room.artifacts.synthesis = { by: ids[0], final: PLAN, pointResolutions: [], merges: [] };
  return { room, ids };
}

// ---------------------------------------------------------------- 1. tipado
test('tipado: una afirmación se clasifica por lo que se puede hacer con ella', () => {
  const medible = classifyClaim('La suite `node check.mjs` debe quedar en verde tras el cambio.');
  assert.equal(medible.type, 'executable');
  assert.ok(medible.refs.commands.includes('node check.mjs'));

  const juicio = classifyClaim('El galeón no se ve cutre y la espuma se lee como en Fortnite.');
  assert.equal(juicio.type, 'juicio', 'lo que se ve no lo mide un comando');

  const cifra = classifyClaim('El palo mayor mide 60 m de alto.');
  assert.equal(cifra.type, 'cifra', 'un número sin instrumento es una cifra de diseño');

  const nada = classifyClaim('Hay que revisar el asunto con calma.');
  assert.equal(nada.type, 'sin-clasificar');

  // Un comando citado manda sobre la prosa de aspecto: si se puede medir, se mide.
  assert.equal(classifyClaim('El agua se ve mejor cuando `node check-ocean.mjs` pasa.').type, 'executable');
});

test('claimsInPlan: viñetas y frases, sin encabezados ni tablas', () => {
  const plan = '# Plan\n\n- El parser acepta `scene=noche` y devuelve calma a las 22,5 h.\n| a | b |\n\nSegunda parte: el barco flota y no se hunde.\n';
  const claims = claimsInPlan(plan);
  assert.ok(claims.length >= 2);
  assert.ok(claims.every(c => !c.startsWith('#')));
  assert.ok(!claims.some(c => c.includes('|')));
  assert.ok(claims.some(c => /parser/i.test(c)));
});

// ---------------------------------------------------------------- 2. el encargo
test('encargo: la cláusula que el plan no cubre se publica como sin cobertura', () => {
  const room = createRoom({
    task: 'Mejora el galeón. El barco debe ser navegable con teclado y gamepad.\nEl océano debe tener oleaje con espectro.',
    settings: FAST,
  });
  room.artifacts.synthesis = {
    final: 'El océano se calcula con un espectro de olas y se comprueba con `node check-ocean.mjs`.',
  };
  const led = buildObligations(room);
  assert.ok(led.ask.clauses.length >= 2, 'el encargo se trocea en cláusulas');
  assert.ok(led.ask.uncovered.some(u => /navegable/i.test(u.clause)),
    'la cláusula de navegación no aparece en el plan y sale como sin cobertura');
  assert.ok(led.ask.clauses.some(c => c.covered && /océano|oleaje|espectro/i.test(c.clause)),
    'la del océano sí está cubierta: el contraste distingue unas de otras');
  assert.equal(led.verdict, 'no-cumplido', 'una cláusula sin cobertura bloquea el veredicto');
  assert.ok(led.blockers.some(b => b.kind === 'encargo-sin-cobertura'));
});

test('cobertura: el umbral no convierte en cubierta una cláusula de otro tema', () => {
  const clauses = askClauses('El barco debe ser navegable. La suite debe quedar en verde.');
  const covered = coverageOf(clauses, [{ id: 'plan', text: 'Dejar la suite en verde con node check.mjs.' }]);
  assert.equal(covered.filter(c => c.covered).length, 1);
  assert.match(covered.find(c => c.covered).clause, /suite/i);
  assert.match(covered.find(c => !c.covered).clause, /navegable/i);
});

// ---------------------------------------------------------------- 3. evidencia
test('evidencia: la huella se reutiliza y la medición caduca cuando cambia el árbol', () => {
  const room = createRoom({ task: 'Medir algo del proyecto con un comando.', settings: FAST });
  const a = recordEvidence(room, { command: 'node check.mjs', exitCode: 0, ok: true, output: 'ok', commit: 'aaa' });
  const b = recordEvidence(room, { command: 'node check.mjs', exitCode: 0, ok: true, output: 'ok', commit: 'aaa' });
  assert.equal(a.entry.hash, b.entry.hash, 'la misma medición tiene la misma huella');
  assert.equal(b.reused, true, 'y no se duplica');
  assert.equal(evidenceOf(room).total, 1);
  assert.equal(evidenceOf(room).entries[0].uses, 2);

  room.repo = { head: 'bbb' };
  assert.equal(evidenceOf(room).entries[0].status, 'caduca', 'una medición de otro commit no certifica el HEAD');

  // Atada a una tarea: provisional mientras el árbol está en vuelo, fresca al integrarse,
  // caduca si después se deshace.
  room.work = { order: ['w1'], items: { w1: { id: 'w1', status: 'in-review' } } };
  const c = recordEvidence(room, { command: 'node x.mjs', exitCode: 0, ok: true, output: 'y', commit: 'bbb', itemId: 'w1', kind: 'patch' });
  assert.equal(evidenceStatus(room, c.entry), 'provisional');
  room.work.items.w1.status = 'integrated';
  assert.equal(evidenceStatus(room, c.entry), 'fresca');
  room.work.items.w1.status = 'reverted';
  assert.equal(evidenceStatus(room, c.entry), 'caduca', 'deshacer la mejora invalida su evidencia');
});

test('falsabilidad: una comprobación que no puede fallar se marca', () => {
  const vacuas = vacuousChecks([
    { claim: 'la suite pasa', method: 'node check.mjs', expectation: 'exit 0' },
    { claim: 'todo bien', method: 'mirar', expectation: 'se ve bien' },
    { claim: 'sin método', method: '', expectation: '0' },
  ]);
  assert.equal(vacuas.length, 2);
  assert.ok(vacuas.some(v => /comparación ni cifra/.test(v.because)));
  assert.ok(vacuas.some(v => /CÓMO/.test(v.because)));
});

// ---------------------------------------------------------------- 4. alcance
test('alcance: la tarea que manda crear lo que ya existe se detecta al nacer', async () => {
  const { room } = await workRoom();
  startWork(room, 'p1');
  assert.equal(room.work.order.length, 1);
  const item = room.work.items[room.work.order[0]];
  assert.deepEqual(item.files, ['src/ship/hull.js', 'check.mjs']);
  assert.equal(item.scopeCheck.verdict, 'ya-existe', '«añadir src/ship/hull.js» con el archivo ya en el repo');
  assert.match(item.scopeCheck.because, /CREAR|crear/i);
  assert.equal(item.scopeCheck.hit, 'src/ship/hull.js');
  assert.ok(isCreating(item.claim));
});

test('alcance: sin verbo de creación, lo que ya existe se marca a verificar y no como duplicado', () => {
  const v = scopeVerdict({
    refs: { files: ['src/ship/hull.js'], commands: [], symbols: [], numbers: [] },
    existingPaths: ['src/ship/hull.js'],
    creating: false,
  });
  assert.equal(v.verdict, 'a-verificar');
  const nuevo = scopeVerdict({
    refs: { files: ['src/ship/mast.js'], commands: [], symbols: [], numbers: [] },
    existingPaths: ['src/ship/hull.js'],
    creating: true,
  });
  assert.equal(nuevo.verdict, 'nuevo');
});

test('conflictos: dos tareas no trabajan el mismo archivo a la vez', async () => {
  const { room, ids } = await workRoom({ task: 'Añadir el casco procedural y la vela al proyecto.' });
  startWork(room, 'p1');
  const primera = room.work.items[room.work.order[0]];
  // Segunda tarea sobre el mismo archivo, como la crearía una revisión o la ronda siguiente.
  room.work.items.w2 = {
    ...primera, id: 'w2', title: 'Tocar otra vez el casco', status: 'open', claimant: null,
    patches: [], review: null, verify: null, commit: null, attempts: 0, verifyFailures: 0,
  };
  room.work.order.push('w2');
  annotateItems(room, [room.work.items.w2]);
  assert.deepEqual(room.work.items.w2.blockedBy, [primera.id]);
  assert.ok(room.work.items.w2.fileConflicts.some(c => c.files.includes('src/ship/hull.js')));

  claimItem(room, ids[0], { itemId: primera.id });
  assert.throws(() => claimItem(room, ids[1], { itemId: 'w2' }), err => {
    assert.equal(err.code, 'busy');
    assert.match(err.message, /src\/ship\/hull\.js/);
    assert.match(err.message, new RegExp(primera.id));
    return true;
  });
});

// ---------------------------------------------------------------- 5. el libro completo
test('obligaciones: el plan se vuelve obligaciones con dueño y evidencia medida por el servidor', async () => {
  const { room } = await workRoom();
  startWork(room, 'p1');
  const item = room.work.items[room.work.order[0]];

  const antes = buildObligations(room);
  assert.equal(antes.delivery, 'code');
  const medible = antes.claims.find(c => c.type === 'executable');
  assert.ok(medible, 'el plan tiene al menos una afirmación medible');
  assert.equal(medible.ownerId, item.id, 'y se le asigna la tarea que la implementa');
  assert.equal(medible.status, 'en-trabajo');
  assert.equal(antes.counts.medidas, 0);

  // El servidor ejecuta el comando de verificación sobre el árbol de la tarea: eso ES la
  // evidencia, con su huella, su código de salida y el commit.
  const out = await runVerify(room, { kind: 'patch', itemId: item.id });
  assert.equal(out.ok, true);
  assert.ok(out.evidenceHash);
  item.status = 'integrated';
  item.commit = room.repo.head;

  const despues = buildObligations(room);
  assert.ok(despues.counts.medidas >= 1, 'la afirmación medida por el servidor cuenta como medida');
  const medida = despues.claims.find(c => c.id === medible.id);
  assert.ok(medida.evidenceId, 'la afirmación cita la medición que la respalda');
  assert.equal(medida.evidenceStatus, 'fresca');
  assert.ok(despues.evidence.frescas >= 1);
  assert.ok(despues.evidence.entries.every(e => e.outputTail === null || e.ok === false),
    'el acta no arrastra la salida entera de una verificación en verde');

  // El encargo de esta sala está cubierto por el plan: no hay bloqueo por cobertura.
  assert.equal(despues.ask.uncovered.length, 0);
  const md = obligationsMarkdown(room).join('\n');
  assert.match(md, /## Obligaciones de prueba \(generadas desde los artefactos\)/);
  assert.match(md, /Veredicto:/);
  assert.match(md, /El encargo contra el plan/);
});

test('obligaciones: una decisión votada que nadie construyó sale como incumplida', () => {
  const room = createRoom({
    task: 'Mejorar el cálculo del proyecto de ejemplo.',
    agenda: [{ label: 'aplicar la mejora del total', options: ['aplicar', 'aplazar', 'descartar'] }],
    settings: FAST,
  });
  const id = joinRoom(room, { name: 'Ana', harness: 'ana', model: 'test' }).agentId;
  const point = room.agenda[0];
  point.source = 'finding';
  point.audit = { action: 'multiplicar price por qty', claim: 'El total ignora la cantidad.', evidence: 'calc.mjs:3', file: 'calc.mjs', severity: 'high' };
  room.artifacts.proposals.p1 = {
    id: 'p1', author: id, round: 1, v: 1, title: 'plan', plan: 'Aplicar la mejora.',
    positions: { [point.id]: 'aplicar' },
  };
  const led = buildObligations(room);
  assert.equal(led.decisions.approved, 1, 'el debate aprobó la mejora');
  assert.equal(led.decisions.materialized, 0, 'y ninguna tarea la recogió');
  assert.equal(led.decisions.unmaterialized.length, 1);
  assert.match(led.decisions.unmaterialized[0].reason, /ninguna tarea/);
  assert.ok(led.blockers.some(b => b.kind === 'decision-sin-obra'));
  assert.equal(led.verdict, 'no-cumplido');
});

test('obligaciones: el brief del verificador apunta a lo que nadie cerró', async () => {
  const { room } = await workRoom({ task: 'Añadir el casco procedural y dejar la suite en verde.' });
  startWork(room, 'p1');
  const brief = obligationsBrief(room);
  assert.ok(brief.targets.length >= 1, 'hay obligaciones que atacar');
  assert.ok(brief.counts.total >= 1);
  assert.equal(typeof brief.verdict, 'string');
  assert.match(brief.message, /obligaciones de prueba/i);
  assert.ok(brief.worlds.signatures >= 1);
  assert.ok(brief.worlds.signatures >= 1);
  assert.match(brief.worlds.note, /mismo proceso|PUNTO/i,
    'el libro dice que todas las cifras vienen del mismo proceso del servidor');
});

// ---------------------------------------------------------------- 6. los turnos
// Lo que el servidor ya sabe tiene que llegar en el turno: ofrecerle a un agente un trabajo que
// el motor va a rechazar (o que ya está hecho) es un bucle, no un aviso.
test('turnos: el trabajo avisa del alcance y el verificador recibe sus objetivos', async () => {
  const { room, ids } = await workRoom();
  startWork(room, 'p1');
  const turn = currentTurn(room, ids[0]);
  assert.equal(turn.action, 'claim-item');
  const task = turn.tasks[0];
  assert.equal(task.scopeCheck.verdict, 'ya-existe', 'el turno dice que eso ya está en el repo');
  assert.ok(Array.isArray(task.blockedBy));
  assert.ok(turn.warnings.some(w => w.scope === 'ya-existe'));

  room.phase = { name: 'verify', startedAt: Date.now(), deadline: Date.now() + 60_000, data: { winnerId: 'p1', verifierId: ids[1] } };
  const verificacion = currentTurn(room, ids[1]);
  assert.equal(verificacion.action, 'submit-verification');
  assert.ok(verificacion.obligations, 'el verificador recibe las obligaciones de prueba');
  assert.ok(verificacion.obligations.targets.length >= 1, 'con los objetivos que nadie cerró');
  assert.ok(verificacion.obligations.counts.total >= 1);
});

// ---------------------------------------------------------------- 7. el acta
test('acta: el resultado cierra con el libro generado y sin prosa que lo tape', async () => {
  const { room, ids } = await workRoom({ task: 'Añadir el casco procedural y dejar la suite en verde.' });
  startWork(room, 'p1');
  const item = room.work.items[room.work.order[0]];
  const out = await runVerify(room, { kind: 'patch', itemId: item.id });
  assert.equal(out.ok, true);
  item.status = 'integrated';
  item.commit = room.repo.head;
  finishRoom(room, 'p1');

  assert.equal(room.status, 'closed');
  const obl = room.result.obligations;
  assert.ok(obl, 'el resultado trae el libro de obligaciones');
  assert.ok(['cumplido', 'cumplido-con-pendientes', 'no-cumplido', 'no-verificable'].includes(obl.verdict));
  assert.ok(obl.evidence.total >= 1, 'con la evidencia que ejecutó el servidor');
  assert.ok(obl.evidence.entries.some(e => e.command === 'node check.mjs' && e.exitCode === 0));
  const md = exportMarkdown(room);
  assert.match(md, /## Obligaciones de prueba \(generadas desde los artefactos\)/);
  assert.match(md, /Veredicto: (CUMPLIDO|CUMPLIDO CON PENDIENTES|NO CUMPLIDO|NO VERIFICABLE)/);
  assert.match(md, /Evidencia ejecutada por el servidor/);
});
