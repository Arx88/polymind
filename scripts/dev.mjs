// AGORA — desarrollo: arranca el backend (API de agentes) y Vite (interfaz) juntos.
//   npm run dev
// Backend en :8790 (para no chocar con un servidor ya en marcha en :8787) y
// Vite en :5190 con proxy hacia el backend. Sin dependencias: solo child_process.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = process.env.PORT || '8790';
const APP_PORT = process.env.AGORA_APP_PORT || '5190';

const children = [];
function run(label, cmd, args, env) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, shell: false });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => process.stdout.write(prefix(label, d)));
  child.stderr.on('data', d => process.stderr.write(prefix(label, d)));
  child.on('close', code => {
    console.log(`\n[${label}] terminó con código ${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function prefix(label, text) {
  return String(text).split('\n').filter(Boolean).map(l => `[${label}] ${l}`).join('\n') + '\n';
}

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const c of children) { try { c.kill(); } catch { /* ya murió */ } }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`AGORA · backend :${API_PORT} · interfaz :${APP_PORT}\n`);
run('api', process.execPath, ['server/index.mjs'], { PORT: API_PORT });
run('app', process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'app/vite.config.ts'], {
  AGORA_API: `http://localhost:${API_PORT}`,
  AGORA_APP_PORT: APP_PORT,
});
