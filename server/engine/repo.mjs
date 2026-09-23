// AGORA v2 — repositorio de trabajo.
//
// Aquí vive TODO lo que toca el disco: clonar, leer, buscar, aplicar parches,
// commitear y ejecutar el comando de verificación. Reglas de diseño:
//
//  · El repo del usuario nunca se toca: se clona en data/workspaces/<sala>/repo
//    y se trabaja en una rama propia `agora/<sala>`.
//  · Los agentes no ejecutan nada. El único comando que corre es el que declaró
//    el humano al crear la sala, con timeout y salida acotada, y corre en
//    segundo plano para no bloquear el servidor.
//  · Los parches solo pueden tocar rutas dentro del clon; `..`, rutas absolutas
//    y `.git` se rechazan antes de llamar a git.
//
// Git se usa de forma síncrona (los movimientos del motor son síncronos y cada
// llamada dura milisegundos); lo único asíncrono es clonar y verificar.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { gist } from './util.mjs';
import { CAPS } from './settings.mjs';
import { log } from './state.mjs';
import { recordEvidence } from './ledger.mjs';

// Techos de seguridad de la capa de repo. Igual que en el resto del motor: están puestos
// para que el servidor no se ahogue, no para racionar información. Leer un archivo entero,
// ver la lista completa de ficheros o recibir la salida larga de una suite son cosas que un
// harness pide porque las necesita; cortarlas solo le cuesta un viaje extra y contexto.
export const REPO_LIMITS = {
  cloneTimeoutMs: 180_000,
  gitTimeoutMs: 60_000,
  pushTimeoutMs: 120_000,
  fileMaxBytes: 8_000_000,
  indexMaxFiles: 20_000,
  searchMaxMatches: 300,
  outputChars: 60_000,
  verifyOutputChars: 40_000,
};

// ---------------------------------------------------------------- procesos
export function execProcess({ file, args = [], cwd, timeoutMs = REPO_LIMITS.gitTimeoutMs, shell = false, env = null, maxChars = REPO_LIMITS.outputChars }) {
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        shell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...(env || {}) },
      });
    } catch (err) {
      resolve({ code: -1, output: String(err?.message || err), timedOut: false, durationMs: 0 });
      return;
    }
    let out = '', err = '', timedOut = false;
    const push = (acc, chunk) => (acc.length > maxChars * 3 ? acc : acc + chunk);
    child.stdout?.on('data', c => { out = push(out, String(c)); });
    child.stderr?.on('data', c => { err = push(err, String(c)); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, output: String(e?.message || e), timedOut, durationMs: Date.now() - started }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : (typeof code === 'number' ? code : -1),
        output: clip([out, err].filter(Boolean).join('\n'), maxChars),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

// En Windows `child.kill` deja vivos a los nietos (npm → node → …). taskkill /T
// los mata a todos; en POSIX se mata el grupo de procesos.
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* el proceso ya murió */ }
}

// Conserva el principio (el resumen) y el final (los fallos) de una salida larga.
export function clip(text, maxChars = REPO_LIMITS.outputChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head - 40;
  return `${s.slice(0, head)}\n\n… [${s.length - maxChars} caracteres omitidos] …\n\n${s.slice(-tail)}`;
}

