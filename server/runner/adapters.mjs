// AGORA v2 — adaptadores de CLI para el runner local.
//
// Cada adaptador declara cómo se invoca un agente headless y cómo se le pasa el
// prompt. El runner solo ejecuta adaptadores de esta lista (o un `custom`
// explícitamente autorizado con --allow-custom): nada de shell libre.

export const ADAPTERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: ['-p', '--output-format', 'text'],
    promptVia: 'stdin',
    hint: 'claude -p lee el prompt por stdin y escribe la respuesta en stdout.',
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex',
    args: ['exec', '-'],
    promptVia: 'stdin',
    hint: 'codex exec - ejecuta el prompt de stdin en modo no interactivo.',
  },
  zcode: {
    id: 'zcode',
    label: 'ZCode',
    command: 'zcode',
    args: ['run', '--print'],
    promptVia: 'stdin',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    args: ['--prompt', '{prompt}'],
    promptVia: 'arg',
  },
  mock: {
    id: 'mock',
    label: 'Simulador (pruebas)',
    command: process.execPath,
    args: ['test/fake-cli.mjs'],
    promptVia: 'stdin',
    hint: 'CLI de mentira usada por las pruebas del runner.',
  },
  custom: {
    id: 'custom',
    label: 'CLI propia',
    command: null,
    args: [],
    promptVia: 'stdin',
    requiresAllowCustom: true,
  },
};

export function resolveAdapter(idOrSpec) {
  const spec = typeof idOrSpec === 'string' ? { id: idOrSpec } : (idOrSpec || {});
  const base = ADAPTERS[spec.id || spec.cli || 'custom'];
  if (!base) return null;
  const adapter = { ...base, ...spec };
  if (!adapter.command) {
    if (!spec.command) return null;
    adapter.command = spec.command;
  }
  if (!Array.isArray(adapter.args)) adapter.args = [];
  return adapter;
}

export function adapterList() {
  return Object.values(ADAPTERS).map(a => ({ id: a.id, label: a.label, command: a.command, hint: a.hint || null }));
}

// Extrae el primer objeto JSON equilibrado del texto que imprimió el CLI.
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start < 0) continue;
    let depth = 0, inString = false, escape = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const slice = candidate.slice(start, i + 1);
          try { return JSON.parse(slice); } catch { break; }
        }
      }
    }
  }
  return null;
}
