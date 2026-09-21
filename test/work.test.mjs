// AGORA v2 — pruebas del trabajo conjunto sobre un repo (auditoría + parches).
//
// Cubren la cadena completa con git de verdad, en un repo temporal clonado:
// hallazgos → agenda → aprobación → tarea → parche → revisión de otro agente →
// verificación ejecutada por el servidor → commit. Y, sobre todo, los caminos en
// los que el sistema debe decir «no»: auto-revisión, rutas fuera del repo,
// verificación en rojo (se revierte) y línea base ya rota.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createRoom, joinRoom, applyMove, currentTurn, startRoom, maybeAdvance, sweep,
  exportMarkdown, attachRepo, attachScaffold, runBaseline, repoIndex, readRepoFile, searchRepo,
  planImprovements, planText, workFrom, auditOrProposal,
  workDiff, unsafePatchPaths, stagePatch, approvedImprovements, workSummary,
  repoSummary, normalizeRepoPath, recoverInterruptedWork, finishRoom, Hall, sweepClaims,
  claimIdleThresholdMs, offlineThresholdMs, pickSettings, pushBranch,
  rosterSummary, stageConsensus,
  revertItem, reapplyItem, revertCommit, refreshFrozenResult, setResultRefresher,
  frozenResultIsStale, healFrozenResults, setVerifyCommand,
} from '../server/engine/index.mjs';

// Igual que hace el transporte al arrancar: el informe congelado se refresca cuando el
// trabajo cambia después de cerrar la sala (deshacer y su verificación).
setResultRefresher(refreshFrozenResult);

// ---------------------------------------------------------------- fixtures git
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-work-'));
const DATA = path.join(TMP, 'data');

const CALC_BUGGY = [
  'export function total(items) {',
  '  let t = 0;',
  '  for (const item of items) t += item.price;',
  '  return t;',
  '}',
  '',
  'export function avg(items) {',
  '  return items.length ? total(items) / items.length : 0;',
  '}',
  '',
].join('\n');

const CALC_FIXED = [
  'export function total(items) {',
  '  let t = 0;',
  '  for (const item of items) t += item.price * (item.qty ?? 1);',
  '  return t;',
  '}',
  '',
  'export function avg(items) {',
  '  return items.length ? total(items) / items.length : 0;',
  '}',
  '',
].join('\n');

// La comprobación fija el comportamiento ACTUAL (el bug incluido): la suite está
// en verde al empezar, así que cualquier verificación en rojo posterior es culpa
// del parche, no del repo. Es el caso limpio para probar la reversión.
const CHECK_CURRENT = [
  "import { avg, total } from './calc.mjs';",
  'if (avg([]) !== 0) { console.error("avg([]) debe ser 0"); process.exit(1); }',
  'if (total([{ price: 2, qty: 3 }]) !== 2) { console.error("comportamiento actual: 2"); process.exit(1); }',
  'console.log("check ok");',
  '',
].join('\n');

const CHECK_FIXED = [
  "import { avg, total } from './calc.mjs';",
  'if (avg([]) !== 0) { console.error("avg([]) debe ser 0"); process.exit(1); }',
  'if (total([{ price: 2, qty: 3 }]) !== 6) { console.error("esperado 6"); process.exit(1); }',
  'console.log("check ok");',
  '',
].join('\n');

const fixtures = new Map();

function repoFixture(name, { brokenSuite = false } = {}) {
  if (fixtures.has(name)) return fixtures.get(name);
  const dir = path.join(TMP, 'fixtures', name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
    return r.stdout;
  };
  fs.writeFileSync(path.join(dir, 'calc.mjs'), CALC_BUGGY);
  fs.writeFileSync(path.join(dir, 'check.mjs'), brokenSuite
    ? `${CHECK_CURRENT}\nif (!fs.existsSync('fixtures/golden.json')) { console.error('falta el golden que nadie ha creado'); process.exit(1); }\n`
    : CHECK_CURRENT);
  fs.writeFileSync(path.join(dir, 'README.md'), '# proyecto de prueba\n\nComprueba con `node check.mjs`.\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-q', '-m', 'estado inicial');
  const out = { dir };
  fixtures.set(name, out);
  return out;
}

// ---------------------------------------------------------------- utilidades
const FAST = {
  phaseMs: Object.fromEntries(['lobby', 'frame', 'audit', 'proposal', 'critique', 'revise', 'vote',
    'tiebreak', 'objection', 'repair', 'synthesis', 'verify', 'work', 'review'].map(p => [p, 120_000])),
  joinQuietMs: 120_000,
  minAgents: 2,
  requireDiversity: false,
};

function repoRoom(names = ['Ana', 'Bruno', 'Ciro'], settings = {}) {
  const room = createRoom({
    task: 'Auditar el proyecto de ejemplo y aplicar las mejoras que apruebe el debate.',
    agenda: [],
    settings: { ...FAST, ...settings },
  });
  const ids = names.map(n => joinRoom(room, { name: n, harness: n.toLowerCase(), model: 'test' }).agentId);
  return { room, ids };
}

function act(room, agentId, behavior = {}) {
  const turn = currentTurn(room, agentId);
  const pick = v => (typeof v === 'function' ? v(turn, room) : v);
  switch (turn.action) {
    case 'start-or-wait':
      applyMove(room, agentId, { kind: 'start' });
      return 'start';
    case 'frame-contribute':
      applyMove(room, agentId, { kind: 'pass' });
      return 'pass';
    case 'audit-repo': {
      const next = (behavior.findings || []).shift();
      if (!next) { applyMove(room, agentId, { kind: 'pass' }); return 'pass'; }
      applyMove(room, agentId, { kind: 'finding', payload: next });
      return 'finding';
    }
    case 'contrast-agenda':
      // Contraste de ejes: solo aparece cuando la agenda trae puntos (los del encuadre o los
      // sembrados al crear la sala). Aquí se pasa sin tocar nada.
      applyMove(room, agentId, { kind: 'pass' });
      return 'pass';
    case 'submit-proposal': {
      const p = pick(behavior.proposal);
      applyMove(room, agentId, { kind: 'proposal', payload: p || defaultProposal(room, agentId) });
      return 'proposal';
    }
    case 'submit-critique': {
      const target = turn.targets[0];
      applyMove(room, agentId, {
        kind: 'critique',
        payload: pick(behavior.critique) || {
          target: target.id,
          steelman: 'El enfoque es directo y verificable.',
          objections: [{ type: 'risk', severity: 'low', text: 'Cuidado con llamadas antiguas sin qty: hay que mantener compatibilidad.' }],
        },
      });
      return 'critique';
    }
    case 'submit-revision-or-pass':
      // En reparación, el autor puede entregar una versión corregida (la prueba del camino
      // verificación→reparación→trabajo lo necesita). En revisión se sigue pasando por defecto.
      if (behavior.revision && room.phase.name === 'repair') {
        applyMove(room, agentId, { kind: 'revision', payload: pick(behavior.revision) });
        return 'revision';
      }
      applyMove(room, agentId, { kind: 'pass' });
      return 'pass';
    case 'submit-vote':
      applyMove(room, agentId, { kind: 'vote', payload: { ranking: turn.options.map(o => o.id) } });
      return 'vote';
    case 'objection-or-pass':
      applyMove(room, agentId, { kind: 'pass' });
      return 'pass';
    case 'submit-synthesis':
      applyMove(room, agentId, { kind: 'synthesis', payload: { final: `PLAN FINAL\n${turn.winner.plan}\nSe aplica tal cual.`, merges: [], pointResolutions: [] } });
      return 'synthesis';
    case 'submit-verification':
      applyMove(room, agentId, { kind: 'verification', payload: pick(behavior.verification) || { verdict: 'pass', checks: [{ claim: 'node check.mjs en verde tras el cambio', method: 'node check.mjs', expectation: 'exit 0' }] } });
      return 'verification';
    case 'claim-item': {
      const itemId = pick(behavior.claim) || turn.openTasks?.[0]?.id;
      applyMove(room, agentId, { kind: 'claim-item', payload: { itemId } });
      return 'claim-item';
    }
    case 'submit-patch': {
      const patch = pick(behavior.patch) || {};
      applyMove(room, agentId, { kind: 'submit-patch', payload: { itemId: turn.task.id, summary: 'cambio propuesto', ...patch } });
      return 'submit-patch';
    }
    case 'review-patch': {
      const review = pick(behavior.review);
      applyMove(room, agentId, {
        kind: 'review-patch',
        payload: review || { itemId: turn.patch.itemId, verdict: 'approve', notes: 'Cambio mínimo, correcto y cubierto por la comprobación.' },
      });
      return 'review-patch';
    }
    // Revisión posterior al trabajo: por defecto cada mejora integrada se da por buena
    // (quien quiera probar el «trabajo extraordinario» devuelve verdict:"improve").
    case 'postwork-review': {
      const r = pick(behavior.recheck) || {};
      const itemId = r.itemId || turn.assign?.[0]?.id;
      applyMove(room, agentId, { kind: 'recheck', payload: { itemId, verdict: 'ok', ...r } });
      return 'recheck';
    }
    default:
      return null;
  }
}

