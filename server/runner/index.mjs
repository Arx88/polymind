// AGORA v2 — runner local.
//
// Convierte «el usuario no hace nada» en literal: lanza N CLIs headless, los une
// a la sala y los conduce por el bucle del protocolo (turn → CLI → move) sin
// intervención humana.
//
//   node server/runner/index.mjs --room CODE --roster roster.json [--url http://localhost:8787]
//   node server/runner/index.mjs --room CODE --cli mock --agents 3      (prueba sin CLIs reales)
//
// Guardas: solo se ejecutan adaptadores de la lista de adapters.mjs; una CLI
// propia exige --allow-custom. Cada turno tiene timeout y el número de turnos
// está acotado.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, resolveAdapter, extractJson, adapterList } from './adapters.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

export function loadRoster(file) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  const agents = Array.isArray(data) ? data : (data.agents || []);
  return agents;
}

function buildPrompt(agent, turn, agenda, lastError) {
  const lines = [
    `Eres «${agent.name}» (harness: ${agent.harness}${agent.model ? `, modelo: ${agent.model}` : ''}), participante de un debate AGORA entre agentes y harnesses distintos.`,
    'Defiende tu propio criterio como harness: no hay papeles asignados ni lentes repartidas.',
    agent.role ? `Lente que TÚ declaraste: ${agent.role}.` : '',
    'Responde SIEMPRE con un único objeto JSON, sin texto adicional ni explicaciones:',
    '{"kind":"<action>","payload":{ ... }}',
    'donde "<action>" es el valor del campo action del turno.',
    '',
    'Acciones y esquemas (usa el que te pida el turno):',
    '- submit-proposal → {"kind":"proposal","payload":{"title","plan","approach","positions":[{"pointId","choiceId"}],"premortem"}}',
    '- frame-contribute → {"kind":"pass"} | {"kind":"point-proposal","payload":{"label","options":[]}} | {"kind":"ratify","payload":{"approve":true}}',
    '- submit-critique → {"kind":"critique","payload":{"target","steelman","objections":[{"type","severity","text"}],"improvements":[{"change","why","validation"}]}}. Construye sobre lo valioso del plan ajeno, no solo busques fallos.',
    '- submit-revision-or-pass → {"kind":"revision","payload":{"plan","note"}} o {"kind":"pass"} o {"kind":"concede","payload":{"reason","endorse"}}',
    '- submit-vote → {"kind":"vote","payload":{"ranking":["p…","p…"]}}',
    '- submit-argument → {"kind":"argument","payload":{"target","text"}}',
    '- objection-or-pass → {"kind":"objection","payload":{"text","severity":"blocker|concern"}} o {"kind":"pass"}',
    '- submit-synthesis → {"kind":"synthesis","payload":{"final","merges":[],"pointResolutions":[]}}',
    '- submit-verification → {"kind":"verification","payload":{"checks":[{"claim","method","expectation"}],"findings":[],"verdict":"pass|fail"}}',
    '- confirm-phase-ready → {"kind":"phase-ready","payload":{"revision":"copia exactamente phaseAgreement.revision","ready":true}}. Solo confirma si terminaste y aceptas pasar de fase; no implica estar de acuerdo con el plan. Nunca inventes la revisión.',
    'En revision y synthesis incluye contributionResponses:[{contributionId,disposition:"adopted|adapted|declined",reason}] para explicar el destino de cada sharedImprovement. Una mejora sin respuesta no cuenta como incorporada.',
    // Fases que solo existen si la sala trae repositorio. Sin estas líneas, un CLI
    // conducido por el runner no podía auditar el código ni trabajar en él.
    '- audit-repo → {"kind":"finding","payload":{"file","line","symbol","severity":"high|med|low","claim","evidence","action"}}',
    '- claim-item → {"kind":"claim-item","payload":{"itemId":"w1"}}',
    '- submit-patch → {"kind":"submit-patch","payload":{"itemId","summary","files":[{"path","content"}]}}  (o "diff" unificado; files[] reescribe el archivo completo)',
    '- review-patch → {"kind":"review-patch","payload":{"itemId","verdict":"approve|changes","notes"}}',
    '- postwork-review → {"kind":"recheck","payload":{"itemId","verdict":"ok|improve","claim","action","evidence","file","severity"}}  (revisión posterior: juzga la mejora YA integrada contra el diff real)',
    '- progress → {"kind":"progress","payload":{"note"}}  (latido: mantiene tu tarea mientras trabajas, sin gastar un movimiento completo)',
    '',
    'Si la sala trae repositorio, el turno incluye: `repoAccess` (URLs para leer el código con tu token: índice, búsqueda y archivo), `filesContext` (contenido actual de los archivos de tu tarea, para que el parche encaje) y `repo` (rama, línea base y comando de verificación). Nadie ejecuta código por ti: el servidor aplica tu parche y corre la verificación.',
    '',
    // Sin esto, un CLI cerraba su parte y se despedía a mitad de fase: el runner esperaba
    // un JSON que no llegaba y el debate se quedaba sin él.
    'CUÁNDO TERMINAS: no lo decides tú. Responde un movimiento en CADA invocación: nada de «ya está» ni de '
    + 'texto suelto sin JSON, porque el runner no puede enviar nada por ti. El debate acaba cuando el servidor '
    + 'devuelve action:"done", y eso no ocurre en esta invocación. Si tardas en una tarea, manda '
    + '{kind:"progress", payload:{note:"qué estás haciendo"}} y sigue trabajando.',
    '',
  ];
  if (agenda?.length) {
    lines.push('Puntos de decisión (usa pointId y choiceId exactos):');
    for (const p of agenda) lines.push(`  ${p.id}: ${(p.options || []).map(o => o.id).join(' | ') || 'libre'}`);
    lines.push('');
  }
  if (lastError) {
    lines.push(`TU ÚLTIMO ENVÍO FUE RECHAZADO: ${lastError}`);
    lines.push('Corrige exactamente eso y vuelve a enviar un JSON válido.', '');
  }
  lines.push('<<<AGORA_TURN>>>');
  lines.push(JSON.stringify(turn));
  lines.push('<<<END_AGORA_TURN>>>');
  lines.push('');
  lines.push('Responde solo con el JSON del movimiento.');
  return lines.filter(Boolean).join('\n');
}

