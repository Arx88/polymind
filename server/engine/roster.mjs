// AGORA v2 — plantilla de participantes: entrada, roles, capacidades, vacantes,
// asignación de críticas (advocatus diaboli) y de verificación independiente.

import { now, token, clampStr, arr, oneOf, DebateError } from './util.mjs';
import { CAPABILITY_IDS, roleLabel, lensFor, normalizeLens, offlineGraceMs } from './settings.mjs';
import { log, activeAgents, nameOf, nextSeat, proposalOf } from './state.mjs';

// ---------------------------------------------------------------- entrada
export function joinRoom(room, profile = {}) {
  const name = clampStr(String(profile.name || 'agente'), 40) || 'agente';
  // La lente es opcional y siempre declarada por el agente. El servidor NO reparte
  // identidades: quien no declara nada debate como su harness (y su modelo).
  const declared = normalizeLens(profile.lens || profile.role);
  const capabilities = normalizeCapabilities(profile.capabilities);

  if (room.status !== 'lobby') {
    const seat = takeVacancy(room);
    if (seat && room.settings.allowMidJoin !== false) {
      return register(room, { name, profile, role: declared || seat.role, capabilities, seat, replacementOf: seat.agentId });
    }
    throw new DebateError('closed_to_join',
      `La sala ya comenzó (fase ${room.phase.name}). ` +
      (room.vacancies.length ? 'No quedan vacantes.' : 'Sin vacantes abiertas.') +
      ` Lectura en vivo: GET /api/rooms/${room.code}/public`);
  }
  return register(room, { name, profile, role: declared, capabilities, seat: null, replacementOf: null });
}

function register(room, { name, profile, role, capabilities, seat, replacementOf }) {
  const taken = new Set(Object.values(room.agents).map(a => a.name));
  const finalName = taken.has(name) ? `${name}-${room.order.length + 1}` : name;
  const id = seat?.agentId || nextSeat(room);
  const tok = token();
  room.agents[id] = {
    ...(room.agents[id] || {}),
    id,
    name: finalName,
    model: clampStr(String(profile.model || ''), 60),
    harness: clampStr(String(profile.harness || ''), 60),
    role,
    capabilities,
    token: tok,
    joinedAt: now(),
    lastSeenAt: now(),
    status: 'active',
    recoveryVacancy: false,
    overBudget: false,
    servedChars: 0,
    sentChars: 0,
    replacementOf: replacementOf || null,
    reportedProblem: clampStr(String(profile.problem || ''), 200),
  };
  if (!room.order.includes(id)) room.order.push(id);

  if (replacementOf) {
    const vacIdx = room.vacancies.findIndex(v => v.agentId === replacementOf);
    if (vacIdx >= 0) room.vacancies.splice(vacIdx, 1);
    const inherited = proposalOf(room, replacementOf);
    if (inherited && !inherited.conceded) {
      inherited.author = id;
      inherited.reassignedFrom = replacementOf;
      inherited.reassignedAt = now();
    }
    log(room, id, 'join', `${finalName} entra como reemplazo de ${nameOf(room, replacementOf)}${harnessOf(profile, role)}.`);
  } else {
    log(room, id, 'join', `${finalName} se une al debate${harnessOf(profile, role)}.`);
  }
  return {
    agentId: id, token: tok, role,
    harness: room.agents[id].harness || null,
    model: room.agents[id].model || null,
    seat: id,
    replacement: !!replacementOf,
  };
}

export function authAgent(room, agentId, tok) {
  const a = room.agents[agentId];
  if (!a || a.token !== tok) throw new DebateError('unauthorized', 'agentId o token inválido');
  a.lastSeenAt = now();
  if (a.recoveryVacancy && a.status === 'absent' && room.status === 'debate' && room.vacancies.some(v => v.agentId === agentId)) {
    a.status = 'active';
    delete a.recoveryVacancy;
    room.vacancies = room.vacancies.filter(v => v.agentId !== agentId);
    log(room, agentId, 'recovery', `${a.name} vuelve a dar señal y recupera su asiento aún vacante.`);
  }
  return a;
}

function normalizeCapabilities(raw) {
  const list = arr(raw).map(c => String(typeof c === 'object' ? c?.id : c).toLowerCase().trim());
  const out = list.filter(c => CAPABILITY_IDS.includes(c));
  return [...new Set(out)];
}

// Texto del registro de entrada: identifica por harness y modelo, no por personaje.
function harnessOf(profile, role) {
  const parts = [];
  if (profile.harness) parts.push(String(profile.harness));
  if (profile.model) parts.push(String(profile.model));
  const head = parts.length ? ` (${parts.join(' · ')})` : '';
  return role ? `${head} con lente declarada «${roleLabel(role)}»` : head;
}