// Todos los agentes actúan; si algo queda verificándose, se espera aquí. Sin esto,
// la promesa de la verificación no podría resolverse nunca (el bucle es síncrono).
async function drive(room, behaviors, { rounds = 30, stop = null } = {}) {
  const ids = Object.keys(behaviors);
  for (let i = 0; i < rounds; i++) {
    if (room.status === 'closed' || stop?.(room)) return;
    for (const id of ids) {
      if (room.status === 'closed' || stop?.(room)) return;
      if (room.agents[id]?.status === 'absent') continue;
      act(room, id, behaviors[id]);
      if (room.__pendingVerify) await settle(room);
    }
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function settle(room) {
  while (room.__pendingVerify) {
    const pending = room.__pendingVerify;
    await pending;
    if (room.__pendingVerify === pending) room.__pendingVerify = null;
  }
  maybeAdvance(room);
}

function defaultProposal(room, agentId) {
  return {
    title: `Plan de ${agentId}`,
    plan: 'Aplicar la mejora aprobada, ajustar la comprobación del proyecto y ejecutar node check.mjs antes de dar nada por hecho.',
    approach: `enfoque-${agentId}`,
    positions: Object.fromEntries(room.agenda.map(p => [p.id, 'aplicar'])),
  };
}

// Comportamiento uniforme: cualquiera puede reclamar, parchear y revisar, así la
// prueba no depende de a quién le toque el turno (la asignación es por carga).
function behaviors(ids, { findings = [], patch = () => ({}), review = null, recheck = null, revision = null, verification = null } = {}) {
  return Object.fromEntries(ids.map((id, i) => [id, {
    findings: i === 0 ? findings : [],
    patch,
    review,
    recheck,
    revision,
    verification,
  }]));
}

const FIND_TOTAL = {
  file: 'calc.mjs',
  line: 3,
  symbol: 'total',
  severity: 'high',
  claim: 'El total ignora la cantidad de cada línea, así que se cobra de menos al cliente.',
  evidence: 'calc.mjs:3 suma solo item.price; check.mjs documenta el comportamiento actual con qty.',
  action: 'multiplicar price por qty con valor por defecto 1',
};

const FIND_README = {
  file: 'README.md',
  severity: 'low',
  claim: 'El README no explica cómo ejecutar la comprobación del proyecto ni qué espera.',
  evidence: 'README.md solo tiene una frase.',
  action: 'documentar en el README cómo ejecutar check.mjs y qué valida',
};

const PATCH_DIFF_ONLY = [
  '--- a/calc.mjs',
  '+++ b/calc.mjs',
  '@@ -1,5 +1,5 @@',
  ' export function total(items) {',
  '   let t = 0;',
  '-  for (const item of items) t += item.price;',
  '+  for (const item of items) t += item.price * (item.qty ?? 1);',
  '   return t;',
  ' }',
  '',
].join('\n');

const PATCH_FILES = {
  summary: 'arregla el total y pone la comprobación al día',
  files: [{ path: 'calc.mjs', content: CALC_FIXED }, { path: 'check.mjs', content: CHECK_FIXED }],
};

async function workRoom(fixtureName, names = ['Ana', 'Bruno', 'Ciro'], fixtureOpts = {}) {
  const fixture = repoFixture(fixtureName, fixtureOpts);
  const { room, ids } = repoRoom(names, fixtureOpts.settings || {});
  await attachRepo(room, { dataDir: DATA, source: fixture.dir, verify: 'node check.mjs', verifyTimeoutMs: 20_000 });
  room.repo.baseline = await runBaseline(room);
  startRoom(room);
  return { room, ids, fixture };
}

// ---------------------------------------------------------------- proyecto nuevo
// Sin repo la sala NO se queda en un plan: crea su propio proyecto y el plan ganador se
// convierte en tareas que acaban en archivos de verdad. Solo se planifica si el humano lo pide.
const NEW_CALC = [
  'export function total(items) {',
  '  let t = 0;',
  '  for (const item of items) t += item.price * (item.qty ?? 1);',
  '  return t;',
  '}',
  '',
].join('\n');

const NEW_CHECK = [
  "import { total } from './src/calc.mjs';",
  'const got = total([{ price: 2, qty: 3 }]);',
  "if (got !== 6) { console.error('esperado 6, salió', got); process.exit(1); }",
  "console.log('ok');",
  '',
].join('\n');

async function greenfieldRoom({ planOnly = false, verify = 'node check.mjs' } = {}) {
  const room = createRoom({
    task: 'Construye el módulo de cálculo del proyecto nuevo.',
    agenda: [{ label: 'Modelo del total: precio por cantidad', options: ['precio multiplicado por cantidad', 'solo precio'] }],
    settings: { ...FAST, planOnly },
  });
  const ids = ['Ana', 'Bruno', 'Ciro'].map(n => joinRoom(room, { name: n, harness: n.toLowerCase(), model: 'test' }).agentId);
  if (!planOnly) await attachScaffold(room, { dataDir: DATA, verify, verifyTimeoutMs: 20_000 });
  startRoom(room);
  return { room, ids };
}

function planProposal(room) {
  return {
    title: 'Motor de cálculo con cantidades',
    plan: 'Construir src/calc.mjs con total() y check.mjs que lo comprueba.',
    approach: 'modulo-unico',
    positions: Object.fromEntries(room.agenda.map(p => [p.id, p.options[0].id])),
  };
}

test('proyecto nuevo: la sala sin repo crea su proyecto y el plan se convierte en tareas', async () => {
  const { room, ids } = await greenfieldRoom();
  assert.equal(room.repo?.greenfield, true, 'la sala tiene un proyecto nuevo con git dentro');
  assert.ok(room.repo.branch.startsWith(`agora/${room.code}`), 'el trabajo va en una rama de la sala');
  assert.equal(room.repo.files, 1, 'el proyecto nace prácticamente vacío: solo el punto de partida');
  assert.equal(auditOrProposal(room), 'proposal', 'sin código que auditar se pasa directo a proponer');
  const readme = fs.readFileSync(path.join(room.repo.dir, 'README.md'), 'utf8');
  assert.match(readme, /Proyecto nuevo de la sala/, 'el proyecto arranca diciendo qué es');
  assert.ok(readme.includes('Construye el módulo de cálculo'), 'y con la tarea dentro');

  await drive(room, Object.fromEntries(ids.map(id => [id, { proposal: () => planProposal(room) }])), {
    rounds: 40, stop: r => r.phase.name === 'work',
  });

  assert.equal(room.phase.name, 'work', 'lo decidido se trabaja en vez de cerrarse en plan');
  const work = workSummary(room);
  assert.equal(work.items.length, 1, 'el punto de agenda decidido es una tarea');
  assert.match(work.items[0].title, /Modelo del total/);
  assert.equal(work.verifyCommand, 'node check.mjs', 'el comando declarado para el proyecto nuevo se usa');

  await drive(room, behaviors(ids, {
    patch: () => ({
      summary: 'crea el módulo y su comprobación',
      files: [{ path: 'src/calc.mjs', content: NEW_CALC }, { path: 'check.mjs', content: NEW_CHECK }],
    }),
  }), { rounds: 60, stop: r => r.status === 'closed' });

  assert.equal(room.status, 'closed', 'la sala cierra sola');
  assert.equal(room.result.delivery.kind, 'code', 'el informe dice que entregó CÓDIGO');
  assert.equal(room.result.delivery.reason, 'proyecto-nuevo');
  assert.equal(room.result.delivery.integrated, 1);
  assert.equal(room.result.delivery.branch, room.repo.branch);
  assert.ok(room.result.delivery.files >= 3, 'el informe cuenta los archivos del proyecto');
  assert.ok(fs.existsSync(path.join(room.repo.dir, 'src/calc.mjs')), 'el archivo existe de verdad');
  assert.ok(fs.existsSync(path.join(room.repo.dir, 'check.mjs')));
  assert.match(workDiff(room), /src\/calc\.mjs/, 'el diff final trae lo que escribió el agente');
  assert.ok(room.log.some(l => l.kind === 'work' && /^Entrega:/.test(l.text)), 'el cierre dice qué se entrega');
});

test('solo planificación: la sala lo declara y no escribe código', async () => {
  const { room, ids } = await greenfieldRoom({ planOnly: true });
  assert.equal(room.repo, null, 'con solo planificación no se crea proyecto');
  await drive(room, Object.fromEntries(ids.map(id => [id, { proposal: () => planProposal(room) }])), {
    rounds: 40, stop: r => r.status === 'closed',
  });
  assert.equal(room.status, 'closed');
  assert.equal(room.result.delivery.kind, 'plan');
  assert.equal(room.result.delivery.reason, 'solo-planificacion');
  assert.match(room.result.delivery.note, /SOLO PLANIFICACIÓN/);
  assert.ok(room.log.some(l => /Solo planificación/.test(l.text)), 'el registro lo dice desde el encuadre');
});

test('proyecto nuevo: sin puntos decididos, el plan se reparte por secciones', () => {
  const room = createRoom({ task: 'Construye el visor de marea con olas y clima', settings: { ...FAST } });
  room.repo = { greenfield: true, branch: 'agora/prueba', dir: os.tmpdir(), files: 0 };
  assert.deepEqual(planImprovements(room), [], 'sin plan no hay nada que construir');

  room.artifacts.synthesis = {
    final: 'A) Motor de olas\nFFT en GPU con cascadas y espuma por jacobiano.\nB) Interfaz\nBarras de viento y clima en index.html.',
    merges: [],
    pointResolutions: [],
  };
  const items = planImprovements(room);
  assert.equal(items.length, 2, 'un plan con dos secciones son dos tareas');
  assert.match(items[0].title, /Motor de olas/);
  assert.match(items[0].claim, /FFT en GPU/);
  assert.ok(items[1].files.includes('index.html'), 'las rutas que nombra el plan se pasan a la tarea');
  assert.equal(planText(room), room.artifacts.synthesis.final);

  // Con puntos decididos manda el debate, no el texto del plan.
  room.agenda = [{ id: 'eje', label: 'Eje decidido por el debate', weight: 1, source: 'agent', options: [{ id: 'si', label: 'sí' }] }];
  room.agents = { a1: { id: 'a1', name: 'Ana', status: 'active' } };
  room.order = ['a1'];
  room.artifacts.positions = { a1: { pos: { eje: 'si' } } };
  room.artifacts.synthesis.pointResolutions = [{ pointId: 'eje', choiceId: 'si', note: '', basis: 'evidence', evidence: 'decidido' }];
  const porPunto = planImprovements(room);
  assert.equal(porPunto.length, 1, 'un punto decidido es una tarea');
  assert.match(porPunto[0].claim, /Eje decidido por el debate/);
  assert.equal(workFrom(room).length, 1, 'la ronda 1 de un proyecto nuevo trabaja el plan');
});

// ---------------------------------------------------------------- auditoría
test('auditoría: los hallazgos equivalentes se funden en un punto y el debate decide', async () => {
  const { room, ids } = await workRoom('calc');
  const [a, b, c] = ids;

  assert.ok(room.repo.branch.startsWith(`agora/${room.code}`), 'el trabajo va en una rama propia de la sala');
  assert.equal(room.repo.baseline.ok, true, 'la línea base del fixture está en verde');

  await drive(room, {
    [a]: { findings: [FIND_TOTAL], proposal: () => defaultProposal(room, a) },
    [b]: { findings: [{ ...FIND_TOTAL, evidence: 'confirmo el mismo fallo leyendo calc.mjs línea 3' }], proposal: () => defaultProposal(room, b) },
    [c]: { findings: [FIND_README], proposal: () => defaultProposal(room, c) },
  }, { rounds: 8, stop: r => r.phase.name === 'proposal' });

  assert.equal(room.phase.name, 'proposal', 'la auditoría cerró al responder los tres');
  const points = room.agenda.filter(p => p.source === 'finding');
  assert.equal(points.length, 2, 'los dos hallazgos sobre calc.mjs se funden; el del README es otro');
  const calcPoint = points.find(p => p.audit.file === 'calc.mjs');
  assert.equal(calcPoint.audit.corroborations, 2, 'la corroboración se cuenta');
  assert.deepEqual(calcPoint.options.map(o => o.id), ['aplicar', 'aplazar', 'descartar']);
  assert.ok(room.artifacts.findings.every(f => f.pointId), 'cada hallazgo queda ligado a su punto');

  // El debate descarta el README y aprueba la mejora de calc.mjs.
  const positions = () => Object.fromEntries(room.agenda.map(p => [p.id, p.audit?.file === 'calc.mjs' ? 'aplicar' : 'descartar']));
  await drive(room, Object.fromEntries(ids.map(id => [id, { proposal: () => ({ ...defaultProposal(room, id), positions: positions() }) }])), {
    stop: r => r.phase.name === 'work',
  });

  assert.equal(room.phase.name, 'work', 'con repo y mejoras aprobadas se pasa a trabajar');
  assert.equal(approvedImprovements(room).length, 1, 'solo se aprueba la mejora de calc.mjs');
  const work = workSummary(room);
  assert.equal(work.items.length, 1, 'descartar un punto no crea tarea');
  assert.deepEqual(work.items[0].files, ['calc.mjs']);
  assert.equal(work.verifyCommand, 'node check.mjs');
});

// ---------------------------------------------------------------- ciclo de trabajo
test('trabajo: parche aceptado → revisión de otro agente → verificación → commit en la rama', async () => {
  const { room, ids } = await workRoom('calc');
  const baseCommit = room.repo.baseCommit;

  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'El parche hace lo que dice y la comprobación se actualiza con él.' }),
  }));

  assert.equal(room.status, 'closed', 'el trabajo termina y la sala se cierra sola');
  const w = room.result.work;
  assert.equal(w.stats.items, 1);
  assert.equal(w.stats.integrated, 1);
  assert.equal(w.stats.files, 2, 'el diff final toca calc.mjs y check.mjs');
  assert.equal(w.commits.length, 1);
  assert.match(w.commits[0].subject, /^agora\(/);
  assert.match(w.commits[0].subject, /multiplicar price/, 'el asunto del commit dice qué se hizo');
  assert.match(w.commits[0].author, /^[ABC]/, 'el commit lleva el nombre del agente que lo escribió');
  assert.notEqual(room.repo.head, baseCommit, 'la rama avanzó');
  assert.equal(w.items[0].status, 'integrated');
  assert.equal(w.items[0].unreviewed, false);
  assert.equal(w.items[0].verify.ok, true);
  assert.ok(w.patches.some(p => p.review && p.review.verdict === 'approve'), 'hay una revisión independiente registrada');

  const diff = workDiff(room);
  assert.match(diff, /item\.qty \?\? 1/, 'el diff real contiene el cambio');
  const md = exportMarkdown(room);
  assert.match(md, /## Trabajo conjunto sobre el repositorio/);
  assert.ok(md.includes(w.branch), 'el export dice en qué rama está el trabajo');

  // Obligaciones de prueba: el resultado se GENERA desde las mediciones del servidor, no desde
  // la prosa del plan. La verificación de la tarea queda como evidencia con su comando y su
  // código de salida, y el acta lleva el veredicto en vez de contar solo lo que salió bien.
  const obl = room.result.obligations;
  assert.ok(obl, 'el acta trae el libro de obligaciones');
  assert.ok(obl.evidence.total >= 1, 'la verificación del servidor queda registrada como evidencia');
  assert.ok(obl.evidence.entries.some(e => e.command === 'node check.mjs' && e.exitCode === 0),
    'con su comando y su código de salida');
  assert.ok(obl.claims.length >= 1, 'y las afirmaciones del plan están tipadas');
  assert.ok(['cumplido', 'cumplido-con-pendientes', 'no-cumplido', 'no-verificable'].includes(obl.verdict));
  assert.match(md, /## Obligaciones de prueba \(generadas desde los artefactos\)/);
  assert.match(md, /Veredicto: (CUMPLIDO|CUMPLIDO CON PENDIENTES|NO CUMPLIDO|NO VERIFICABLE)/);

  // Marcador por harness: sale del registro, no de una impresión.
  const board = room.result.scoreboard;
  assert.equal(board.byAgent.length, 3, 'una fila por agente');
  assert.ok(board.byAgent.every(r => r.harness), 'cada fila se identifica por su harness');
  assert.equal(board.byAgent.filter(r => r.votedWinner).length, 3, 'los tres votaron al ganador');
  assert.equal(board.byAgent.filter(r => r.verifier).length, 1, 'verificar es de uno, no de todos');
  const workers = board.byAgent.filter(r => r.patches > 0);
  assert.equal(workers.length, 1, 'un solo agente entregó el parche de la única tarea');
  assert.equal(workers[0].integrated, 1, 'y su mejora contó como integrada');
  assert.equal(board.byAgent.find(r => r.reviews > 0 && r.reviews !== undefined)?.reviews, 1, 'otro hizo la revisión');
  assert.equal(board.byAgent.reduce((s, r) => s + r.findings, 0), 1, 'el hallazgo se atribuye a quien lo presentó');
  assert.match(md, /## Marcador por harness/, 'el acta incluye el marcador');
});

test('trabajo: si la verificación falla, el árbol vuelve atrás y la tarea se libera con la salida a la vista', async () => {
  const { room, ids } = await workRoom('calc');
  let attempts = 0;

  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    // 1er intento: arregla el código y deja la comprobación vieja → la verificación lo caza.
    patch: () => {
      attempts += 1;
      return attempts === 1 ? { summary: 'arregla solo calc.mjs', diff: PATCH_DIFF_ONLY } : PATCH_FILES;
    },
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Apruebo el cambio propuesto.' }),
  }));

  const w = room.result.work;
  assert.equal(attempts, 2, 'el agente volvió a intentarlo tras el fallo');
  assert.equal(w.stats.integrated, 1);
  const failed = w.patches.find(p => p.verify && p.verify.ok === false);
  assert.ok(failed, 'queda registrado el parche que no pasó la verificación');
  assert.match(failed.verify.outputTail, /esperado 6|comportamiento actual/, 'la salida del fallo se conserva');
  assert.equal(failed.committed, false, 'un parche que no verifica no se commitea');
  assert.equal(w.commits.length, 1, 'solo el parche bueno queda como commit');
  assert.equal(w.stats.verifyRuns, 2, 'la verificación corrió dos veces');
});

