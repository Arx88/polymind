// AGORA v2 — servidor MCP sobre stdio, sin dependencias.
//
// MCP es solo JSON-RPC 2.0 delimitado por líneas: implementarlo a mano (~250
// líneas) evita arrastrar un SDK al servidor y basta para las herramientas que un
// agente necesita para debatir, auditar el código y trabajar sobre él.
//
//   node server/transports/mcp.mjs --room CODE --name "Analista-1" [--url http://localhost:8787]
//
// Herramientas: debate_join · debate_turn (bloqueante) · debate_submit ·
//               debate_repo (índice, búsqueda, archivo o diff) · debate_result

import readline from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'agora', version: '2.0.0' };

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

const TOOLS = [
  {
    name: 'debate_join',
    description: 'Entra en la sala de debate AGORA. Devuelve tu agentId y la agenda de decisión. Este debate es entre harnesses: no hay rol que aceptar. Declara tu harness y tu modelo y participa como eres. Solo hace falta la primera vez.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre con el que aparecerás en el debate' },
        harness: { type: 'string', description: 'Tu harness (claude-code, codex, cursor, zcode, cli propia…). Es tu identidad en la sala.' },
        model: { type: 'string', description: 'Modelo con el que estás participando' },
        lens: { type: 'string', description: 'OPCIONAL: lente que declaras tú mismo (texto libre o una conocida). Nadie te la asigna; si no la pones, debate sin lente.' },
        capabilities: { type: 'array', items: { type: 'string', enum: ['data', 'web', 'logic', 'creativity', 'risk', 'synthesis', 'negotiation', 'ethics', 'vision'] }, description: 'OPCIONAL: lo que de verdad puedes hacer. Declarar vision obliga: el servidor te entrega las capturas del artefacto y espera tu firma en cada afirmación de aspecto' },
      },
    },
  },
  {
    name: 'debate_turn',
    description: 'Bloquea hasta que te toque actuar y devuelve la acción exacta con su esquema de payload (o action:"done" al cerrarse el debate). No consume cómputo mientras espera.',
    inputSchema: {
      type: 'object',
      properties: {
        wait: { type: 'number', description: 'Segundos máximos de bloqueo (por defecto 120)' },
        since: { type: 'number', description: 'Último logSeq visto, para recibir solo el delta' },
      },
    },
  },
  {
    name: 'debate_submit',
    description: 'Envía tu movimiento (kind y payload del turno actual). Devuelve avisos de normalización y tu siguiente turno.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'El valor de action del turno: start, point-proposal, rule-change, ratify, pass, finding, proposal, critique, revision, concede, vote, argument, objection, synthesis, verification, claim-item, submit-patch, review-patch' },
        payload: { type: 'object', description: 'Payload según el esquema del turno' },
        idempotencyKey: { type: 'string', description: 'Clave para que un reintento no duplique el movimiento' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'debate_repo',
    description: 'Solo si la sala trae repositorio: lee el código sobre el que se debate y se trabaja (índice, búsqueda o archivo) o lleva el diff final de la rama. Sin argumentos devuelve el índice. Lo que lees cuenta en tu coste: busca antes de leer archivos enteros.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa dentro del repo (por ejemplo src/pricing.mjs)' },
        query: { type: 'string', description: 'Patrón a buscar en el código (devuelve archivo:línea)' },
        regex: { type: 'boolean', description: 'Trata `query` como expresión regular' },
        from: { type: 'number', description: 'Primera línea a leer (1 por defecto)' },
        lines: { type: 'number', description: 'Cuántas líneas leer (200 por defecto)' },
        diff: { type: 'boolean', description: 'Devuelve el diff acumulado de la rama de la sala' },
      },
    },
  },
  {
    name: 'debate_result',
    description: 'Devuelve el resultado congelado: plan final, comprobaciones de verificación, consenso por punto, disenso, checksum y, si hubo repo, la rama con sus commits, tareas y verificación.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export class AgoraMcpServer {
  constructor({ url, room, name, role, capabilities, model, harness }) {
    this.base = (url || 'http://localhost:8787').replace(/\/$/, '');
    this.room = room;
    this.profile = { name: name || 'agente-mcp', role, capabilities, model: model || 'mcp', harness: harness || 'mcp' };
    this.agentId = null;
    this.token = null;
    this.logSeq = 0;
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

  async join(overrides = {}) {
    if (this.agentId && this.token) return { alreadyJoined: true, agentId: this.agentId, lens: this.currentLens };
    const profile = { ...this.profile, ...overrides };
    const out = await this.api(`/api/rooms/${this.room}/join`, { method: 'POST', body: profile });
    this.agentId = out.agentId;
    this.token = out.token;
    this.currentLens = out.role;
    return {
      agentId: out.agentId,
      harness: out.harness,
      model: out.model,
      lens: out.role, // null si no declaraste ninguna: es lo normal
      seat: out.seat,
      replacement: out.replacement,
      phase: out.phase,
      agenda: out.turn?.agenda || [],
      hint: out.turn?.message || null,
      briefing: out.briefing,
    };
  }

  async turn(wait = 120, since = 0) {
    await this.join();
    const out = await this.api(`/api/rooms/${this.room}/turn?agent=${this.agentId}&token=${this.token}&wait=${wait}&since=${since || this.logSeq}`);
    if (out.turn?.logSeq) this.logSeq = out.turn.logSeq;
    return out.turn;
  }

  async submit(kind, payload, idempotencyKey) {
    await this.join();
    const out = await this.api(`/api/rooms/${this.room}/move`, {
      method: 'POST',
      body: { agentId: this.agentId, token: this.token, kind, payload, idempotencyKey },
    });
    if (out.turn?.logSeq) this.logSeq = out.turn.logSeq;
    return { warnings: out.warnings || [], replayed: !!out.replayed, turn: out.turn };
  }

  // Lectura del repositorio de la sala. El servidor cobra estas lecturas al agente
  // (son su coste), así que se pide solo lo necesario: búsqueda antes que archivos.
  async repo({ path: rel, query, regex, from, lines, diff } = {}) {
    await this.join();
    const creds = new URLSearchParams({ agent: this.agentId, token: this.token });
    if (diff) {
      const res = await fetch(`${this.base}/api/rooms/${this.room}/work.diff?${creds.toString()}`);
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(text.slice(0, 200) || `HTTP ${res.status}`), { code: 'repo_error' });
      return { diff: text };
    }
    if (rel) creds.set('path', rel);
    if (query) { creds.set('q', query); if (regex) creds.set('regex', '1'); }
    if (from) creds.set('from', String(from));
    if (lines) creds.set('lines', String(lines));
    return this.api(`/api/rooms/${this.room}/repo?${creds.toString()}`);
  }

  async result() {
    await this.join();
    const out = await this.api(`/api/rooms/${this.room}/result?agent=${this.agentId}&token=${this.token}`);
    return out.closed ? out.result : { closed: false, phase: out.phase, deadlineInSec: out.deadlineInSec };
  }

  async call(name, args = {}) {
    switch (name) {
      case 'debate_join': return this.join(args);
      case 'debate_turn': return this.turn(args.wait ?? 120, args.since ?? 0);
      case 'debate_submit': return this.submit(args.kind, args.payload || {}, args.idempotencyKey);
      case 'debate_repo': return this.repo(args);
      case 'debate_result': return this.result();
      default: throw Object.assign(new Error(`Herramienta desconocida: ${name}`), { code: 'unknown_tool' });
    }
  }
}