function runCli(adapter, prompt, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const args = adapter.args.map(a => String(a).replace('{prompt}', prompt));
    const child = spawn(adapter.command, args, {
      cwd: cwd || ROOT,
      shell: false,
      env: { ...process.env, AGORA_RUNNER: '1' },
    });
    let out = '', err = '', done = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ya murió */ }
      reject(new Error(`timeout de ${timeoutMs} ms al ejecutar ${adapter.command}`));
    }, timeoutMs) : null;
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`no se pudo ejecutar «${adapter.command}»: ${e.message}`));
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`«${adapter.command}» terminó con código ${code}: ${err.slice(0, 300)}`));
        return;
      }
      resolve(out);
    });
    if (adapter.promptVia === 'stdin') child.stdin.end(prompt, 'utf8');
    else child.stdin.end();
  });
}

export class Runner {
  constructor(options) {
    this.base = (options.url || 'http://localhost:8787').replace(/\/$/, '');
    this.room = options.room;
    this.timeoutMs = options.timeoutMs || 180_000;
    this.explicitTimeout = options.timeoutMs != null;
    this.maxTurns = options.maxTurns || 40;
    this.dryRun = !!options.dryRun;
    this.allowCustom = !!options.allowCustom;
    this.cwd = options.cwd || ROOT;
    this.agents = [];
    this.log = options.log || ((...a) => console.log(...a));
  }