// El camino que siguió la sala rdmp6h en producción: la verificación del plan encontró un
// hallazgo grave, el autor reparó y la sala se cerró ahí mismo. Con el repo adjunto y las
// mejoras ya aprobadas por el debate, la fase de trabajo no llegaba a abrirse NUNCA y el
// acta salía con 0 integradas: harneas que se van sin generar trabajo, sin que nadie se
// haya ido. Aquí se fija que la sala repara y SIGUE hasta trabajar lo aprobado.
test('verificación con hallazgo grave: el autor repara y la sala sigue hasta trabajar lo aprobado', async () => {
  const { room, ids } = await workRoom('calc-verify-repair');
  const baseCommit = room.repo.baseCommit;

  const b = behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'El parche hace lo que dice y actualiza la comprobación.' }),
    revision: () => ({
      plan: 'PLAN REVISADO: además de multiplicar por qty, las líneas antiguas sin cantidad se migran con qty=1 y queda escrito en el README. Detalle suficiente para pasar el mínimo.',
      note: 'incorpora el hallazgo de la verificación',
    }),
    // El verificador asignado encuentra un hallazgo de severidad alta: eso abre reparación.
    verification: () => ({
      verdict: 'pass',
      checks: [{ claim: 'node check.mjs sigue en verde tras el cambio', method: 'node check.mjs', expectation: 'exit 0' }],
      findings: [{ severity: 'high', text: 'El plan no dice qué pasa con las líneas antiguas sin qty: se cobraría de menos sobre datos ya guardados.' }],
    }),
  });

  await drive(room, b, { stop: r => r.phase.name === 'work' });

  assert.notEqual(room.status, 'closed', 'la sala no se cierra con mejoras aprobadas sin trabajar');
  assert.equal(room.phase.name, 'work', 'tras reparar, la sala pasa a trabajar lo aprobado');
  assert.equal(room.artifacts.verification.repaired, true, 'la reparación queda registrada en la verificación');
  assert.ok(room.work && room.work.order.length === 1, 'hay una tarea de trabajo esperando agente');

  // Y termina sola: nadie interviene, nadie reclama por ella.
  await drive(room, b, { rounds: 40 });
  assert.equal(room.status, 'closed', 'la sala termina sin intervención humana');
  assert.equal(room.result.work.stats.integrated, 1, 'la mejora aprobada acaba integrada en la rama');
  assert.equal(room.result.work.items[0].status, 'integrated');
  assert.equal(room.result.work.verifyCommand, 'node check.mjs', 'y verificada con el comando del proyecto');
  assert.notEqual(room.repo.head, baseCommit, 'la rama avanzó con el trabajo');
});

test('trabajo: la línea base ya en rojo no se le achaca al parche', async () => {
  const { room, ids } = await workRoom('calc-broken', ['Ana', 'Bruno'], { brokenSuite: true });
  assert.equal(room.repo.baseline.ok, false, 'la suite del fixture arranca en rojo');

  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => ({ summary: 'multiplica por qty', diff: PATCH_DIFF_ONLY }),
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Cambio correcto.' }),
  }));

  const w = room.result.work;
  assert.equal(w.baseline.ok, false, 'el resultado guarda que la línea base estaba roja');
  assert.equal(w.items[0].status, 'integrated', 'no se bloquea el trabajo por un fallo que ya existía');
  assert.equal(w.items[0].verify.preExisting, true, 'y queda marcado como fallo preexistente en el resultado');
});

// El caso que dejaba el trabajo esperando: todos los agentes con tarea reclamada y un parche
// en vuelo. Antes, cada uno pedía entregar el suyo (el servidor lo rechazaba por «busy») y
// NADIE revisaba: el trabajo no avanzaba hasta que expiraba algún reclamo.
test('trabajo: con el árbol ocupado y todos con tarea, revisar va antes que entregar', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);
  const [a, b] = ids;

  // Dos mejoras aprobadas (una de cada agente) para que las dos entren en la cola de trabajo.
  await drive(room, {
    [a]: { findings: [FIND_TOTAL], proposal: () => defaultProposal(room, a) },
    [b]: { findings: [FIND_README], proposal: () => defaultProposal(room, b) },
  }, { rounds: 40, stop: r => r.phase.name === 'work' });
  assert.equal(room.work.order.length, 2, 'dos mejoras aprobadas por el debate');

  // El caso exacto: cada agente con su tarea reclamada y un parche en vuelo. Antes, los dos
  // pedían entregar el suyo (el servidor rechazaba el segundo por «busy») y NADIE revisaba.
  applyMove(room, a, { kind: 'claim-item', payload: { itemId: room.work.order[0] } });
  applyMove(room, b, { kind: 'claim-item', payload: { itemId: room.work.order[1] } });
  applyMove(room, a, { kind: 'submit-patch', payload: { itemId: room.work.order[0], ...PATCH_FILES } });
  await settle(room);

  assert.ok(room.work.pending, 'el parche de Ana espera revisión');
  assert.notEqual(room.work.items[room.work.order[0]].status, 'claimed', 'y su tarea ya no está en su mano');
  assert.equal(room.work.items[room.work.order[1]].status, 'claimed', 'Bruno sigue con la suya reclamada');
  assert.equal(currentTurn(room, b).action, 'review-patch',
    'quien puede revisar revisa: pedir su parche sería un rechazo anunciado y dejaría el trabajo quieto');

  // Y el ciclo sigue de verdad: la revisión desatasca el árbol y las dos tareas se integran.
  const README_PATCH = {
    summary: 'documenta cómo se ejecuta la comprobación',
    files: [{ path: 'README.md', content: '# proyecto de prueba\n\nEjecuta `node check.mjs` para validar el cálculo de precios.\n' }],
  };
  await drive(room, {
    [a]: { patch: () => PATCH_FILES, review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Correcto.' }) },
    [b]: { patch: () => README_PATCH, review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Correcto.' }) },
  }, { rounds: 40 });
  await settle(room);
  const integradas = Object.values(room.work.items).filter(i => i.status === 'integrated').length;
  assert.ok(integradas >= 1, 'y las tareas acaban integrándose: el árbol no se queda quieto');
});

test('trabajo: nadie aprueba su propio parche', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);

  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Bien.' }),
  }), { stop: r => !!r.work?.pending });

  const itemId = room.work.order[0];
  const patchId = room.work.pending;
  const author = room.work.patches[patchId].author;
  assert.ok(patchId, 'hay un parche esperando revisión');
  assert.throws(
    () => applyMove(room, author, { kind: 'review-patch', payload: { verdict: 'approve' } }),
    err => err.code === 'self_review',
  );
  assert.equal(room.work.pending, patchId, 'el parche sigue pendiente: nada se aprobó');
  assert.ok(currentTurn(room, author).previousRejection, 'el autor sabe por qué se rechazó');

  const other = ids.find(id => id !== author);
  await drive(room, { [other]: { review: () => ({ itemId: patchId, verdict: 'approve', notes: 'Correcto.' }) } }, { rounds: 2 });
  await settle(room);
  assert.equal(room.work.items[itemId].status, 'integrated');
});

test('trabajo: rechazar un parche devuelve la tarea al montón sin ensuciar el árbol', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);

  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Bien.' }),
  }), { stop: r => !!r.work?.pending });

  const itemId = room.work.order[0];
  const patchId = room.work.pending;
  const author = room.work.patches[patchId].author;
  const other = ids.find(id => id !== author);
  applyMove(room, other, {
    kind: 'review-patch',
    payload: { itemId, verdict: 'changes', notes: 'Falta actualizar el README con la nueva expectativa de total.' },
  });

  const item = room.work.items[itemId];
  assert.equal(item.status, 'open', 'un parche rechazado libera la tarea');
  assert.equal(item.claimant, null);
  assert.match(item.lastError, /README/, 'el motivo del revisor viaja con la tarea');
  assert.equal(room.repo.head, room.repo.baseCommit, 'nada se commiteó');
  assert.equal(workDiff(room), '', 'el árbol quedó limpio tras el rechazo');
  assert.equal(room.work.pending, null);
});

