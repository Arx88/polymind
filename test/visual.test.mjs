// AGORA v2 — pruebas de la evidencia visual: capturas del artefacto y juicio firmado por quien NO
// lo escribió.
//
// Lo que se comprueba aquí, y por qué cada cosa:
//   1. el PNG se mide decodificando el archivo (una imagen negra NO es evidencia, aunque quien la
//      traiga diga que sí);
//   2. la captura entra en el registro con su huella y su commit, y caduca cuando la rama se mueve;
//   3. la independencia del juez la calcula el servidor: el autor de la tarea no cierra nada con
//      un «pasa», el ojo externo sí, y solo si cita una captura fresca;
//   4. un «no-pasa» bloquea el veredicto (mirar y contradecir pesa más que no mirar);
//   5. sin navegador, el resultado dice `sin-captura` / `not-tested`: nunca `pass`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

import {
  createRoom, joinRoom,  buildObligations, obligationsBrief, obligationsMarkdown,
  pngStats, captureRoom, recordJudgment, independenceOf, visualBrief, visualMarkdown,
  shotsFor, shotFreshness, runCaptures, visualState, judgmentsOf, setServerBase, closesNow,
  visionJudges, visionDuty, visionMarkdown, markAbsent,
  chromePath, headlessArgs, visualConfig, reviewIsCovered, currentTurn, captureHoldMs,
} from '../server/engine/index.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-visual-'));
setServerBase('http://127.0.0.1:8899');

// ---------------------------------------------------------------- un PNG de verdad
// El test no usa navegador: fabrica el PNG que el navegador habría devuelto. Nada de CRC (el
// decodificador del motor no lo necesita para leer píxeles, y el PNG real sí lo trae).
function makePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0; p += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; p += 3;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const NEGRO = makePng(40, 30, () => [0, 0, 0]);
const ESCENA = makePng(40, 30, (x, y) => [40 + x * 3, 90 + y * 4, 160 + ((x + y) % 40)]);

// ---------------------------------------------------------------- sala con artefacto integrado
const PLAN = [
  'El galeón no se ve cutre y la espuma se lee como en Fortnite.',
  'La suite `node check.mjs` debe quedar en verde tras el cambio.',
].join('\n');

// El artefacto tiene que ser REAL (un git con su página): el motor, antes de capturar, le pregunta
// a la vista previa qué hay que retratar, y una carpeta vacía no tendría nada que capturar.
function artefactoRoom() {
  const dir = fs.mkdtempSync(path.join(TMP, 'repo-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><canvas id="mar"></canvas></body></html>\n');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  const commit = git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'inicial');
  assert.equal(commit.status, 0, `git no pudo preparar el artefacto: ${commit.stderr || commit.stdout}`);
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const room = createRoom({ task: 'Barco procedural con mar AAA.', settings: { minAgents: 2 } });
  const ids = ['Ana', 'Bruno', 'Carla'].map(n => joinRoom(room, { name: n, harness: n.toLowerCase(), model: 'test' }).agentId);
  room.repo = { dir, head, branch: 'main', greenfield: true, verify: { command: 'node check.mjs' } };
  room.rounds = 1;
  room.artifacts.proposals.p1 = { id: 'p1', author: ids[0], round: 1, v: 1, title: 'Plan del barco', plan: PLAN, positions: {} };
  room.lastWinnerId = 'p1';
  room.artifacts.synthesis = { by: ids[0], final: PLAN, pointResolutions: [], merges: [] };
  // El artefacto ya integrado: Ana escribió la tarea, Bruno y Carla no tocaron nada.
  room.work = {
    branch: 'main', head, order: ['w1'], pending: null, patchSeq: 1, seq: 1,
    items: {
      w1: {
        id: 'w1', pointId: null, title: 'Mar y espuma', claim: 'La espuma se lee como en Fortnite.',
        evidence: '', files: ['index.html'], severity: 'med', status: 'integrated', claimant: ids[0],
        commit: head, patches: ['g1'], review: { by: ids[1], verdict: 'approve' },
        verify: { ran: true, ok: true, exitCode: 0, command: 'node check.mjs' }, attempts: 1, verifyFailures: 0,
      },
    },
    patches: { g1: { id: 'g1', itemId: 'w1', author: ids[0], summary: 'mar', stat: { fileCount: 1, insertions: 10, deletions: 2, files: [{ path: 'index.html' }] } } },
  };
  return { room, ids };
}