export function git(repo, args, { timeoutMs = REPO_LIMITS.gitTimeoutMs, maxChars = REPO_LIMITS.outputChars } = {}) {
  const res = spawnSync('git', args, {
    cwd: repo.dir,
    timeout: timeoutMs,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // Windows devuelve CRLF: sin normalizar, cualquier regex anclada al final de
  // línea (`archivo:línea:texto$`) fallaría y la búsqueda saldría vacía.
  const raw = [res.stdout || '', res.stderr || ''].filter(Boolean).join('\n').replace(/\r\n/g, '\n');
  const output = clip(raw, maxChars);
  return { code: typeof res.status === 'number' ? res.status : -1, output, ok: res.status === 0 };
}

function gitOk(repo, args, opts = {}) {
  const res = git(repo, args, opts);
  if (!res.ok) throw Object.assign(new Error(`git ${args.slice(0, 2).join(' ')}: ${res.output.slice(0, 400)}`), { code: 'git_failed' });
  return res.output;
}

export function gitAvailable() {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
  return res.status === 0;
}

// ---------------------------------------------------------------- origen
// En Windows media docena de herramientas (git bash, MSYS, Cygwin) escriben la ruta
// como `/c/Users/…`, y node no la resuelve: existiría un `ENOENT` con una ruta que el
// usuario ve correcta en su terminal. Se traduce al formato de Windows antes de
// comprobar nada. Fuera de Windows la ruta se deja intacta.
export function normalizeRepoPath(value, platform = process.platform) {
  const raw = String(value || '').trim();
  if (platform !== 'win32') return raw;
  const msys = raw.match(/^\/(?:cygdrive\/)?([a-zA-Z])\/(.*)$/);
  return msys ? `${msys[1].toUpperCase()}:/${msys[2]}` : raw;
}

// Acepta una ruta local o una URL de git. Devuelve {kind, value} o null.
export function resolveRepoSource(raw) {
  if (raw && typeof raw === 'object') {
    const value = normalizeRepoPath(raw.path || raw.url || raw.source || raw.value || '');
    if (!value) return null;
    return { kind: raw.kind === 'url' || (raw.kind !== 'path' && looksLikeUrl(value)) ? 'url' : 'path', value };
  }
  const value = normalizeRepoPath(raw);
  if (!value) return null;
  return { kind: looksLikeUrl(value) ? 'url' : 'path', value };
}

export function looksLikeUrl(value) {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i.test(String(value || ''));
}

export function workspaceDirFor(dataDir, code) {
  return path.join(dataDir, 'workspaces', String(code).toLowerCase(), 'repo');
}

// ---------------------------------------------------------------- adjuntar
// Sin comando de verificación declarado, los parches se integraban sin que nada los
// comprobara: «otro agente revisa, el servidor verifica» quedaba en la mitad de la frase.
// Si el proyecto trae su propia forma de comprobarse, se usa esa (y se dice de dónde sale).
export function detectVerifyCommand(dir) {
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  const pkg = read('package.json');
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      const test = parsed?.scripts?.test;
      // El «Error: no test specified» de npm init no es una verificación.
      if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) {
        return { command: 'npm test', why: 'package.json → scripts.test' };
      }
    } catch { /* package.json ilegible: se sigue buscando */ }
  }
  if (read('pyproject.toml') || read('pytest.ini') || read('tox.ini')) {
    return { command: 'python -m pytest -q', why: 'configuración de pytest' };
  }
  if (read('go.mod')) return { command: 'go test ./...', why: 'go.mod' };
  if (read('Cargo.toml')) return { command: 'cargo test -q', why: 'Cargo.toml' };
  const make = read('Makefile');
  if (make && /^test:/m.test(make)) return { command: 'make test', why: 'Makefile → test' };
  const entries = (() => { try { return fs.readdirSync(dir); } catch { return []; } })();
  if (entries.includes('check.mjs') && /"check"/.test(pkg || '')) return { command: 'node check.mjs', why: 'scripts.check del proyecto' };
  if (entries.includes('tests') || entries.includes('test')) {
    const tests = (() => { try { return fs.readdirSync(path.join(dir, entries.includes('tests') ? 'tests' : 'test')); } catch { return []; } })();
    if (tests.some(f => /check\.mjs$/.test(f))) return { command: `node ${entries.includes('tests') ? 'tests' : 'test'}/check.mjs`, why: 'la comprobación del proyecto' };
  }
  return null;
}

export async function attachRepo(room, { dataDir, source, ref = null, verify = null, verifyTimeoutMs = null, baseline = true, pushTo = null }) {
  const src = resolveRepoSource(source);
  if (!src) throw Object.assign(new Error('repo: indica una ruta local o una URL de git'), { code: 'bad_repo' });
  if (src.kind === 'path' && !fs.existsSync(src.value)) {
    throw Object.assign(new Error(`repo: la ruta no existe → ${src.value}`), { code: 'bad_repo' });
  }
  if (!gitAvailable()) {
    throw Object.assign(new Error('repo: git no está instalado o no está en el PATH'), { code: 'no_git' });
  }

  const dir = workspaceDirFor(dataDir, room.code);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });

  // `--no-checkout` a propósito: primero se fija la política de fin de línea del
  // clon y solo después se materializa el árbol. En Windows, un checkout con
  // autocrlf=true da CRLF y cualquier parche escrito contra el contenido real del
  // repo (LF) fallaría al aplicarse. Aquí el clon refleja el repo, no la máquina.
  const cloneArgs = ['clone', '--quiet', '--no-checkout'];
  if (src.kind === 'url') {
    cloneArgs.push('--depth', '1');
    if (ref) cloneArgs.push('--branch', String(ref).slice(0, 120));
  }
  cloneArgs.push(src.value, dir);
  const cloned = await execProcess({ file: 'git', args: cloneArgs, cwd: path.dirname(dir), timeoutMs: REPO_LIMITS.cloneTimeoutMs, maxChars: 4_000 });
  if (cloned.code !== 0) {
    throw Object.assign(
      new Error(`No se pudo clonar ${src.value}: ${clip(cloned.output, 400) || 'error de git'}`),
      { code: 'clone_failed' },
    );
  }

  const repo = {
    kind: src.kind,
    source: src.value,
    ref: ref ? String(ref).slice(0, 120) : null,
    dir,
    branch: `agora/${room.code}`,
    defaultBranch: null,
    baseCommit: null,
    head: null,
    verify: normalizeVerify(verify, verifyTimeoutMs),
    verifySource: null,
    baseline: null,
    files: 0,
    // Destino opcional de publicación. Vacío = la sala nunca empujará nada: publicar es
    // una acción explícita del panel, y sin destino declarado no hay a dónde.
    pushTo: pushTo ? String(pushTo).trim().slice(0, 400) : null,
    pushed: [],
    attachedAt: Date.now(),
  };
  room.repo = repo;

  // Política de fin de línea del clon: LF, como el contenido real del repo.
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.eol', 'lf']);
  git(repo, ['config', 'core.safecrlf', 'false']);

  const co = git(repo, ['checkout', '--quiet', repo.ref || 'HEAD']);
  if (!co.ok) {
    room.repo = null;
    throw Object.assign(
      new Error(`No se pudo preparar el árbol${repo.ref ? ` en «${repo.ref}»` : ''}: ${clip(co.output, 300)}`),
      { code: 'bad_ref' },
    );
  }
  repo.defaultBranch = gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  repo.baseCommit = gitOk(repo, ['rev-parse', 'HEAD']).trim();
  repo.head = repo.baseCommit;
  repo.files = git(repo, ['ls-files']).output.split('\n').filter(Boolean).length;
  git(repo, ['checkout', '--quiet', '-b', repo.branch]);

  // Sin comando declarado se busca uno en el propio proyecto: mejor una verificación
  // detectada y dicha a voces que integrar parches sin comprobar nada.
  if (!repo.verify) {
    const found = detectVerifyCommand(repo.dir);
    if (found) {
      repo.verify = normalizeVerify(found.command, verifyTimeoutMs);
      repo.verifySource = { detected: true, why: found.why };
      log(room, null, 'work',
        `La sala no declaró comando de verificación: se usará «${found.command}» (detectado en ${found.why}). ` +
        `Cámbialo o quítalo con POST /admin {op:"set-verify", command:"..."}.`);
    } else {
      log(room, null, 'work',
        'La sala no tiene comando de verificación y no se pudo detectar uno: los parches se integrarán SIN comprobar. ' +
        'Añádelo cuando quieras con POST /admin {op:"set-verify", command:"npm test"}.');
    }
  }

  if (repo.verify && baseline !== false) repo.baseline = { status: 'running', at: Date.now() };
  return repo;
}