  async api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(this.base + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error(data.message || `HTTP ${res.status}`);
      err.code = data.error || 'http_error';
      throw err;
    }
    return data;
  }

  prepareParticipants(specs) {
    return specs.map((spec, i) => {
      const adapter = resolveAdapter(spec);
      if (!adapter) throw new Error(`adaptador desconocido: ${spec.cli || spec.id || '(vacío)'}. Disponibles: ${Object.keys(ADAPTERS).join(', ')}`);
      if (adapter.requiresAllowCustom && !this.allowCustom) {
        throw new Error('la CLI «custom» exige --allow-custom (ejecuta procesos arbitrarios)');
      }
      return {
        name: spec.name || `agente-${i + 1}`,
        // La lente es opcional y la declara el roster; el runner no reparte papeles.
        role: spec.lens || spec.role || null,
        capabilities: spec.capabilities || [],
        model: spec.model || adapter.label,
        harness: spec.harness || adapter.id,
        adapter,
        cwd: spec.cwd || this.cwd,
      };
    });
  }

  async join(participant) {
    const out = await this.api(`/api/rooms/${this.room}/join`, {
      method: 'POST',
      body: {
        name: participant.name,
        model: participant.model,
        harness: participant.harness,
        role: participant.role,
        capabilities: participant.capabilities,
      },
    });
    participant.agentId = out.agentId;
    participant.token = out.token;
    participant.role = out.role;
    participant.agenda = out.turn?.agenda || [];
    this.log(`[${participant.name}] unido como ${out.agentId} (${participant.harness}${participant.model ? ` · ${participant.model}` : ''}${out.role ? ` · lente «${out.role}»` : ''})`);
    return out;
  }

  // Conduce a un participante hasta action:"done".
  async drive(participant) {
    let lastError = null;
    for (let turnCount = 0; turnCount < this.maxTurns; turnCount++) {
      const t = await this.api(`/api/rooms/${this.room}/turn?agent=${participant.agentId}&token=${participant.token}&wait=120`);
      const turn = t.turn;
      if (!turn || turn.action === 'done') {
        this.log(`[${participant.name}] debate cerrado`);
        return;
      }
      if (turn.action === 'wait') continue;

      if (this.dryRun) {
        this.log(`[${participant.name}] (dry-run) acción pendiente: ${turn.action}`);
        return;
      }

      const prompt = buildPrompt(participant, turn, turn.agenda || participant.agenda, lastError);
      let move;
      let heartbeatPending = false;
      const heartbeat = setInterval(async () => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        try {
          await this.api(`/api/rooms/${this.room}/heartbeat`, { method: 'POST', body: { agentId: participant.agentId, token: participant.token } });
        } catch { /* transport failure is reflected by server presence; never forge progress */ }
        finally { heartbeatPending = false; }
      }, 30_000);
      try {
        const timeoutMs = turn.phaseAdvanceMode === 'agreement' && !this.explicitTimeout ? 0 : this.timeoutMs;
        const stdout = await runCli(participant.adapter, prompt, { timeoutMs, cwd: participant.cwd });
        move = extractJson(stdout);
      } catch (err) {
        this.log(`[${participant.name}] fallo del CLI: ${err.message}`);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      } finally {
        clearInterval(heartbeat);
      }
      if (!move || !move.kind) {
        lastError = 'no se pudo extraer {"kind":…,"payload":…} de la salida del CLI';
        this.log(`[${participant.name}] ${lastError}`);
        continue;
      }
      try {
        const out = await this.api(`/api/rooms/${this.room}/move`, {
          method: 'POST',
          body: {
            agentId: participant.agentId,
            token: participant.token,
            kind: move.kind,
            payload: move.payload || {},
            idempotencyKey: `${participant.agentId}-${turnCount}-${turn.action}`,
          },
        });
        lastError = null;
        this.log(`[${participant.name}] ${turn.action} → ${move.kind}` +
          (out.warnings?.length ? ` (avisos: ${out.warnings.join('; ')})` : ''));
        // Un latido o un pase significa «ahora no puedo avanzar»: insistir de inmediato
        // quemaba turnos del runner sin que cambiara nada (el árbol seguía ocupado).
        if (move.kind === 'progress' || move.kind === 'pass') await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        if (err.code === 'wrong_phase' || err.code === 'duplicate') continue;
        lastError = `${err.code || 'error'}: ${err.message}`;
        this.log(`[${participant.name}] rechazado → reintentará: ${lastError}`);
        // El árbol está ocupado (otro parche en vuelo) o su tarea acaba de cambiar de
        // manos: reintentar en bucle no ayuda a nadie, así que se da un respiro.
        if (err.code === 'busy' || err.code === 'conflict') await new Promise(r => setTimeout(r, 2500));
      }
    }
    this.log(`[${participant.name}] alcanzó el límite de ${this.maxTurns} turnos`);
  }

  async run(specs) {
    this.agents = this.prepareParticipants(specs);
    await Promise.all(this.agents.map(a => this.join(a).catch(err => {
      this.log(`[${a.name}] no pudo unirse: ${err.message}`);
      a.failed = true;
    })));
    await Promise.all(this.agents.filter(a => !a.failed).map(a => this.drive(a)));
    const res = await this.api(`/api/rooms/${this.room}/result?agent=${this.agents[0]?.agentId}&token=${this.agents[0]?.token}`).catch(() => null);
    return res?.closed ? res.result : null;
  }
}

