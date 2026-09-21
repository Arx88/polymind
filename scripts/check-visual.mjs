// Verificación end-to-end del juicio visual con NAVEGADOR REAL y servidor HTTP real.
//
// No usa capturadores falsos: arranca Chrome headless, deja que el motor capture la página que la
// sala está construyendo, pide el PNG por HTTP como lo haría el panel, y firma el juicio con los
// movimientos de verdad (applyMove), incluido el intento del autor por aprobar su propio trabajo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = process.argv[2] || process.cwd();
const engine = await import(pathToFileURL(path.join(REPO, 'server/engine/index.mjs')).href);
const { createAgora } = await import(pathToFileURL(path.join(REPO, 'server/transports/http.mjs')).href);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-e2e-'));
const DATA = path.join(TMP, 'data');
const FIXTURE = path.join(TMP, 'proyecto');

// Un artefacto con algo que ver: canvas con degradado + formas, que es lo que el navegador tiene
// que dibujar de verdad (si esto sale negro, la captura no vale).
fs.mkdirSync(FIXTURE, { recursive: true });
fs.writeFileSync(path.join(FIXTURE, 'index.html'), `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Mar de prueba</title></head>
<body style="margin:0;background:#0b1020">
<canvas id="mar" width="640" height="360" style="width:100vw;height:100vh;display:block"></canvas>
<script>
  const c = document.getElementById('mar').getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 360);
  g.addColorStop(0, '#1b3a6b'); g.addColorStop(0.55, '#2f7fb8'); g.addColorStop(1, '#0a1c33');
  c.fillStyle = g; c.fillRect(0, 0, 640, 360);
  c.fillStyle = '#eaf6ff';
  for (let i = 0; i < 14; i += 1) {
    c.beginPath(); c.arc(40 + i * 45, 150 + Math.sin(i) * 30, 12 + (i % 4) * 5, 0, 7); c.fill();
  }
  c.fillStyle = '#ffd479'; c.fillRect(300, 40, 60, 60);
  window.__listo = true;
</script></body></html>
`);
const git = (...args) => spawnSync('git', args, { cwd: FIXTURE, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('add', '.');
const commit = git('-c', 'user.name=e2e', '-c', 'user.email=e2e@local', 'commit', '-q', '-m', 'artefacto');
if (commit.status !== 0) throw new Error(`git: ${commit.stderr}`);

const agora = createAgora({ dataDir: DATA, memory: false });
const port = await new Promise(resolve => {
  agora.server.listen(0, '127.0.0.1', () => resolve(agora.server.address().port));
});
const base = `http://127.0.0.1:${port}`;
console.log(`servidor en ${base} (puerto real) · captureBase=${engine.captureBase()}`);

const room = agora.hall.create({
  task: 'Un mar de prueba que no se vea cutre y que la suite quede en verde.',
  settings: { minAgents: 2, phaseMs: Object.fromEntries(['lobby', 'frame', 'work', 'review'].map(p => [p, 300_000])) },
});
// Carla declara la capacidad «vision»: mirar el artefacto pasa a ser su parte de la obligación,
// y el servidor va a exigirle la firma (si no la pone, el veredicto no sube).
const ids = ['Ana', 'Bruno', 'Carla'].map(n => engine.joinRoom(room, {
  name: n, harness: n.toLowerCase(), model: 'e2e',
  capabilities: n === 'Carla' ? ['vision'] : [],
}).agentId);

await engine.attachRepo(room, { dataDir: DATA, source: FIXTURE, verify: null, baseline: false });
engine.startRoom(room);
room.phase = { name: 'work', startedAt: Date.now(), deadline: Date.now() + 300_000, data: { winnerId: 'p1' } };
room.rounds = 1;
const PLAN = [
  'El mar de prueba no se ve cutre y el degradado se lee como un mar.',
  'La suite `node check.mjs` debe quedar en verde tras el cambio.',
].join('\n');
room.artifacts.proposals.p1 = { id: 'p1', author: ids[0], round: 1, v: 1, title: 'Plan del mar', plan: PLAN, positions: {} };
room.lastWinnerId = 'p1';
room.artifacts.synthesis = { by: ids[0], final: PLAN, pointResolutions: [], merges: [] };
room.work = {
  branch: room.repo.branch, head: room.repo.head, order: ['w1'], pending: null, patchSeq: 1, seq: 1,
  items: {
    w1: {
      id: 'w1', pointId: null, title: 'Mar de prueba', claim: 'El degradado se lee como un mar.',
      evidence: '', files: ['index.html'], severity: 'med', status: 'integrated', claimant: ids[0],
      commit: room.repo.head, patches: ['g1'], review: { by: ids[1], verdict: 'approve' },
      verify: { ran: false, ok: null }, attempts: 1, verifyFailures: 0,
    },
  },
  patches: { g1: { id: 'g1', itemId: 'w1', author: ids[0], summary: 'mar', stat: { fileCount: 1, insertions: 10, deletions: 0, files: [{ path: 'index.html' }] } } },
};

// --- 1. el movimiento `capture` que pide un agente -------------------------------
const pedir = engine.applyMove(room, ids[2], { kind: 'capture', payload: {} });
console.log('capture →', JSON.stringify(pedir.warnings || []), JSON.stringify(room.phase.data?.responses?.[ids[2]] || null), `fase=${room.phase.name}`);

// --- 2. la captura REAL con Chrome headless --------------------------------------
const t0 = Date.now();
const res = await engine.captureRoom(room, { by: ids[2], reason: 'verificación e2e' });
console.log(`captura real: ok=${res.ok} renderer=${res.renderer} ms=${Date.now() - t0}`);
const visual = engine.visualState(room);
for (const s of visual.shots) {
  console.log(`  toma ${s.id}: ${s.stats?.width}x${s.stats?.height} ${s.stats?.bytes ?? s.bytes}B luminancia=${s.stats?.brightness} contraste=${s.stats?.contrast} vivos=${s.stats?.alive}% negra=${s.blank} frescura=${engine.shotFreshness(room, s)}`);
}

// --- 3. el PNG por HTTP, como lo pide el panel ------------------------------------
const png = await fetch(`${base}/api/rooms/${room.code}/visual/${visual.shots[0].id}`);
const bytes = Buffer.from(await png.arrayBuffer());
const index = await (await fetch(`${base}/api/rooms/${room.code}/visual`)).json();
console.log(`HTTP GET captura → ${png.status} ${png.headers.get('content-type')} ${bytes.length}B · índice con ${index.visual.shots.length} toma(s) en estado ${index.visual.shots[0]?.freshness}`);

// --- 4. el autor intenta aprobar su propia obra -----------------------------------
const all = engine.buildObligations(room).claims;
console.log('afirmaciones tipadas:', JSON.stringify(all.map(c => `${c.id}:${c.type}:${c.text.slice(0, 40)}`), null, 1));
const claim = all.find(c => c.type === 'juicio');
// La obligación de ver, antes de firmar: Carla declaró visión y todavía no miró.
const deber = engine.visionDuty(room, all);
console.log(`visión declarada: ${deber.judges.map(j => `${j.name} debe ${j.pending.join(', ') || 'nada'}`).join(' · ')} → faltan ${deber.missing} firma(s)`);
console.log(`  bloqueo en el veredicto: ${engine.buildObligations(room).blockers.filter(b => b.kind === 'visión-sin-firmar').length}`);
engine.applyMove(room, ids[0], { kind: 'judgment', payload: { claimId: claim.id, verdict: 'pasa', reason: 'yo la veo perfecta', captures: ['principal'] } });
console.log('autor pasa →', JSON.stringify(room.phase.data?.responses?.[ids[0]] || null));
console.log('  estado en el libro:', engine.buildObligations(room).claims.find(c => c.id === claim.id).status);

// --- 5. el ojo externo firma ------------------------------------------------------
engine.applyMove(room, ids[2], { kind: 'judgment', payload: { claimId: claim.id, verdict: 'pasa', reason: 'el degradado y las manchas se leen como mar; no da aspecto de demo', captures: ['principal'] } });
console.log('carla (ajena) pasa →', JSON.stringify(room.phase.data?.responses?.[ids[2]] || null));
const led = engine.buildObligations(room);
console.log(`  estado: ${led.claims.find(c => c.id === claim.id).status} · juzgadas=${led.counts.juzgadas} capturas=${led.counts.capturas} veredicto=${led.verdict}`);

// --- 6. el artefacto cambia: el juicio caduca -------------------------------------
fs.writeFileSync(path.join(room.repo.dir, 'index.html'), '<!doctype html><html><body><h1 style="color:#fff">otra cosa</h1></body></html>');
const add = spawnSync('git', ['add', 'index.html'], { cwd: room.repo.dir, encoding: 'utf8' });
const nuevo = spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@local', 'commit', '-m', 'segundo'], { cwd: room.repo.dir, encoding: 'utf8' });
if (nuevo.status !== 0) throw new Error(`git add: ${add.stderr} | git commit 2: ${nuevo.stderr || nuevo.stdout}`);
room.repo.head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: room.repo.dir, encoding: 'utf8' }).stdout.trim();
const tras = engine.buildObligations(room);
console.log(`  tras mover el commit: captura=${engine.shotFreshness(room, visual.shots[0])} juicio=${tras.claims.find(c => c.id === claim.id).status}`);