export function serveMcp({ input = process.stdin, output = process.stdout, server }) {
  const rl = readline.createInterface({ input });
  const write = obj => output.write(JSON.stringify(obj) + '\n');
  const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  rl.on('line', async line => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); }
    catch { fail(null, -32700, 'JSON inválido'); return; }
    const { id, method, params } = msg;
    try {
      switch (method) {
        case 'initialize':
          ok(id, {
            protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: 'Sala AGORA. Llama a debate_join, luego repite debate_turn → debate_submit hasta action:"done", y termina con debate_result. Reporta el checksum a tu usuario.',
          });
          return;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;
        case 'ping':
          ok(id, {});
          return;
        case 'tools/list':
          ok(id, { tools: TOOLS });
          return;
        case 'tools/call': {
          const name = params?.name;
          const args = params?.arguments || {};
          try {
            const result = await server.call(name, args);
            ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
          } catch (err) {
            ok(id, {
              isError: true,
              content: [{ type: 'text', text: `Error (${err.code || 'error'}): ${err.message}` }],
            });
          }
          return;
        }
        default:
          if (id !== undefined) fail(id, -32601, `Método no soportado: ${method}`);
      }
    } catch (err) {
      if (id !== undefined) fail(id, -32603, err.message);
    }
  });

  return new Promise(resolve => rl.on('close', resolve));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const args = parseArgs();
  if (!args.room) {
    console.error('Uso: node server/transports/mcp.mjs --room CODE --name "Nombre" [--url http://localhost:8787] [--harness claude] [--model sonnet] [--lens analyst]');
    process.exit(1);
  }
  const caps = args.capabilities ? String(args.capabilities).split(',').filter(Boolean) : undefined;
  const server = new AgoraMcpServer({
    url: args.url, room: args.room, name: args.name,
    lens: args.lens || args.role, // la lente es opcional y siempre declarada por el agente
    capabilities: caps, model: args.model, harness: args.harness || 'mcp',
  });
  serveMcp({ server });
}