// ---------------------------------------------------------------- proyecto nuevo
// Una sala sin repo NO termina en un plan: si no hay código, la sala crea su propio proyecto y
// trabaja en él. El workspace nace prácticamente vacío (un README que dice qué es), pero con git
// dentro, así que el resto del camino —tareas, parches, revisión, verificación, commits, rama—
// funciona igual que sobre un repo ajeno. Lo único distinto es que no hay nada que auditar en la
// primera ronda: el plan que gane el debate ES la especificación.
export async function attachScaffold(room, { dataDir, verify = null, verifyTimeoutMs = null } = {}) {
  if (!gitAvailable()) {
    throw Object.assign(new Error('repo: git no está instalado o no está en el PATH'), { code: 'no_git' });
  }
  const dir = workspaceDirFor(dataDir, room.code);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const repo = {
    kind: 'scaffold',
    greenfield: true,
    source: 'proyecto nuevo',
    ref: null,
    dir,
    branch: `agora/${room.code}`,
    defaultBranch: null,
    baseCommit: null,
    head: null,
    verify: normalizeVerify(verify, verifyTimeoutMs),
    verifySource: null,
    baseline: null,
    files: 0,
    // Un proyecto nuevo no tiene destino de publicación: no hay remoto del que venga ni al que
    // empujar. Publicar sigue siendo una acción explícita y aquí no hay a dónde.
    pushTo: null,
    pushed: [],
    attachedAt: Date.now(),
  };
  room.repo = repo;

  gitOk(repo, ['init', '--quiet']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'core.eol', 'lf']);
  git(repo, ['config', 'core.safecrlf', 'false']);
  // Ramas `main` cuando el git instalado lo permite; si no, la que traiga por defecto.
  git(repo, ['checkout', '--quiet', '-b', 'main']);

  const readme = [
    `# ${room.title || 'Proyecto nuevo'}`,
    '',
    `Proyecto nuevo de la sala ${room.code} (Polymind). Aquí no había código: lo escribe el debate.`,
    '',
    `**Tarea.** ${room.task}`,
    '',
    room.criteria ? `**Criterios de aceptación.** ${room.criteria}` : '',
    '',
    'El plan que gane el debate es la especificación. Cada parte decidida se convierte en una',
    `tarea del trabajo conjunto: un agente la implementa, otro la revisa y el servidor la verifica`,
    `antes de commitearla en la rama \`${repo.branch}\`.`,
    '',
  ].filter(x => x !== null).join('\n');
  fs.writeFileSync(path.join(dir, 'README.md'), readme.replace(/\n{3,}/g, '\n\n'));

  gitOk(repo, ['add', '-A']);
  const commit = git(repo, [
    '-c', 'user.name=Polymind',
    '-c', 'user.email=agora@local',
    'commit', '--quiet', '--no-gpg-sign', '-m', `Proyecto nuevo de la sala ${room.code}: punto de partida`,
  ]);
  if (!commit.ok) {
    room.repo = null;
    throw Object.assign(
      new Error(`No se pudo preparar el proyecto nuevo: ${clip(commit.output, 300) || 'git no pudo commitear'}`),
      { code: 'scaffold_failed' },
    );
  }

  repo.defaultBranch = gitOk(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  repo.baseCommit = gitOk(repo, ['rev-parse', 'HEAD']).trim();
  repo.head = repo.baseCommit;
  git(repo, ['checkout', '--quiet', '-b', repo.branch]);
  repo.files = git(repo, ['ls-files']).output.split('\n').filter(Boolean).length;

  if (!repo.verify) {
    const found = detectVerifyCommand(repo.dir);
    if (found) {
      repo.verify = normalizeVerify(found.command, verifyTimeoutMs);
      repo.verifySource = { detected: true, why: found.why };
    }
  }
  log(room, null, 'work',
    `Proyecto nuevo creado en el espacio de trabajo de la sala (rama ${repo.branch}). ` +
    'No hay código que auditar: el plan que gane el debate se convierte en tareas y los agentes ' +
    'escriben los archivos aquí.' +
    (repo.verify ? ` Verificación: «${repo.verify.command}».` : ' Sin comando de verificación todavía (POST /admin {op:"set-verify"}).'));
  if (repo.verify) repo.baseline = { status: 'running', at: Date.now() };
  return repo;
}

