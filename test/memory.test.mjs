import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { Hall, log, progressOf } from '../server/engine/state.mjs';
import { joinRoom } from '../server/engine/roster.mjs';
import { workspaceDirFor } from '../server/engine/repo.mjs';
import { createMemory, memoryConfigFromEnv, scrubRemote } from '../server/memory.mjs';

// La memoria durable, probada contra un remoto de verdad pero sin red: un repo desnudo en
// disco hace de GitHub. Lo que se comprueba es lo único que importa: que el trabajo salga del
// disco antes de que el host lo borre y que vuelva entero cuando vuelva a arrancar.

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function bareRemote(t) {
  const root = tmp(t, 'polymind-memoria-');
  const remote = path.join(root, 'memoria.git');
  const made = spawnSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, 'no se pudo crear el remoto de prueba');
  return remote;
}

// El arranque real: un Hall con su memoria enganchada, como lo hace createAgora.
function withMemory(dataDir, remote) {
  const hall = new Hall(dataDir);
  const memory = createMemory({ dataDir, config: remote ? { remote } : null, logger: null });
  hall.onPersist = room => memory.touch(room);
  return { hall, memory };
}

// ---------------------------------------------------------------- configuración
test('la memoria se lee del entorno y el token no aparece en lo que se publica', () => {
  const cfg = memoryConfigFromEnv({ AGORA_MEMORY_REPO: 'Arx88/polymind-memoria', AGORA_MEMORY_TOKEN: 'ghp_secreto123' });
  assert.ok(cfg, 'con repositorio declarado, la memoria se activa');
  assert.match(cfg.remote, /x-access-token:/);
  assert.match(cfg.remote, /ghp_secreto123/);
  assert.equal(scrubRemote(cfg.remote), 'https://github.com/Arx88/polymind-memoria.git');
  assert.doesNotMatch(scrubRemote(cfg.remote), /ghp_secreto123/);
  assert.equal(cfg.branch, 'main');

  assert.equal(memoryConfigFromEnv({}), null);
  assert.equal(memoryConfigFromEnv({ AGORA_MEMORY: '0', AGORA_MEMORY_REPO: 'a/b' }), null);
  assert.equal(memoryConfigFromEnv({ AGORA_MEMORY_GIT: '/tmp/loquesea.git' }).remote, '/tmp/loquesea.git');
});

// ---------------------------------------------------------------- salas
test('una sala sale del disco antes de perderlo y vuelve entera al arrancar', async t => {
  const remote = bareRemote(t);
  const dataDir = tmp(t, 'polymind-datos-');
  const { hall, memory } = withMemory(dataDir, remote);

  const room = hall.create({ task: 'Una tarea que no debe desaparecer con el host' });
  const agente = joinRoom(room, { name: 'Buffy', harness: 'freebuff', model: 'test' });
  for (let i = 0; i < 5; i += 1) log(room, null, 'phase', `avance ${i}`);
  hall.persist(room);
  const esperado = progressOf(hall.get(room.code));

  const out = await memory.flush('prueba');
  assert.equal(out.ok, true, 'el volcado publica sin errores');

  // El remoto tiene la sala y su índice (la rama nace en el primer volcado).
  const refs = git(remote, '--git-dir', remote, 'show-ref');
  assert.match(refs.out, /refs\/heads\/main/);
  const tree = git(remote, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main');
  assert.match(tree.out, new RegExp(`rooms/${room.code}\.json`));
  assert.match(tree.out, /meta\.json/);

  // El host borra el disco entero (dormir, reiniciar, desplegar): no queda nada.
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dataDir), false);

  // Un arranque nuevo sobre el mismo remoto: la sala vuelve tal cual, con sus tokens.
  const arranque = withMemory(dataDir, remote);
  const hidratado = await arranque.memory.hydrate();
  assert.equal(hidratado.remote, true, 'el remoto se alcanza');
  assert.equal(hidratado.rooms, 1, 'se repone una sala');

  const back = arranque.hall.get(room.code);
  assert.ok(back, 'la sala existe otra vez');
  assert.equal(back.task, room.task);
  assert.equal(progressOf(back), esperado, 'vuelve con el mismo avance');
  assert.equal(back.agents[agente.agentId].token, agente.token, 'el token del agente sigue valiendo');
});

