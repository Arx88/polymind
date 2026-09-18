// AGORA — motor del debate: máquina de estados, reglas, recuentos, persistencia.
// Sin dependencias. El servidor (server.mjs) es HTTP; esto es la lógica pura.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PHASE_ORDER = ['lobby','proposal','critique','revise','vote','tiebreak','objection','repair','synthesis','closed'];

export const DEFAULT_SETTINGS = {
  language: 'es',
  minAgents: 2,
  expectedAgents: 0,            // 0 = desconocido; auto-arranque por calma
  joinQuietMs: 90_000,          // sin entradas nuevas en este tiempo y hay mínimos → arranca
  maxDurationMs: 45 * 60_000,
  phaseMs: {
    lobby: 10 * 60_000, proposal: 8 * 60_000, critique: 6 * 60_000, revise: 6 * 60_000,
    vote: 4 * 60_000, tiebreak: 4 * 60_000, objection: 3 * 60_000, repair: 6 * 60_000, synthesis: 6 * 60_000,
  },
};

const CAPS = {
  task: 2000, context: 2000, criteria: 1000,
  proposalTitle: 120, proposalPlan: 4000, proposalRisks: 600, proposalAssumptions: 400,
  steelman: 300, objectionsPerCritique: 5, objectionText: 600,
  revisionNote: 300, tiebreakArg: 400, objectionMsg: 600, synthesisFinal: 6000, gist: 220,
};
export { CAPS };

const MOVE_KINDS = {
  lobby:     ['start'],
  proposal:  ['proposal'],
  critique:  ['critique'],
  revise:    ['revision', 'pass'],
  vote:      ['vote'],
  tiebreak:  ['argument', 'vote'],
  objection: ['objection', 'pass'],
  repair:    ['revision', 'pass'],
  synthesis: ['synthesis'],
  closed:    [],
};

function now() { return Date.now(); }
function uid(prefix) { return prefix + randomBytes(5).toString('hex'); }
function token() { return randomBytes(12).toString('base64url'); }
function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}
function gist(text, n = CAPS.gist) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
export function checksumOf(obj) {
  return 'sha256:' + createHash('sha256').update(stableStringify(obj)).digest('hex');
}