export function normalizeVerify(verify, timeoutMs = null) {
  let command = '';
  let ms = null;
  if (typeof verify === 'string') command = verify.trim();
  else if (verify && typeof verify === 'object') {
    command = String(verify.command || verify.cmd || '').trim();
    ms = Number(verify.timeoutMs) || null;
  }
  if (!command) return null;
  const capped = Number.isFinite(ms) && ms > 0 ? Math.min(Math.max(ms, 5_000), 30 * 60_000) : null;
  return {
    // Espacios de más fuera: es una línea de shell, no un párrafo, y el panel la muestra.
    command: command.replace(/\s+/g, ' ').trim().slice(0, 2_000),
    timeoutMs: capped || Math.min(Math.max(Number(timeoutMs) || 5 * 60_000, 5_000), 30 * 60_000),
  };
}

// ---------------------------------------------------------------- verificación
// Único punto donde se ejecuta algo del proyecto. `reused` evita que la misma
// tarea verifique dos veces si nada cambió entre medias.
//
// Aquí, y solo aquí, nace la EVIDENCIA de la sala: el comando, su código de salida y el commit
// sobre el que corrió quedan en el libro mayor con su huella. Nadie teclea un número: los que
// salen en el acta los produjo este proceso. `itemId` ata la medición al árbol de una tarea
// (una verificación sobre un parche staged certifica ese contenido, no el HEAD del momento).
export async function runVerify(room, { timeoutMs = null, kind = 'verify', itemId = null, by = null } = {}) {
  const repo = room.repo;
  if (!repo) return { ran: false, reason: 'sin-repo' };
  discoverProjectVerification(room);
  if (!repo.verify) return { ran: false, reason: 'sin-comando-de-verificacion' };
  const verifiedHead = repo.head || null;
  // Bind the executed check to an exact index tree. If the command changes the
  // index/worktree, its result must not certify the subsequently committed tree.
  const indexTree = () => {
    const unstaged = git(repo, ['diff', '--quiet']);
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']);
    if (!unstaged.ok || !untracked.ok || untracked.output.trim()) return null;
    const tree = git(repo, ['write-tree']);
    return tree.ok ? tree.output.trim() : null;
  };
  const beforeTree = indexTree();
  const limit = timeoutMs || repo.verify.timeoutMs;
  const res = await execProcess({
    file: repo.verify.command,
    args: [],
    shell: true,
    cwd: repo.dir,
    timeoutMs: limit,
    maxChars: REPO_LIMITS.verifyOutputChars,
    env: { CI: '1', AGORA: room.code, FORCE_COLOR: '0' },
  });
  const out = {
    ran: true,
    command: repo.verify.command,
    exitCode: res.code,
    ok: res.code === 0,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    outputTail: clip(res.output, REPO_LIMITS.verifyOutputChars),
    at: Date.now(),
  };
  const afterTree = indexTree();
  out.verifiedTree = beforeTree && beforeTree === afterTree ? beforeTree : null;
  try {
    const { entry, reused } = recordEvidence(room, {
      command: out.command,
      exitCode: out.exitCode,
      ok: out.ok,
      output: res.output,
      commit: verifiedHead,
      verifiedTree: out.verifiedTree,
      dirty: !!itemId || !out.verifiedTree || repo.head !== verifiedHead,
      kind,
      itemId,
      by,
    });
    out.evidenceId = entry?.id || null;
    out.evidenceHash = entry?.hash || null;
    out.evidenceReused = !!reused;
  } catch { /* el libro mayor nunca tumba una verificación */ }
  return out;
}

export async function runBaseline(room) {
  if (!room.repo?.verify) return null;
  const out = await runVerify(room, { kind: 'baseline' });
  return { ...out, status: 'done' };
}