// ---------------------------------------------------------------- guardias
test('repo: un parche no puede escribir fuera del clon', async () => {
  const { room } = await workRoom('calc', ['Ana', 'Bruno']);

  const evil = ['--- a/../../../evil.txt', '+++ b/../../../evil.txt', '@@ -0,0 +1 @@', '+pwned', ''].join('\n');
  assert.ok(unsafePatchPaths(evil).length > 0, 'las rutas hacia arriba se detectan antes de llamar a git');
  const res = stagePatch(room, { diff: evil });
  assert.equal(res.ok, false);
  assert.match(res.error, /fuera del repo/);
  assert.equal(fs.existsSync(path.join(TMP, 'evil.txt')), false, 'no se escribió nada fuera del clon');

  const abs = ['--- a/C:/Windows/system32/drivers/etc/hosts', '+++ b/C:/Windows/system32/drivers/etc/hosts', '@@ -0,0 +1 @@', '+x', ''].join('\n');
  assert.equal(stagePatch(room, { diff: abs }).ok, false);
  assert.equal(stagePatch(room, { files: [{ path: '../fuera.mjs', content: 'x' }] }).ok, false);
  assert.equal(stagePatch(room, { files: [{ path: '.git/config', content: 'x' }] }).ok, false);
});

test('repo: el índice, la búsqueda y la lectura por rangos funcionan y respetan el clon', async () => {
  const { room } = await workRoom('calc', ['Ana', 'Bruno']);

  const index = repoIndex(room);
  assert.equal(index.total, 3);
  assert.ok(index.files.includes('calc.mjs'));
  assert.equal(index.branch, room.repo.branch);
  assert.ok(index.extensions.some(e => e.name === '.mjs'));

  const search = searchRepo(room, 'item.price');
  assert.ok(search.matches.some(m => m.path === 'calc.mjs' && m.line === 3), `la búsqueda dice archivo y línea: ${JSON.stringify(search.matches)}`);
  assert.equal(searchRepo(room, 'no-existe-esta-cadena').matches.length, 0);

  const file = readRepoFile(room, 'calc.mjs', { from: 3, lines: 2 });
  assert.equal(file.kind, 'file');
  assert.equal(file.startLine, 3);
  assert.match(file.text, /item\.price/);
  assert.equal(file.truncated, true, 'avisa de que hay más contenido');
  // El clon se materializa en LF aunque el servidor viva en Windows: si no, los
  // parches escritos contra el contenido real del repo no aplicarían nunca.
  assert.equal(/\r/.test(readRepoFile(room, 'calc.mjs').text), false, 'el checkout del clon es LF');

  const dir = readRepoFile(room, '.', {});
  assert.equal(dir.kind, 'dir');
  assert.ok(dir.entries.some(e => e.name === 'calc.mjs'));
  assert.ok(readRepoFile(room, '../../etc/passwd').error, 'rutas fuera del clon: error, no lectura');
  assert.ok(readRepoFile(room, '.git/config').error, 'el interior de .git no se sirve');
});

test('una sala sin repo se comporta igual que siempre: encuadre → propuestas', () => {
  const room = createRoom({
    task: 'Diseñar la capa de caché para una API de búsqueda con presupuesto limitado.',
    settings: FAST,
  });
  const a = joinRoom(room, { name: 'Ana', harness: 'test' }).agentId;
  const b = joinRoom(room, { name: 'Bruno', harness: 'test' }).agentId;
  startRoom(room);
  assert.equal(room.phase.name, 'frame');
  applyMove(room, a, { kind: 'pass' });
  applyMove(room, b, { kind: 'pass' });
  assert.equal(room.phase.name, 'proposal', 'sin repo no aparece la auditoría');
  assert.equal(repoSummary(room), null);
});

test('el repo adjunto no se mezcla con el repo del usuario: se clona aparte', async () => {
  const fixture = repoFixture('calc');
  const { room } = repoRoom(['Ana', 'Bruno']);
  const repo = await attachRepo(room, { dataDir: DATA, source: fixture.dir, verify: 'node check.mjs' });
  assert.notEqual(path.resolve(repo.dir), path.resolve(fixture.dir));
  assert.ok(repo.dir.startsWith(DATA), 'el clon vive en el directorio de datos del servidor');
  assert.ok(fs.existsSync(path.join(repo.dir, 'calc.mjs')));
  fs.writeFileSync(path.join(repo.dir, 'calc.mjs'), 'export const total = () => 0;\n');
  assert.match(fs.readFileSync(path.join(fixture.dir, 'calc.mjs'), 'utf8'), /item\.price/, 'el repo original queda intacto');
});

test('trabajo: la tarea de un agente que deja de dar señales vuelve al montón y otro la termina', async () => {
  const { room, ids } = await workRoom('calc');
  const [a, b, c] = ids;

  await drive(room, behaviors(ids, { findings: [FIND_TOTAL] }), { stop: r => r.phase.name === 'work' });
  assert.equal(room.phase.name, 'work');
  const item = room.work.items[room.work.order[0]];
  applyMove(room, a, { kind: 'claim-item', payload: { itemId: item.id } });
  assert.equal(item.claimant, a, 'la tarea está reclamada');

  // Y se apaga sin entregar nada: nadie lo ve desde hace más de lo permitido.
  const idle = claimIdleThresholdMs(room) + 1_000;
  room.agents[a].lastSeenAt = Date.now() - idle;
  assert.equal(sweepClaims(room), true, 'el reloj del servidor la recoge');
  assert.equal(item.status, 'open', 'la tarea vuelve al montón');
  assert.equal(item.claimant, null);
  assert.match(item.note, /sin dar señales/);
  assert.ok(room.log.some(e => /vuelve al montón/.test(e.text || '')), 'queda escrito quién la dejó');
  assert.equal(sweepClaims(room), false, 'liberar es idempotente');

  // Otros dos la retoman (uno parchea, otro revisa) y la llevan hasta el commit: el
  // trabajo no queda colgado esperando a quien se apagó.
  await drive(room, {
    [b]: { patch: () => PATCH_FILES },
    [c]: { review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Cambio mínimo y comprobación actualizada con él.' }) },
  }, { rounds: 16 });

  assert.equal(room.work.items[item.id].status, 'integrated', 'la tarea se integró después');
  assert.equal(workSummary(room).items.find(i => i.id === item.id).byName, 'Bruno', 'la terminó otro agente');
  assert.equal(room.status, 'closed', 'la sala cierra cuando el trabajo termina');
});

test('trabajo: una tarea no se libera mientras su parche está en manos del servidor', async () => {
  const { room, ids } = await workRoom('calc');

  await drive(room, behaviors(ids, { findings: [FIND_TOTAL], patch: () => PATCH_FILES }), {
    stop: r => !!r.work?.pending,
  });
  const patchId = room.work.pending;
  const patch = room.work.patches[patchId];
  const reviewer = ids.find(id => currentTurn(room, id).action === 'review-patch');
  applyMove(room, reviewer, { kind: 'review-patch', payload: { itemId: patch.itemId, verdict: 'approve', notes: 'Correcto y cubierto por la comprobación.' } });

  // El autor se apaga justo ahora: da igual, el parche ya es responsabilidad del
  // servidor (verificación y commit), así que la tarea NO vuelve al montón.
  room.agents[patch.author].lastSeenAt = Date.now() - 10 * 60_000;
  assert.equal(sweepClaims(room), false);
  assert.equal(room.work.items[patch.itemId].status, 'verifying');
  await settle(room);
  assert.equal(room.work.items[patch.itemId].status, 'integrated');
});

// ---------------------------------------------------------------- estados imposibles
// El caso de la sala real gn89q7: un agente esperaba la revisión de su parche, el turno le
// ofrecía «claim-item» (que el motor rechaza) y, sin otra salida a la vista, usó «pass» para
// ceder el turno. Aquello dejó la tarea abierta con el parche en vuelo: nadie podía revisarlo
// («no está en revisión») ni entregar nada («hay un parche esperando revisión»), y la sala se
// quedó girando en 401 y latidos hasta que el humano la forzó.
test('trabajo: retirarse con el parche propio en revisión no lo tira ni deja la tarea abierta', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);

  await drive(room, behaviors(ids, { findings: [FIND_TOTAL], patch: () => PATCH_FILES }), {
    stop: r => !!r.work?.pending,
  });
  const patchId = room.work.pending;
  const patch = room.work.patches[patchId];
  const item = room.work.items[patch.itemId];
  const reviewer = ids.find(id => id !== patch.author);

  applyMove(room, patch.author, { kind: 'pass' });

  assert.equal(room.agents[patch.author].workOptOut, true, 'el autor queda como observador');
  assert.equal(room.work.pending, patchId, 'su parche sigue en vuelo: retirarse no lo tira');
  assert.equal(item.status, 'in-review', 'la tarea sigue en revisión, no vuelve abierta al montón');
  assert.ok(!room.log.some(e => /devuelve la tarea/.test(e.text || '')), 'no se devuelve al montón un parche entregado');
  assert.match(room.log.at(-1).text, /deja el trabajo/);

  // El turno ya no le pide un movimiento imposible: le dice la verdad.
  const turn = currentTurn(room, patch.author);
  assert.equal(turn.action, 'wait', 'nada de claim-item para quien ya no puede reclamar');
  assert.match(turn.message, /en revisión/);

  // Y la revisión hace su trabajo: la sala no queda bloqueada.
  applyMove(room, reviewer, {
    kind: 'review-patch',
    payload: { itemId: item.id, verdict: 'approve', notes: 'Cambio mínimo, correcto y con la comprobación al día.' },
  });
  await settle(room);
  assert.equal(item.status, 'integrated', 'la mejora se integra aunque su autor se haya retirado');
});

test('trabajo: un estado imposible (parche en vuelo con la tarea abierta) se repara solo', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);

  await drive(room, behaviors(ids, { findings: [FIND_TOTAL], patch: () => PATCH_FILES }), {
    stop: r => !!r.work?.pending,
  });
  const patch = room.work.patches[room.work.pending];
  const item = room.work.items[patch.itemId];
  const reviewer = ids.find(id => id !== patch.author);
  const breakIt = () => { item.status = 'open'; item.claimant = null; item.reviewer = null; };

  // Así quedaba la sala cuando alguien se retiraba con su parche entregado (antes del arreglo).
  breakIt();
  sweep(room);
  assert.equal(item.status, 'in-review', 'el invariante vuelve a cumplirse en el barrido');
  assert.equal(item.reviewer, patch.reviewer, 'y la tarea reconoce a su revisor');
  assert.ok(room.log.some(e => /Estado del trabajo reparado/.test(e.text || '')), 'la reparación queda escrita');

  // Y aunque nadie barra, el propio movimiento legítimo del revisor lo repara en el sitio.
  breakIt();
  applyMove(room, reviewer, {
    kind: 'review-patch',
    payload: { itemId: item.id, verdict: 'approve', notes: 'El cambio hace lo que dice.' },
  });
  await settle(room);
  assert.equal(item.status, 'integrated', 'la revisión ya no se rechaza por un estado roto');
});

test('trabajo: sin parche en vuelo, una tarea atascada en revisión vuelve al montón', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);

  await drive(room, behaviors(ids, { findings: [FIND_TOTAL], patch: () => PATCH_FILES }), {
    stop: r => !!r.work?.pending,
  });
  const patch = room.work.patches[room.work.pending];
  const item = room.work.items[patch.itemId];
  const other = ids.find(id => id !== patch.author);

  // El parche desapareció por un camino roto: la tarea no puede quedarse «en revisión» para siempre.
  room.work.pending = null;
  sweep(room);
  assert.equal(item.status, 'open', 'la tarea vuelve al montón');
  assert.equal(item.claimant, null);
  assert.match(item.note, /no había ningún parche en vuelo/);

  applyMove(room, other, { kind: 'claim-item', payload: { itemId: item.id } });
  assert.equal(item.status, 'claimed', 'y otro puede retomarla');
  assert.equal(item.claimant, other);
});