// Carla firmó en el paso anterior, así que la obligación de ver queda saldada.
const deber2 = engine.visionDuty(room, engine.buildObligations(room).claims);
console.log(`visión después de firmar: faltan ${deber2.missing} firma(s) · bloqueos=${engine.buildObligations(room).blockers.filter(b => b.kind === 'visión-sin-firmar').length}`);

const md = engine.visualMarkdown(room).join('\n');
console.log('--- acta (evidencia visual) ---');
console.log(md);

// --- 7. el humano juzga AL FINAL, sobre la entrega congelada -----------------------
// Antes de entregar, el juicio humano se rechaza: no hay nada que aceptar todavía.
const temprano = await fetch(`${base}/api/rooms/${room.code}/admin`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ adminToken: room.adminToken, op: 'human-review', verdict: 'aprobado' }),
});
console.log(`revisión humana ANTES de entregar → HTTP ${temprano.status} ${JSON.stringify((await temprano.json()).message || '').slice(0, 90)}`);

engine.finishRoom(room, 'p1');
console.log(`sala cerrada: ${room.status} · checksum ${String(room.result.checksum).slice(0, 18)}`);
const aprobar = await fetch(`${base}/api/rooms/${room.code}/admin`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ adminToken: room.adminToken, op: 'human-review', verdict: 'aprobado', reason: 'el mar se lee y sirve así', by: 'Juan' }),
});
console.log(`aprobado → HTTP ${aprobar.status} veredicto=${(await aprobar.json()).verdict}`);
console.log(`  en el resultado: ${JSON.stringify(room.result.humanReview?.verdict)} por ${room.result.humanReview?.by} · abiertos=${room.result.humanReview?.open.length}`);