// El sondeo inicial no bloquea la creación de la sala: corre en segundo plano y
// avisa por callback. Una sala que arranca con la suite en rojo debe poder decirlo.
export function baselineInBackground(room, onChange = null) {
  if (!room.repo) return null;
  if (room.__baselinePromise) return room.__baselinePromise;
  discoverProjectVerification(room);
  if (!room.repo.verify) { room.repo.baseline = null; return null; }
  room.repo.baseline = { status: 'running', at: Date.now() };
  const promise = runBaseline(room)
    .then(res => { if (room.repo) room.repo.baseline = res; return res; })
    .catch(err => {
      if (room.repo) room.repo.baseline = { status: 'done', ran: false, ok: false, outputTail: String(err?.message || err) };
      return null;
    })
    .finally(() => {
      // La promesa viva es la única prueba de que el sondeo sigue en marcha: sin esta
      // marca, un reinicio del servidor dejaría la línea base «running» para siempre.
      delete room.__baselinePromise;
      try { onChange?.(room); } catch { /* el callback no debe tumbar el sondeo */ }
    });
  room.__baselinePromise = promise;
  return promise;
}

// Greenfield projects acquire their test suite after attachment. Apply the same
// discovery policy as attachScaffold, but never override a human opt-out.
export function discoverProjectVerification(room) {
  const repo = room.repo;
  if (!repo?.greenfield || repo.verify || repo.verifyDisabled) return;
  const found = detectVerifyCommand(repo.dir);
  if (!found) return;
  repo.verify = normalizeVerify(found.command);
  repo.verifySource = { detected: true, why: found.why };
  log(room, null, 'work', `Verificación detectada en el proyecto construido: ${found.command} (${found.why}).`);
}

// ---------------------------------------------------------------- lectura
export function repoIndex(room, { limit = REPO_LIMITS.indexMaxFiles } = {}) {
  const repo = room.repo;
  if (!repo) return null;
  const listed = lines(git(repo, ['ls-files'], { maxChars: 4_000_000 }).output);
  const files = listed.slice(0, limit);
  const dirs = new Map();
  const byExt = new Map();
  for (const f of listed) {
    const top = f.includes('/') ? f.split('/')[0] : '.';
    dirs.set(top, (dirs.get(top) || 0) + 1);
    const ext = path.extname(f).toLowerCase() || '(sin extensión)';
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }
  return {
    source: repo.source,
    kind: repo.kind,
    branch: repo.branch,
    baseCommit: repo.baseCommit,
    head: repo.head,
    defaultBranch: repo.defaultBranch,
    verify: repo.verify ? repo.verify.command : null,
    baseline: repo.baseline || null,
    total: listed.length,
    truncated: listed.length > files.length,
    files,
    dirs: [...dirs.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    extensions: [...byExt.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

// Guardia de rutas: nada fuera del clon, nada dentro de .git.
export function resolveInsideRepo(room, rel) {
  const repo = room.repo;
  if (!repo) return null;
  const raw = String(rel || '').replace(/\\/g, '/').trim();
  if (!raw) return null;
  const root = path.resolve(repo.dir);
  const abs = path.resolve(root, raw);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const normalized = path.relative(root, abs).split(path.sep).join('/');
  if (normalized.startsWith('.git/') || normalized === '.git') return null;
  // La raíz del clon sí se puede listar ('.'), pero nunca su interior .git.
  return { abs, rel: normalized || '.' };
}

export function readRepoFile(room, rel, { from = 1, lines = 500 } = {}) {
  const target = resolveInsideRepo(room, rel);
  if (!target) return { error: 'path inválido: usa una ruta relativa dentro del repo, sin .git' };
  let stat;
  try { stat = fs.statSync(target.abs); }
  catch { return { error: `no existe en el repo: ${target.rel}` }; }
  if (stat.isDirectory()) {      const entries = fs.readdirSync(target.abs).slice(0, 2_000).map(name => {
      const st = fs.statSync(path.join(target.abs, name));
      return { name, kind: st.isDirectory() ? 'dir' : 'file', bytes: st.isDirectory() ? 0 : st.size };
    });
    return { path: target.rel, kind: 'dir', entries, total: entries.length };
  }
  if (stat.size > REPO_LIMITS.fileMaxBytes) {
    return { error: `archivo demasiado grande (${Math.round(stat.size / 1024)} KB): pide un rango con from/lines` };
  }
  const text = fs.readFileSync(target.abs, 'utf8');
  const all = text.split('\n');
  const start = Math.max(1, Math.min(Number(from) || 1, all.length || 1));
  const count = Math.max(1, Math.min(Number(lines) || 500, 20_000));
  const slice = all.slice(start - 1, start - 1 + count);
  return {
    path: target.rel,
    kind: 'file',
    startLine: start,
    endLine: start - 1 + slice.length,
    totalLines: all.length,
    bytes: stat.size,
    truncated: start - 1 + slice.length < all.length,
    text: slice.join('\n'),
  };
}

export function searchRepo(room, query, { max = REPO_LIMITS.searchMaxMatches, regex = false } = {}) {
  const repo = room.repo;
  if (!repo) return { error: 'sin repo' };
  const q = String(query || '').trim();
  if (!q) return { error: 'falta el patrón de búsqueda (?q=)' };
  const res = git(repo, ['grep', '-n', '-I', '--color=never', regex ? '-E' : '-F', '--', q], { maxChars: 600_000 });
  const found = lines(res.output);
  const matches = [];
  for (const line of found.slice(0, max)) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    matches.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 400) });
  }
  return {
    query: q,
    regex: !!regex,
    matches,
    total: res.output.includes('caracteres omitidos') ? -1 : found.length,
    truncated: found.length > matches.length || res.output.includes('caracteres omitidos'),
  };
}