// ---------------------------------------------------------------- CLI directa
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const args = parseArgs();
  if (!args.room) {
    console.error('Uso: node server/runner/index.mjs --room CODE --roster roster.json [--url http://localhost:8787]');
    console.error('     node server/runner/index.mjs --room CODE --cli mock --agents 3');
    console.error('');
    console.error('Adaptadores disponibles:');
    for (const a of adapterList()) console.error(`  ${a.id.padEnd(8)} ${a.label}${a.hint ? ` — ${a.hint}` : ''}`);
    process.exit(1);
  }
  let specs = [];
  if (args.roster) specs = loadRoster(args.roster);
  else {
    const count = Math.max(1, parseInt(args.agents || '3', 10));
    const cli = args.cli || 'mock';
    // Sin roster, los agentes se identifican por su harness (su identidad real) y no
    // llevan lente: el runner no reparte papeles, igual que el servidor.
    const names = args.names ? String(args.names).split(',').map(s => s.trim()).filter(Boolean) : [];
    const label = (ADAPTERS[cli]?.label || cli).split(' ')[0];
    specs = Array.from({ length: count }, (_, i) => ({
      name: names[i % names.length] || `${label}-${i + 1}`,
      cli,
      harness: args.harness || (ADAPTERS[cli] ? cli : undefined),
    }));
  }
  const runner = new Runner({
    room: args.room,
    url: args.url || `http://localhost:${args.port || process.env.PORT || 8787}`,
    timeoutMs: args.timeout ? parseInt(args.timeout, 10) : undefined,
    maxTurns: args['max-turns'] ? parseInt(args['max-turns'], 10) : undefined,
    dryRun: !!args['dry-run'],
    allowCustom: !!args['allow-custom'],
  });
  runner.run(specs).then(result => {
    if (!result) { console.log('\nEl debate no cerró o no hay resultado todavía.'); return; }
    console.log('\n═══ RESULTADO ═══');
    console.log(`Ganador: ${result.winner?.title} (${result.winner?.author})`);
    console.log(`Consenso: ${Math.round((result.consensus?.global || 0) * 100)}% · comprobaciones: ${result.checks?.length || 0}`);
    console.log(`Checksum: ${result.checksum}`);
    console.log(`Coste medido: ~${result.cost?.estTokens} tokens (media ${result.cost?.avgPerAgent}/agente)`);
  }).catch(err => {
    console.error('Runner falló:', err.message);
    process.exit(1);
  });
}

export { adapterList, extractJson };