// Y ahora el humano NO está conforme: pide cambios concretos, que se convierten en trabajo.
const pedirCambios = await fetch(`${base}/api/rooms/${room.code}/admin`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    adminToken: room.adminToken, op: 'human-review', verdict: 'cambios',
    reason: 'el horizonte se corta en seco a la derecha',
    requests: ['Suavizar el corte del horizonte a la derecha con una banda de niebla.'],
  }),
});
const cambios = await pedirCambios.json();
console.log(`cambios → HTTP ${pedirCambios.status} reabierta=${cambios.reopened} tareas=${JSON.stringify(cambios.items)} fase=${cambios.room?.phase || room.phase.name} estado=${room.status}`);
console.log(`  tarea nueva: ${JSON.stringify(room.work.items[cambios.items[0]]?.from)} «${room.work.items[cambios.items[0]]?.title}»`);
console.log(`  bloqueo humano-pide-cambios: ${engine.buildObligations(room).blockers.filter(b => b.kind === 'humano-pide-cambios').length}`);
const resultadoAbierto = await (await fetch(`${base}/api/rooms/${room.code}/result?agent=${ids[0]}&token=${room.agents[ids[0]].token}`)).json();
console.log(`  GET /result mientras trabaja: closed=${resultadoAbierto.closed} reabierta=${resultadoAbierto.reopened?.by} peticiones=${resultadoAbierto.reopened?.requests.length}`);

// Al integrar la tarea, la petición pasa a atendido y deja de bloquear.
room.work.items[cambios.items[0]].status = 'integrated';
console.log(`  tras integrarla: ${engine.humanReviewReport(room).requests[0].status} · bloqueos=${engine.buildObligations(room).blockers.filter(b => b.kind === 'humano-pide-cambios').length}`);
console.log('--- acta (revisión humana) ---');
console.log(engine.obligationsMarkdown(room).join('\n').split('### Revisión humana')[1]?.split('\n').slice(0, 8).join('\n') || '(sin sección)');

await new Promise(r => agora.server.close(r));
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\nE2E visual: OK');