// Líneas útiles de una salida de git, sin CR sueltos ni vacíos.
function lines(output) {
  return String(output || '').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
}

// ---------------------------------------------------------------- parches
// Aplica un parche (diff unificado) o reescribe archivos completos, deja los
// cambios en el índice y devuelve el diff real que verá el revisor.
export function stagePatch(room, { diff = '', files = [] } = {}) {
  const repo = room.repo;
  if (!repo) return { ok: false, error: 'la sala no tiene repo' };
  const headBefore = repo.head;
  const applied = [];

  if (diff) {
    const bad = unsafePatchPaths(diff);
    if (bad.length) return { ok: false, error: `el parche toca rutas fuera del repo: ${bad.join(', ')}`, headBefore };
    const file = path.join(repo.dir, '.agora-patch.diff');
    fs.writeFileSync(file, diff);
    let res;
    try {
      res = git(repo, ['apply', '--3way', '--whitespace=nowarn', '--recount', file]);
      if (!res.ok) res = git(repo, ['apply', '--whitespace=nowarn', '--recount', file]);
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* nada */ }
    }
    if (!res.ok) return { ok: false, error: `git apply rechazó el parche:\n${clip(res.output, 4_000)}`, headBefore };
    applied.push('diff');
  }

  // Un parche toca los archivos que toca. Antes esto cortaba la lista en 20 —los que
  // sobraban desaparecían sin avisar— y RECHAZABA cualquier archivo de más de 80 KB, así
  // que un refactor con un archivo generado no se podía entregar de ninguna forma. Los
  // techos ahora son los mismos del resto del motor y están para no morir de memoria.
  for (const f of Array.isArray(files) ? files.slice(0, CAPS.patchFilesMax) : []) {
    const target = resolveInsideRepo(room, f?.path);
    if (!target) return { ok: false, error: `ruta inválida en files[]: ${String(f?.path || '')}`, headBefore };
    const content = typeof f?.content === 'string' ? f.content : '';
    if (content.length > CAPS.patchFileMax) {
      return {
        ok: false,
        headBefore,
        error: `${target.rel} pesa ${content.length} caracteres y el techo de un archivo por parche está en ${CAPS.patchFileMax}. ` +
          'Pártelo en un parche por tanda o cambia el archivo por diff unificado.',
      };
    }
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.writeFileSync(target.abs, content);
    applied.push(target.rel);
  }

  if (!applied.length) return { ok: false, error: 'payload vacío: envía diff o files[{path, content}]', headBefore };

  git(repo, ['add', '-A']);
  const stagedDiff = git(repo, ['diff', '--cached'], { maxChars: CAPS.patchDiffMax }).output;
  if (!stagedDiff.trim()) {
    unstagePatch(room);
    return { ok: false, error: 'el parche no cambia nada respecto al repo (diff vacío)', headBefore };
  }
  return { ok: true, headBefore, diff: stagedDiff, stat: stageStat(repo) };
}

function stageStat(repo) {
  const numstat = lines(git(repo, ['diff', '--cached', '--numstat']).output);
  const files = [];
  let insertions = 0, deletions = 0;
  for (const line of numstat) {
    const [a, d, file] = line.split('\t');
    const ins = a === '-' ? 0 : Number(a) || 0;
    const del = d === '-' ? 0 : Number(d) || 0;
    insertions += ins;
    deletions += del;
    files.push({ path: file, insertions: ins, deletions: del, binary: a === '-' });
  }
  return { files, insertions, deletions, fileCount: files.length };
}

// Deshace por completo lo que hubiera sin commitear: el árbol vuelve al HEAD.
export function unstagePatch(room) {
  const repo = room.repo;
  if (!repo) return;
  git(repo, ['reset', '--hard', 'HEAD']);
  git(repo, ['clean', '-fdq']);
}

