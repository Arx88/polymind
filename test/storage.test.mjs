import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hall, log, progressOf } from '../server/engine/state.mjs';
import { publicRoom } from '../server/engine/views.mjs';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// La sala que se pierde sin querer: un debate terminado en memoria y, en disco, la copia de un
// servidor zombi que se quedó en el lobby. Sin el guardián, el archivo se sobrescribía con la
// copia pobre y el trabajo desaparecía al reiniciar.
function closeWithDecision(room, hall, pasos = 40) {
  for (let i = 0; i < pasos; i += 1) log(room, null, 'phase', `paso ${i} de un debate que termina`);
  room.status = 'closed';
  room.phase = { name: 'closed', startedAt: Date.now(), deadline: Date.now(), data: {} };
  room.result = { outcome: 'decided', checksum: 'sha256:decision', final: 'PLAN FINAL' };
  hall.persist(room);
  return room;
}

function staleCopyOf(room) {
  return {
    schemaVersion: 2,
    code: room.code,
    title: room.title,
    task: room.task,
    status: 'closed',
    phase: { name: 'closed', startedAt: Date.now(), deadline: Date.now(), data: {} },
    settings: room.settings,
    agents: {},
    order: [],
    agenda: [],
    artifacts: { proposals: {}, critiques: {}, findings: [] },
    log: [{ id: 1, ts: Date.now(), agentId: null, kind: 'room', text: 'Sala creada.' }],
    logSeq: 1,
    result: { outcome: 'expired' },
    createdAt: room.createdAt,
  };
}

// Borrar un trabajo es una decisión del humano y tiene que ser TOTAL: si el JSON quedara en el
// directorio, la sala reaparecería en la siguiente lista (y con memoria publicada volvería del
// remoto). El borrado se lleva el archivo, su temporal, la caché y las marcas de progreso.
test('borrar una sala la quita de la lista, del disco y de la caché', t => {
  const dir = tmpDir(t, 'polymind-borrado-');
  const hall = new Hall(dir);
  const room = hall.create({ task: 'Un trabajo que se borra del todo' });
  assert.ok(fs.existsSync(path.join(dir, `${room.code}.json`)));
  assert.equal(hall.list().length, 1);

  assert.equal(hall.remove(room.code), true);
  assert.equal(fs.existsSync(path.join(dir, `${room.code}.json`)), false, 'el archivo se va');
  assert.equal(hall.get(room.code), null, 'la sala ya no existe');
  assert.equal(hall.list().length, 0, 'y no vuelve a aparecer en la lista');

  // Otro proceso sobre el mismo directorio tampoco la ve: no es un olvido de la caché.
  const otra = new Hall(dir);
  assert.equal(otra.get(room.code), null);
  assert.equal(otra.list().length, 0);
});

test('a stale copy on disk cannot erase a finished debate', t => {
  const dir = tmpDir(t, 'polymind-clobber-');
  const hall = new Hall(dir);
  const room = closeWithDecision(hall.create({ task: 'Una tarea que termina de verdad' }), hall);
  const file = hall.fileOf(room.code);
  const bueno = fs.readFileSync(file, 'utf8');

  // El otro proceso guarda SU copia: la sala todavía en el lobby, sin agentes ni resultado.
  fs.writeFileSync(file, JSON.stringify(staleCopyOf(room)));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).result.outcome, 'expired');

  // El reloj vuelve a leer la sala: la versión avanzada manda y el disco se restaura.
  const healed = hall.get(room.code);
  assert.equal(healed.result.outcome, 'decided');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).result.outcome, 'decided');
  assert.equal(fs.readFileSync(file, 'utf8'), bueno);
});

test('a further copy on disk is adopted, never overwritten with the old one', t => {
  const dir = tmpDir(t, 'polymind-adopt-');
  const hall = new Hall(dir);
  const room = hall.create({ task: 'Otra tarea que termina mejor fuera' });
  const obsoleto = hall.get(room.code);

  // Otra instancia hizo el debate entero y lo dejó en disco.
  const otra = new Hall(dir);
  closeWithDecision(otra.get(room.code), otra);

  // La copia vieja no puede pisarla, ni al leer ni al guardar.
  assert.equal(hall.get(room.code).result.outcome, 'decided');
  obsoleto.task = 'un cambio de una instancia que se quedó atrás';
  assert.equal(hall.persist(obsoleto), true);
  const disco = JSON.parse(fs.readFileSync(hall.fileOf(room.code), 'utf8'));
  assert.equal(disco.result.outcome, 'decided');
  assert.notEqual(disco.task, obsoleto.task);
});

test('progress ranks a decided room above a merely closed one', () => {
  const base = { status: 'debate', log: [], logSeq: 10, agents: {} };
  const enCurso = { ...base };
  const caducada = { ...base, status: 'closed', result: { outcome: 'expired' }, logSeq: 500 };
  const decidida = { ...base, status: 'closed', result: { outcome: 'decided' }, logSeq: 40 };
  const fallida = { ...base, status: 'closed', result: { outcome: 'failed' }, logSeq: 300 };
  assert.ok(progressOf(enCurso) < progressOf(caducada));
  assert.ok(progressOf(caducada) < progressOf(fallida));
  assert.ok(progressOf(fallida) < progressOf(decidida));
});

test('failed writes preserve the last snapshot and expose recoverable degraded state', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymind-storage-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const hall = new Hall(dir);
  const room = hall.create({task:'Probar la durabilidad de un trabajo'});
  const file = hall.fileOf(room.code);
  const before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(file + '.tmp');
  room.task = 'Un cambio que todavía no se pudo guardar';
  assert.equal(hall.persist(room), false);
  assert.equal(room.__changed, true);
  assert.equal(publicRoom(room).storage.saved, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.rmdirSync(file + '.tmp');
  assert.equal(hall.persist(room), true);
  assert.equal(publicRoom(room).storage.saved, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).task, room.task);
  assert.equal(fs.readFileSync(file, 'utf8').includes('__storageFailure'), false);
});
test('a failed initial write does not leave a phantom room in memory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymind-create-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const hall = new Hall(dir);
  const file = path.join(dir, 'not-a-directory');
  fs.writeFileSync(file, 'test fixture');
  hall.dir = file;
  assert.throws(() => hall.create({task:'Esta sala no debe aparecer si no se guarda'}), {code:'storage_unavailable'});
  assert.equal(hall.cache.size,0);
});