test('trabajo: quien se retira no recibe reclamaciones que el motor va a rechazar', async () => {
  const { room, ids } = await workRoom('calc');
  await drive(room, behaviors(ids, { findings: [FIND_TOTAL] }), { stop: r => r.phase.name === 'work' });
  const [a, b] = ids;

  applyMove(room, b, { kind: 'pass' });
  const turn = currentTurn(room, b);
  assert.equal(turn.action, 'wait', 'al observador no se le ofrece reclamar');
  assert.match(turn.message, /fuera del trabajo/);
  assert.deepEqual(turn.payloadSchema, [], 'y no se le ofrece ningún movimiento');

  // El motor lo rechazaría igual: el turno ahora dice la verdad en vez de invitar a un 401.
  assert.throws(
    () => applyMove(room, b, { kind: 'claim-item', payload: { itemId: room.work.order[0] } }),
    err => err.code === 'unauthorized',
  );
  assert.ok(room.work.items[room.work.order[0]].status === 'open', 'la tarea sigue libre para quien sí trabaja');
  assert.ok(currentTurn(room, a).action !== 'wait', 'y quien trabaja sigue teniendo qué hacer');
});

test('salud: el aviso de atasco no aparca la sala (los plazos siguen corriendo)', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);

  await drive(room, behaviors(ids, { findings: [FIND_TOTAL], patch: () => PATCH_FILES }), {
    stop: r => !!r.work?.pending,
  });
  const patchId = room.work.pending;

  // La revisión lleva más de la cuenta sin veredicto (la salud avisa «stalled») y el plazo ya venció.
  room.work.patches[patchId].reviewAssignedAt = Date.now() - claimIdleThresholdMs(room) - 60_000;
  room.phase.deadline = Date.now() - 1_000;

  assert.equal(sweep(room), true, 'la sala procesa el vencimiento en vez de quedarse varada');
  assert.equal(room.phase.name, 'work');
  assert.equal(room.phase.data.extensions, 1, 'prorroga: hay un parche esperando revisión');
  assert.ok(room.log.some(e => /no ha producido un veredicto/.test(e.text || '')), 'el aviso de salud queda escrito');

  // El aviso se escribe una vez, no en cada barrido.
  const notices = room.log.filter(e => /no ha producido un veredicto/.test(e.text || '')).length;
  sweep(room);
  assert.equal(room.log.filter(e => /no ha producido un veredicto/.test(e.text || '')).length, notices);
});

// ---------------------------------------------------------------- reanudación
test('reinicio: la verificación que quedó a medias se retoma sobre el mismo árbol y termina integrando', async () => {
  const { room, ids } = await workRoom('calc');

  await drive(room, behaviors(ids, { findings: [FIND_TOTAL], patch: () => PATCH_FILES }), {
    stop: r => !!r.work?.pending,
  });
  const patchId = room.work.pending;
  const itemId = room.work.patches[patchId].itemId;
  assert.ok(patchId, 'hay un parche esperando revisión');

  // Otro agente lo aprueba: la verificación arranca EN SEGUNDO PLANO.
  const reviewer = ids.find(id => currentTurn(room, id).action === 'review-patch');
  applyMove(room, reviewer, {
    kind: 'review-patch',
    payload: { itemId, verdict: 'approve', notes: 'El cambio es mínimo y la comprobación viaja con él.' },
  });
  assert.equal(room.work.patches[patchId].verify.status, 'running');
  assert.equal(room.work.items[itemId].status, 'verifying');

  // El proceso muere aquí: lo único que sobrevive es el JSON del disco. La copia en
  // memoria se cierra para que su promesa no integre nada por su cuenta (en el
  // servidor de verdad no existiría: se la lleva el proceso al morir).
  const onDisk = JSON.parse(JSON.stringify(room));
  finishRoom(room, reviewer);

  assert.equal(onDisk.phase.name, 'work', 'la sala en disco seguía en trabajo');

  // Lo único que un JSON viejo podría dejar donde había una promesa es un `{}`. Eso
  // (una marca que ya no es una promesa viva) no puede bloquear la reanudación.
  assert.equal(typeof onDisk.__pendingVerify?.then, 'undefined');

  // Y el disco no escribe marcas del proceso: solo estado de la sala.
  const hall = new Hall(path.join(TMP, 'hall'));
  hall.persist(room);
  const raw = JSON.parse(fs.readFileSync(hall.fileOf(room.code), 'utf8'));
  assert.equal('__pendingVerify' in raw, false);
  assert.equal('__changed' in raw, false);
  assert.ok(raw.work.patches[patchId], 'el parche en vuelo sí se guarda: es estado, no proceso');

  const resumed = recoverInterruptedWork(onDisk);
  assert.ok(resumed, 'al arrancar se detecta el trabajo a medias');
  assert.deepEqual(resumed.resumed, [patchId]);
  await resumed.promise;

  assert.equal(onDisk.work.items[itemId].status, 'integrated', 'la tarea termina integrada, no atascada');
  assert.equal(onDisk.work.pending, null, 'el árbol queda libre');
  assert.equal(onDisk.work.items[itemId].verify.ok, true, 'la verificación retomada salió en verde');
  assert.ok(onDisk.work.items[itemId].commit, 'se commiteó en la rama de la sala');
  assert.match(workDiff(onDisk), /item\.qty \?\? 1/, 'el cambio del parche sigue en la rama');
  assert.ok(onDisk.log.some(e => /quedó a medias por un reinicio/.test(e.text || '')),
    'el registro cuenta que se retomó, sin dar nada por bueno');
  assert.equal(recoverInterruptedWork(onDisk), null, 'ya no queda nada que retomar: la recuperación es idempotente');
});

test('reinicio: el sondeo de la línea base cortado también se retoma', async () => {
  const fixture = repoFixture('calc');
  const { room } = repoRoom(['Ana', 'Bruno']);
  await attachRepo(room, { dataDir: DATA, source: fixture.dir, verify: 'node check.mjs', verifyTimeoutMs: 20_000 });

  // Lo que queda en disco si el servidor muere mientras sondea la suite del repo.
  room.repo.baseline = { status: 'running', at: Date.now() };
  const onDisk = JSON.parse(JSON.stringify(room));
  assert.equal(onDisk.__baselinePromise, undefined);

  const resumed = recoverInterruptedWork(onDisk);
  assert.ok(resumed, 'el sondeo cortado se detecta');
  assert.deepEqual(resumed.resumed, ['baseline']);
  await resumed.promise;

  assert.equal(onDisk.repo.baseline.status, 'done');
  assert.equal(onDisk.repo.baseline.ok, true, 'la línea base vuelve a medirse de verdad');
  assert.equal(recoverInterruptedWork(onDisk), null);
});

test('publicar: la rama sale al remoto declarado y sin destino no se inventa ninguno', async () => {
  const fixture = repoFixture('calc');
  // Un remoto de verdad: un repositorio desnudo local hace de GitHub.
  const remote = path.join(TMP, 'remoto-desnudo.git');
  spawnSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });

  const { room, ids } = repoRoom(['Ana', 'Bruno', 'Ciro']);
  await attachRepo(room, { dataDir: DATA, source: fixture.dir, verify: 'node check.mjs', pushTo: remote });
  room.repo.baseline = await runBaseline(room);
  assert.equal(repoSummary(room).pushTo, remote, 'la sala recuerda dónde publicar');

  // Sin cambios integrados no hay nada que publicar: se dice, no se empuja el punto de partida.
  const empty = pushBranch(room);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no ha integrado ningún cambio/);
  assert.equal(room.repo.pushedAt || null, null, 'un intento fallido no marca la sala como publicada');

  // El debate aprueba la mejora, un agente parchea, otro revisa y se commitea.
  startRoom(room);
  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Correcto y con la comprobación al día.' }),
  }));
  assert.equal(room.status, 'closed');

  const out = pushBranch(room);
  assert.equal(out.ok, true, `el push falló: ${out.output}`);
  assert.equal(out.branch, room.repo.branch);
  const refs = spawnSync('git', ['--git-dir', remote, 'branch', '--list', room.repo.branch], { encoding: 'utf8' }).stdout;
  assert.match(refs, new RegExp(room.repo.branch.replace('/', '\\/')), 'la rama está en el remoto');
  const head = spawnSync('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${room.repo.branch}`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(head, room.repo.head, 'el remoto apunta al commit de la sala');
  assert.deepEqual(repoSummary(room).pushed, [room.repo.branch]);
  assert.equal(repoSummary(room).pushedHead, room.repo.head, 'se recuerda QUÉ commit salió');
  assert.equal(repoSummary(room).pushedOutdated, false);

  // Deshacer después de publicar deja el remoto atrás, y eso hay que decirlo.
  const undone = revertItem(room, { reason: 'publicada y luego revisada: no debería haber salido' });
  assert.equal(undone.ok, true, undone.error || '');
  const after = repoSummary(room);
  assert.equal(after.pushedHead, head, 'el remoto sigue donde lo dejamos');
  assert.notEqual(after.head, after.pushedHead);
  assert.equal(after.pushedOutdated, true, 'y la sala avisa de que va por detrás');
  assert.equal(spawnSync('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${room.repo.branch}`], { encoding: 'utf8' }).stdout.trim(), head, 'el remoto no se mueve solo');
  assert.ok(room.log.some(e => /publicada en/.test(e.text || '')), 'queda escrito en el registro');

  // Cambiar de destino también es explícito; y sin ninguno, se avisa.
  const other = path.join(TMP, 'otro-remoto.git');
  spawnSync('git', ['init', '-q', '--bare', other], { encoding: 'utf8' });
  assert.equal(pushBranch(room, { remote: other }).ok, true);
  assert.equal(pushBranch({ repo: { ...room.repo, pushTo: null, pushed: [] } }).ok, false);
  assert.match(pushBranch({ repo: { ...room.repo, pushTo: null, pushed: [] } }).error, /no declaró/);
});

// ---------------------------------------------------------------- deshacer
test('deshacer: la mejora integrada se revierte en la rama, se vuelve a verificar y el resultado deja de contarla', async () => {
  const { room, ids } = await workRoom('calc');
  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Hace lo que dice y la comprobación se actualiza con él.' }),
  }));
  assert.equal(room.status, 'closed');
  const item = room.result.work.items[0];
  const integratedHead = room.repo.head;
  assert.equal(room.result.work.stats.integrated, 1);
  assert.match(workDiff(room), /item\.qty \?\? 1/, 'el cambio está en la rama');

  const out = revertItem(room, { reason: 'la comprobación nueva no cubre el caso de la lista vacía' });
  assert.equal(out.ok, true, out.error || '');
  assert.equal(out.item, item.id, 'sin decir cuál, se deshace la última integrada');
  assert.equal(out.of, item.commit, 'se revierte exactamente el commit que la integró');
  assert.notEqual(room.repo.head, integratedHead, 'la reversión es un commit nuevo, no un reset');

  const w = workSummary(room);
  assert.equal(w.items[0].status, 'reverted');
  assert.equal(w.stats.integrated, 0);
  assert.equal(w.stats.reverted, 1);
  assert.equal(w.items[0].revert.of, item.commit);
  assert.match(w.items[0].revert.reason, /lista vacía/);
  assert.deepEqual(w.items[0].revert.files.sort(), ['calc.mjs', 'check.mjs'], 'queda dicho qué archivos se deshicieron');
  assert.equal(workDiff(room), '', 'el árbol vuelve a decir lo mismo que antes de integrarlo');

  // El resultado congelado no puede seguir contando como integrado lo que ya no está.
  assert.equal(room.result.work.stats.integrated, 0);
  assert.equal(room.result.work.stats.reverted, 1);
  assert.equal(room.result.stats.integrated, 0);
  assert.ok(room.log.some(e => /Deshecha la tarea/.test(e.text || '')), 'queda escrito en el acta');
  assert.match(exportMarkdown(room), /deshech/i, 'y el acta lo cuenta');

  // Deshacer tampoco se da por bueno: el servidor vuelve a ejecutar la verificación.
  assert.ok(room.__pendingRevertVerify, 'la verificación posterior corre en segundo plano');
  assert.equal(room.result.work.items[0].revert.verify.status, 'running', 'el informe dice que se está ejecutando, no que ya está');
  await room.__pendingRevertVerify;
  const after = workSummary(room).items[0].revert.verify;
  assert.equal(after.status, 'done');
  assert.equal(after.ran, true, 'se ejecutó de verdad');
  assert.equal(after.ok, true, 'y al deshacerlo el proyecto vuelve a verificar en verde');
  assert.ok(room.log.some(e => /vuelve a pasar en verde/.test(e.text || '')));
  // Y el informe congelado no se queda diciendo «verificando» para siempre.
  assert.equal(room.result.work.items[0].revert.verify.ok, true, 'el informe se refresca cuando la verificación termina');
  assert.equal(room.result.work.items[0].revert.verify.status, 'done');

  // Y no se deshace dos veces lo mismo.
  const again = revertItem(room, { itemId: item.id });
  assert.equal(again.ok, false);
  assert.match(again.error, /No hay ninguna mejora integrada/);

  // Un botón junto a los datos tiene que poder deshacerse: la vuelta a aplicar devuelve la
  // mejora con un commit nuevo (revierte la reversión) y vuelve a verificar.
  const back = reapplyItem(room, { reason: 'el equipo la quiere de vuelta con el caso extra cubierto' });
  assert.equal(back.ok, true, back.error || '');
  assert.equal(back.item, item.id);
  assert.equal(back.of, out.commit, 'revierte exactamente la reversión');
  const w2 = workSummary(room);
  assert.equal(w2.items[0].status, 'integrated');
  assert.equal(w2.stats.integrated, 1);
  assert.equal(w2.stats.reverted, 0);
  assert.equal(w2.items[0].commit, back.commit, 'el commit vigente es el de la vuelta a aplicar');
  assert.equal(w2.items[0].revert.of, item.commit, 'el historial conserva lo que se deshizo');
  assert.equal(w2.items[0].reapplied.of, out.commit);
  assert.match(w2.items[0].reapplied.reason, /de vuelta/);
  assert.match(workDiff(room), /item\.qty \?\? 1/, 'y el cambio vuelve a estar en la rama');
  assert.equal(room.result.work.items[0].status, 'integrated', 'el informe congelado lo cuenta otra vez');
  assert.equal(room.result.work.stats.reverted, 0);
  assert.equal(room.result.scoreboard.byAgent.filter(r => r.integrated > 0).length, 1, 'y el marcador también');

  assert.ok(room.__pendingRevertVerify, 'la verificación posterior corre en segundo plano');
  await room.__pendingRevertVerify;
  const rv = workSummary(room).items[0].reapplied.verify;
  assert.equal(rv.status, 'done');
  assert.equal(rv.ok, true, 'el proyecto sigue verificando tras devolver la mejora');
  assert.equal(room.result.work.items[0].reapplied.verify.ok, true, 'y el informe congelado no se queda a medias');

  const twice = reapplyItem(room, {});
  assert.equal(twice.ok, false);
  assert.match(twice.error, /No hay ninguna mejora deshecha/);
  // Y no se vuelve a aplicar lo que nunca se deshizo.
  const wrong = reapplyItem(room, { itemId: item.id });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /No hay ninguna mejora deshecha/);
});