// Quién es este agente para sí mismo: su harness, su modelo y, solo si lo declaró,
// su lente. Sin lente no se le inyecta ninguna.
export function identityBrief(room, agentId) {
  const agent = room.agents[agentId];
  if (!agent) return null;
  return {
    name: agent.name,
    harness: agent.harness || null,
    model: agent.model || null,
    lens: agent.role || null,
    // Cadena vacía si declaró una lente libre sin descripción: mejor null que ruido.
    lensNote: (agent.role && lensFor(agent.role, room.settings.language)) || null,
    capabilities: agent.capabilities,
    capabilityNote: capabilityNote(agent),
    seat: agent.id,
    replacementOf: agent.replacementOf ? nameOf(room, agent.replacementOf) : null,
  };
}

// Las capacidades declaradas condicionan lo que se te puede exigir.
function capabilityNote(agent) {
  if (!agent) return null;
  const missing = [];
  if (!agent.capabilities.includes('web')) missing.push('no exijas ni prometas fuentes externas');
  if (!agent.capabilities.includes('data')) missing.push('evita pedir cálculos con datos que no tienes');
  return missing.length ? `(${missing.join('; ')})` : null;
}

function profileName(room, agent) {
  return { name: agent.name, model: agent.model, harness: agent.harness };
}

// ---------------------------------------------------------------- vacantes
export function openVacancy(room, agentId, reason = 'incomparecencia') {
  if (room.vacancies.some(v => v.agentId === agentId)) return null;
  const agent = room.agents[agentId];
  const vacancy = {
    agentId,
    name: agent?.name || agentId,
    role: agent?.role || null,
    reason,
    since: now(),
  };
  room.vacancies.push(vacancy);
  log(room, agentId, 'vacancy', `Asiento de ${vacancy.name} queda vacante (${reason}). Un reemplazo puede ocuparlo.`);
  return vacancy;
}

export function takeVacancy(room) {
  if (!room.vacancies.length) return null;
  const sorted = [...room.vacancies].sort((a, b) => a.since - b.since);
  return sorted[0];
}

export function markAbsent(room, agentId, reason = 'no respondió a tiempo') {
  const agent = room.agents[agentId];
  if (!agent || agent.status === 'absent') return false;
  agent.status = 'absent';
  agent.absentAt = now();
  log(room, agentId, 'absent', `${agent.name} pasa a ausente (${reason}).`);
  if (room.status === 'debate') openVacancy(room, agentId, reason);
  return true;
}

// Un agente que agota su presupuesto deja de recibir trabajo nuevo, pero conserva
// su voto (que es barato) para no distorsionar el recuento.
export function applyBudget(room, agentId) {
  const budget = room.settings.tokenBudgetPerAgent || 0;
  if (!budget) return false;
  const agent = room.agents[agentId];
  if (!agent || agent.overBudget) return false;
  const spent = (agent.servedChars + agent.sentChars) / 3.5;
  if (spent > budget) {
    agent.overBudget = true;
    log(room, agentId, 'budget', `${agent.name} agotó su presupuesto (~${Math.round(spent)} tokens); pasa a evaluador.`);
    return true;
  }
  return false;
}

export function budgetStatus(room, agentId) {
  const agent = room.agents[agentId];
  const budget = room.settings.tokenBudgetPerAgent || 0;
  if (!agent) return null;
  const est = Math.round((agent.servedChars + agent.sentChars) / 3.5);
  return { budget, spent: est, remaining: budget ? Math.max(0, budget - est) : null, over: !!agent.overBudget };
}

// ---------------------------------------------------------------- asignaciones
// Críticas: cada propuesta viva recibe al menos un atacante y todos atacan algo.
export function assignCritiques(room) {
  const active = activeAgents(room);
  const live = Object.values(room.artifacts.proposals).filter(p => !p.conceded);
  const assignments = {};
  if (!live.length) return assignments;
  if (active.length === 1) { assignments[active[0]] = live.map(p => p.id); return assignments; }

  const submitted = active.filter(id => live.some(p => p.author === id));
  let pool = submitted.filter(id => live.some(p => p.author !== id));
  if (!pool.length) pool = submitted.length ? submitted : active;

  const perAgent = live.length >= pool.length ? 1 : 2;
  const queue = [];
  for (let k = 0; k < 2; k++) for (const p of live) queue.push(p.id);
  let qi = 0;
  for (const aid of pool) {
    const targets = [];
    while (qi < queue.length && targets.length < perAgent) {
      const pid = queue[qi++];
      if (room.artifacts.proposals[pid]?.author === aid) continue;
      if (!targets.includes(pid)) targets.push(pid);
    }
    if (targets.length) assignments[aid] = targets;
  }
  // Cobertura: ninguna propuesta sin atacante.
  for (const p of live) {
    if (!Object.values(assignments).some(t => t.includes(p.id))) {
      const cands = pool.filter(id => id !== p.author);
      if (cands.length) (assignments[cands[0]] ||= []).push(p.id);
    }
  }
  return assignments;
}