// Una copia atrasada no pisa lo que ya avanzó: el remoto repone, no retrocede.
test('la memoria no retrocede una sala más avanzada que la copia publicada', async t => {
  const remote = bareRemote(t);
  const dataDir = tmp(t, 'polymind-datos-');
  const { hall, memory } = withMemory(dataDir, remote);
  const room = hall.create({ task: 'Una sala que sigue avanzando después de publicarse' });
  hall.persist(room);
  await memory.flush('prueba');

  // Después del volcado, la sala local avanza más.
  for (let i = 0; i < 4; i += 1) log(room, null, 'phase', `después ${i}`);
  hall.persist(room);
  const avanzado = progressOf(hall.get(room.code));

  const otro = withMemory(dataDir, remote);
  await otro.memory.hydrate();
  assert.equal(progressOf(otro.hall.get(room.code)), avanzado, 'lo local no se pisa con lo publicado');
});

// ---------------------------------------------------------------- workspaces
test('el código de la sala vuelve con su rama y hasta el parche preparado sin comitear', async t => {
  const remote = bareRemote(t);
  const dataDir = tmp(t, 'polymind-datos-');
  const { hall, memory } = withMemory(dataDir, remote);

  const room = hall.create({ task: 'Una sala que escribe código en un proyecto nuevo' });
  const dir = workspaceDirFor(dataDir, room.code);
  fs.mkdirSync(dir, { recursive: true });
  assert.ok(git(dir, 'init', '-q').ok);
  git(dir, 'config', 'user.email', 'agora@local');
  git(dir, 'config', 'user.name', 'agora');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'hola.txt'), 'primera versión\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'primer commit');
  git(dir, 'checkout', '-q', '-b', `agora/${room.code}`);
  room.repo = {
    kind: 'scaffold',
    source: null,
    dir,
    branch: `agora/${room.code}`,
    head: git(dir, 'rev-parse', 'HEAD').out,
    files: 1,
  };
  hall.persist(room);

  // Un parche recién preparado: en el árbol, todavía sin comitear. Es lo que se perdería.
  fs.writeFileSync(path.join(dir, 'hola.txt'), 'primera versión\ncambio preparado\n');
  fs.writeFileSync(path.join(dir, 'nuevo.txt'), 'archivo nuevo\n');

  const out = await memory.flush('prueba');
  assert.equal(out.ok, true);
  assert.equal(out.workspaces, 1, 'la rama del workspace viaja');

  // El host borra el disco: la sala, el repo de trabajo y el espejo, todo.
  fs.rmSync(dataDir, { recursive: true, force: true });

  const arranque = withMemory(dataDir, remote);
  const hidratado = await arranque.memory.hydrate();
  assert.equal(hidratado.workspaces, 1, 'el workspace vuelve');

  const dir2 = workspaceDirFor(dataDir, room.code);
  assert.ok(fs.existsSync(path.join(dir2, '.git')), 'hay un repo otra vez');
  assert.equal(git(dir2, 'rev-parse', '--abbrev-ref', 'HEAD').out, `agora/${room.code}`, 'conserva la rama de la sala');
  const commit = git(dir2, 'log', '-1', '--format=%s');
  assert.equal(commit.out, 'primer commit', 'conserva el historial');
  assert.match(fs.readFileSync(path.join(dir2, 'hola.txt'), 'utf8'), /cambio preparado/, 'vuelve el cambio sin comitear');
  assert.ok(fs.existsSync(path.join(dir2, 'nuevo.txt')), 'vuelve también el archivo nuevo');
  // Y vuelve PREPARADO, no suelto: si había un parche esperando revisión, sigue esperándola.
  const preparado = git(dir2, 'diff', '--cached', '--name-only');
  assert.match(preparado.out, /hola\.txt/);
  assert.match(preparado.out, /nuevo\.txt/);

  const room2 = arranque.hall.get(room.code);
  assert.equal(room2.repo.dir, dir2, 'la sala apunta al árbol restaurado');
});

// ---------------------------------------------------------------- apagada
test('sin remoto declarado la memoria no toca nada', async t => {
  const dataDir = tmp(t, 'polymind-sin-memoria-');
  const { hall, memory } = withMemory(dataDir, null);
  assert.equal(memory.enabled, false);
  assert.equal(memory.status().enabled, false);

  hall.create({ task: 'Una sala normal, sin memoria configurada' });
  const out = await memory.flush('prueba');
  assert.equal(out.skipped, true, 'no hay nada que publicar');
  assert.equal(fs.existsSync(path.join(dataDir, '.memory')), false, 'no se crea ni la carpeta del espejo');
  await memory.hydrate();
  await memory.stop();
});