test('deshacer: si lo que vino después tocó las mismas líneas, se aborta y el árbol queda intacto', () => {
  // Un repo de verdad con dos commits sobre la misma línea: revertir el primero choca.
  const dir = fs.mkdtempSync(path.join(TMP, 'conflicto-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  };
  fs.writeFileSync(path.join(dir, 'calc.mjs'), 'const a = 1;\nexport const total = () => a;\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@l', 'commit', '-q', '-m', 'inicial');
  fs.writeFileSync(path.join(dir, 'calc.mjs'), 'const a = 2;\nexport const total = () => a;\n');
  git('commit', '-q', '-am', 'primero');
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'calc.mjs'), 'const a = 3;\nexport const total = () => a;\n');
  git('commit', '-q', '-am', 'segundo');
  const before = git('rev-parse', 'HEAD');

  const room = { code: 'rev', repo: { dir, branch: 'main' } };
  const out = revertCommit(room, { sha: first, message: 'deshacer el primero' });
  assert.equal(out.ok, false);
  assert.deepEqual(out.conflicts, ['calc.mjs'], 'dice qué archivo chocó');
  assert.match(out.error, /sin resolver conflictos/);
  assert.equal(git('rev-parse', 'HEAD'), before, 'no se movió el HEAD');
  assert.equal(git('status', '--porcelain'), '', 'y el árbol quedó limpio, sin restos de la reversión');

  // Un commit que no está en el clon tampoco se inventa, y el árbol sucio se rechaza.
  const missing = revertCommit(room, { sha: 'deadbee', message: 'x' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no está en el clon/);
  fs.appendFileSync(path.join(dir, 'calc.mjs'), '// a medias\n');
  const dirty = revertCommit(room, { sha: before, message: 'x' });
  assert.equal(dirty.ok, false);
  assert.match(dirty.error, /sin commitear/);
  git('checkout', '--', 'calc.mjs');

  // El caso feliz: sin choque, revierte con un commit propio y el archivo vuelve.
  fs.writeFileSync(path.join(dir, 'otro.mjs'), 'export const x = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'tercero');
  const third = git('rev-parse', 'HEAD');
  const ok = revertCommit(room, { sha: third, message: 'deshacer el tercero' });
  assert.equal(ok.ok, true, ok.error || '');
  assert.equal(fs.existsSync(path.join(dir, 'otro.mjs')), false, 'el archivo añadido desaparece');
  assert.equal(git('rev-parse', 'HEAD'), ok.sha);
  assert.match(git('log', '-1', '--format=%s'), /deshacer el tercero/);
});

test('deshacer: nada se revierte con un parche a medias ni en una sala sin trabajo', async () => {
  const { room, ids } = await workRoom('calc');
  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Correcto y con la comprobación al día.' }),
  }));
  const item = room.result.work.items[0];

  // Con un parche esperando no se revierte encima de trabajo a medias.
  room.work.pending = 'g-falso';
  const busy = revertItem(room, { itemId: item.id });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /parche sin resolver/);
  room.work.pending = null;

  const unknown = revertItem(room, { itemId: 'w-nadie' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /no existe/);

  const noRepo = revertItem({ code: 'x' }, {});
  assert.equal(noRepo.ok, false);
  assert.match(noRepo.error, /no tiene repositorio/);
  const noWork = revertItem({ code: 'x', repo: { dir: TMP } }, {});
  assert.equal(noWork.ok, false);
  assert.match(noWork.error, /no tiene trabajo conjunto/);
});

test('coherencia: un informe congelado que se contradice con el trabajo real se recalcula al arrancar', async () => {
  const { room, ids } = await workRoom('calc');
  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'Hace lo que dice y la comprobación se actualiza con él.' }),
  }));
  assert.equal(room.status, 'closed');

  const dir = fs.mkdtempSync(path.join(TMP, 'heal-'));
  new Hall(dir).persist(room);
  const file = path.join(dir, `${room.code}.json`);

  // El archivo se queda mintiendo, como lo dejaría una versión vieja del servidor: el
  // trabajo real tiene la mejora integrada, pero el informe dice que se deshizo y que su
  // verificación sigue corriendo.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.work.items[raw.work.order[0]].status, 'integrated', 'el trabajo real está integrado');
  raw.result.work.items[0].status = 'reverted';
  raw.result.work.items[0].revert = {
    of: raw.work.items[raw.work.order[0]].commit, commit: raw.work.items[raw.work.order[0]].commit,
    by: 'humano', at: Date.now(), files: [], reason: 'prueba',
    verify: { status: 'running', ran: false, command: 'node check.mjs', at: Date.now() },
  };
  raw.result.work.stats.integrated = 0;
  raw.result.work.stats.reverted = 1;
  fs.writeFileSync(file, JSON.stringify(raw));

  const fresh = new Hall(dir);
  const loaded = fresh.get(room.code);
  assert.equal(frozenResultIsStale(loaded), true, 'la contradicción se detecta');

  assert.deepEqual(healFrozenResults(fresh), [room.code], 'y se arregla al arrancar');
  assert.equal(loaded.result.work.items[0].status, 'integrated', 'el estado real manda');
  assert.equal(loaded.result.work.items[0].revert, null, 'ni se inventa una reversión que no ocurrió');
  assert.equal(loaded.result.work.stats.integrated, 1);
  assert.equal(loaded.result.work.stats.reverted, 0);
  assert.equal(frozenResultIsStale(loaded), false, 'ya no hay nada que arreglar');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).result.work.items[0].status, 'integrated', 'el arreglo queda en disco');

  // Una segunda pasada no reescribe nada (no se toca el informe por gusto) y lo que se
  // relee del disco sigue coherente.
  assert.deepEqual(healFrozenResults(new Hall(dir)), []);
  assert.equal(frozenResultIsStale(new Hall(dir).get(room.code)), false);
});

test('ajustes: los topes del trabajo y el umbral de silencio se respetan (y se acotan)', () => {
  const s = pickSettings({
    offlineMs: 90_000,
    repo: { verifyCommand: '  npm   test  ', verifyTimeoutMs: 30_000, baseline: false, maxWorkItems: 3, claimIdleMs: 60_000 },
  });
  assert.equal(s.offlineMs, 90_000);
  assert.equal(s.repo.verifyCommand, 'npm test', 'el comando se normaliza');
  assert.equal(s.repo.verifyTimeoutMs, 30_000);
  assert.equal(s.repo.baseline, false);
  assert.equal(s.repo.maxWorkItems, 3);
  assert.equal(s.repo.claimIdleMs, 60_000);

  const room = { settings: s };
  assert.equal(offlineThresholdMs(room), 90_000);
  assert.equal(claimIdleThresholdMs(room), 60_000);

  // Fuera de rango se acota, y sin valor se usa el de por defecto: nunca queda en 0
  // (un 0 haría que cualquier tarea se liberara al instante, o ninguna).
  const clamped = pickSettings({ offlineMs: 1, repo: { maxWorkItems: 999, claimIdleMs: 1, verifyTimeoutMs: 1 } });
  assert.equal(clamped.offlineMs, 30_000);
  // El techo de la cola subió a 200: una auditoría en un repo grande aprueba muchas mejoras
  // y la sala decide cuántas ejecuta, pero el servidor no le pone un tope de veinte.
  assert.equal(clamped.repo.maxWorkItems, 200);
  assert.equal(clamped.repo.claimIdleMs, 30_000);
  assert.equal(clamped.repo.verifyTimeoutMs, 5_000);
  // La paciencia con una tarea reclamada subió a 20 minutos por defecto: con 5 minutos,
  // quien verificaba su parche en local perdía la tarea a mitad de camino.
  assert.equal(claimIdleThresholdMs({ settings: {} }), 20 * 60_000);
  assert.equal(offlineThresholdMs({}), 120_000);
});