// Un capturador falso que devuelve PNGs de verdad: el camino de guardado, medida y registro se
// recorre entero sin abrir un navegador.
function fakeRunner({ black = false } = {}) {
  const buf = black ? NEGRO : ESCENA;
  return async (room, { shots }) => ({
    ok: !black,
    renderer: 'SwiftShader (software)',
    chrome: 'falso',
    entries: shots.map((s, i) => ({
      ...s,
      buf,
      bytes: buf.length,
      hash: `sha256:falsa${i}`,
      loaded: true,
      // Miente a propósito en `blank`: el servidor no le cree, mide el archivo.
      blank: false,
      stats: { width: 40, height: 30, brightness: 200, contrast: 50, alive: 99, colors: 20 },
      probe: { title: 'barco', webgl: true, renderer: 'SwiftShader (software)', nodes: 42 },
      errors: [],
    })),
  });
}

async function conCapturas({ black = false } = {}) {
  const { room, ids } = artefactoRoom();
  const res = await captureRoom(room, { runner: fakeRunner({ black }), reason: 'trabajo' });
  assert.equal(res.ok || black, true, `la captura no produjo nada: ${res.message || res.reason || ''}`);
  return { room, ids, res };
}

// ---------------------------------------------------------------- 1. el PNG se mide de verdad
test('png: la luminancia se lee del archivo, y una imagen negra queda marcada', () => {
  const negro = pngStats(NEGRO);
  assert.equal(negro.width, 40);
  assert.equal(negro.height, 30);
  assert.equal(negro.brightness, 0);
  assert.equal(negro.contrast, 0);
  assert.equal(negro.alive, 0);

  const escena = pngStats(ESCENA);
  assert.ok(escena.brightness > 20, 'una escena con color no puede medir 0 de luminancia');
  assert.ok(escena.alive > 90, `los píxeles con contenido deben ser casi todos (dio ${escena.alive}%)`);
  assert.ok(escena.colors > 5);
});

test('png: un archivo que no es PNG no se acepta como medición', () => {
  assert.equal(pngStats(Buffer.from('no soy un png')), null);
});

// ---------------------------------------------------------------- 2. captura y registro
test('captura: guarda el PNG, lo mide del archivo y lo registra con huella y commit', async () => {
  const { room, res } = await conCapturas();
  assert.equal(res.ok, true);
  const v = visualState(room);
  // Dos mundos de pantalla por defecto: la misma página en un escritorio y en una pantalla
  // pequeña. Es lo que hace que «se ve bien» sea una pregunta con dos respuestas posibles.
  assert.equal(v.shots.length, 2);
  assert.deepEqual(v.shots.map(s => s.id), ['principal-escritorio', 'principal-pantalla-pequena']);
  assert.deepEqual(v.shots.map(s => s.viewport.width), [1280, 640]);
  assert.equal(v.viewports.length, 2);
  const shot = v.shots[0];
  assert.equal(shot.freshness ?? shotFreshness(room, shot), 'fresca');
  assert.ok(shot.file?.endsWith('.png'));
  assert.equal(shot.page, 'index.html', 'cada captura recuerda qué página retrató');
  assert.ok(v.shots.every(s => fs.existsSync(path.join(v.dir, s.file))), 'cada pantalla deja su PNG');
  // El PNG vive en la carpeta de capturas de la sala, FUERA del árbol del repo: retratar el
  // artefacto no puede ensuciar el repo que se entrega.
  const dir = visualState(room).dir;
  assert.ok(dir && fs.existsSync(path.join(dir, shot.file)), 'el PNG tiene que estar en disco');
  assert.ok(!dir.startsWith(room.repo.dir), 'y fuera del repo');
  assert.equal(shot.commit, room.repo.head);
  assert.ok(shot.stats.brightness > 20);
  const ev = buildObligations(room).evidence.entries.find(e => e.kind === 'capture');
  assert.ok(ev, 'la captura entra en el registro de evidencia del servidor');
  assert.equal(ev.status, 'fresca', 'atada al commit actual');
});

