// Polymind — memoria durable en un repositorio git.
//
// El registro cuenta QUÉ pasó; esto es lo que hace que el trabajo VUELVA. En un host efímero
// (el plan gratuito de Render, por ejemplo) dormir, reiniciar o desplegar borra el disco: las
// salas (`data/<code>.json`) y los repos que escriben los agentes desaparecen con él. El log
// queda, el trabajo no. Aquí el trabajo se guarda donde no se borra: un repo git (privado).
//
// Diseño, en una sola dirección y sin sorpresas:
//   · Espejo local (`data/.memory/mirror`): un clon del repo de memoria. Ahí se escriben las
//     salas y ahí llegan las ramas de trabajo; es rápido y no depende de la red.
//   · `flush()` = copiar las salas tocadas al espejo, empujar la rama de cada workspace
//     (`ws/<code>` con sus commits, `wip/<code>` con lo preparado sin comitear) y UN push al
//     remoto. Si la red falla, el espejo conserva el trabajo y se reintenta con espera creciente.
//   · `hydrate()` al arrancar = traer el remoto, reponer las salas que falten o estén atrasadas
//     y clonar los workspaces de las salas abiertas desde el espejo, con su rama y su wip.
//   · `forget(code)` = borrar un trabajo de verdad: si su copia siguiera publicada, volvería al
//     arrancar. Se lleva el JSON, su fila del índice y las dos ramas de trabajo, aquí y en el
//     remoto; si la red falla, queda pendiente y se reintenta como cualquier volcado.
//
// Nada de esto es obligatorio: sin `AGORA_MEMORY_REPO` ni `AGORA_MEMORY_GIT`, la app funciona
// exactamente como antes (disco local y ya). Y si el remoto no está, el espejo manda.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { log as registry } from './log.mjs';
import { workspaceDirFor } from './engine/repo.mjs';
import { progressOf } from './engine/state.mjs';

// ---------------------------------------------------------------- configuración
// Dos formas de decir dónde vive la memoria:
//   AGORA_MEMORY_REPO=usuario/repo  +  AGORA_MEMORY_TOKEN=…   (GitHub: se arma la URL)
//   AGORA_MEMORY_GIT=…                                        (cualquier URL o ruta, tal cual)
// Con `AGORA_MEMORY=0` se apaga aunque haya configuración.
export function memoryConfigFromEnv(env = process.env) {
  if (String(env.AGORA_MEMORY || '').trim() === '0') return null;
  const direct = String(env.AGORA_MEMORY_GIT || '').trim();
  const repo = String(env.AGORA_MEMORY_REPO || '').trim();
  const token = String(env.AGORA_MEMORY_TOKEN || '').trim();
  let remote = direct;
  if (!remote && repo) {
    const slug = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    remote = token
      ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${slug}.git`
      : `https://github.com/${slug}.git`;
  }
  if (!remote) return null;
  return {
    remote,
    branch: String(env.AGORA_MEMORY_BRANCH || 'main').trim() || 'main',
    flushMs: Math.max(1000, Number(env.AGORA_MEMORY_FLUSH_MS || 5000) || 5000),
  };
}

// La URL sin credenciales: es la única que se escribe en el registro.
export function scrubRemote(remote) {
  return String(remote || '').replace(/\/\/[^/@\s]+@/, '//');
}

function gitRun(args, { cwd, timeoutMs = 20_000, env = null } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    // Sin terminal no hay credenciales que pedir: si el remoto pide login, git falla
    // (y se dice) en vez de quedarse esperando detrás de una ventana.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...(env || {}) },
  });
  const out = [res.stdout || '', res.stderr || ''].filter(Boolean).join('\n').replace(/\r\n/g, '\n').trim();
  return { ok: res.status === 0, code: typeof res.status === 'number' ? res.status : -1, out, error: res.error || null };
}

export function gitUsable() {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return res.status === 0;
}