// En Windows las herramientas de consola escriben `/c/Users/…`: si el servidor no lo
// traduce, la sala nace sin repo y el usuario ve «la ruta no existe» sobre una ruta que
// su terminal acepta. La traducción es solo para Windows; en Linux/macOS `/c/...` es una
// ruta legítima y no se toca.
test('las rutas al estilo git bash se traducen en Windows y no en otros sistemas', () => {
  assert.equal(normalizeRepoPath('/c/Users/juanp/proyecto', 'win32'), 'C:/Users/juanp/proyecto');
  assert.equal(normalizeRepoPath('/cygdrive/d/codigo', 'win32'), 'D:/codigo');
  assert.equal(normalizeRepoPath('C:/Users/juanp/proyecto', 'win32'), 'C:/Users/juanp/proyecto');
  assert.equal(normalizeRepoPath('  /c/tmp/x  ', 'win32'), 'C:/tmp/x');
  assert.equal(normalizeRepoPath('/c/Users/juanp/proyecto', 'linux'), '/c/Users/juanp/proyecto');
  assert.equal(normalizeRepoPath('https://github.com/u/r.git', 'win32'), 'https://github.com/u/r.git');
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- revisión posterior
// La sala no cierra con las tareas integradas: se revisa el conjunto. Sin trabajo
// extraordinario, lo que la revisión ve mejorable queda escrito en el resultado; con él,
// vuelve a la cola como tarea y se ejecuta antes de cerrar.
test('sin trabajo extraordinario: la revisión cierra la sala y lo propuesto queda registrado', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);
  const action = 'documentar en check.mjs por qué el total multiplica por qty';

  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    recheck: () => ({
      verdict: 'improve',
      claim: 'la comprobación no explica el comportamiento arreglado',
      action,
      evidence: 'check.mjs comprueba el número pero no por qué',
      file: 'check.mjs',
      severity: 'low',
    }),
  }));

  assert.equal(room.status, 'closed', 'la sala cierra: nadie pidió trabajo extraordinario');
  const w = room.result.work;
  assert.equal(w.stats.items, 1, 'no se crea trabajo nuevo sin trabajo extraordinario');
  assert.equal(w.review.proposals.length, 1, 'lo que la revisión propuso queda registrado');
  assert.equal(w.review.proposals[0].action, action);
  assert.equal(w.review.pending.length, 0, 'todo lo integrado fue revisado por otro');
  assert.equal(w.review.reviewed, 1);
  assert.match(exportMarkdown(room), /revisión posterior/i, 'el acta lo cuenta');
});

test('trabajo extraordinario: lo que la revisión ve mejorable vuelve a la cola y se ejecuta', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno'], { settings: { extraordinary: true } });
  let patches = 0;
  let rondas = 0;

  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    // La segunda tarea (nacida de la revisión) toca otro archivo: si se reenviara el mismo
    // parche, el servidor lo rechazaría por no cambiar nada (y con razón).
    patch: () => {
      patches += 1;
      return patches === 1
        ? PATCH_FILES
        : { summary: 'documenta la decisión en el README', files: [{ path: 'README.md', content: '# proyecto de prueba\n\nEl total multiplica price por qty (por defecto 1). Comprueba con `node check.mjs`.\n' }] };
    },
    recheck: () => {
      rondas += 1;
      return rondas === 1
        ? {
          verdict: 'improve',
          claim: 'el README sigue describiendo el comportamiento viejo',
          action: 'reescribir el README con la fórmula nueva del total',
          evidence: 'README.md no menciona qty',
          file: 'README.md',
        }
        : { verdict: 'ok' };
    },
  }));

  assert.equal(room.status, 'closed', 'con las dos rondas hechas, la sala cierra igual');
  const w = room.result.work;
  assert.equal(w.stats.items, 2, 'la mejora de la revisión entró como tarea');
  assert.equal(w.stats.integrated, 2, 'y se ejecutó, no quedó en el aire');
  assert.equal(w.items.filter(i => i.from === 'review').length, 1, 'la tarea nueva se marca como venida de la revisión');
  assert.equal(w.review.proposals.length, 0, 'nada quedó propuesto sin ejecutar');
  assert.equal(w.review.extraordinary, true);
  assert.equal(w.review.maxRounds, 2, 'el tope de rondas viaja en el resultado');
});

// ---------------------------------------------------------------- mejora recursiva
test('recursión: la sala vuelve a auditar su propio código y ejecuta lo que la ronda nueva encuentre', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno'], { settings: { repo: { recursionRounds: 1 } } });
  let patches = 0;

  await drive(room, behaviors(ids, {
    // Ronda 1: el total ignora qty. Ronda 2: el README sigue describiendo el comportamiento
    // viejo. Solo el primer agente propone hallazgos, así que cada auditoría toma el suyo.
    findings: [FIND_TOTAL, FIND_README],
    patch: () => {
      patches += 1;
      return patches === 1
        ? PATCH_FILES
        : { summary: 'documenta el total nuevo en el README', files: [{ path: 'README.md', content: '# proyecto de prueba\n\nEl total multiplica price por qty (por defecto 1). Comprueba con `node check.mjs`.\n' }] };
    },
  }), { rounds: 90 });

  assert.equal(room.status, 'closed', 'la sala cierra al agotarse las rondas declaradas');
  assert.equal(room.rounds, 2, 'se abrió una segunda ronda de auditoría');
  const w = room.result.work;
  assert.equal(w.stats.integrated, 2, 'las mejoras de las DOS rondas se ejecutaron');
  assert.equal(w.items.filter(i => i.from === 'recursion').length, 1, 'la mejora de la ronda 2 entra como tarea de la recursión');
  assert.equal(room.result.recursion.rounds, 2);
  assert.equal(room.result.recursion.cap, 1, 'el tope viaja en el acta (1 ronda extra)');
  assert.equal(room.result.recursion.history.length >= 1, true, 'queda el balance por ronda');
  assert.equal(room.result.recursion.stop.reason, 'tope-de-rondas', 'y por qué se paró');
  assert.match(exportMarkdown(room), /ronda 2/i, 'el acta cuenta la ronda');
});

test('recursión: una auditoría sin hallazgos es la declaración de «no hay más» y la sala cierra', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno'], { settings: { repo: { recursionRounds: 2 } } });

  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL], // solo la ronda 1 tiene algo que decir
    patch: () => PATCH_FILES,
  }), { rounds: 90 });

  assert.equal(room.status, 'closed');
  assert.equal(room.rounds, 2, 'la ronda 2 se abrió y no encontró nada: paró ahí, sin gastar la 3');
  assert.equal(room.result.recursion.stop.reason, 'auditoria-sin-hallazgos');
  assert.equal(room.result.recursion.stop.agents, 2, 'se dice cuántos agentes miraron y no vieron nada');
  assert.equal(room.result.work.stats.integrated, 1, 'no se inventó trabajo en la ronda vacía');
});

test('recursión: sin rondas pedidas, la sala cierra como siempre (no hay bucle)', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);
  await drive(room, behaviors(ids, { findings: [FIND_TOTAL], patch: () => PATCH_FILES }));
  assert.equal(room.status, 'closed');
  assert.equal(room.rounds, 1, 'una sola ronda');
  assert.equal(room.result.recursion.cap, 0);
  assert.equal(room.result.recursion.stop.reason, 'sin-recursion');
});

test('recursión: una ronda que no integra nada no encadena otra auditoría', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno'], { settings: { repo: { recursionRounds: 3 } } });
  // Nadie propone hallazgos: la auditoría de la ronda 1 cierra vacía y la sala termina por el
  // camino de siempre (sin trabajo que ejecutar), no abriendo rondas en bucle.
  await drive(room, behaviors(ids, {}));
  assert.equal(room.status, 'closed');
  assert.equal(room.rounds, 1, 'no se abren rondas sin nada integrado');
});

test('la revisión sobrevive al recálculo del informe (los veredictos no se pierden al reiniciar)', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);
  await drive(room, behaviors(ids, {
    findings: [FIND_TOTAL],
    patch: () => PATCH_FILES,
    recheck: () => ({ verdict: 'ok', evidence: 'el diff hace lo que el plan decía' }),
  }));
  assert.equal(room.status, 'closed');
  assert.equal(room.result.work.review.reviewed, 1, 'el informe del cierre cuenta el veredicto real');

  // Guardado y vuelto a cargar como haría un arranque del servidor: el veredicto vive en los
  // artefactos, así que recalcular el informe NO puede decir «0 revisadas» de algo revisado.
  const dir = fs.mkdtempSync(path.join(TMP, 'review-'));
  new Hall(dir).persist(room);
  const fresh = new Hall(dir);
  const loaded = fresh.get(room.code);
  refreshFrozenResult(loaded);
  assert.equal(loaded.result.work.review.reviewed, 1, 'tras recalcular sigue contando el veredicto');
  assert.equal(loaded.result.work.review.pending.length, 0, 'y no reaparece como pendiente');
  assert.equal(loaded.result.work.review.reviewedItems[0].by.length, 1, 'queda dicho quién revisó');
});

// ---------------------------------------------------------------- verificación tardía
// El caso que dejó integrar parches sin comprobar: la sala nace sin comando. Se puede fijar
// (o corregir) en cualquier momento, y a partir de ahí los parches se comprueban de verdad.
test('verificación: el comando se puede fijar después y se dice de dónde salió', async () => {
  const fixture = repoFixture('calc');
  const { room, ids } = repoRoom(['Ana', 'Bruno']);
  await attachRepo(room, { dataDir: DATA, source: fixture.dir, verify: '', verifyTimeoutMs: 20_000, baseline: false });
  startRoom(room);

  assert.equal(room.repo.verify, null, 'la sala no declaró comando');
  assert.equal(room.repo.verifySource, null, 'y no se detectó ninguno en este fixture (check.mjs suelto)');

  const out = setVerifyCommand(room, { command: 'node  check.mjs', timeoutMs: 30_000 });
  assert.equal(out.ok, true);
  assert.equal(out.command, 'node check.mjs', 'el comando se normaliza (espacios de más fuera)');
  assert.equal(out.rerun, true, 'y se pide volver a medir la línea base');
  assert.equal(room.repo.verifySource.why, 'fijado a mano desde el panel');
  assert.equal(room.repo.baseline, null, 'la línea base vieja se descarta: era de otro comando');

  // Quitarlo también es una decisión legítima, y se dice en voz alta.
  const off = setVerifyCommand(room, { command: '' });
  assert.equal(off.ok, true);
  assert.equal(off.command, null);
  assert.equal(room.repo.verify, null);
  assert.ok(room.log.some(e => /SIN verificación/.test(e.text || '')), 'se registra que la sala no comprobará nada');

  // Un comando que no es una línea de shell no se acepta a medias.
  // Un comando de verdad (con flags, rutas y variables) cabe entero: el techo es de
  // memoria, no de longitud útil. Antes se cortaba a 300 caracteres —a media línea—, que
  // cambiaba en silencio lo que el servidor ejecutaba.
  const largo = `node --test ${'--experimental-flag '.repeat(20)}check.mjs`;
  const bad = setVerifyCommand(room, { command: largo });
  assert.equal(bad.ok, true, 'un comando largo se acepta entero');
  assert.equal(room.repo.verify.command, largo.replace(/\s+/g, ' ').trim(), 'sin recortes: se ejecuta lo que se declaró');
  assert.ok(room.repo.verify.command.length > 300, 'y supera el techo viejo de 300 caracteres');

  const enorme = setVerifyCommand(room, { command: 'x'.repeat(5_000) });
  assert.equal(enorme.ok, true, 'solo un comando absurdo se recorta, no se rechaza');
  assert.ok(room.repo.verify.command.length <= 2_000);

  // Y con la sala sin repo, la acción no finge que hizo algo.
  const sinRepo = createRoom({ task: 'Debate sin repositorio, solo con la agenda de decisión.', settings: FAST });
  assert.equal(setVerifyCommand(sinRepo, { command: 'npm test' }).ok, false);
  void ids;
});