// Publicar la rama de la sala en el remoto que declaró el humano al crear la sala.
// No se inventa destinos: sin `pushTo` no hay push. Se ejecuta sin interacción (si el
// remoto pide credenciales, falla con un mensaje en vez de quedarse colgado esperando).
export function pushBranch(room, { remote = null } = {}) {
  const repo = room.repo;
  if (!repo) return { ok: false, error: 'Esta sala no tiene repositorio.' };
  const target = String(remote || repo.pushTo || '').trim();
  if (!target) {
    return { ok: false, error: 'La sala no declaró `repo.pushTo`: no hay remoto al que publicar (nunca se inventa uno).' };
  }
  // Publicar el punto de partida no aporta nada: solo sale si el debate movió la rama.
  if (!repo.head || repo.head === repo.baseCommit) {
    return { ok: false, error: 'La rama sigue en el punto de partida: el debate no ha integrado ningún cambio, no hay nada que publicar.' };
  }
  const res = spawnSync('git', ['push', target, `HEAD:refs/heads/${repo.branch}`], {
    cwd: repo.dir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: REPO_LIMITS.pushTimeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', AGORA: room.code },
  });
  const output = clip([res.stdout || '', res.stderr || ''].filter(Boolean).join('\n').replace(/\r\n/g, '\n'), 2_000);
  const ok = res.status === 0;
  repo.pushedAt = ok ? Date.now() : repo.pushedAt || null;
  repo.pushTarget = target;
  repo.pushOutputTail = output;
  if (ok) {
    // Se recuerda QUÉ commit salió, no solo que se publicó: si después se deshace una
    // mejora o se integra otra, el remoto se queda atrás y hay que poder decirlo.
    repo.pushedHead = repo.head;
    repo.pushed = [...new Set([...(repo.pushed || []), repo.branch])];
    log(room, null, 'work', `Rama ${repo.branch} publicada en ${target}.`);
  } else {
    log(room, null, 'work', `No se pudo publicar la rama en ${target}: ${gist(output, 160)}`);
  }
  return { ok, target, branch: repo.branch, head: repo.head, output };
}

export function commitStaged(room, { message, authorName, authorEmail = 'agora@local' }) {
  const repo = room.repo;
  // El mensaje del commit es un artefacto que lee el humano en su historial: un resumen
  // largo del agente no se corta a los 2 000 caracteres.
  const msg = String(message || '').slice(0, 8_000);
  const res = git(repo, [
    '-c', `user.name=${String(authorName || 'agora').slice(0, 60)}`,
    '-c', `user.email=${String(authorEmail).slice(0, 80)}`,
    'commit', '--quiet', '--no-gpg-sign', '-m', msg,
  ]);
  if (!res.ok) return { ok: false, error: clip(res.output, 600) };
  repo.head = git(repo, ['rev-parse', 'HEAD']).output.trim();
  return { ok: true, sha: repo.head };
}

// Deshacer un cambio integrado. Se revierte el commit REAL (queda en el historial: no se
// reescribe ni se hace `reset`), y si choca con lo que vino después se aborta limpiamente
// diciendo qué archivos chocaron, en vez de dejar el árbol a medias.
export function revertCommit(room, { sha, message, authorName = 'agora', authorEmail = 'agora@local' }) {
  const repo = room.repo;
  if (!repo?.dir) return { ok: false, error: 'Esta sala no tiene repositorio.' };
  const target = String(sha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(target)) return { ok: false, error: `Commit inválido: «${target}».` };
  if (!git(repo, ['cat-file', '-e', `${target}^{commit}`]).ok) {
    return { ok: false, error: `El commit ${target.slice(0, 8)} no está en el clon de esta sala.` };
  }
  if (git(repo, ['status', '--porcelain']).output.trim()) {
    return { ok: false, error: 'El árbol del clon tiene cambios sin commitear: no se deshace nada encima de trabajo a medias.' };
  }

  const res = git(repo, ['revert', '--no-commit', '--no-edit', target]);
  if (!res.ok) {
    const conflicts = git(repo, ['diff', '--name-only', '--diff-filter=U']).output
      .split('\n').map(s => s.trim()).filter(Boolean);
    git(repo, ['revert', '--abort']);
    const dirty = !!git(repo, ['status', '--porcelain']).output.trim();
    return {
      ok: false,
      conflicts,
      error: conflicts.length
        ? `No se puede deshacer ${target.slice(0, 8)} sin resolver conflictos: lo que vino después tocó ${conflicts.slice(0, 5).join(', ')}. Se abortó y el árbol quedó como estaba.`
        : `git revert falló sobre ${target.slice(0, 8)}: ${gist(res.output, 240)}${dirty ? ' · el árbol quedó sucio, revísalo' : ''}`,
    };
  }

  const commit = commitStaged(room, { message, authorName, authorEmail });
  if (!commit.ok) {
    git(repo, ['reset', '--hard']);
    return { ok: false, error: `La reversión se preparó pero el commit falló: ${gist(commit.error || '', 240)}. Se dejó el árbol como estaba.` };
  }
  return { ok: true, sha: commit.sha, of: target, branch: repo.branch };
}

// Qué archivos tocó un commit ya integrado (para el panel y para explicar una reversión).
export function commitFiles(room, sha) {
  const repo = room.repo;
  if (!repo?.dir || !sha) return { files: [], stat: null };
  const list = git(repo, ['show', '--name-only', '--format=', String(sha)]).output
    .split('\n').map(s => s.trim()).filter(Boolean);
  const numstat = git(repo, ['show', '--numstat', '--format=', String(sha)]).output;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    if (m[1] !== '-') insertions += Number(m[1]);
    if (m[2] !== '-') deletions += Number(m[2]);
  }
  return {    files: list.slice(0, 500), stat: { fileCount: list.length, insertions, deletions } };
}