// ---------------------------------------------------------------- memoria
export function createMemory({
  dataDir,
  config = null,
  logger = registry,
  flushMs = 5000,
  networkTimeoutMs = 30_000,
} = {}) {
  const cfg = config && config.remote ? config : null;
  const enabled = !!cfg;
  const branch = cfg?.branch || 'main';
  const remote = cfg?.remote || null;
  const display = scrubRemote(remote);
  const flushEvery = Math.max(1000, cfg?.flushMs || flushMs || 5000);
  const mirrorDir = path.join(dataDir, '.memory', 'mirror');
  const roomsDir = path.join(mirrorDir, 'rooms');
  const metaFile = path.join(mirrorDir, 'meta.json');

  const say = (level, ev, data) => {
    try { logger?.[level]?.(ev, data); } catch { /* el registro nunca tumba la memoria */ }
  };

  const dirty = new Map();      // code -> true (cambios pendientes de copiar al espejo)
  const lastSeen = new Map();   // code -> { progress, status } (lo último que ya está en el espejo)
  const forgotten = new Map();  // code -> true (olvidos pendientes: el remoto todavía tiene la copia)
  const refreshed = new Set();  // codes cuyo workspace ya se empujó en este ciclo
  let chain = Promise.resolve();
  let timer = null;
  let closed = false;
  let hydrated = false;
  let pendingPush = false;      // hay commits locales sin publicar (la red falló)
  let failures = 0;
  let lastPushAt = 0;
  let lastError = null;
  let mirrorReady = false;

  const exists = p => { try { return fs.existsSync(p); } catch { return false; } };
  const roomFile = code => path.join(dataDir, String(code).toLowerCase() + '.json');
  const mirrorRoomFile = code => path.join(roomsDir, String(code).toLowerCase() + '.json');
  const workspaceOf = code => workspaceDirFor(dataDir, code);
  const isRepo = dir => exists(path.join(dir, '.git'));

  function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  function writeJSONAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  }

  // ------------------------------------------------------ espejo
  function ensureMirror() {
    if (mirrorReady && exists(path.join(mirrorDir, '.git'))) return true;
    if (!gitUsable()) throw Object.assign(new Error('git no está disponible'), { code: 'no_git' });
    if (!exists(path.join(mirrorDir, '.git'))) {
      fs.mkdirSync(path.dirname(mirrorDir), { recursive: true });
      fs.rmSync(mirrorDir, { recursive: true, force: true });
      const clone = gitRun(['clone', '--quiet', remote, mirrorDir], { timeoutMs: networkTimeoutMs });
      if (!clone.ok) {
        throw Object.assign(new Error(`no se pudo clonar la memoria (${display}): ${clone.out.slice(0, 300)}`), { code: 'memory_clone_failed' });
      }
      // El espejo guarda el remoto SIN credenciales: el token solo viaja en cada operación de red.
      gitRun(['remote', 'set-url', 'origin', display], { cwd: mirrorDir });
    }
    // Un repo recién nacido (sin commits) no tiene rama: la primera que se cree será la nuestra.
    const head = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: mirrorDir });
    if (!head.ok) gitRun(['checkout', '--quiet', '-b', branch], { cwd: mirrorDir });
    else if (head.out !== branch && gitRun(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: mirrorDir }).ok) {
      gitRun(['checkout', '--quiet', branch], { cwd: mirrorDir });
    } else if (head.out !== branch) {
      gitRun(['checkout', '--quiet', '-b', branch], { cwd: mirrorDir });
    }
    mirrorReady = true;
    return true;
  }

  // Trae lo que haya en el remoto sin pisar trabajo local sin publicar. Best effort: si no hay
  // red, se sigue con lo que hay en el espejo (que es la copia buena del último ciclo).
  function syncFromRemote() {
    if (pendingPush) {
      const up = gitRun(['push', '--quiet', remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: mirrorDir, timeoutMs: networkTimeoutMs });
      if (up.ok) pendingPush = false;
    }
    let reached = false;
    const fetch = gitRun(['fetch', '--quiet', remote, branch], { cwd: mirrorDir, timeoutMs: networkTimeoutMs });
    if (fetch.ok) {
      const merge = gitRun(['merge', '--ff-only', '--quiet', 'FETCH_HEAD'], { cwd: mirrorDir });
      if (merge.ok) reached = true;
      else {
        // Divergió: se intenta rebase (son JSON nuestros, el conflicto es improbable) y, si no,
        // manda lo local: el trabajo reciente vive aquí.
        const rebase = gitRun(['rebase', '--quiet', 'FETCH_HEAD'], { cwd: mirrorDir });
        if (!rebase.ok) gitRun(['rebase', '--abort'], { cwd: mirrorDir });
        reached = rebase.ok;
      }
    }
    // Las ramas de trabajo NO son ramas locales de un clon recién hecho (viven en
    // refs/remotes/origin): se traen a refs/heads para poder clonar de ellas sin salir del
    // espejo. Sin esto, el workspace no vuelve nunca en una instancia nueva.
    gitRun([
      'fetch', '--quiet', '--force', remote,
      '+refs/heads/ws/*:refs/heads/ws/*',
      '+refs/heads/wip/*:refs/heads/wip/*',
    ], { cwd: mirrorDir, timeoutMs: networkTimeoutMs });
    if (!reached) {
      // Un remoto recién creado no tiene ramas que traer: si contesta, contesta. Decir «sin
      // respuesta» cuando el repo está vacío sería mentir en la primera línea del registro.
      reached = gitRun(['ls-remote', '--heads', remote], { cwd: mirrorDir, timeoutMs: networkTimeoutMs }).ok;
    }
    return reached;
  }

  // ------------------------------------------------------ salas
  function copyRoomsToMirror(codes) {
    const written = [];
    for (const code of codes) {
      const src = roomFile(code);
      if (!exists(src)) continue;
      const dest = mirrorRoomFile(code);
      try {
        fs.mkdirSync(roomsDir, { recursive: true });
        fs.copyFileSync(src, dest);
        written.push(code);
      } catch (err) {
        say('warn', 'memory.room_write_failed', { room: code, error: err?.code || err?.message });
      }
    }
    return written;
  }

  function updateMeta(codes) {
    const meta = readJSON(metaFile) || { schema: 1, rooms: {} };
    meta.schema = 1;
    meta.updatedAt = Date.now();
    meta.rooms = meta.rooms || {};
    for (const code of codes) {
      const room = readJSON(mirrorRoomFile(code));
      if (!room) continue;
      const work = room.work || null;
      meta.rooms[code] = {
        title: room.title || null,
        status: room.status || null,
        phase: room.status === 'closed' ? 'closed' : (room.phase?.name || null),
        progress: progressOf(room),
        outcome: room.result?.outcome || null,
        checksum: room.result?.checksum || null,
        agents: Object.keys(room.agents || {}).length,
        hasRepo: !!room.repo,
        workItems: work ? (work.order || []).length : 0,
        workIntegrated: work ? (work.order || []).filter(id => work.items?.[id]?.status === 'integrated').length : 0,
        createdAt: room.createdAt || null,
        updatedAt: Date.now(),
      };
    }
    try { writeJSONAtomic(metaFile, meta); } catch (err) {
      say('warn', 'memory.meta_write_failed', { error: err?.code || err?.message });
    }
  }

  function commitMirror(message) {
    const paths = ['rooms'];
    if (exists(metaFile)) paths.push('meta.json');
    gitRun(['add', '-A', '--', ...paths], { cwd: mirrorDir });
    const staged = gitRun(['diff', '--cached', '--quiet'], { cwd: mirrorDir });
    if (staged.ok) return null; // nada nuevo: el espejo ya tenía esta versión
    const res = gitRun([
      '-c', 'user.name=Polymind', '-c', 'user.email=memoria@polymind.local',
      'commit', '--quiet', '--no-gpg-sign', '-m', message,
    ], { cwd: mirrorDir });
    if (!res.ok) {
      say('warn', 'memory.commit_failed', { error: res.out.slice(0, 300) });
      return null;
    }
    return gitRun(['rev-parse', '--short', 'HEAD'], { cwd: mirrorDir }).out || null;
  }

  function commitSnapshot(codes, reason) {
    if (!codes.length) return null;
    const list = codes.slice(0, 8).join(', ') + (codes.length > 8 ? ` +${codes.length - 8}` : '');
    const msg = `memoria: ${codes.length} sala${codes.length === 1 ? '' : 's'} (${list})${reason ? ` · ${reason}` : ''}`;
    return commitMirror(msg);
  }

  // ------------------------------------------------------ workspaces
  // El trabajo de una sala viaja como rama de git dentro del espejo:
  //   ws/<code>   los commits (lo integrado)
  //   wip/<code>  el corte de lo que está preparado o a medias (parche staged, sin comitear)
  // Si el árbol está limpio, la wip se borra: una wip vieja resucitaría cambios ya integrados.
  function pushWorkspace(code) {
    const dir = workspaceOf(code);
    if (!isRepo(dir)) return null;
    const head = gitRun(['rev-parse', 'HEAD'], { cwd: dir });
    if (!head.ok) return null;
    const refs = [];
    const deleted = [];
    const pushed = gitRun(['push', '--quiet', mirrorDir, `${head.out}:refs/heads/ws/${code}`], { cwd: dir });
    if (pushed.ok) refs.push(`ws/${code}`);
    const wipSha = snapshotWorkspace(dir, code);
    if (wipSha) {
      const w = gitRun(['push', '--quiet', mirrorDir, `${wipSha}:refs/heads/wip/${code}`], { cwd: dir });
      if (w.ok) refs.push(`wip/${code}`);
    } else if (gitRun(['rev-parse', '--verify', `refs/heads/wip/${code}`], { cwd: mirrorDir }).ok) {
      gitRun(['push', '--quiet', mirrorDir, `:refs/heads/wip/${code}`], { cwd: dir });
      deleted.push(`wip/${code}`);
    }
    refreshed.add(code);
    return { code, refs, deleted };
  }

  // El corte de lo que no está comiteado, con TODO lo que hay en el árbol: lo preparado en el
  // índice (un parche esperando revisión) y los archivos nuevos sin seguimiento. Se hace con un
  // índice temporal para no tocar el de verdad — la sala no debe notar que se la está copiando.
  // Devuelve el commit del corte, o null si el árbol está limpio (entonces no hay nada que guardar).
  function snapshotWorkspace(dir, code) {
    const tmpIndex = path.join(os.tmpdir(), `polymind-wip-${code}-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      if (!gitRun(['read-tree', 'HEAD'], { cwd: dir, env }).ok) return null;
      if (!gitRun(['add', '-A'], { cwd: dir, env }).ok) return null;
      const tree = gitRun(['write-tree'], { cwd: dir, env });
      if (!tree.ok || !tree.out) return null;
      const head = gitRun(['rev-parse', 'HEAD^{tree}'], { cwd: dir });
      if (head.ok && head.out === tree.out) return null; // nada cambió: no hay corte que guardar
      const commit = gitRun([
        '-c', 'user.name=Polymind', '-c', 'user.email=memoria@polymind.local',
        'commit-tree', tree.out, '-p', 'HEAD', '-m', `corte de trabajo ${code}`,
      ], { cwd: dir });
      return commit.ok ? commit.out : null;
    } finally {
      try { fs.rmSync(tmpIndex, { force: true }); } catch { /* el temporal se va con el proceso */ }
    }
  }

  function pushToRemote({ committed = false, ws = [] } = {}) {
    if (!enabled) return false;
    const specs = [];
    if (committed || pendingPush) specs.push(`refs/heads/${branch}:refs/heads/${branch}`);
    for (const entry of ws) {
      for (const ref of entry.refs) specs.push(`refs/heads/${ref}:refs/heads/${ref}`);
      for (const ref of entry.deleted) specs.push(`:refs/heads/${ref}`);
    }
    if (!specs.length) return true;
    const res = gitRun(['push', '--quiet', remote, ...specs], { cwd: mirrorDir, timeoutMs: networkTimeoutMs });
    if (!res.ok) {
      pendingPush = true;
      lastError = res.out.slice(0, 300) || `código ${res.code}`;
      say('warn', 'memory.push_failed', { repo: display, error: lastError });
      return false;
    }
    pendingPush = false;
    lastPushAt = Date.now();
    lastError = null;
    return true;
  }

  // ------------------------------------------------------ olvido
  // Borrar un trabajo tiene que borrar también su memoria. Si la copia siguiera en el espejo o
  // en el remoto, el siguiente arranque la resucitaría: `adoptRooms` repone en disco todo lo que
  // falte y el repo de trabajo volvería de su rama. El olvido es: fuera el JSON, fuera su fila
  // del índice y fuera sus dos ramas de trabajo, aquí y allá. Si la red falla, queda pendiente y
  // se reintenta como cualquier volcado: un olvido a medias solo se nota al reiniciar.
  const workRefs = code => [`ws/${code}`, `wip/${code}`];

  function dropRoomFromMeta(code) {
    const meta = readJSON(metaFile);
    if (!meta?.rooms || !(code in meta.rooms)) return;
    delete meta.rooms[code];
    meta.updatedAt = Date.now();
    try { writeJSONAtomic(metaFile, meta); } catch (err) {
      say('warn', 'memory.meta_write_failed', { error: err?.code || err?.message });
    }
  }

  // Qué ramas de esta sala existen de verdad en el remoto: borrar una que no está hace fallar
  // el push entero, y el olvido se quedaría a medias para siempre. `null` = no se pudo preguntar
  // (sin red): se reintenta, no se decide.
  function remoteWorkRefs(code) {
    const res = gitRun(['ls-remote', '--heads', remote, `refs/heads/ws/${code}`, `refs/heads/wip/${code}`], { cwd: mirrorDir, timeoutMs: networkTimeoutMs });
    if (!res.ok) return null;
    const found = new Set();
    for (const line of res.out.split('\n')) {
      const ref = line.split('\t')[1]?.trim();
      if (ref?.startsWith('refs/heads/')) found.add(ref.slice('refs/heads/'.length));
    }
    return found;
  }

  async function forgetOnce(code) {
    if (!enabled) return { ok: true, skipped: true };
    code = String(code).toLowerCase();
    const t0 = Date.now();
    dirty.delete(code);
    lastSeen.delete(code);
    forgotten.set(code, true); // pendiente hasta que el remoto lo sepa
    try { ensureMirror(); } catch (err) {
      lastError = err?.message || String(err);
      say('warn', 'memory.forget_deferred', { room: code, error: lastError });
      schedule(5000);
      return { ok: false, error: lastError };
    }
    // Aquí, ya: el espejo es local y es lo que lee el próximo arranque de este host.
    fs.rmSync(mirrorRoomFile(code), { force: true });
    dropRoomFromMeta(code);
    for (const ref of workRefs(code)) gitRun(['update-ref', '-d', `refs/heads/${ref}`], { cwd: mirrorDir });
    const commit = commitMirror(`memoria: olvida la sala ${code}`);
    const alive = remoteWorkRefs(code);
    if (alive === null) {
      const wait = Math.min(60_000, 3000 * 2 ** Math.min(failures, 5));
      failures += 1;
      lastError = 'sin respuesta del remoto al olvidar';
      say('warn', 'memory.forget_deferred', { room: code, error: lastError, retryMs: wait });
      schedule(wait);
      return { ok: false, error: lastError };
    }
    const specs = [
      ...(commit ? [`refs/heads/${branch}:refs/heads/${branch}`] : []),
      ...[...alive].map(ref => `:refs/heads/${ref}`),
    ];
    const pushed = specs.length
      ? gitRun(['push', '--quiet', remote, ...specs], { cwd: mirrorDir, timeoutMs: networkTimeoutMs })
      : { ok: true, out: '', code: 0 };
    if (!pushed.ok) {
      pendingPush = true;
      lastError = pushed.out.slice(0, 300) || `código ${pushed.code}`;
      const wait = Math.min(60_000, 3000 * 2 ** Math.min(failures, 5));
      failures += 1;
      say('warn', 'memory.push_failed', { repo: display, error: lastError, retryMs: wait });
      schedule(wait);
      return { ok: false, error: lastError };
    }
    if (commit) pendingPush = false;
    forgotten.delete(code);
    failures = 0;
    lastError = null;
    lastPushAt = Date.now();
    say('info', 'memory.forget', { repo: display, room: code, refs: alive.size, commit: commit || null, ms: Date.now() - t0 });
    return { ok: true, room: code, refs: alive.size, commit };
  }

  // ------------------------------------------------------ flush
  async function flushOnce(reason) {
    if (!enabled || closed) return { ok: false, skipped: true };
    const batch = [...dirty.keys()];
    dirty.clear();
    const forgetting = [...forgotten.keys()];
    if (!batch.length && !pendingPush && !forgetting.length) return { ok: true, changed: 0 };
    const t0 = Date.now();
    try {
      ensureMirror();
    } catch (err) {
      for (const code of batch) dirty.set(code, true);
      const wait = Math.min(60_000, 3000 * 2 ** Math.min(failures, 5));
      failures += 1;
      lastError = err?.message || String(err);
      say('warn', 'memory.mirror_failed', { repo: display, error: lastError, retryMs: wait });
      schedule(wait);
      return { ok: false, error: lastError };
    }
    const codes = copyRoomsToMirror(batch);
    if (codes.length) updateMeta(codes);
    const ws = [];
    for (const code of batch) {
      const entry = pushWorkspace(code);
      if (entry) ws.push(entry);
    }
    const commit = commitSnapshot(codes, reason);
    const pushed = pushToRemote({ committed: !!commit, ws });
    // Olvidos pendientes: se reintentan con el mismo ciclo (y en el mismo push cuando se puede).
    let forgottenDone = 0;
    for (const code of [...forgotten.keys()]) {
      const out = await forgetOnce(code);
      if (out.ok) forgottenDone += 1;
    }
    const summary = { ok: pushed, changed: codes.length, workspaces: ws.length, forgotten: forgottenDone, commit, ms: Date.now() - t0 };
    if (pushed) {
      failures = 0;
      lastError = null;
      say('info', 'memory.flush', { repo: display, rooms: codes.length, workspaces: ws.length, commit: commit || null, ms: summary.ms, reason: reason || null });
    } else {
      const wait = Math.min(60_000, 3000 * 2 ** Math.min(failures, 5));
      failures += 1;
      schedule(wait);
    }
    return summary;
  }

  function schedule(ms = flushEvery) {
    if (!enabled || closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      enqueue(() => flushOnce('auto'));
    }, Math.max(250, ms));
    timer.unref?.();
  }

  function enqueue(task) {
    // La cadena nunca se rompe: una operación fallida se registra y la siguiente sigue. Si no,
    // un push caído dejaría la memoria muda para siempre.
    const next = chain.then(() => task()).catch(err => {
      say('warn', 'memory.task_failed', { error: err?.message || String(err) });
      return { ok: false, error: err?.message || String(err) };
    });
    chain = next;
    return next;
  }

  // Lo llama el guardián del Hall tras CADA guardado en disco. Solo marca cuando de verdad
  // avanzó algo (latidos y lecturas no cuentan) y fuerza el volcado cuando la sala se cierra.
  function touch(room) {
    if (!enabled || closed || !room?.code) return;
    const code = String(room.code).toLowerCase();
    const progress = progressOf(room);
    const known = lastSeen.get(code);
    const status = room.status || 'open';
    if (known && progress <= known.progress && known.status === status) return;
    const wasClosed = known?.status === 'closed';
    lastSeen.set(code, { progress, status });
    dirty.set(code, true);
    if (status === 'closed' && !wasClosed) enqueue(() => flushOnce('cierre'));
    else schedule();
  }

  // ------------------------------------------------------ hidratación
  function adoptRooms() {
    if (!exists(roomsDir)) return { rooms: 0, codes: [] };
    let files = [];
    try { files = fs.readdirSync(roomsDir).filter(f => /^[a-z0-9]{4,12}\.json$/i.test(f)); } catch { return { rooms: 0, codes: [] }; }
    const adopted = [];
    for (const file of files) {
      const code = file.slice(0, -5).toLowerCase();
      const remoteRoom = readJSON(path.join(roomsDir, file));
      if (!remoteRoom) continue;
      const local = readJSON(roomFile(code));
      if (local && progressOf(local) >= progressOf(remoteRoom)) continue; // lo de aquí ya es igual o mejor
      try {
        fs.copyFileSync(path.join(roomsDir, file), roomFile(code));
        adopted.push(code);
      } catch (err) {
        say('warn', 'memory.adopt_failed', { room: code, error: err?.code || err?.message });
      }
    }
    return { rooms: adopted.length, codes: adopted };
  }

  // Deja el workspace como estaba: su rama, su política de fin de línea y su corte a medias.
  function restoreWorkspace(room) {
    const code = String(room.code).toLowerCase();
    const dir = workspaceOf(code);
    if (isRepo(dir)) return false; // el disco sobrevivió: no se toca
    if (!gitRun(['rev-parse', '--verify', `refs/heads/ws/${code}`], { cwd: mirrorDir }).ok) return false;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    const clone = gitRun(['clone', '--quiet', '--single-branch', '--branch', `ws/${code}`, '--', mirrorDir, dir], { timeoutMs: 60_000 });
    if (!clone.ok) {
      say('warn', 'memory.workspace_restore_failed', { room: code, error: clone.out.slice(0, 300) });
      return false;
    }
    gitRun(['config', 'core.autocrlf', 'false'], { cwd: dir });
    gitRun(['config', 'core.eol', 'lf'], { cwd: dir });
    gitRun(['config', 'core.safecrlf', 'false'], { cwd: dir });
    const target = room.repo?.branch || `agora/${code}`;
    gitRun(['branch', '-m', target], { cwd: dir });
    // El corte a medias (parche preparado, sin comitear) vuelve al árbol de trabajo: es lo que
    // la revisión estaba mirando cuando el host se durmió.
    let appliedWip = false;
    const fetchWip = gitRun(['fetch', '--quiet', mirrorDir, `refs/heads/wip/${code}`], { cwd: dir });
    if (fetchWip.ok) {
      const tree = gitRun(['rev-parse', 'FETCH_HEAD^{tree}'], { cwd: dir });
      // El corte vuelve tal cual estaba: el árbol Y lo preparado en el índice (un parche
      // esperando revisión sigue esperándola, no se convierte en un cambio suelto).
      if (tree.ok && gitRun(['read-tree', '--reset', '-u', tree.out], { cwd: dir }).ok) {
        appliedWip = true;
      }
    }
    // La sala vuelve a apuntar a su árbol, con los números del clon restaurado.
    const head = gitRun(['rev-parse', 'HEAD'], { cwd: dir }).out;
    const files = gitRun(['ls-files'], { cwd: dir }).out.split('\n').filter(Boolean).length;
    const room2 = readJSON(roomFile(code));
    if (room2?.repo) {
      room2.repo = { ...room2.repo, dir, head: head || room2.repo.head, files };
      try { writeJSONAtomic(roomFile(code), room2); } catch { /* se reintenta en el próximo guardado */ }
    }
    say('info', 'memory.workspace_restored', { room: code, branch: target, wip: appliedWip, files });
    return true;
  }

  async function hydrateOnce() {
    if (!enabled || hydrated) return { ok: false, skipped: true };
    const t0 = Date.now();
    try {
      ensureMirror();
    } catch (err) {
      lastError = err?.message || String(err);
      say('warn', 'memory.hydrate_failed', { repo: display, error: lastError });
      return { ok: false, error: lastError };
    }
    const remoteReached = syncFromRemote();
    const { rooms: adoptedCount } = adoptRooms();
    // Workspaces: solo de las salas que pueden seguir trabajando (las cerradas ya no se
    // reabren; el código sigue en el espejo, en la rama de la sala, por si el panel lo mira).
    const onDisk = [];
    try {
      for (const f of fs.readdirSync(dataDir)) {
        if (!/^[a-z0-9]{4,12}\.json$/i.test(f)) continue;
        const room = readJSON(path.join(dataDir, f));
        if (room) onDisk.push(room);
      }
    } catch { /* directorio vacío */ }
    let workspaces = 0;
    for (const room of onDisk) {
      if (!room.repo) continue;
      const code = String(room.code).toLowerCase();
      const dir = workspaceOf(code);
      // El árbol vive donde vive ESTE servidor: si el host cambió de ruta (local y nube), la
      // sala apunta al de aquí. Sin esto, el motor buscaría un directorio que ya no existe.
      if (room.repo.dir !== dir) {
        room.repo = { ...room.repo, dir };
        try { writeJSONAtomic(roomFile(code), room); } catch { /* se reintenta en el próximo guardado */ }
      }
      if (room.status === 'closed') continue;
      try { if (restoreWorkspace(room)) workspaces += 1; } catch (err) {
        say('warn', 'memory.workspace_restore_failed', { room: code, error: err?.message });
      }
    }
    hydrated = true;
    // Punto de partida: lo que ya está en el espejo no se vuelve a volcar por existir.
    lastSeen.clear();
    for (const room of onDisk) lastSeen.set(String(room.code).toLowerCase(), { progress: progressOf(room), status: room.status || 'open' });
    const summary = { ok: remoteReached, rooms: adoptedCount, workspaces, remote: remoteReached, ms: Date.now() - t0 };
    say('info', 'memory.hydrate', { repo: display, roomsOnDisk: onDisk.length, roomsAdopted: adoptedCount, workspaces, remoteReached, ms: summary.ms });
    return summary;
  }

  // ------------------------------------------------------ API
  return {
    enabled,
    repo: display,
    branch,
    touch,
    hydrate: () => enqueue(() => hydrateOnce()),
    flush: (reason = 'manual') => enqueue(() => flushOnce(reason)),
    // Olvidar un trabajo borrado: sin esto, su copia publicada lo traería de vuelta al arrancar.
    forget: code => enqueue(() => forgetOnce(code)),
    status: () => ({
      enabled,
      repo: display,
      branch,
      hydrated,
      dirty: dirty.size,
      forgotten: forgotten.size,
      pendingPush,
      lastPushAt: lastPushAt || null,
      lastError,
    }),
    stop: async () => {
      if (closed) return;
      if (timer) clearTimeout(timer);
      timer = null;
      if (enabled && (dirty.size || forgotten.size || pendingPush)) await enqueue(() => flushOnce('parada')).catch(() => null);
      closed = true;
    },
  };
}