test('captura: un PNG negro NO es evidencia, aunque quien lo traiga diga que sí', async () => {
  const { room, res } = await conCapturas({ black: true });
  assert.equal(res.ok, false);
  const shot = visualState(room).shots[0];
  assert.equal(shot.blank, true, 'la negrura la decide la medida del archivo, no el capturador');
  assert.equal(shotFreshness(room, shot), 'negra');
  const ev = buildObligations(room).evidence.entries.find(e => e.kind === 'capture');
  assert.equal(ev.ok, false);
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  assert.ok(claim.status !== 'juzgada', 'una imagen negra no puede cerrar un juicio');
});

test('captura: cuando la rama se mueve, la captura caduca sola', async () => {
  const { room } = await conCapturas();
  assert.equal(shotFreshness(room, visualState(room).shots[0]), 'fresca');
  room.repo.head = 'otro-commit-distinto';
  assert.equal(shotFreshness(room, visualState(room).shots[0]), 'caduca');
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  assert.equal(claim.evidenceStatus, claim.evidenceStatus);   // no cambia por esto
});

test('captura: sin navegador en la máquina no hay aprobado, hay no-comprobado', async () => {
  const { room } = artefactoRoom();
  const res = await runCaptures(room, { shots: await shotsFor(room), chrome: path.join(TMP, 'no-existe-chrome') });
  assert.equal(res.ok, false);
  assert.ok(['fallo-de-captura', 'sin-navegador'].includes(res.reason), `motivo inesperado: ${res.reason}`);
  assert.equal(res.entries.length, 0, 'sin imagen no hay entradas que contar como evidencia');
});

test('disparos: sin configuración se retrata el artefacto entero, en cada mundo de pantalla', async () => {
  const { room } = artefactoRoom();
  const shots = await shotsFor(room);
  assert.equal(shots.length, 2, 'la página principal en dos pantallas');
  assert.match(shots[0].url, /\/api\/rooms\/[a-z0-9]+\/preview\/index\.html$/);
  assert.deepEqual(shots.map(s => [s.id, s.viewport.width, s.viewport.height]), [
    ['principal-escritorio', 1280, 720], ['principal-pantalla-pequena', 640, 360],
  ]);
  // Con varias páginas, se retratan TODAS (el índice primero): lo que no se captura no se firma.
  fs.writeFileSync(path.join(room.repo.dir, 'tormenta.html'), '<!doctype html><html><body><canvas></canvas></body></html>\n');
  const todas = await shotsFor(room);
  assert.equal(todas.length, 4, 'dos páginas × dos pantallas');
  assert.match(todas[2].url, /tormenta\.html$/);
  assert.equal(todas[3].label.includes('pantalla-pequena'), true);

  // Con una sola pantalla declarada (la forma vieja, en singular), vuelve a haber una toma por página.
  room.settings.visual = { viewport: { width: 1024, height: 768 } };
  const una = await shotsFor(room);
  assert.equal(una.length, 2);
  assert.deepEqual(una.map(s => s.id), ['principal', 'tormenta-html']);
  assert.equal(una[0].viewport.width, 1024);

  // Y con tomas declaradas, manda la sala: cada una es una URL relativa a la vista previa.
  room.settings.visual = { shots: [{ id: 'noche', label: 'noche', url: '?scene=noche' }, 'tormenta.html'] };
  const propias = await shotsFor(room);
  assert.equal(propias.length, 4);
  assert.ok(propias[0].url.endsWith('/preview/?scene=noche'));
  assert.ok(propias[0].id.startsWith('noche-'));
  assert.ok(propias[1].url.endsWith('/preview/?scene=noche'), 'la misma toma en la otra pantalla');
  assert.ok(propias[2].url.endsWith('/preview/tormenta.html'));
});