// Fijar (o cambiar) el comando de verificación sin recrear la sala. Antes solo se podía
// declarar al crear: quien no lo puso se quedaba integrando parches sin comprobar nada.
export function setVerifyCommand(room, { command = '', timeoutMs = null, rerunBaseline = true } = {}) {
  const repo = room.repo;
  if (!repo?.dir) return { ok: false, error: 'Esta sala no tiene repositorio.' };
  const next = normalizeVerify(command, timeoutMs ?? repo.verify?.timeoutMs ?? null);
  if (!next && String(command || '').trim()) {
    return { ok: false, error: 'Comando inválido: usa una línea (se ejecuta por el shell del clon).' };
  }
  const before = repo.verify?.command || null;
  repo.verify = next;
  repo.verifyDisabled = !next;
  repo.verifySource = next ? { detected: false, why: 'fijado a mano desde el panel' } : null;
  repo.baseline = null;
  log(room, null, 'work', next
    ? `Comando de verificación de la sala: «${next.command}»${before ? ` (antes «${before}»)` : ''}. Los parches que se integren a partir de aquí se comprueban con él.`
    : 'La sala se queda SIN verificación: sus parches se integrarán sin comprobar. Se dirá así en el resultado.');
  if (next && rerunBaseline) return { ok: true, command: next.command, baseline: 'running', rerun: true };
  return { ok: true, command: next ? next.command : null, baseline: null, rerun: false };
}

export function workDiff(room, { from = null, to = null, maxChars = 400_000 } = {}) {
  const repo = room.repo;
  if (!repo) return '';
  const a = from || repo.baseCommit;
  const b = to || repo.head;
  if (a === b) return '';
  return git(repo, ['diff', '--no-color', a, b], { maxChars }).output;
}

export function workStats(room, from = null, to = null) {
  const repo = room.repo;
  if (!repo) return { files: 0, insertions: 0, deletions: 0, list: [] };
  const a = from || repo.baseCommit;
  const b = to || repo.head;
  if (a === b) return { files: 0, insertions: 0, deletions: 0, list: [] };
  const numstat = lines(git(repo, ['diff', '--numstat', a, b]).output);
  const list = [];
  let insertions = 0, deletions = 0;
  for (const line of numstat) {
    const [i, d, file] = line.split('\t');
    const ins = i === '-' ? 0 : Number(i) || 0;
    const del = d === '-' ? 0 : Number(d) || 0;
    insertions += ins;
    deletions += del;
    list.push({ path: file, insertions: ins, deletions: del });
  }
  return { files: list.length, insertions, deletions, list };
}

export function commitLog(room, from = null, to = null) {
  const repo = room.repo;
  if (!repo) return [];
  const a = from || repo.baseCommit;
  const b = to || repo.head;
  const out = git(repo, ['log', '--format=%H%x1f%an%x1f%s%x1f%ct', `${a}..${b}`]).output;
  return lines(out).map(line => {
    const [sha, author, subject, ts] = line.split('\x1f');
    return { sha, author, subject, at: Number(ts) * 1000 };
  });
}

// Rutas de un diff unificado que apuntan fuera del repo (o a .git): se rechazan
// antes de tocar git, para que un parche no pueda escribir donde no debe.
export function unsafePatchPaths(diff) {
  const bad = new Set();
  const text = String(diff || '');
  if (text.length > 200_000) return ['parche demasiado grande'];
  const header = /^diff --git a\/(.+) b\/(.+)$/;
  const target = /^\+\+\+ (?:b\/)?(.+)$/;
  const source = /^--- (?:a\/)?(.+)$/;
  for (const line of text.split('\n')) {
    const candidates = [];
    const h = line.match(header);
    if (h) candidates.push(h[1], h[2]);
    const t = line.match(target);
    if (t && t[1] !== '/dev/null') candidates.push(t[1]);
    const s = line.match(source);
    if (s && s[1] !== '/dev/null') candidates.push(s[1]);
    for (const raw of candidates) {
      const p = String(raw).trim().replace(/^"|"$/g, '').replace(/\t.*$/, '');
      if (!p) continue;
      const norm = p.replace(/\\/g, '/');
      if (p.includes('\0') || norm.startsWith('/') || /^[a-zA-Z]:\//.test(norm) || norm.split('/').includes('..')) { bad.add(p.slice(0, 60)); continue; }
      if (norm === '.git' || norm.startsWith('.git/')) bad.add(p.slice(0, 60));
    }
  }
  return [...bad];
}

export function repoLabel(room) {
  const repo = room.repo;
  if (!repo) return null;
  return { kind: repo.kind, source: repo.source, ref: repo.ref, branch: repo.branch, files: repo.files };
}