// ---------------------------------------------------------------- sin techos de trabajo
// Un parche toca los archivos que toca. Antes: la lista se cortaba en 20 sin avisar y un
// archivo de más de 80 KB RECHAZABA el parche entero, así que un refactor con un archivo
// generado no se podía entregar de ninguna manera.
test('trabajo: un parche de quince archivos entra entero, sin recortes ni avisos', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);
  const [a, b] = ids;
  await drive(room, {
    [a]: { findings: [FIND_TOTAL], proposal: () => defaultProposal(room, a) },
    [b]: { findings: [FIND_README], proposal: () => defaultProposal(room, b) },
  }, { rounds: 40, stop: r => r.phase.name === 'work' });

  const itemId = room.work.order[0];
  applyMove(room, a, { kind: 'claim-item', payload: { itemId } });
  const files = Array.from({ length: 15 }, (_, i) => ({
    path: `docs/nota-${i}.md`,
    content: `# nota ${i}\n\n${'detalle documentado. '.repeat(60)}`,
  }));
  const out = applyMove(room, a, { kind: 'submit-patch', payload: { itemId, summary: 'quince archivos de una vez', files } });
  assert.deepEqual(out.warnings, [], 'ni un aviso: el trabajo cabe completo');
  const patch = room.work.patches[room.work.pending];
  assert.ok(patch.stat.fileCount >= 15, `el diff real trae los quince archivos (${patch.stat.fileCount})`);
});

test('trabajo: un archivo grande (antes rechazado por pasar de 80 KB) se integra igual', async () => {
  const { room, ids } = await workRoom('calc', ['Ana', 'Bruno']);
  const [a, b] = ids;
  await drive(room, {
    [a]: { findings: [FIND_TOTAL], proposal: () => defaultProposal(room, a) },
    [b]: { findings: [FIND_README], proposal: () => defaultProposal(room, b) },
  }, { rounds: 40, stop: r => r.phase.name === 'work' });

  const itemId = room.work.order[0];
  applyMove(room, a, { kind: 'claim-item', payload: { itemId } });
  const generado = `# catálogo generado\n\n${'linea-de-catalogo-con-contenido-real\n'.repeat(5_000)}`;
  assert.ok(generado.length > 150_000, 'el archivo supera con creces el techo viejo de 80 KB');
  const out = applyMove(room, a, {
    kind: 'submit-patch',
    payload: { itemId, summary: 'añade el catálogo generado', files: [{ path: 'docs/catalogo.md', content: generado }] },
  });
  assert.deepEqual(out.warnings, []);
  const guardado = readRepoFile(room, 'docs/catalogo.md', { lines: 3 });
  assert.equal(guardado.text.split('\n')[0], '# catálogo generado', 'el archivo está de verdad en el árbol de la sala');
});

// ---------------------------------------------------------------- techo de duración
// Segunda forma de cerrar con 0 integradas sin que nadie abandone nada: el techo de duración
// (45 min por defecto) se medía contra TODO el ciclo, mientras las fases suman bastante más.
// Una sala con repo que usaba sus plazos se congelaba justo después de aprobar las mejoras y
// el trabajo no llegaba a abrirse. El trabajo sobre el repo tiene su propio presupuesto.
test('techo de duración: una sala con repo no se congela con el trabajo por delante', async () => {
  const { room, ids } = await workRoom('calc-ceiling', ['Ana', 'Bruno']);
  const [a, b] = ids;
  room.settings.maxDurationMs = 1; // el debate ya agotó su techo

  await drive(room, {
    [a]: { findings: [FIND_TOTAL], proposal: () => defaultProposal(room, a) },
    [b]: { proposal: () => defaultProposal(room, b) },
  }, { rounds: 20, stop: () => approvedImprovements(room).length > 0 });

  assert.equal(approvedImprovements(room).length, 1, 'hay una mejora aprobada que ejecutar');
  sweep(room);
  assert.notEqual(room.status, 'closed', 'el techo del debate no cierra una sala que aún tiene que trabajar lo aprobado');

  await drive(room, behaviors(ids, {
    patch: () => PATCH_FILES,
    review: () => ({ itemId: room.work.pending, verdict: 'approve', notes: 'correcto y cubierto por la comprobación.' }),
  }), { rounds: 40 });

  assert.equal(room.status, 'closed', 'y la sala termina sola');
  assert.equal(room.result.work.stats.integrated, 1, 'con el trabajo integrado, no con 0');
  assert.equal(room.result.work.items[0].status, 'integrated');
});

// El techo sigue siendo un techo: la ampliación son los presupuestos de fase, no una barra
// libre. Una sala con repo que lleva una hora sin cerrar tampoco vive para siempre.
// La mejora recursiva pide varias rondas: el techo del debate se amplía con el presupuesto de
// cada ronda extra, o la red de seguridad cortaría la sala justo al empezar la segunda.
test('techo de duración: las rondas de mejora recursiva se presupuestan (y siguen acotadas)', async () => {
  const { room } = await workRoom('calc-ceiling-recursion', ['Ana', 'Bruno'], { settings: { repo: { recursionRounds: 1 } } });
  room.settings.maxDurationMs = 1;
  // 20 min: por encima del techo sin rondas (trabajo + revisión) y por debajo de lo que suma el
  // presupuesto completo de la ronda extra que la sala pidió.
  room.createdAt = Date.now() - 20 * 60_000;

  sweep(room);
  assert.notEqual(room.status, 'closed', 'con una ronda pedida, la sala no se congela a los 20 min');

  // El tope sigue siendo un tope: con las rondas agotadas y mucho tiempo encima, cierra.
  room.rounds = 2;
  room.createdAt = Date.now() - 6 * 3600_000;
  sweep(room);
  assert.equal(room.status, 'closed', 'una sala varada sigue cerrando');
});

test('techo de duración: la ampliación está acotada y una sala varada sigue cerrando', async () => {
  const { room } = await workRoom('calc-ceiling-stranded', ['Ana', 'Bruno']);
  room.settings.maxDurationMs = 1;
  room.createdAt = Date.now() - 60 * 60_000; // una hora: más que el debate y que su trabajo

  sweep(room);

  assert.equal(room.status, 'closed', 'la sala varada se cierra');
  assert.equal(room.result.work, null, 'y sin inventarse trabajo: no había nada aprobado');
  assert.equal(room.repo.head, room.repo.baseCommit, 'la rama del repo queda intacta');
});

// ---------------------------------------------------------------- presencia en el trabajo
// El fallo que se veía en una sala real: el tablero decía «trabaja Buffy» y la lista de agentes
// decía «Desconectado» del mismo Buffy, en la misma pantalla. Un agente que reclamó una tarea y se
// fue a escribirla no late (el bucle pregunta «¿me toca?» y mientras escribe no pregunta), así que
// la presencia se medía con un umbral de dos minutos y el panel se contradecía a sí mismo.
test('presencia: quien tiene una tarea en la mano figura trabajando, no desconectado', async () => {
  const { room, ids } = await workRoom('calc-presence', ['Ana', 'Bruno', 'Ciro']);
  const [a, b, c] = ids;

  await drive(room, {
    [a]: { findings: [FIND_TOTAL], proposal: () => defaultProposal(room, a) },
    [b]: { findings: [FIND_README], proposal: () => defaultProposal(room, b) },
    [c]: {},
  }, { rounds: 40, stop: r => r.phase.name === 'work' });
  assert.ok(room.work?.order.length >= 2, 'dos mejoras aprobadas para repartir');

  applyMove(room, a, { kind: 'claim-item', payload: { itemId: room.work.order[0] } });
  applyMove(room, a, { kind: 'submit-patch', payload: { itemId: room.work.order[0], ...PATCH_FILES } });
  applyMove(room, b, { kind: 'claim-item', payload: { itemId: room.work.order[1] } });
  await settle(room);

  // Seis minutos escribiendo: más que el umbral de «sin señal» (dos minutos). Es exactamente lo
  // que estaba pasando de verdad en la sala real.
  room.agents[a].lastSeenAt = Date.now() - 6 * 60_000;
  room.agents[b].lastSeenAt = Date.now() - 6 * 60_000;

  const first = room.work.items[room.work.order[0]];
  const roster = rosterSummary(room);
  const ana = roster.find(r => r.id === a);
  const bruno = roster.find(r => r.id === b);

    assert.equal(ana.online, false, 'la asignación no demuestra conexión reciente');
  assert.equal(ana.holding.state, 'working', 'Ana tiene su tarea en la mano');
  assert.equal(ana.holding.itemId, room.work.order[0]);
    assert.equal(ana.presence, 'offline');
    assert.equal(bruno.online, false, 'sin contacto reciente; no se descarta su tarea');
  assert.equal(room.work.items[room.work.order[1]].claimant, b, 'Bruno sigue con la suya');

  // Y quien revisa tampoco se ha ido: tiene el parche en su tejado.
  assert.equal(first.status, 'in-review', 'el parche de Ana espera revisión');
  assert.ok(first.reviewer && first.reviewer !== a, 'el parche tiene revisor asignado a otro agente');
  const rev = roster.find(r => r.id === first.reviewer);
  // Lo propio manda: si además tiene tarea suya, se presenta trabajando en ella y la revisión va
  // como dato añadido.
  const reviewing = rev.holding.state === 'reviewing' || (rev.holding.also || []).some(x => x.itemId === room.work.order[0]);
  assert.ok(reviewing, `${rev.name} figura con el parche en su tejado, no desconectado`);
  assert.equal(rev.online, rev.id === c, 'la asignación conserva el trabajo; la conexión depende de la última señal');
});

// Y sin nada en la mano el mismo silencio SÍ es una desconexión: el umbral sigue mandando. Sin
// esta mitad, «trabajando» sería una forma de no decir nunca que alguien se fue.
test('presencia: sin tarea en la mano, el silencio sigue siendo una desconexión', async () => {
  const { room } = await workRoom('calc-presence-idle', ['Ana', 'Bruno']);
  for (const id of room.order) room.agents[id].lastSeenAt = Date.now() - 6 * 60_000;

  const roster = rosterSummary(room);
  assert.ok(roster.every(r => r.holding === null), 'nadie sostiene trabajo');
  assert.ok(roster.every(r => r.online === false), 'sin tarea y sin señales, desconectado');
  assert.ok(roster.every(r => r.presence === 'offline'));
});

// La etapa de trabajo se medía con el consenso de la AGENDA: con el plan acordado al 100%, el
// panel enseñaba «Trabajo 100% · 0 sin cerrar» mientras había 0 de 5 tareas integradas. Se leía
// como «ya está hecho» y no lo estaba.
test('la etapa de trabajo se mide con su tablero, no con el consenso del plan', async () => {
  const { room, ids } = await workRoom('calc-board', ['Ana', 'Bruno']);
  const [a, b] = ids;

  await drive(room, {
    [a]: { findings: [FIND_TOTAL], proposal: () => defaultProposal(room, a) },
    [b]: {},
  }, { rounds: 40, stop: r => r.phase.name === 'work' });
  assert.ok(room.work?.order.length >= 1, 'el debate aprobó una mejora');
  applyMove(room, a, { kind: 'claim-item', payload: { itemId: room.work.order[0] } });

  const work = stageConsensus(room, 'work').find(s => s.macro === 'work');
  assert.ok(work.work, 'la etapa lleva su tablero');
  assert.equal(work.work.total, room.work.order.length, 'total = tareas, no puntos de agenda');
  assert.equal(work.work.integrated, 0, 'nadie ha integrado nada todavía');
  assert.equal(work.work.inProgress, 1, 'una en la mano de un agente');
  assert.equal(work.global, 0, 'y el porcentaje es el del tablero (0 integradas), no el del plan');
  assert.equal(work.total, room.work.order.length, 'las cifras de la fila salen del tablero');
  assert.equal(work.unresolved, room.work.order.length, 'sin cerrar = las que faltan por integrar');
  assert.equal(work.measured, true, 'una etapa con tablero sí se mide');

  // La decisión sigue midiéndose con el consenso de verdad: ahí el 100% sí significa algo.
  const decision = stageConsensus(room, 'work').find(s => s.macro === 'decision');
  if (decision) assert.ok(decision.global >= 0 && !decision.work, 'la decisión no lleva tablero de trabajo');
});