// ---------------------------------------------------------------- 3. independencia
test('independencia: la calcula el servidor desde el trabajo, no la declara el juez', async () => {
  const { room, ids } = artefactoRoom();
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  assert.equal(independenceOf(room, ids[0], claim).level, 'autor', 'Ana escribió la tarea');
  assert.equal(independenceOf(room, ids[1], claim).level, 'ajeno', 'Bruno revisó, no escribió');
  assert.equal(independenceOf(room, ids[2], claim).level, 'ajeno');
  // Con Bruno escribiendo otra parte del artefacto, deja de ser ojo externo.
  room.work.patches.g2 = { id: 'g2', itemId: 'w9', author: ids[1], summary: 'otra cosa' };
  room.work.items.w9 = { id: 'w9', title: 'otra', files: ['x.js'], status: 'integrated', claimant: ids[1], patches: ['g2'] };
  assert.equal(independenceOf(room, ids[1], claim).level, 'coautor');
});

// ---------------------------------------------------------------- 4. juicio
test('juicio: el autor no cierra nada con un «pasa»; el ojo externo con captura fresca, sí', async () => {
  const { room, ids } = await conCapturas();
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');

  const autor = recordJudgment(room, ids[0], { verdict: 'pasa', reason: 'yo la veo bien', captures: ['principal'] }, { claim });
  assert.equal(autor.closes, false);
  assert.equal(autor.independence.level, 'autor');
  assert.ok(autor.warnings.some(w => /miras lo tuyo/.test(w)), `avisos: ${autor.warnings.join(' | ')}`);
  let led = buildObligations(room);
  assert.equal(led.claims.find(c => c.id === claim.id).status, 'juzgada-por-autor');
  assert.ok(led.pendings.some(p => p.kind === 'juicio-pendiente'));

  const externo = recordJudgment(room, ids[2], { verdict: 'pasa', reason: 'la espuma se lee, el casco tiene silueta', captures: ['principal'] }, { claim });
  assert.equal(externo.closes, true);
  led = buildObligations(room);
  assert.equal(led.claims.find(c => c.id === claim.id).status, 'juzgada');
  assert.equal(led.counts.juzgadas, 1);
  assert.ok(!led.pendings.some(p => p.kind === 'juicio-pendiente' && p.text === claim.text));
});

test('juicio: un «pasa» sin captura citada o sobre imagen caducada no cierra', async () => {
  const { room, ids } = await conCapturas();
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  const sinCita = recordJudgment(room, ids[2], { verdict: 'pasa', reason: 'me lo parece' }, { claim });
  assert.equal(sinCita.closes, false);
  assert.ok(sinCita.warnings.some(w => /no citaste ninguna captura/.test(w)));

  room.repo.head = 'otro-commit-distinto';   // el artefacto cambió después de capturarlo
  const caduco = recordJudgment(room, ids[2], { verdict: 'pasa', reason: 'la vi antes', captures: ['principal'] }, { claim });
  assert.equal(caduco.closes, false);
  assert.equal(judgmentsOf(room).at(-1).captures[0].freshness, 'caduca');
  const led = buildObligations(room);
  assert.equal(led.claims.find(c => c.id === claim.id).status, 'caducada');
});

