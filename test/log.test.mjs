// AGORA v2 — pruebas del registro operativo (server/log.mjs).
//
// Lo que se protege aquí: que el registro diga lo que pasó, que no filtre secretos y que no
// pueda tumbar al servidor. Un log que miente o que publica un token es peor que no tenerlo.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger, redact, runtimeInfo, levelValue, LEVELS } from '../server/log.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-log-'));

// Un destino de mentira que guarda las líneas en memoria: así se prueba la salida sin tocar
// stdout (que en las pruebas es el del propio runner).
function fakeStdout() {
  const lines = [];
  return {
    lines,
    write: chunk => { lines.push(String(chunk)); return true; },
    parsed: () => lines.map(l => JSON.parse(l)),
  };
}

test('cada evento es una línea JSON con marca de tiempo, nivel y nombre', () => {
  const out = fakeStdout();
  const log = createLogger({ level: 'debug', stdout: out });
  log.info('room.create', { room: 'abc123' });

  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].endsWith('\n'), true, 'una línea por evento: sin esto, un log deja de ser legible por máquina');
  const [ev] = out.parsed();
  assert.equal(ev.ev, 'room.create');
  assert.equal(ev.level, 'info');
  assert.equal(ev.room, 'abc123');
  assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('el nivel filtra sin perder lo grave: warn no se calla aunque el umbral sea error', () => {
  const out = fakeStdout();
  const log = createLogger({ level: 'warn', stdout: out });
  log.debug('ruido', { a: 1 });
  log.info('tambien ruido', { a: 2 });
  log.warn('esto sí', { a: 3 });
  log.error('esto también', { a: 4 });

  const evs = out.parsed().map(e => e.ev);
  assert.deepEqual(evs, ['esto sí', 'esto también']);
  assert.equal(levelValue('info'), LEVELS.info);
  assert.equal(levelValue('nivel-inventado'), LEVELS.info, 'un nivel inválido cae al prudente, no a «todo»');
});

test('los secretos se tachan antes de escribirse, también dentro de una URL', () => {
  const masked = redact({
    token: 'abcdef123456',
    adminToken: 'Zx9QwErTyUiO',
    authorization: 'Bearer xyz',
    agent: 'a1',
    url: 'https://host/api/rooms/abc/turn?agent=a1&token=abcdef123456&wait=30',
    nested: { password: 'secreto', ok: true },
  });
  assert.equal(masked.token, '***3456');
  assert.equal(masked.adminToken, '***yUiO');
  assert.equal(masked.agent, 'a1');
  assert.equal(masked.url.includes('abcdef123456'), false, 'un token en una query no puede llegar al registro');
  assert.equal(masked.url.includes('wait=30'), true, 'lo que no es secreto se conserva entero');
  assert.equal(masked.nested.password, '***reto');
  assert.equal(masked.nested.ok, true);
});

test('lo que no cabe se recorta: el registro no es el sitio de un plan entero', () => {
  const long = 'x'.repeat(1200);
  const out = redact({ plan: long, items: Array.from({ length: 30 }, (_, i) => i) });
  assert.ok(out.plan.length < 500, `recortado: ${out.plan.length}`);
  assert.match(out.plan, /\+800\)$/);
  assert.equal(out.items.length, 13, '12 elementos y la nota de cuántos se omitieron');
});

test('el anillo en memoria guarda lo último y respeta el filtro de lectura', () => {
  const out = fakeStdout();
  const log = createLogger({ level: 'debug', stdout: out, memory: 10 });
  for (let i = 0; i < 25; i += 1) log.info('room.tick', { room: i % 2 ? 'aaa111' : 'bbb222', i });
  log.error('room.fallo', { room: 'bbb222' });

  const stats = log.stats();
  assert.equal(stats.capacity, 10);
  assert.equal(stats.buffered, 10);
  assert.equal(stats.written, 26);
  assert.equal(stats.dropped, 16);

  const recent = log.recent({ limit: 3 });
  assert.equal(recent[0].ev, 'room.fallo', 'lo más reciente primero');
  assert.equal(log.recent({ level: 'error' }).length, 1);
  assert.equal(log.recent({ room: 'aaa111' }).every(e => e.room === 'aaa111'), true);
  assert.equal(log.recent({ ev: 'room.tick' }).length, 9);
});

test('el registro tampoco puede tumbar al servidor: errores, ciclos y basura', () => {
  const out = fakeStdout();
  const log = createLogger({ level: 'debug', stdout: out });
  const ciclo = { nombre: 'sala' };
  ciclo.yo = ciclo;
  log.info('raro', { error: new Error('se rompió'), ciclo, fn: () => 1, nulo: null });

  const [ev] = out.parsed();
  assert.equal(ev.error.message, 'se rompió');
  assert.equal(ev.ciclo.yo, '[circular]');
  assert.equal(ev.nulo, null);

  // Un stdout que revienta no puede propagar la excepción al que registra.
  const roto = createLogger({ stdout: { write: () => { throw new Error('cerrado'); } } });
  assert.doesNotThrow(() => roto.info('con stdout roto'));
});

test('con AGORA_LOG_FILE el registro también queda en disco', () => {
  const file = path.join(TMP, 'polymind.jsonl');
  const out = fakeStdout();
  const log = createLogger({ level: 'info', stdout: out, file });
  log.info('server.boot', { port: 8790 });
  log.close();

  const written = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(written.length, 1);
  assert.equal(written[0].ev, 'server.boot');
  assert.equal(written[0].port, 8790);
});

test('en Render el arranque dice qué instancia y qué commit es', () => {
  const antes = { ...process.env };
  process.env.RENDER = 'true';
  process.env.RENDER_SERVICE_ID = 'srv-123';
  process.env.RENDER_INSTANCE_ID = 'srv-123-abcde';
  process.env.RENDER_GIT_COMMIT = '7baf6e0375d0e34e2c82fc703f59716ed47c3fa3';
  process.env.RENDER_GIT_BRANCH = 'master';

  const info = runtimeInfo();
  assert.equal(info.host, 'render');
  assert.equal(info.commit, '7baf6e03');
  assert.equal(info.instanceId, 'srv-123-abcde');

  for (const k of ['RENDER', 'RENDER_SERVICE_ID', 'RENDER_INSTANCE_ID', 'RENDER_GIT_COMMIT', 'RENDER_GIT_BRANCH']) delete process.env[k];
  Object.assign(process.env, antes);
});