export class DebateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------------------------------------------------------------- sala nueva
const CODE_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
function makeCode() {
  return Array.from({ length: 6 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');
}

export function createRoom(input) {
  const task = clampStr(input.task || '', CAPS.task).trim();
  if (task.length < 10) throw new DebateError('bad_task', 'task: describe la tarea con al menos 10 caracteres');
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  s.phaseMs = { ...DEFAULT_SETTINGS.phaseMs, ...(input.settings?.phaseMs || {}) };
  if (typeof s.expectedAgents === 'number' && s.expectedAgents > 0) s.minAgents = Math.min(s.minAgents, s.expectedAgents);

  const room = {
    code: makeCode(),
    createdAt: now(),
    task,
    context: clampStr(input.context || '', CAPS.context),
    criteria: clampStr(input.criteria || '', CAPS.criteria),
    settings: s,
    status: 'lobby',
    adminToken: token(),
    agents: {},               // id -> {id,name,model,harness,token,joinedAt,lastSeenAt}
    order: [],                // ids en orden de llegada
    phase: { name: 'lobby', startedAt: now(), deadline: now() + s.phaseMs.lobby, data: {} },
    artifacts: {
      proposals: {},          // id -> {id,v,author,title,plan,risks,assumptions,history,gist,createdAt}
      critiques: {},          // id -> {id,target,author,steelman,objections:[{type,severity,text}]}
      tiebreak: { finalists: [], args: [], ballots: {} },
      objections: [],         // {id,by,text,severity,addressed}
    },
    lastMedians: null, lastBallots: null,
    log: [], logSeq: 0,
    result: null,
  };
  log(room, null, 'room', `Sala creada. Tarea: ${gist(task, 140)}`);
  return room;
}

function log(room, agentId, kind, text) {
  room.log.push({ id: ++room.logSeq, ts: now(), agentId, kind, text });
}

// ---------------------------------------------------------------- membresía
export function joinRoom(room, profile) {
  if (room.status !== 'lobby') throw new DebateError('closed_to_join', 'La sala ya comenzó: entra como observador con GET /api/rooms/' + room.code + '/public');
  const name = clampStr(String(profile.name || 'agente'), 40).trim() || 'agente';
  const taken = new Set(Object.values(room.agents).map(a => a.name));
  const finalName = taken.has(name) ? `${name}-${room.order.length + 1}` : name;
  const id = 'a' + (room.order.length + 1);
  const tok = token();
  room.agents[id] = {
    id, name: finalName,
    model: clampStr(String(profile.model || ''), 60),
    harness: clampStr(String(profile.harness || ''), 60),
    token: tok, joinedAt: now(), lastSeenAt: now(),
  };
  room.order.push(id);
  log(room, id, 'join', `${finalName} se une al debate${profile.model ? ` (${profile.model})` : ''}.`);
  maybeAutoStart(room);
  return { agentId: id, token: tok };
}

export function authAgent(room, agentId, tok) {
  const a = room.agents[agentId];
  if (!a || a.token !== tok) throw new DebateError('unauthorized', 'agentId o token inválido');
  a.lastSeenAt = now();
  return a;
}

// ---------------------------------------------------------------- arranque
export function canStart(room) {
  return room.status === 'lobby' && room.order.length >= room.settings.minAgents;
}
export function startRoom(room, byAgentId) {
  if (room.status !== 'lobby') return false;
  if (!canStart(room)) throw new DebateError('too_few', `Se requieren al menos ${room.settings.minAgents} agentes`);
  room.status = 'debate';
  log(room, byAgentId, 'phase', `¡Comienza el debate! ${room.order.length} participantes. Fase 1: propuestas a ciegas.`);
  enterPhase(room, 'proposal');
  return true;
}
function maybeAutoStart(room) {
  if (room.status !== 'lobby' || !canStart(room)) return;
  const s = room.settings;
  const n = room.order.length;
  if (s.expectedAgents > 0 && n >= s.expectedAgents) { startRoom(room, null); return; }
  const lastJoin = Math.max(...room.order.map(id => room.agents[id].joinedAt));
  if (now() - lastJoin >= s.joinQuietMs) startRoom(room, null);
}

// ---------------------------------------------------------------- fases
function enterPhase(room, name, extraData = {}) {
  const t = now();
  room.phase = { name, startedAt: t, deadline: t + (room.settings.phaseMs[name] || 5 * 60_000), data: { ...extraData } };
  const d = room.phase.data;
  const active = room.order;

  if (name === 'critique') {
    d.assignments = computeAssignments(room, active);
    log(room, null, 'phase', 'Fase de crítica: cada agente ataca las propuestas asignadas (advocatus diaboli).');
  } else if (name === 'vote') {
    d.ballots = {};
    log(room, null, 'phase', 'Fase de votación secreta: cada agente ordena las propuestas de mejor a peor.');
  } else if (name === 'tiebreak') {
    d.args = [];
    d.ballots = {};
    log(room, null, 'phase', `Empate entre ${d.finalists?.length || 0} finalistas: alegatos decisivos y segunda votación.`);
  } else if (name === 'objection') {
    d.responses = {};
    log(room, null, 'phase', 'Ventana de veto: ¿la ganadora tiene un fallo fatal? severity:"blocker" fuerza reparación.');
  } else if (name === 'repair') {
    d.responses = {};
    log(room, null, 'phase', 'Ronda de reparación: el autor responde a los vetos (revisión o defensa por escrito).');
  } else if (name === 'synthesis') {
    log(room, null, 'phase', 'Fase final: síntesis del plan ganador incorporando las mejores objeciones.');
  }
}

function computeAssignments(room, active) {
  const pids = Object.keys(room.artifacts.proposals);
  const assignments = {};
  if (!pids.length) return assignments;
  // modo solo: el agente se critica a sí mismo (autocrítica estructurada)
  if (active.length === 1) { assignments[active[0]] = [...pids]; return assignments; }
  const submitted = active.filter(id => pids.some(pid => room.artifacts.proposals[pid].author === id));
  let pool = submitted.filter(id => pids.some(pid => room.artifacts.proposals[pid].author !== id));
  if (!pool.length) pool = submitted.length ? submitted : active;
  const perAgent = pids.length >= pool.length ? 1 : 2;
  const queue = [];
  for (let k = 0; k < 2; k++) for (const pid of pids) queue.push(pid);
  let qi = 0;
  for (const aid of pool) {
    const targets = [];
    while (qi < queue.length && targets.length < perAgent) {
      const pid = queue[qi++];
      if (room.artifacts.proposals[pid].author === aid) continue;
      if (!targets.includes(pid)) targets.push(pid);
    }
    if (targets.length) assignments[aid] = targets;
  }
  // cobertura: toda propuesta con al menos un atacante
  for (const pid of pids) {
    if (!Object.values(assignments).some(t => t.includes(pid))) {
      const cands = pool.filter(id => id !== room.artifacts.proposals[pid].author);
      if (cands.length) (assignments[cands[0]] ||= []).push(pid);
    }
  }
  return assignments;
}

function phaseMsLeft(room) { return room.phase.deadline - now(); }

// avanzar cuando todos los requeridos respondieron
function maybeAdvance(room) {
  if (room.status === 'closed') return;
  const p = room.phase;
  const active = room.order;
  switch (p.name) {
    case 'proposal': {
      const submitted = active.filter(id => Object.values(room.artifacts.proposals).some(pr => pr.author === id));
      if (submitted.length >= active.length && active.length) {
        log(room, null, 'phase', `Propuestas reveladas: ${Object.keys(room.artifacts.proposals).length}. Pasan todas a revisión cruzada.`);
        enterPhase(room, 'critique');
      }
      break;
    }
    case 'critique': {
      const need = Object.keys(p.data.assignments || {}).length;
      const done = active.filter(id => {
        const targets = p.data.assignments?.[id] || [];
        return targets.every(pid => Object.values(room.artifacts.critiques).some(c => c.author === id && c.target === pid));
      }).length;
      if (need === 0 || done >= active.length) enterPhase(room, 'revise');
      break;
    }
    case 'revise': {
      const authors = reviseAuthors(room);
      if (authors.length === 0) { proceedToVote(room); break; }
      if (authors.every(id => p.data.responses?.[id])) proceedToVote(room);
      break;
    }
    case 'vote': {
      if (active.length && active.every(id => p.data.ballots[id])) tallyAndAdvance(room, false);
      break;
    }
    case 'tiebreak': {
      if (active.length && active.every(id => p.data.ballots[id])) tallyAndAdvance(room, true);
      break;
    }
    case 'objection': {
      if (active.length && active.every(id => p.data.responses?.[id])) afterObjections(room);
      break;
    }
    case 'repair': {
      const author = room.artifacts.proposals[p.data.winnerId]?.author;
      if (author && p.data.responses?.[author]) proceedToSynthesis(room, p.data.winnerId);
      break;
    }
    case 'synthesis': break; // termina por deadline o al recibir síntesis
  }
}

function reviseAuthors(room) {
  const serious = Object.values(room.artifacts.critiques).filter(c => c.objections.some(o => o.severity !== 'low'));
  const authors = new Set(
    serious.map(c => room.artifacts.proposals[c.target]?.author).filter(Boolean)
  );
  return [...authors];
}

function proceedToVote(room) {
  enterPhase(room, 'vote');
}

function tallyAndAdvance(room, isTiebreak) {
  const p = room.phase;
  const options = p.data.options || p.data.finalists || Object.keys(room.artifacts.proposals);
  const ballots = { ...p.data.ballots };
  const voters = Object.keys(ballots);
  room.lastBallots = ballots;
  if (!voters.length) { closeRoom(room, 'failed', 'Nadie votó; sin quórum.'); return; }
  const medians = computeMedians(options, ballots);
  room.lastMedians = medians;
  const createdAtOf = id => room.artifacts.proposals[id]?.createdAt || 0;
  const ranked = Object.entries(medians).sort((a, b) => a[1].median - b[1].median || a[1].sum - b[1].sum || createdAtOf(a[0]) - createdAtOf(b[0]));
  const top = ranked[0], second = ranked[1];
  const clear = !second || top[1].median < second[1].median ||
    (top[1].median === second[1].median && top[1].sum < second[1].sum);

  if (isTiebreak) {
    if (clear) { proceedToObjection(room, top[0]); return; }
    log(room, null, 'vote', 'Empate persistente: se decide por antigüedad de la propuesta.');
    proceedToObjection(room, ranked[0][0]);
    return;
  }
  if (clear) {
    const wp = room.artifacts.proposals[top[0]];
    log(room, null, 'vote', `Ganadora por votación: «${wp?.title || top[0]}» de ${room.agents[wp?.author]?.name || wp?.author || '?'}.`);
    proceedToObjection(room, top[0]);
    return;
  }
  enterPhase(room, 'tiebreak', { finalists: ranked.slice(0, 2).map(r => r[0]) });
}

function computeMedians(options, ballots) {
  const out = {};
  for (const oid of options) {
    const positions = Object.values(ballots).map(b => {
      const i = Array.isArray(b) ? b.indexOf(oid) : -1;
      return i === -1 ? options.length : i;
    }).sort((a, b) => a - b);
    const mid = Math.floor(positions.length / 2);
    const median = positions.length % 2 ? positions[mid] : Math.min(positions[mid - 1], positions[mid]);
    out[oid] = { median, sum: positions.reduce((a, b) => a + b, 0) };
  }
  return out;
}

function proceedToObjection(room, winnerId) {
  enterPhase(room, 'objection');
  room.phase.data.winnerId = winnerId;
}

function afterObjections(room) {
  const blockers = room.artifacts.objections.filter(o => o.severity === 'blocker');
  if (blockers.length) {
    const winnerId = room.phase.data.winnerId;
    enterPhase(room, 'repair', { winnerId, blockers: blockers.map(b => b.id) });
    return;
  }
  proceedToSynthesis(room, room.phase.data.winnerId);
}

function proceedToSynthesis(room, winnerId) {
  enterPhase(room, 'synthesis', { winnerId, authorId: room.artifacts.proposals[winnerId]?.author });
}

// ---------------------------------------------------------------- avanzar por plazo
export function sweep(room) {
  if (room.status === 'closed') return false;
  const t = now();
  if (t - room.createdAt > room.settings.maxDurationMs) { forceFinish(room); return true; }
  if (t < room.phase.deadline) return false;
  const p = room.phase.name;
  if (p === 'lobby') {
    if (room.order.length >= room.settings.minAgents) startRoom(room, null);
    else closeRoom(room, 'expired', 'Plazo de lobby agotado sin suficientes agentes.');
    return true;
  }
  if (p === 'proposal') {
    const missing = room.order.filter(id => !Object.values(room.artifacts.proposals).some(pr => pr.author === id));
    for (const id of missing) log(room, id, 'timeout', `${room.agents[id]?.name || id} no presentó propuesta a tiempo; continúa como evaluador.`);
    if (!Object.keys(room.artifacts.proposals).length) { closeRoom(room, 'failed', 'Ninguna propuesta a tiempo.'); return true; }
    log(room, null, 'phase', `Propuestas reveladas: ${Object.keys(room.artifacts.proposals).length}. Pasan todas a revisión cruzada.`);
    enterPhase(room, 'critique');
    maybeAdvance(room);
    return true;
  }
  if (p === 'critique') {
    const n = Object.values(room.artifacts.critiques).length;
    if (!n) log(room, null, 'phase', 'Plazo agotado sin críticas; se pasa a votación directa.');
    enterPhase(room, 'revise');
    maybeAdvance(room);
    return true;
  }
  if (p === 'revise') {
    log(room, null, 'phase', 'Fase de revisión cerrada por plazo.');
    proceedToVote(room);
    maybeAdvance(room);
    return true;
  }
  if (p === 'vote') {
    if (!Object.keys(room.phase.data.ballots).length) {
      closeRoom(room, 'failed', 'Plazo de votación agotado sin votos.');
      return true;
    }
    tallyAndAdvance(room, false);
    maybeAdvance(room);
    return true;
  }
  if (p === 'tiebreak') {
    if (!Object.keys(room.phase.data.ballots).length) {
      // nadie revotó: decide la primera ronda (medianas guardadas)
      const ranked = Object.entries(room.lastMedians || {}).sort((a, b) => a[1].median - b[1].median || a[1].sum - b[1].sum);
      if (!ranked.length) { closeRoom(room, 'failed', 'Desempate sin votos ni ronda previa.'); return true; }
      log(room, null, 'vote', 'Plazo del desempate sin votos: decide la primera votación.');
      proceedToObjection(room, ranked[0][0]);
      maybeAdvance(room);
      return true;
    }
    tallyAndAdvance(room, true);
    maybeAdvance(room);
    return true;
  }
  if (p === 'objection') {
    for (const id of room.order) {
      room.phase.data.responses ||= {};
      if (!room.phase.data.responses[id]) room.phase.data.responses[id] = { kind: 'pass' };
    }
    afterObjections(room);
    maybeAdvance(room);
    return true;
  }
  if (p === 'repair') {
    log(room, null, 'phase', 'Reparación no presentada a tiempo: los vetos quedan como disenso sin responder.');
    proceedToSynthesis(room, room.phase.data.winnerId);
    maybeAdvance(room);
    return true;
  }
  if (p === 'synthesis') {
    finishRoom(room);
    return true;
  }
  return false;
}

function forceFinish(room) {
  if (room.phase.name === 'vote' && Object.keys(room.phase.data.ballots || {}).length) {
    tallyAndAdvance(room, false);
    if (room.status === 'closed') return;
    if (room.phase.name !== 'vote') { sweep(room); return; }
  }
  const ps = Object.values(room.artifacts.proposals).sort((a, b) => a.createdAt - b.createdAt);
  if (ps.length) {
    log(room, null, 'timeout', 'Tiempo máximo del debate agotado: se congela la mejor propuesta disponible como resultado de emergencia.');
    finishRoom(room, ps[0].id);
  } else {
    closeRoom(room, 'expired', 'Tiempo máximo agotado sin material suficiente.');
  }
}

// ---------------------------------------------------------------- movimientos
export function applyMove(room, agentId, move) {
  if (room.status === 'closed') throw new DebateError('closed', 'El debate ya cerró.');
  const kind = move?.kind;
  const allowed = MOVE_KINDS[room.phase.name] || [];
  if (!allowed.includes(kind)) {
    throw new DebateError('wrong_phase', `Movimiento «${kind}» no válido en fase «${room.phase.name}». Consulta tu turno con /turn.`);
  }
  const a = room.agents[agentId];
  a.lastSeenAt = now();
  const d = room.phase.data;
  const caps = CAPS;

  switch (kind) {
    case 'start': {
      startRoom(room, agentId);
      return;
    }
    case 'proposal': {
      if (Object.values(room.artifacts.proposals).some(p => p.author === agentId)) {
        throw new DebateError('duplicate', 'Ya presentaste tu propuesta.');
      }
      const title = clampStr(move.payload?.title, caps.proposalTitle).trim();
      const plan = clampStr(move.payload?.plan, caps.proposalPlan).trim();
      if (!title || plan.length < 30) throw new DebateError('bad_payload', 'payload: {title (≤120), plan (30..4000), risks?, assumptions?}');
      const id = uid('p');
      room.artifacts.proposals[id] = {
        id, v: 1, author: agentId, title, plan,
        risks: clampStr(move.payload?.risks || '', caps.proposalRisks),
        assumptions: clampStr(move.payload?.assumptions || '', caps.proposalAssumptions),
        createdAt: now(), history: [], gist: gist(plan),
      };
      log(room, agentId, 'proposal', `${a.name} presenta su propuesta: «${title}» (oculta hasta revelar).`);
      break;
    }
    case 'critique': {
      const targets = d.assignments?.[agentId] || [];
      const target = move.payload?.target;
      if (!targets.includes(target)) {
        throw new DebateError('not_assigned', `No tienes asignada la propuesta ${target}. Tus objetivos: ${targets.join(', ') || 'ninguno'}.`);
      }
      if (Object.values(room.artifacts.critiques).some(c => c.author === agentId && c.target === target)) {
        throw new DebateError('duplicate', 'Ya criticaste esta propuesta.');
      }
      const steelman = clampStr(move.payload?.steelman || '', caps.steelman);
      const rawObs = Array.isArray(move.payload?.objections) ? move.payload.objections.slice(0, caps.objectionsPerCritique) : [];
      const objections = rawObs.map(o => ({
        type: ['risk','cost','feasibility','ethics','missing-info'].includes(o?.type) ? o.type : 'risk',
        severity: ['high','med','low'].includes(o?.severity) ? o.severity : 'med',
        text: clampStr(o?.text || '', caps.objectionText),
      })).filter(o => o.text.length > 5);
      if (!objections.length) throw new DebateError('bad_payload', 'payload.objections: ≥1 objeción concreta {type, severity, text}');
      const id = uid('c');
      room.artifacts.critiques[id] = { id, target, author: agentId, steelman, objections, createdAt: now() };
      const top = objections.find(o => o.severity === 'high') || objections[0];
      log(room, agentId, 'critique', `${a.name} ataca «${room.artifacts.proposals[target]?.title}»: ${objections.length} objeciones. Principal: «${gist(top.text, 110)}»`);
      break;
    }
    case 'pass': {
      if (room.phase.name === 'revise' || room.phase.name === 'repair' || room.phase.name === 'objection') {
        d.responses ||= {};
        if (d.responses[agentId]) throw new DebateError('duplicate', 'Ya respondiste en esta fase.');
        d.responses[agentId] = { kind: 'pass' };
        if (room.phase.name === 'revise') log(room, agentId, 'pass', `${a.name} mantiene su propuesta sin cambios.`);
        if (room.phase.name === 'repair') log(room, agentId, 'pass', `${a.name} defiende su versión original frente a los vetos.`);
      } else throw new DebateError('wrong_phase', 'pass no aplica en esta fase.');
      break;
    }
    case 'revision': {
      const isRepair = room.phase.name === 'repair';
      const proposals = room.artifacts.proposals;
      const pid = isRepair ? d.winnerId : move.payload?.proposalId;
      const pr = proposals[pid];
      if (!pr || pr.author !== agentId) throw new DebateError('not_author', 'Solo el autor puede revisar esa propuesta.');
      const plan = clampStr(move.payload?.plan, caps.proposalPlan).trim();
      if (plan.length < 30) throw new DebateError('bad_payload', 'payload: {proposalId?, plan (30..4000), note?}');
      pr.history.push({ v: pr.v, plan: pr.plan, note: pr.revisionNote || '' });
      pr.v += 1;
      pr.plan = plan;
      pr.gist = gist(plan);
      pr.revisionNote = clampStr(move.payload?.note || '', caps.revisionNote);
      d.responses ||= {};
      d.responses[agentId] = { kind: 'revision' };
      log(room, agentId, 'revision', `${a.name} publica v${pr.v} de «${pr.title}»${pr.revisionNote ? ` — ${gist(pr.revisionNote, 100)}` : ''}.`);
      break;
    }
    case 'vote': {
      const options = d.options || d.finalists || Object.keys(room.artifacts.proposals);
      const ranking = Array.isArray(move.payload?.ranking) ? move.payload.ranking.filter(x => options.includes(x)) : [];
      const uniq = [...new Set(ranking)];
      if (uniq.length !== options.length) {
        throw new DebateError('bad_payload', `ranking debe incluir TODAS las opciones (${options.join(',')}) en tu orden de preferencia.`);
      }
      d.ballots[agentId] = uniq;
      log(room, agentId, 'vote', `${a.name} emitió su voto (secreto).`);
      break;
    }
    case 'argument': {
      const text = clampStr(move.payload?.text, caps.tiebreakArg).trim();
      const target = move.payload?.target;
      if (!text || !d.finalists.includes(target)) throw new DebateError('bad_payload', `payload: {target: uno de ${d.finalists.join('|')}, text ≤400}`);
      if (d.args.some(x => x.by === agentId)) throw new DebateError('duplicate', 'Ya presentaste tu alegato.');
      d.args.push({ by: agentId, target, text });
      log(room, agentId, 'argument', `${a.name} defiende «${room.artifacts.proposals[target]?.title}»: «${gist(text, 120)}»`);
      break;
    }
    case 'objection': {
      d.responses ||= {};
      if (d.responses[agentId]) throw new DebateError('duplicate', 'Ya respondiste en esta fase.');
      const text = clampStr(move.payload?.text, caps.objectionMsg).trim();
      const severity = move.payload?.severity === 'blocker' ? 'blocker' : 'concern';
      if (text.length < 15) throw new DebateError('bad_payload', 'payload: {text 15..600, severity: blocker|concern}');
      const id = uid('o');
      room.artifacts.objections.push({ id, by: agentId, text, severity, addressed: false });
      d.responses[agentId] = { kind: 'objection', id };
      log(room, agentId, 'objection', `${a.name} ${severity === 'blocker' ? 'VETA el resultado:' : 'observa:'} «${gist(text, 130)}»`);
      break;
    }
    case 'synthesis': {
      const final = clampStr(move.payload?.final, caps.synthesisFinal).trim();
      if (final.length < 50) throw new DebateError('bad_payload', 'payload: {final (50..6000), merges?: [ids de objeciones incorporadas]}');
      for (const id of (move.payload?.merges || [])) {
        const o = room.artifacts.objections.find(x => x.id === id);
        if (o) o.addressed = true;
      }
      room.phase.data.synthesis = { final, merges: move.payload?.merges || [] };
      log(room, agentId, 'synthesis', `${a.name} publica la síntesis final. Cerrando debate…`);
      finishRoom(room);
      return;
    }
  }
  maybeAdvance(room);
}

// ---------------------------------------------------------------- cierre
export function finishRoom(room, fallbackWinnerId = null) {
  if (room.status === 'closed') return;
  const wid = fallbackWinnerId || room.phase.data?.winnerId;
  const wp = wid ? room.artifacts.proposals[wid] : null;
  if (!wp) { closeRoom(room, 'failed', 'Sin propuesta ganadora identificable.'); return; }
  const synthesis = room.phase.data?.synthesis || null;
  const nameOf = id => room.agents[id]?.name || id;
  const dissent = room.artifacts.objections.map(o => ({
    by: nameOf(o.by), text: o.text, severity: o.severity, addressed: o.addressed,
  }));
  const result = {
    task: room.task, language: room.settings.language,
    outcome: 'decided',
    winner: { id: wid, title: wp.title, author: nameOf(wp.author), version: wp.v, plan: wp.plan },
    final: synthesis ? synthesis.final : wp.plan,
    finalSource: synthesis ? 'synthesis' : 'winner',
    dissent,
    medians: room.lastMedians ? Object.fromEntries(Object.entries(room.lastMedians).map(([k, v]) => [room.artifacts.proposals[k]?.title || k, v])) : {},
    ballots: room.lastBallots ? Object.fromEntries(Object.entries(room.lastBallots).map(([aid, r]) => [nameOf(aid), r.map(id => room.artifacts.proposals[id]?.title || id)])) : {},
    stats: { agents: room.order.length, proposals: Object.keys(room.artifacts.proposals).length, critiques: Object.keys(room.artifacts.critiques).length, objections: room.artifacts.objections.length, durationMin: Math.round((now() - room.createdAt) / 60000) },
  };
  result.checksum = checksumOf({ code: room.code, task: result.task, winner: result.winner, final: result.final });
  room.result = result;
  room.status = 'closed';
  room.phase = { name: 'closed', startedAt: now(), deadline: now(), data: {} };
  log(room, null, 'closed', `DEBATE CERRADO. Resultado: «${wp.title}». Checksum ${result.checksum.slice(0, 19)}…`);
}

export function closeRoom(room, outcome, reason) {
  if (room.status === 'closed') return;
  const nameOf = id => room.agents[id]?.name || id;
  room.result = {
    task: room.task, language: room.settings.language, outcome, reason,
    winner: null, final: '',
    dissent: room.artifacts.objections.map(o => ({ by: nameOf(o.by), text: o.text, severity: o.severity, addressed: o.addressed })),
    checksum: checksumOf({ code: room.code, outcome, reason }),
    stats: { agents: room.order.length, durationMin: Math.round((now() - room.createdAt) / 60000) },
  };
  room.status = 'closed';
  room.phase = { name: 'closed', startedAt: now(), deadline: now(), data: {} };
  log(room, null, 'closed', `DEBATE CERRADO (${outcome}): ${reason}`);
}

// ---------------------------------------------------------------- vistas para agentes
export function currentTurn(room, agentId) {
  const a = room.agents[agentId];
  if (!a) throw new DebateError('unknown_agent', 'Únete primero con /join.');
  a.lastSeenAt = now();
  const p = room.phase;
  const base = {
    phase: room.status === 'closed' ? 'closed' : p.name,
    status: room.status,
    deadlineInSec: room.status === 'closed' ? 0 : Math.max(0, Math.round(phaseMsLeft(room) / 1000)),
    language: room.settings.language,
    room: room.code,
  };
  if (room.status === 'closed') {
    return { ...base, action: 'done', message: `Debate cerrado. Obtén el resultado con GET /api/rooms/${room.code}/result?agent=${agentId}&token=... y repórtalo a tu usuario con el checksum.` };
  }
  if (room.status === 'lobby') {
    const canI = canStart(room);
    return { ...base, phase: 'lobby', action: canI ? 'start-or-wait' : 'wait', message: canI
      ? 'Ya hay suficientes agentes: puedes POST move {kind:"start"} o esperar el auto-arranque.'
      : `Esperando a más agentes (mínimo ${room.settings.minAgents}).` };
  }
  const d = p.data;
  switch (p.name) {
    case 'proposal': {
      const mine = Object.values(room.artifacts.proposals).some(x => x.author === agentId);
      if (mine) return { ...base, action: 'wait', message: 'Propuesta recibida. Esperando al resto (ciegas: las ajenas se revelan al cerrar la fase).' };
      return {
        ...base, action: 'submit-proposal',
        task: room.task, context: room.context, criteria: room.criteria,
        message: 'Presenta TU propuesta inicial. Ciega: no leas ni esperes las ajenas. Concreta y ejecutable.',
        payloadSchema: { title: 'string ≤120', plan: 'string 30..4000 — pasos concretos', risks: 'string ≤600 opcional', assumptions: 'string ≤400 opcional' },
      };
    }
    case 'critique': {
      const pending = (d.assignments?.[agentId] || [])
        .filter(pid => !Object.values(room.artifacts.critiques).some(c => c.author === agentId && c.target === pid));
      if (!pending.length) return { ...base, action: 'wait', message: 'Sin crítica pendiente. Espera la siguiente fase.' };
      return {
        ...base, action: 'submit-critique',
        targets: pending.map(pid => {
          const pr = room.artifacts.proposals[pid];
          return { id: pid, title: pr.title, author: room.agents[pr.author]?.name, plan: pr.plan, risks: pr.risks, assumptions: pr.assumptions };
        }),
        message: 'Ataca la propuesta asignada: riesgos reales, huecos, fallos de implementación. Primero steelman (su mejor versión en 1 frase), luego objeciones concretas con ejemplo de fallo.',
        payloadSchema: { target: 'proposal id', steelman: 'string ≤300 opcional', objections: '[{type: risk|cost|feasibility|ethics|missing-info, severity: high|med|low, text ≤600}] máx 5' },
      };
    }
    case 'revise': {
      const mine = Object.values(room.artifacts.proposals).find(x => x.author === agentId);
      if (!mine) return { ...base, action: 'wait', message: 'No tienes propuesta que revisar.' };
      if (d.responses?.[agentId]) return { ...base, action: 'wait', message: 'Ya respondiste. Esperando al resto.' };
      const crits = Object.values(room.artifacts.critiques).filter(c => c.target === mine.id);
      if (!crits.length) return { ...base, action: 'wait', message: 'Sin críticas contra tu propuesta: espera la votación.' };
      return {
        ...base, action: 'submit-revision-or-pass',
        proposalId: mine.id, currentVersion: mine.v,
        critiques: crits.map(c => ({ by: room.agents[c.author]?.name, steelman: c.steelman, objections: c.objections })),
        message: 'Responde a las objeciones: publica versión revisada o pasa. No ignores objeciones high/med sin motivo.',
        payloadSchema: `{proposalId:"${mine.id}", plan:"30..4000", note:"≤300 qué cambiaste"}  o  {kind:"pass"}`,
      };
    }
    case 'vote': {
      const options = d.options || d.finalists || Object.keys(room.artifacts.proposals);
      if (d.ballots?.[agentId]) return { ...base, action: 'wait', message: 'Voto recibido (secreto).' };
      return {
        ...base, action: 'submit-vote',
        options: options.map(pid => { const pr = room.artifacts.proposals[pid]; return { id: pid, title: pr.title, author: room.agents[pr.author]?.name, gist: pr.gist, version: pr.v }; }),
        message: 'Ordena TODAS las opciones de mejor a peor. Voto secreto hasta el cierre.',
        payloadSchema: { ranking: `[${options.join(',')}] en tu orden de preferencia` },
      };
    }
    case 'tiebreak': {
      if (d.ballots?.[agentId]) return { ...base, action: 'wait', message: 'Voto del desempate recibido.' };
      if ((d.args || []).some(x => x.by === agentId)) {
        return {
          ...base, action: 'submit-vote',
          options: d.finalists.map(pid => { const pr = room.artifacts.proposals[pid]; return { id: pid, title: pr.title, gist: pr.gist, version: pr.v }; }),
          message: 'Segunda votación entre finalistas (tras leer los alegatos).',
          payloadSchema: { ranking: `[${d.finalists.join(',')}]` },
        };
      }
      return {
        ...base, action: 'submit-argument',
        finalists: d.finalists.map(pid => { const pr = room.artifacts.proposals[pid]; return { id: pid, title: pr.title, gist: pr.gist, version: pr.v }; }),
        message: 'Empate: un alegato decisivo (≤400) por uno de los finalistas; después vota de nuevo.',
        payloadSchema: { target: 'finalist id', text: 'string ≤400' },
      };
    }
    case 'objection': {
      if (d.responses?.[agentId]) return { ...base, action: 'wait', message: 'Respuesta registrada.' };
      const wp = room.artifacts.proposals[d.winnerId];
      return {
        ...base, action: 'objection-or-pass',
        winner: { id: d.winnerId, title: wp.title, plan: wp.plan, version: wp.v },
        message: '¿Fallo FATAL en la ganadora? severity:"blocker" fuerza ronda de reparación. Preocupación menor: "concern". Nada que objetar: pass.',
        payloadSchema: '{text:"15..600", severity:"blocker|concern"}  o  {kind:"pass"}',
      };
    }
    case 'repair': {
      const wp = room.artifacts.proposals[d.winnerId];
      if (wp.author !== agentId) return { ...base, action: 'wait', message: `${room.agents[wp.author]?.name} está reparando los vetos.` };
      if (d.responses?.[agentId]) return { ...base, action: 'wait', message: 'Respuesta recibida: se pasa a la síntesis.' };
      const blockers = room.artifacts.objections.filter(o => o.severity === 'blocker');
      return {
        ...base, action: 'submit-revision-or-pass',
        proposalId: wp.id,
        blockers: blockers.map(o => ({ by: room.agents[o.by]?.name, text: o.text })),
        message: 'Vetos contra tu plan: revisa la propuesta abordándolos, o pasa (el disenso quedará registrado sin responder).',
        payloadSchema: '{plan:"30..4000", note:"≤300"}  o  {kind:"pass"}',
      };
    }
    case 'synthesis': {
      if (d.authorId !== agentId) return { ...base, action: 'wait', message: `${room.agents[d.authorId]?.name || 'el autor'} está redactando la síntesis final.` };
      const wp = room.artifacts.proposals[d.winnerId];
      return {
        ...base, action: 'submit-synthesis',
        winner: { id: d.winnerId, title: wp.title, plan: wp.plan, version: wp.v },
        objections: room.artifacts.objections.map(o => ({ id: o.id, by: room.agents[o.by]?.name, severity: o.severity, text: o.text, addressed: o.addressed })),
        medians: room.lastMedians ? Object.fromEntries(Object.entries(room.lastMedians).map(([k, v]) => [room.artifacts.proposals[k]?.title || k, v])) : {},
        message: 'Redacta el PLAN FINAL EJECUTABLE: fusiona la ganadora con las objeciones válidas; marca en merges[] los ids incorporados. Lo no incorporado queda como disenso registrado.',
        payloadSchema: { final: 'string 50..6000', merges: '[ids de objeciones]' },
      };
    }
  }
  return { ...base, action: 'wait', message: 'Espera.' };
}

export function agentState(room, agentId, since = 0) {
  const a = room.agents[agentId];
  if (!a) throw new DebateError('unknown_agent', 'Agente desconocido');
  const nameOf = id => room.agents[id]?.name || id;
  const entries = room.log.filter(l => l.id > since).slice(-40).map(l => ({
    id: l.id, ts: l.ts, by: l.agentId ? nameOf(l.agentId) : 'sistema', kind: l.kind, text: l.text,
  }));
  const blind = room.status === 'debate' && room.phase.name === 'proposal';
  const proposals = Object.values(room.artifacts.proposals)
    .filter(pr => !blind || pr.author === agentId)
    .map(pr => ({ id: pr.id, title: pr.title, author: nameOf(pr.author), version: pr.v, gist: pr.gist }));
  return {
    room: room.code, task: room.task, context: room.context, criteria: room.criteria,
    status: room.status, phase: room.phase.name,
    deadlineInSec: Math.max(0, Math.round(phaseMsLeft(room) / 1000)),
    language: room.settings.language,
    agents: room.order.map(id => ({ name: room.agents[id].name, model: room.agents[id].model, harness: room.agents[id].harness })),
    proposals,
    objections: room.artifacts.objections.map(o => ({ id: o.id, by: nameOf(o.by), severity: o.severity, text: o.text, addressed: o.addressed })),
    log: entries,
    result: room.status === 'closed' ? room.result : undefined,
  };
}

// vista para humanos (UI): sin tokens; votos solo al cerrar
export function publicRoom(room) {
  const closed = room.status === 'closed';
  const nameOf = id => room.agents[id]?.name || id;
  return {
    code: room.code, createdAt: room.createdAt, task: room.task, context: room.context, criteria: room.criteria,
    settings: { language: room.settings.language, minAgents: room.settings.minAgents, expectedAgents: room.settings.expectedAgents },
    status: room.status,
    phase: closed ? 'closed' : room.phase.name,
    deadlineInSec: closed ? 0 : Math.max(0, Math.round(phaseMsLeft(room) / 1000)),
    agents: room.order.map(id => ({ id, name: nameOf(id), model: room.agents[id].model, harness: room.agents[id].harness, lastSeenAt: room.agents[id].lastSeenAt })),
    proposals: Object.values(room.artifacts.proposals).map(p => ({ id: p.id, title: p.title, authorName: nameOf(p.author), version: p.v, gist: p.gist, plan: p.plan, risks: p.risks, assumptions: p.assumptions, revisionNote: p.revisionNote })),
    critiques: Object.values(room.artifacts.critiques).map(c => ({ id: c.id, authorName: nameOf(c.author), target: c.target, targetTitle: room.artifacts.proposals[c.target]?.title, steelman: c.steelman, objections: c.objections })),
    objections: room.artifacts.objections.map(o => ({ id: o.id, byName: nameOf(o.by), severity: o.severity, text: o.text, addressed: o.addressed })),
    tiebreakArgs: (room.phase?.data?.args || []).map(x => ({ byName: nameOf(x.by), target: x.target, targetTitle: room.artifacts.proposals[x.target]?.title, text: x.text })),
    log: room.log.map(l => ({ id: l.id, ts: l.ts, by: l.agentId ? nameOf(l.agentId) : 'sistema', kind: l.kind, text: l.text })),
    ballots: closed && room.lastBallots
      ? Object.fromEntries(Object.entries(room.lastBallots).map(([aid, r]) => [nameOf(aid), r.map(id => room.artifacts.proposals[id]?.title || id)]))
      : undefined,
    result: closed ? room.result : undefined,
  };
}

// ---------------------------------------------------------------- persistencia
export class Hall {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }
  fileOf(code) { return path.join(this.dir, code + '.json'); }
  create(input) {
    const room = createRoom(input);
    this.cache.set(room.code, room);
    this.persist(room);
    return room;
  }
  get(code) {
    code = String(code || '').toLowerCase();
    let room = this.cache.get(code);
    if (!room) {
      const f = this.fileOf(code);
      if (!fs.existsSync(f)) return null;
      try { room = JSON.parse(fs.readFileSync(f, 'utf8')); }
      catch { return null; }
      this.cache.set(code, room);
    }
    room.__changed = sweep(room) || room.__changed || false;
    return room;
  }
  persist(room) {
    const f = this.fileOf(room.code);
    const tmp = f + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(room)); fs.renameSync(tmp, f); }
    catch { /* disco lleno etc.: seguir en memoria */ }
  }
  list() {
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      const room = this.get(f.slice(0, -5));
      if (!room) continue;
      out.push({
        code: room.code, task: gist(room.task, 120), status: room.status,
        phase: room.status === 'closed' ? 'closed' : room.phase.name,
        agents: room.order.length, createdAt: room.createdAt,
        outcome: room.result?.outcome || null,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