test('juicio: un «pasa» que cerraba deja de cerrar cuando la rama avanza', async () => {
  const { room, ids } = await conCapturas();
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  const externo = recordJudgment(room, ids[2], { verdict: 'pasa', reason: 'el mar se lee, no da aspecto de demo', captures: ['principal'] }, { claim });
  assert.equal(closesNow(room, externo.judgment), true);
  assert.equal(buildObligations(room).claims.find(c => c.id === claim.id).status, 'juzgada');
  room.repo.head = 'otro-commit-distinto';
  // El juicio no se guarda como verdad permanente: se recalcula contra las capturas que hay.
  assert.equal(closesNow(room, externo.judgment), false);
  const led = buildObligations(room);
  assert.equal(led.claims.find(c => c.id === claim.id).status, 'caducada');
  assert.equal(led.counts.juzgadas, 0);
  assert.equal(led.counts.caducados, 1);
  assert.equal(visualBrief(room, ids[2], led.claims).targets[0].alreadyJudgedByMe.closes, false);
});

test('juicio: decir «no pasa» exige motivo, y bloquea el veredicto', async () => {
  const { room, ids } = await conCapturas();
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  assert.throws(() => recordJudgment(room, ids[1], { verdict: 'no-pasa', captures: ['principal'] }, { claim }),
    /exige el motivo/i);
  recordJudgment(room, ids[1], {
    verdict: 'no-pasa',
    reason: 'a 200 m el casco queda oscuro contra el agua y no se lee la silueta',
    captures: ['principal'],
  }, { claim });
  const led = buildObligations(room);
  assert.equal(led.claims.find(c => c.id === claim.id).status, 'no-pasa');
  assert.ok(led.blockers.some(b => b.kind === 'juicio-no-pasa'));
  assert.equal(led.verdict, 'no-cumplido');
});

test('juicio: sin capturas no se puede firmar nada (y se dice cómo pedirlas)', async () => {
  const { room, ids } = artefactoRoom();
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  assert.throws(() => recordJudgment(room, ids[1], { verdict: 'pasa' }, { claim }), /No hay capturas/);
  // Y el resultado lo publica como incumplido por falta de imagen, no como aprobado.
  const led = buildObligations(room);
  assert.equal(led.claims.find(c => c.id === claim.id).status, 'sin-captura');
  assert.ok(led.pendings.some(p => p.kind === 'juicio-sin-captura'));
});

// ---------------------------------------------------------------- 5. lo que ven los turnos y el acta
test('turno: el brief ofrece el material, los objetivos y la independencia de quien mira', async () => {
  const { room, ids } = await conCapturas();
  const claims = buildObligations(room).claims;
  const brief = visualBrief(room, ids[2], claims);
  assert.equal(brief.available, true);
  assert.equal(brief.shots.length, 2);
  assert.ok(brief.shots.every(s => s.viewport), 'cada toma dice en qué pantalla se sacó');
  assert.match(brief.shots[0].url, /\/api\/rooms\/[a-z0-9]+\/visual\/principal(-[\w.-]+)?$/);
  assert.equal(brief.shots[0].freshness, 'fresca');
  assert.ok(brief.targets.length >= 1);
  assert.equal(brief.targets[0].independence, 'ajeno');
  assert.ok(brief.targets[0].claimId.startsWith('o'));
  assert.equal(brief.move.kind, 'judgment');
  // El autor, en cambio, ve que su firma no cierra.
  assert.equal(visualBrief(room, ids[0], claims).targets[0].independence, 'autor');
  // Y el verificador recibe la evidencia visual en sus obligaciones.
  const ob = obligationsBrief(room);
  assert.ok(ob.visual?.available);
  assert.equal(ob.visual.shots.length, 2);
});