// Verificación: nunca el autor, y no por disfraz sino por disidencia real: verifica
// quien MENOS apoyó al ganador según los votos ya emitidos. Sin votos previos se rota.
export function assignVerifier(room, winnerProposal, preference = null) {
  const active = activeAgents(room).filter(id => !room.agents[id].overBudget);
  const candidates = active.filter(id => id !== winnerProposal.author);
  const ballots = room.lastBallots || {};
  const support = id => {
    const ranking = ballots[id] || [];
    const pos = ranking.indexOf(winnerProposal.id);
    return pos === -1 ? ranking.length + 1 : pos; // fuera de su ranking = máxima distancia
  };
  const ranked = [...candidates].sort((a, b) => support(b) - support(a));
  if (ranked.length) return { verifierId: ranked[0], selfVerified: false };
  if (candidates.length) return { verifierId: candidates[0], selfVerified: false };
  const author = room.agents[winnerProposal.author];
  if (author && author.status !== 'absent') return { verifierId: winnerProposal.author, selfVerified: true };
  return { verifierId: null, selfVerified: false };
}

// Autor de la síntesis: el de la ganadora, o un sustituto si está ausente.
export function synthesisAuthor(room, winnerProposal) {
  const author = room.agents[winnerProposal.author];
  if (author && author.status !== 'absent') return winnerProposal.author;
  const alt = activeAgents(room).find(id => !room.agents[id].overBudget) || activeAgents(room)[0] || null;
  if (alt) log(room, alt, 'phase', `${nameOf(room, alt)} redactará la síntesis: el autor de la ganadora está ausente.`);
  return alt;
}

// Estados en los que una tarea ya no se sostiene: nadie la tiene en la mano.
const HOLDING_DONE = ['integrated', 'reverted', 'failed', 'skipped'];

// Qué trabajo tiene este agente EN LA MANO ahora mismo.
//
// Un agente que reclamó una tarea y se fue a escribirla no está «desconectado»: está trabajando.
// Su latido no es el del bucle —el bucle pregunta «¿me toca?», y mientras escribe un parche de 200
// líneas no pregunta nada—, así que su señal es la tarea que sostiene. Lo mismo quien tiene un
// parche esperando su revisión: no se ha ido, está revisando. Sin esto el panel decía
// «Desconectado» en la misma pantalla en la que decía «trabaja Buffy», que es lo peor que puede
// hacer un panel: contradecirse.
// Lo propio manda sobre lo prestado: quien trabaja en su tarea Y revisa la de otro se presenta
// como «trabajando» en la suya, y la revisión va como dato añadido. Al revés, un agente con dos
// revisiones encima parecería no estar haciendo nada suyo.
function holdingOf(room, id) {
  const work = room.work;
  if (!work || work.finishedAt) return null;
  let mine = null;
  const reviews = [];
  for (const key of work.order || []) {
    const item = work.items?.[key];
    if (!item || HOLDING_DONE.includes(item.status)) continue;
    if (item.claimant === id) {
      if (!mine) mine = { itemId: item.id, title: item.title, state: 'working', since: item.claimedAt || null };
    } else if (item.reviewer === id && item.status === 'in-review') {
      reviews.push({ itemId: item.id, title: item.title, state: 'reviewing', since: null });
    }
  }
  if (mine) {
    if (reviews.length) mine.also = reviews;
    return mine;
  }
  return reviews[0] ? { ...reviews[0], also: reviews.slice(1) } : null;
}

// La plantilla para el panel. Expone DOS cosas distintas porque son distintas: `online` es tener
// señal ahora (o sostener trabajo, que vale como señal), y `holding` es el trabajo concreto que
// este agente tiene en la mano. Así el panel puede decir «Trabajando en w1» en vez de inventarse
// una desconexión a partir de un umbral de dos minutos.
export function rosterSummary(room) {
  return room.order.map(id => {
    const a = room.agents[id];
    const holding = holdingOf(room, id);
    const online = room.status !== 'closed' && a.status !== 'absent'
      && (now() - (a.lastSeenAt || 0) < offlineGraceMs(room, a));
    return {
      id,
      name: a.name,
      model: a.model,
      harness: a.harness,
      role: a.role || null,
      roleLabel: roleLabel(a.role),
      lens: a.role || null,
      capabilities: a.capabilities || [],
      status: a.status,
      overBudget: !!a.overBudget,
      lastSeenAt: a.lastSeenAt,
      online,
      holding,
      presence: a.status === 'absent' ? 'absent' : !online ? 'offline' : holding ? holding.state : 'online',
      tokens: Math.round(((a.servedChars || 0) + (a.sentChars || 0)) / 3.5),
      onProposal: !!proposalOf(room, id),
      replacementOf: a.replacementOf || null,
      absentBy: a.absentAt || null,
    };
  });
}

export function vacanciesForUI(room) {
  return room.vacancies.map(v => ({ ...v, roleLabel: roleLabel(v.role) }));
}