// ---------------------------------------------------------------- 6. encontrar el navegador
// «No hay navegador» tiene que significar que NO HAY navegador, no que el motor no miró donde
// estaba. Esto cubre las formas en que un servidor lo tiene instalado hoy: en el PATH, en una
// carpeta que se le indique, o dentro de la carpeta de una instalación (chrome-linux64/chrome).
test('navegador: el motor busca donde un navegador acaba de verdad, y sabe cuándo ceder el sandbox', () => {
  const prev = { chrome: process.env.AGORA_CHROME, dir: process.env.AGORA_CHROME_DIR, ns: process.env.AGORA_CHROME_NO_SANDBOX };
  try {
    const dir = fs.mkdtempSync(path.join(TMP, 'browsers-'));
    const bin = path.join(dir, 'chrome');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    delete process.env.AGORA_CHROME;
    process.env.AGORA_CHROME_DIR = dir;
    assert.equal(chromePath(), bin, 'una carpeta con el binario dentro se encuentra');

    const cache = fs.mkdtempSync(path.join(TMP, 'cache-'));
    const nestedBin = path.join(cache, 'chrome-linux64', 'chrome');
    fs.mkdirSync(path.dirname(nestedBin), { recursive: true });
    fs.writeFileSync(nestedBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    delete process.env.AGORA_CHROME_DIR;
    process.env.AGORA_CHROME = cache;   // apuntando a la CARPETA de la instalación, no al binario
    assert.equal(chromePath(), nestedBin, 'la carpeta de una instalación también vale');
  } finally {
    if (prev.chrome === undefined) delete process.env.AGORA_CHROME; else process.env.AGORA_CHROME = prev.chrome;
    if (prev.dir === undefined) delete process.env.AGORA_CHROME_DIR; else process.env.AGORA_CHROME_DIR = prev.dir;
    if (prev.ns === undefined) delete process.env.AGORA_CHROME_NO_SANDBOX; else process.env.AGORA_CHROME_NO_SANDBOX = prev.ns;
  }

  // En un contenedor como root, Chromium no arranca sin --no-sandbox: el servidor lo deduce.
  process.env.AGORA_CHROME_NO_SANDBOX = '1';
  assert.ok(headlessArgs().includes('--no-sandbox'));
  process.env.AGORA_CHROME_NO_SANDBOX = '0';
  assert.ok(!headlessArgs().includes('--no-sandbox'), 'y se puede forzar lo contrario');
  // `--disable-dev-shm-usage` va siempre: en un contenedor `/dev/shm` es diminuto y Chrome muere a
  // mitad de captura. No es una opción de sandbox, es una condición del contenedor.
  assert.ok(headlessArgs().includes('--disable-dev-shm-usage'));
  delete process.env.AGORA_CHROME_NO_SANDBOX;
});

test('pantallas: la configuración admite varias, y la forma vieja (una sola) sigue valiendo', () => {
  const room = createRoom({ task: 'Barco procedural con mar AAA.', settings: { minAgents: 2 } });
  assert.equal(visualConfig(room).viewports.length, 2, 'por defecto se miran dos pantallas');
  room.settings.visual = { viewport: { width: 800, height: 600 } };
  const una = visualConfig(room);
  assert.equal(una.viewports.length, 1);
  assert.deepEqual([una.viewport.width, una.viewport.height], [800, 600]);
  room.settings.visual = { viewports: [{ id: 'tv', width: 1920, height: 1080 }, { width: 375, height: 667 }] };
  const varias = visualConfig(room);
  assert.deepEqual(varias.viewports.map(v => v.id), ['tv', 'pantalla-2']);
  assert.deepEqual([varias.viewports[1].width, varias.viewports[1].height], [375, 667]);
});

// ---------------------------------------------------------------- 7. la captura retiene la revisión
// La carrera que esto cierra: el servidor fotografía el artefacto justo al integrar el último
// ítem, y en un host lento la fase de revisión puede cerrar antes que el navegador — la afirmación
// de aspecto quedaba «sin captura» sin que nadie hubiera decidido nada. Mientras hay una captura en
// vuelo, la revisión NO cierra y el turno lo dice.
test('captura en vuelo: la revisión no cierra hasta que la imagen está', async () => {
  const { room, ids } = artefactoRoom();
  room.status = 'debate';
  room.phase = { name: 'review', startedAt: Date.now(), deadline: Date.now() + 300_000, data: { review: { revisados: {}, round: 1 } } };
  // Bruno ya revisó la mejora integrada: la revisión está cubierta y podría cerrar…
  room.phase.data.review.revisados[ids[1]] = { w1: { verdict: 'ok', at: Date.now() } };
  assert.equal(reviewIsCovered(room), true, 'sin captura en curso, la revisión puede cerrar');

  room.artifacts.visualRunning = { at: Date.now(), by: ids[2], reason: 'último ítem integrado' };
  assert.equal(reviewIsCovered(room), false, 'con la captura en curso, no');
  const turn = currentTurn(room, ids[2]);
  assert.equal(turn.action, 'wait');
  assert.match(turn.message, /capturando el artefacto/i);

  delete room.artifacts.visualRunning;
  assert.equal(reviewIsCovered(room), true, 'y al terminar, la puerta se abre sola');

  // Y la retención CADUCA: un navegador colgado no congela la sala para siempre.
  room.artifacts.visualRunning = { at: Date.now() - captureHoldMs(room) - 1_000, by: ids[2], reason: 'captura vieja' };
  assert.equal(reviewIsCovered(room), true, 'pasado el plazo de captura, la sala sigue');
  delete room.artifacts.visualRunning;
});

test('una captura informativa no detiene un trabajo sin afirmaciones visuales', () => {
  const { room, ids } = artefactoRoom();
  room.status = 'debate';
  room.phase = { name: 'review', startedAt: Date.now(), deadline: Date.now() + 300_000, data: { review: { revisados: { [ids[1]]: { w1: { verdict: 'ok', at: Date.now() } } }, round: 1 } } };
  room.artifacts.synthesis.final = '1. Ejecutar node check.mjs y conservar las pruebas verdes.';
  room.artifacts.proposals.p1.plan = room.artifacts.synthesis.final;
  room.artifacts.visualRunning = { at: Date.now(), by: ids[2], reason: 'captura informativa' };
  assert.equal(reviewIsCovered(room), true);
  assert.notEqual(currentTurn(room, ids[2]).message?.includes('La revisión no cierra hasta que la imagen esté'), true);
});

// ---------------------------------------------------------------- 8. los modelos que ven
// Declarar «vision» no es un adorno: es el compromiso de mirar el artefacto y firmarlo. Lo que se
// comprueba aquí es que la obligación es real (bloquea), que se le recuerda a quien la debe en su
// propio turno, y que no se convierte en una firma imposible cuando ese agente se va.
test('visión: quien declara ver queda obligado, y sin su firma la obligación no cierra', async () => {
  const { room, ids } = await conCapturas();
  const claims = buildObligations(room).claims;
  const claim = claims.find(c => c.type === 'juicio');
  room.agents[ids[2]].capabilities = ['vision'];

  assert.deepEqual(visionJudges(room).map(j => j.name), ['Carla']);
  const duty = visionDuty(room, claims);
  assert.equal(duty.missing, 1);
  assert.deepEqual(duty.judges[0].pending, [claim.id]);

  let led = buildObligations(room);
  assert.ok(led.blockers.some(b => b.kind === 'visión-sin-firmar'), 'la firma que falta bloquea');
  assert.equal(led.counts.sinFirmar, 1);
  assert.equal(led.counts.vision, 1);
  assert.equal(led.visual.vision.seers[0].pending[0], claim.id);
  assert.match(obligationsMarkdown(room).join('\n'), /Quién tenía que mirar/);
  assert.match(visionMarkdown(room, claims).join('\n'), /debe/);

  // Y su turno se lo pide con nombre y apellido, no como sugerencia.
  const brief = visualBrief(room, ids[2], claims);
  assert.equal(brief.you.declaresVision, true);
  assert.deepEqual(brief.you.owed, [claim.id]);
  assert.match(brief.message, /Declaraste visión/);
  assert.equal(brief.vision.seers[0].pending[0], claim.id);

  // Firma: la obligación de ver queda saldada y el bloqueo se va con ella.
  recordJudgment(room, ids[2], { verdict: 'pasa', reason: 'la espuma se lee y el casco tiene silueta a tres distancias', captures: ['principal'] }, { claim });
  assert.equal(visionDuty(room, buildObligations(room).claims).missing, 0);
  led = buildObligations(room);
  assert.ok(!led.blockers.some(b => b.kind === 'visión-sin-firmar'));
  assert.equal(led.counts.sinFirmar, 0);
});

test('visión: aunque otro ojo cierre la afirmación, quien ve sigue debiendo su firma', async () => {
  const { room, ids } = await conCapturas();
  const claims = buildObligations(room).claims;
  const claim = claims.find(c => c.type === 'juicio');
  // Bruno no escribió nada: su «pasa» cierra la afirmación.
  recordJudgment(room, ids[1], { verdict: 'pasa', reason: 'el mar y el casco se leen bien de lejos', captures: ['principal'] }, { claim });
  assert.equal(buildObligations(room).claims.find(c => c.id === claim.id).status, 'juzgada');

  room.agents[ids[2]].capabilities = ['vision'];
  const brief = visualBrief(room, ids[2], buildObligations(room).claims);
  assert.ok(brief.targets.some(t => t.claimId === claim.id && t.owesSignature),
    'la afirmación vuelve a su turno aunque esté cerrada: él todavía no la miró');
  assert.deepEqual(brief.you.owed, [claim.id]);
  assert.ok(buildObligations(room).blockers.some(b => b.kind === 'visión-sin-firmar'));
});

test('visión: un modelo que se retira no deja una firma imposible de poner', async () => {
  const { room, ids } = await conCapturas();
  room.agents[ids[2]].capabilities = ['vision'];
  assert.equal(visionDuty(room, buildObligations(room).claims).missing, 1);
  markAbsent(room, ids[2], 'sin señal');
  assert.equal(visionDuty(room, buildObligations(room).claims).missing, 0);
  assert.ok(!buildObligations(room).blockers.some(b => b.kind === 'visión-sin-firmar'));
});

test('visión: firmar sin declarar la capacidad se registra, y el acta lo dice', async () => {
  const { room, ids } = await conCapturas();
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  const res = recordJudgment(room, ids[1], { verdict: 'pasa', reason: 'se lee bien a tres distancias distintas', captures: ['principal'] }, { claim });
  assert.equal(res.closes, true, 'un ojo externo sigue cerrando aunque no haya declarado visión');
  assert.equal(res.judgment.visionDeclared, false);
  assert.ok(res.warnings.some(w => /no declaraste la capacidad/i.test(w)));
  const led = buildObligations(room);
  assert.equal(led.visual.judgments[0].visionDeclared, false);
  assert.equal(led.counts.vision, 0, 'sin declaración no se inventa un ojo obligado');
});

test('acta: las capturas y los juicios salen escritos, con su independencia y su huella', async () => {
  const { room, ids } = await conCapturas();
  const claim = buildObligations(room).claims.find(c => c.type === 'juicio');
  recordJudgment(room, ids[1], { verdict: 'dudoso', reason: 'a 200 m no distingo la silueta del casco', captures: ['principal'] }, { claim });
  const md = visualMarkdown(room).join('\n');
  assert.match(md, /Evidencia visual/);
  assert.match(md, /principal/);
  assert.match(md, /1280×720/, 'el acta dice en qué pantalla se tomó cada captura');
  assert.match(md, /SwiftShader/i, 'la procedencia del render se publica');
  assert.match(md, /DUDOSO/);
  assert.match(md, /ajeno/);
  const acta = obligationsMarkdown(room).join('\n');
  assert.match(acta, /Evidencia visual/);
  assert.match(acta, /capturas del artefacto/i);
  // El acta exportada de una sala cerrada reutiliza estas mismas líneas (`obligationsMarkdown`),
  // así que la sección viaja con el resultado sin volver a redactarse.
});
