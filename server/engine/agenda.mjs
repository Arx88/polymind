// AGORA v2 — agenda de decisión.
//
// Es la pieza que hace medible el consenso. En lugar de comparar prosa, cada punto
// de la agenda tiene un espacio de opciones enumerado y cada agente se posiciona.
// Así el recuento es exacto y determinista, y «68% de consenso» deja de ser decorativo.
//
// Este módulo es puro: lee y muta el objeto room, pero no registra en el log ni
// decide transiciones. Quien lo llama (moves/phases) se encarga de eso.

import { now, slug, clampStr, arr, obj, jaccard, estTokens } from './util.mjs';
import { CAPS, MACRO_STAGES } from './settings.mjs';

// ---------------------------------------------------------------- normalización
function normalizeOption(labelOrObj, origin = 'seed', by = null) {
  const raw = typeof labelOrObj === 'string' ? { label: labelOrObj } : obj(labelOrObj);
  const label = clampStr(raw.label ?? raw.text ?? raw.value ?? '', CAPS.pointOption);
  if (!label) return null;
  const id = slug(raw.id || label, 40);
  if (!id) return null;
  return { id, label, origin, by, at: now() };
}

// El server acepta la agenda como lista de textos o de objetos {label, options}.
export function normalizeAgenda(seed) {
  const out = [];
  for (const item of arr(seed).slice(0, CAPS.maxPoints)) {
    const raw = typeof item === 'string' ? { label: item } : obj(item);
    const label = clampStr(raw.label ?? raw.title ?? '', CAPS.pointLabel);
    if (!label) continue;
    const id = slug(raw.id || label, 40);
    if (!id || out.some(p => p.id === id)) continue;
    const options = [];
    for (const opt of arr(raw.options).slice(0, CAPS.maxOptionsPerPoint)) {
      const o = normalizeOption(opt);
      if (o && !options.some(x => x.id === o.id)) options.push(o);
    }
    out.push({
      id,
      label,
      weight: typeof raw.weight === 'number' && raw.weight > 0 ? raw.weight : 1,
      options,
      source: raw.source === 'agent' ? 'agent' : 'seed',
      createdAt: now(),
    });
  }
  return out;
}

export function findPoint(room, ref) {
  if (!ref) return null;
  const id = slug(ref, 48);
  return room.agenda.find(p => p.id === id || slug(p.label, 48) === id) || null;
}

export function addPoint(room, proposal, by = null) {
  const raw = typeof proposal === 'string' ? { label: proposal } : obj(proposal);
  const label = clampStr(raw.label ?? raw.title ?? raw.text ?? '', CAPS.pointLabel);
  if (!label) return { point: null, created: false, reason: 'empty-label' };
  const id = slug(raw.id || label, 40);
  let point = findPoint(room, id);
  if (point) {
    const added = [];
    for (const opt of arr(raw.options)) {
      const o = normalizeOption(opt, by ? 'agent' : 'seed', by);
      if (o && !point.options.some(x => x.id === o.id)) { point.options.push(o); added.push(o); }
    }
    return { point, created: false, addedOptions: added };
  }
  if (room.agenda.length >= CAPS.maxPoints) return { point: null, created: false, reason: 'too-many-points' };
  point = normalizeAgenda([{ ...raw, label, id, source: by ? 'agent' : 'seed' }])[0];
  if (!point) return { point: null, created: false, reason: 'invalid' };
  point.source = by ? 'agent' : 'seed';
  point.createdBy = by;
  // En qué fase nació el eje. En el contraste la agenda entera está a la vista y el eje que
  // entra ahí es uno que el encuadre (a ciegas) no vio: el informe lo dice, y para eso hay que
  // saberlo por la fase y no por la marca de tiempo (dos agentes rápidos caen en el mismo ms).
  point.createdIn = room.phase?.name || null;
  room.agenda.push(point);
  return { point, created: true };
}

export function addOption(room, pointId, label, by = null) {
  const point = findPoint(room, pointId);
  if (!point) return { option: null, created: false, reason: 'unknown-point' };
  const o = normalizeOption(label, by ? 'agent' : 'seed', by);
  if (!o) return { option: null, created: false, reason: 'empty-option' };
  const existing = point.options.find(x => x.id === o.id);
  if (existing) return { option: existing, created: false };
  if (point.options.length >= CAPS.maxOptionsPerPoint + 6) return { option: null, created: false, reason: 'too-many-options' };
  point.options.push(o);
  return { option: o, created: true };
}

// ---------------------------------------------------------------- posiciones
// Acepta {pointId: choiceId}, {pointId: {choiceId|option}} o
// [{pointId, choiceId|option, note}]. Nunca lanza: devuelve avisos.
export function applyPositions(room, raw) {
  const warnings = [];
  const positions = {};
  const newOptions = [];
  let list = [];
  if (Array.isArray(raw)) {
    list = raw.map(item => {
      const o = obj(item);
      return { point: o.pointId ?? o.point ?? o.id ?? o.key, choice: o.choiceId ?? o.choice ?? o.option, note: o.note };
    });
  } else if (raw && typeof raw === 'object') {
    list = Object.entries(raw).map(([point, val]) => {
      if (val && typeof val === 'object') {
        const o = obj(val);
        return { point, choice: o.choiceId ?? o.choice ?? o.option, note: o.note };
      }
      return { point, choice: val };
    });
  }
  for (const item of list) {
    const point = findPoint(room, item.point);
    if (!point) { warnings.push(`punto desconocido: ${clampStr(String(item.point ?? ''), 40)}`); continue; }
    if (item.choice == null) continue;
    const choiceSlug = slug(String(item.choice), 40);
    let option = point.options.find(o => o.id === choiceSlug);
    if (!option) {
      // Una opción inventada por un agente se incorpora al espacio de opciones:
      // a partir de ahí los demás pueden elegirla, y el conteo sigue siendo exacto.
      const res = addOption(room, point.id, String(item.choice), 'agent');
      if (res.option) { option = res.option; newOptions.push({ pointId: point.id, pointLabel: point.label, option }); }
      else if (res.reason === 'too-many-options') {
        // El espacio de opciones de un punto no crece sin fin. Si el techo se alcanza, se
        // dice con el número delante en vez de dejar caer la opción como «inválida».
        warnings.push(`«${point.label}» ya tiene ${point.options.length} opciones (techo ${CAPS.maxOptionsPerPoint + 6}): ` +
          `elige una de las existentes o abre un punto nuevo para lo tuyo.`);
        continue;
      }
      else { warnings.push(`opción inválida para «${point.label}»: ${clampStr(String(item.choice), 40)}`); continue; }
    }
    positions[point.id] = option.id;
    if (item.note) {
      const prev = positions.__notes || (positions.__notes = {});
      prev[point.id] = clampStr(item.note, CAPS.pointNote);
    }
  }
  return { positions, warnings, newOptions };
}

export function positionsOf(proposal) {
  if (!proposal?.positions) return {};
  const out = {};
  for (const [k, v] of Object.entries(proposal.positions)) if (k !== '__notes' && v) out[k] = v;
  return out;
}

export function notesOf(proposal) {
  const notes = proposal?.positions?.__notes;
  return notes && typeof notes === 'object' ? notes : {};
}

// Qué posiciones se movieron entre dos versiones de una propuesta. Converger no es
// gratis: el servidor registra el movimiento y exige saber POR QUÉ se hizo. Un autor
// que se desplaza hacia la mayoría sin citar qué evidencia lo movió queda a la vista
// (y no se le rechaza el movimiento: se le recuerda en la siguiente ronda).
export function diffPositions(before = {}, after = {}) {
  const out = [];
  for (const [pointId, to] of Object.entries(after || {})) {
    if (pointId === '__notes' || !to) continue;
    const from = before?.[pointId] || null;
    if (from === to) continue;
    out.push({ pointId, from, to });
  }
  return out;
}

// Postura de un agente en cada punto: la de su propia propuesta viva; si no tiene
// o la retiró, la del plan que votó primero; si no votó, se abstiene.
export function stanceMap(room) {
  const stances = {};
  const source = {};
  const ballots = room.lastBallots || {};
  for (const id of room.order) {
    const agent = room.agents[id];
    if (!agent || agent.status === 'absent') continue;
    const own = proposalOfAuthor(room, id);
    if (own && !own.conceded) {
      stances[id] = positionsOf(own);
      source[id] = { kind: 'proposal', proposalId: own.id, version: own.v };
      continue;
    }
    const ballot = ballots[id];
    const top = Array.isArray(ballot) ? ballot[0] : null;
    const topProposal = top ? room.artifacts.proposals[top] : null;
    if (topProposal) {
      stances[id] = positionsOf(topProposal);
      source[id] = { kind: 'ballot', proposalId: topProposal.id };
    } else if (own) {
      stances[id] = positionsOf(own);
      source[id] = { kind: 'conceded-proposal', proposalId: own.id };
    } else {
      stances[id] = {};
      source[id] = { kind: 'none' };
    }
  }
  return { stances, source };
}

// La propuesta viva del agente en la RONDA ABIERTA. Con mejora recursiva hay propuestas de
// varias rondas del mismo autor, y quedarse con la primera (orden de inserción) congelaba las
// posiciones en las de la ronda 1: los puntos nuevos de la ronda 2 aparecían sin un solo voto y
// sus mejoras nunca se aprobaban.
function proposalOfAuthor(room, agentId) {
  const ronda = room.rounds || 1;
  const mias = Object.values(room.artifacts.proposals).filter(p => p.author === agentId);
  return mias.find(p => (p.round || 1) === ronda) || null;
}

// ---------------------------------------------------------------- consenso
export function consensusReport(room) {
  const threshold = room.settings?.consensusThreshold ?? 0.75;
  const minShare = room.settings?.consensusMinShare ?? 0.5;
  const { stances, source } = stanceMap(room);
  const points = [];
  let weighted = 0, weightSum = 0;

  for (const point of room.agenda) {
    const counts = new Map();
    const voters = [];
    let abstain = 0;
    for (const [agentId, st] of Object.entries(stances)) {
      const choice = st[point.id];
      if (!choice) { abstain++; continue; }
      const prev = counts.get(choice) || { count: 0, agents: [] };
      prev.count++;
      prev.agents.push(agentId);
      counts.set(choice, prev);
      voters.push(agentId);
    }
    const total = voters.length;
    const choices = [...counts.entries()].map(([choiceId, v]) => ({
      id: choiceId,
      label: point.options.find(o => o.id === choiceId)?.label || choiceId,
      count: v.count,
      share: total ? v.count / total : 0,
      agents: v.agents,
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const modal = choices[0] || null;
    const share = modal?.share || 0;
    let status = 'pending';
    if (total > 0) status = share >= threshold ? 'agreed' : (share >= minShare ? 'discussing' : 'open');
    if (total > 0) { weighted += share * point.weight; weightSum += point.weight; }
    points.push({
      id: point.id,
      label: point.label,
      weight: point.weight,
      source: point.source,
      status,
      share,
      modal,
      choices,
      voters: total,
      abstain,
      options: point.options.map(o => ({ id: o.id, label: o.label, origin: o.origin, by: o.by })),
      // Ejes impugnados en el contraste: sigue contando como punto de la agenda, pero el
      // informe y la interfaz dicen que se discute su propia existencia.
      contested: (point.challenged || []).length > 0,
      challenged: (point.challenged || []).map(c => ({ by: c.byName || c.by, because: c.because || '' })),
      mergedFrom: (point.mergedFrom || []).map(m => ({ label: m.label, by: m.byName || m.by })),
    });
  }

  let global, method;
  if (points.length) { method = 'agenda'; global = weightSum ? weighted / weightSum : 0; }
  else { method = 'ballots'; global = ballotAgreement(room); }

  return {
    global: round2(global),
    method,
    threshold,
    minShare,
    stanceSource: source,
    points,
    agreed: points.filter(p => p.status === 'agreed').length,
    discussing: points.filter(p => p.status === 'discussing').length,
    open: points.filter(p => p.status === 'open').length,
    pending: points.filter(p => p.status === 'pending').length,
    total: points.length,
  };
}

// ---------------------------------------------------------------- por etapa
// Un solo número de consenso no cuenta la historia: una sala puede empezar en 30% y
// terminar en 90% porque se acercaron, o quedarse clavada. Al cerrar cada macro-etapa se
// guarda una foto del consenso (con la fase en la que se cerró), y así el panel puede
// mostrar la evolución por etapa junto al global. Si la etapa se repite (una ronda más de
// trabajo o de revisión), la foto se reemplaza: es el estado final de esa etapa, no un
// acumulado que crecería sin significar nada.
export function recordStageConsensus(room, macro, phase = null, precomputed = null) {
  if (!macro) return null;
  if (!Array.isArray(room.consensusHistory)) room.consensusHistory = [];
  const report = precomputed || consensusReport(room);
  const snapshot = {
    macro,
    phase: phase || null,
    at: now(),
    global: report.global,
    method: report.method,
    agreed: report.agreed,
    total: report.total,
    unresolved: report.total - report.agreed,
    governed: report.total > 0,
  };
  const last = room.consensusHistory[room.consensusHistory.length - 1];
  if (last && last.macro === macro) room.consensusHistory[room.consensusHistory.length - 1] = snapshot;
  else room.consensusHistory.push(snapshot);
  return snapshot;
}

// Las etapas del protocolo con su consenso: lo ya cerrado viene de la historia y la
// etapa en curso se mide en vivo (el global que se ve arriba). Sin agenda, el consenso
// se mide sobre votos y las etapas anteriores a la votación no tienen nada que medir.
export function stageConsensus(room, currentMacro) {
  const history = Array.isArray(room.consensusHistory) ? room.consensusHistory : [];
  const byMacro = new Map(history.map(h => [h.macro, h]));
  const report = consensusReport(room);
  // Sala cerrada: ninguna etapa está «en curso» (decir «ahora» de un debate terminado era
  // mentir), y las que nunca se midieron se marcan como «no hubo» en vez de «aún no llega».
  const closed = room.status === 'closed';
  const current = closed ? null : (currentMacro || null);
  const stages = MACRO_STAGES.map(stage => {
    const done = byMacro.get(stage.id) || null;
    const isNow = stage.id === current;
    const live = isNow
      ? { global: report.global, agreed: report.agreed, total: report.total, unresolved: report.total - report.agreed, at: now() }
      : null;
    const data = done || live;
    // El trabajo NO se mide con el consenso de la agenda: que el plan esté acordado al 100% no dice
    // nada de si el código existe. Si esta etapa se mide así, el panel enseña «Trabajo 100%»
    // mientras hay 0 de 5 tareas integradas — y eso se lee como «ya está hecho» cuando no lo está.
    // Se mide con su tablero: integradas sobre total.
    const board = stage.id === 'work' ? workStageOf(room) : null;
    const measured = board ? true : !!(data && data.total > 0);
    return {
      macro: stage.id,
      label: stage.label,
      status: isNow ? 'now' : done ? 'done' : closed ? 'skipped' : 'pending',
      global: board ? (board.total ? round2(board.integrated / board.total) : 0) : data ? round2(data.global) : null,
      agreed: board ? board.integrated : data ? data.agreed : null,
      total: board ? board.total : data ? data.total : null,
      unresolved: board ? board.total - board.integrated : data ? data.unresolved : null,
      // Una etapa sin agenda que medir (encuadre, o un debate sin puntos) no inventa un
      // porcentaje: se dice que no se mide, en vez de mostrar un 0% que parecería fracaso.
      measured,
      // El tablero del trabajo, para que el panel diga «0/5 integradas» y no un porcentaje que
      // parece una nota del plan.
      work: board,
      phase: done?.phase || null,
      at: data?.at || null,
    };
  });
  return stages;
}

// Cuántas tareas del trabajo están integradas y cuántas siguen en la mano de alguien.
function workStageOf(room) {
  const work = room.work;
  if (!work || !(work.order || []).length) return null;
  const items = work.order.map(k => work.items?.[k]).filter(Boolean);
  if (!items.length) return null;
  const integrated = items.filter(i => i.status === 'integrated').length;
  return {
    integrated,
    total: items.length,
    inProgress: items.filter(i => ['claimed', 'in-review', 'verifying'].includes(i.status)).length,
    free: items.filter(i => i.status === 'open').length,
    failed: items.filter(i => ['failed', 'skipped'].includes(i.status)).length,
    finishedAt: work.finishedAt || null,
  };
}

// Sin agenda: acuerdo = cuota de boletas cuyo primer puesto coincide con el modal.
export function ballotAgreement(room) {
  const ballots = Object.values(room.lastBallots || {}).filter(b => Array.isArray(b) && b.length);
  if (!ballots.length) return 0;
  const counts = new Map();
  for (const b of ballots) counts.set(b[0], (counts.get(b[0]) || 0) + 1);
  const top = Math.max(...counts.values());
  return top / ballots.length;
}

function round2(n) { return Math.round(n * 1000) / 1000; }

// Puntos que siguen abiertos y deberían resolverse antes de cerrar.
export function unresolvedPoints(report) {
  return report.points.filter(p => p.status !== 'agreed');
}

// ---------------------------------------------------------------- disenso protegido
// Un debate que converge de más deja de aportar: dos propuestas casi idénticas con
// votación unánime no prueban que el plan sea bueno, prueban que nadie sostuvo la otra
// mitad. Esto NO presiona para acordar: hace visible la minoría real —con nombres y
// alternativas— para que no se disuelva en una síntesis «por autoridad». Sin tokens:
// se deriva de las posiciones y los votos que ya existen.
//
// `nameOf` es opcional para no crear un ciclo de imports con state.mjs: quien lo llama
// desde la capa de presentación pasa `id => nameOf(room, id)`.
export function dissentReport(room, report = null, nameOf = null) {
  const r = report || consensusReport(room);
  const name = typeof nameOf === 'function' ? nameOf : id => id;
  if (!r.total) {
    return {
      measured: false, count: 0, contestedShare: null, unanimity: null,
      contested: [], points: [],
    };
  }
  const reasons = critiqueReasonsByPoint(room);
  const labelOf = (pointId, choiceId) =>
    room.agenda.find(p => p.id === pointId)?.options.find(o => o.id === choiceId)?.label || choiceId;
  const points = r.points.map(p => {
    const majority = p.modal
      ? {
        choiceId: p.modal.id, label: p.modal.label, count: p.modal.count,
        share: round2(p.modal.share), agents: p.modal.agents, by: p.modal.agents.map(name),
      }
      : null;
    const minority = p.choices.slice(1).map(c => ({
      choiceId: c.id, label: c.label, count: c.count, share: round2(c.share),
      agents: c.agents, by: c.agents.map(name),
    }));
    return {
      id: p.id, label: p.label, status: p.status, share: round2(p.share),
      voters: p.voters, abstain: p.abstain,
      majority, minority, contested: minority.length > 0,
      // Lo que ya se dijo sobre ESTE punto (objeciones ancladas a él con «against»). Va al
      // punto, no a cada alternativa: es el argumento del desacuerdo, no de una opción suelta.
      reasons: reasons[p.id] || [],
    };
  });
  const contested = points.filter(p => p.contested);
  // Solo cuentan los puntos que alguien votó: un punto sin posturas no es unanimidad, es
  // un punto sin medir, y contarlo como acuerdo inflaría el número que más importa aquí.
  const medidos = points.filter(p => p.voters > 0);
  return {
    measured: medidos.length > 0,
    count: contested.length,
    contestedShare: medidos.length ? round2(contested.length / medidos.length) : null,
    // Cuota de puntos votados donde TODOS eligieron lo mismo: el número que delata cuánto se
    // disolvió la diversidad. Alto no es bueno por sí solo, y el informe lo dice así.
    unanimity: medidos.length ? round2(medidos.filter(p => !p.contested).length / medidos.length) : null,
    contested,
    points,
    labelOf,
  };
}

// Objeciones que un agente ancló explícitamente a un punto de agenda («against»).
// Son el argumento de la minoría, tal como se dijo en su momento.
function critiqueReasonsByPoint(room) {
  const out = {};
  for (const c of Object.values(room.artifacts.critiques || {})) {
    for (const o of c.objections || []) {
      if (!o.against) continue;
      (out[o.against] ||= []).push({ by: c.author, severity: o.severity, type: o.type, text: o.text });
    }
  }
  return out;
}

// `blind` se usa durante el ENCUADRE: no enseña los puntos que propusieron otros agentes.
// Sin esto, el primero en hablar elige los ejes de todo el debate (todos los siguientes
// leen su pregunta antes de aportar). Cada agente aporta sin ancla y el servidor junta
// todo al cerrar el encuadre, donde ya es material común.
// Los puntos del humano (plantilla/semilla) sí se ven desde el principio: son el encargo,
// no la opinión de un par.
export function agendaForTurn(room, { blind = false } = {}) {
  const visibles = blind ? room.agenda.filter(p => p.source !== 'agent') : room.agenda;
  return visibles.map(p => ({
    id: p.id,
    label: p.label,
    // El origen importa para decidir: un punto que viene de la auditoría del repo es
    // una mejora concreta sobre un archivo, no una pregunta abierta.
    source: p.source || 'human',
    // Quién propuso el eje (si lo propuso un agente y sigue en la sala). En el contraste es
    // lo que permite discutir el eje con quien lo trajo, no contra un anónimo.
    ...(p.createdBy && room.agents?.[p.createdBy]?.name ? { by: room.agents[p.createdBy].name } : {}),
    ...(p.source === 'finding' && p.audit?.file ? { file: p.audit.file, severity: p.audit.severity || null } : {}),
    // Un eje impugnado sigue en la agenda (nada se borra por mayoría), pero quien se posicione
    // ahí tiene derecho a saber que se discute y por qué. Y si nació de una fusión, de dónde
    // salió: el origen no se pierde.
    ...(p.challenged?.length ? { challenged: p.challenged.map(c => ({ by: c.byName || c.by, because: c.because || '' })) } : {}),
    ...(p.mergedFrom?.length ? { mergedFrom: p.mergedFrom.map(m => ({ label: m.label, by: m.byName || m.by })) } : {}),
    options: p.options.map(o => ({ id: o.id, label: o.label })),
  }));
}

// ---------------------------------------------------------------- contraste de ejes
// El encuadre es a ciegas para que nadie ancle los ejes, pero eso deja dos agujeros: un eje al
// que nadie llegó en su turno no puede entrar nunca, y uno que sobra no se puede impugnar. El
// contraste es una vuelta corta y YA INFORMADA (la agenda entera a la vista) donde cada agente
// puede añadir un punto, impugnar uno existente con motivo, o pedir que se fusione con otro.
//
// Nada se borra por mayoría: un eje impugnado sin fusión acordada queda abierto y visible en
// todo el debate (y en el informe). Una fusión solo ocurre si la pide MÁS DE LA MITAD de la
// sala y todos apuntan al mismo destino; entonces conserva las opciones del absorbido y deja
// constancia de quién lo pidió y por qué.
export function challengePoint(room, agentId, raw = {}) {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { pointId: raw };
  const point = findPoint(room, clampStr(o.pointId ?? o.point ?? o.id, 48));
  if (!point) return { point: null, reason: 'unknown-point' };
  const store = room.artifacts.contrast || (room.artifacts.contrast = { challenges: {}, applied: [], kept: [] });
  store.challenges ||= {};
  const list = store.challenges[point.id] || (store.challenges[point.id] = []);
  const wanted = findPoint(room, clampStr(o.mergeInto ?? o.mergeWith ?? '', 48));
  const entry = {
    by: agentId,
    because: clampStr(o.because ?? o.reason ?? o.why, CAPS.pointNote),
    mergeInto: wanted && wanted.id !== point.id ? wanted.id : null,
    at: now(),
  };
  const prev = list.find(c => c.by === agentId);
  if (prev) Object.assign(prev, entry); else list.push(entry);
  return { point, entry, mergeInto: wanted, repeated: !!prev };
}

// Fusiona dos ejes que son el mismo: se queda el destino y el absorbido pasa a su historial,
// con sus opciones (para que nadie pierda la opción que había elegido) y con los nombres de
// quienes lo pidieron.
function mergePoints(room, from, into, { by = [], reasons = [], nameOf = id => id } = {}) {
  const moved = [];
  for (const o of from.options) {
    if (into.options.some(x => x.id === o.id)) continue;
    into.options.push(o);
    moved.push(o);
  }
  into.weight = Math.max(into.weight || 1, from.weight || 1);
  (into.mergedFrom ||= []).push({
    id: from.id,
    label: from.label,
    options: from.options.map(o => ({ id: o.id, label: o.label })),
    by: [...by],
    byName: by.map(nameOf),
    because: reasons.map(r => r.because).filter(Boolean),
    at: now(),
  });
  room.agenda = room.agenda.filter(p => p.id !== from.id);
  return {
    fromId: from.id, fromLabel: from.label,
    intoId: into.id, intoLabel: into.label,
    movedOptions: moved.map(o => o.label),
  };
}

// Cierra el contraste: decide fusiones (mayoría + destino único) y deja impugnado lo demás.
export function resolveContrast(room, { activeCount = 0, nameOf = id => id } = {}) {
  const store = room.artifacts.contrast || (room.artifacts.contrast = { challenges: {}, applied: [], kept: [] });
  const challenges = store.challenges || {};
  const applied = [];
  const kept = [];
  for (const [pointId, list] of Object.entries(challenges)) {
    if (!list?.length) continue;
    const point = room.agenda.find(p => p.id === pointId);
    if (!point) continue;
    const backers = [...new Set(list.map(c => c.by))];
    const targets = [...new Set(list.map(c => c.mergeInto).filter(Boolean))];
    const target = targets.length === 1 ? room.agenda.find(p => p.id === targets[0]) : null;
    const majority = backers.length * 2 > Math.max(1, activeCount);
    if (majority && target && target.id !== point.id) {
      const merged = mergePoints(room, point, target, { by: backers, reasons: list, nameOf });
      applied.push({
        ...merged,
        by: backers, byName: backers.map(nameOf),
        because: list.map(c => c.because).filter(Boolean),
        at: now(),
      });
      continue;
    }
    point.challenged = list.map(c => ({
      by: c.by, byName: nameOf(c.by), because: c.because || '', mergeInto: c.mergeInto || null, at: c.at,
    }));
    kept.push({
      pointId: point.id,
      label: point.label,
      by: backers, byName: backers.map(nameOf),
      because: list.map(c => c.because).filter(Boolean),
      wantedMerge: targets,
      majority,
      at: now(),
    });
  }
  store.applied = applied;
  store.kept = kept;
  store.resolvedAt = now();
  return { applied, kept };
}

// Coste de la agenda para un agente (para la métrica de tokens de la UI).
export function agendaTokens(room) {
  return estTokens(JSON.stringify(agendaForTurn(room)).length);
}

// ---------------------------------------------------------------- diversidad
// Dos propuestas que eligen lo mismo en casi todos los puntos no aportan:
// son la misma idea con otras palabras. Se detecta con el vector de elecciones.
// Regla: declarar un enfoque distinto es la salida explícita; si no lo declaras,
// lo que se compara son las elecciones de la agenda. Nunca genera bucles de
// rechazo: basta con un enfoque diferente para entrar.
export function diversityReport(room, authorId, positions, approach = '') {
  const minePositions = Object.entries(positions).map(([p, c]) => `${p}:${c}`);
  const mineApproach = approach ? slug(approach, 40) : '';
  const others = [];
  for (const pr of Object.values(room.artifacts.proposals)) {
    if (pr.author === authorId || pr.conceded) continue;
    const theirPositions = Object.entries(positionsOf(pr)).map(([p, c]) => `${p}:${c}`);
    const theirApproach = pr.approach ? slug(pr.approach, 40) : '';
    let similarity = 0;
    let basis = 'none';
    if (mineApproach && theirApproach && mineApproach !== theirApproach) {
      similarity = 0; basis = 'differing-approach';
    } else if (minePositions.length >= 2 && theirPositions.length >= 2) {
      similarity = round2(jaccard(minePositions, theirPositions)); basis = 'positions';
    }
    others.push({
      proposalId: pr.id,
      title: pr.title,
      author: pr.author,
      authorName: room.agents[pr.author]?.name || pr.author,
      similarity,
      basis,
      positions: positionsOf(pr),
    });
  }
  others.sort((a, b) => b.similarity - a.similarity);
  const maxSimilarity = others.length ? others[0].similarity : 0;
  const comparable = others.some(o => o.basis === 'positions');
  const askChange = room.settings?.requireDiversity !== false && comparable &&
    maxSimilarity >= (room.settings?.diversityMax ?? 0.8);
  return { maxSimilarity, others, askChange, closest: others[0] || null };
}

// Cuánto se parecen entre sí las propuestas vivas, en sus decisiones de agenda. Si dos
// propuestas terminan casi idénticas, la votación decide matices y no direcciones, y eso
// hay que decirlo al abrir la votación en vez de descubrirlo leyendo el acta.
export function proposalSimilarity(room) {
  const threshold = room.settings?.diversityMax ?? 0.8;
  const live = Object.values(room.artifacts.proposals).filter(p => !p.conceded);
  const pairs = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const ap = Object.entries(positionsOf(a)).map(([p, c]) => `${p}:${c}`);
      const bp = Object.entries(positionsOf(b)).map(([p, c]) => `${p}:${c}`);
      if (ap.length < 2 || bp.length < 2) continue;
      pairs.push({
        a: a.id, b: b.id, aTitle: a.title, bTitle: b.title,
        aAuthor: a.author, bAuthor: b.author,
        similarity: round2(jaccard(ap, bp)),
      });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  const max = pairs.length ? pairs[0].similarity : 0;
  return {
    pairs,
    max,
    threshold,
    comparable: pairs.length > 0,
    collapsed: pairs.length > 0 && max >= threshold,
    closest: pairs[0] || null,
  };
}

// ---------------------------------------------------------------- cambios de reglas
export const RULE_OPS = ['consensusThreshold', 'tone', 'requireDiversity', 'maxDurationMs', 'tokenBudgetPerAgent', 'phaseMs'];

// Valida y normaliza un cambio de reglas SIN aplicarlo (se aplica al ratificarse).
// Devuelve {op, value, phase, text} o null si es inválido.
export function resolveRuleProposal(room, change = {}) {
  const op = clampStr(change.op || change.field || '', 40);
  if (!RULE_OPS.includes(op)) return null;
  if (op === 'consensusThreshold') {
    // Acepta fracción (0.7) y porcentaje (70): los agentes escriben las dos.
    let v = Number(change.value);
    if (!Number.isFinite(v)) return null;
    if (v > 1 && v <= 100) v = v / 100;
    if (v < 0.5 || v > 1) return null;
    return { op, value: v, phase: null, text: `umbral de consenso → ${Math.round(v * 100)}%` };
  }
  if (op === 'tone') {
    const v = clampStr(String(change.value ?? ''), 80);
    if (!v) return null;
    return { op, value: v, phase: null, text: `tono → ${v}` };
  }
  if (op === 'requireDiversity') {
    return { op, value: !!change.value, phase: null, text: `exigir enfoques distintos → ${change.value ? 'sí' : 'no'}` };
  }
  if (op === 'maxDurationMs') {
    const v = Number(change.value);
    if (!Number.isFinite(v) || v < 60_000 || v > 6 * 3600_000) return null;
    return { op, value: Math.round(v), phase: null, text: `duración máxima → ${Math.round(v / 60000)} min` };
  }
  if (op === 'tokenBudgetPerAgent') {
    const v = Number(change.value);
    if (!Number.isFinite(v) || v < 0) return null;
    return { op, value: Math.round(v), phase: null, text: `presupuesto por agente → ~${Math.round(v)} tokens` };
  }
  if (op === 'phaseMs') {
    const phase = clampStr(change.phase || '', 20);
    const v = Number(change.value);
    if (!room.settings.phaseMs[phase] || !Number.isFinite(v) || v < 5000 || v > 3600_000) return null;
    return { op, value: Math.round(v), phase, text: `duración de «${phase}» → ${Math.round(v / 1000)} s` };
  }
  return null;
}

// Aplica un cambio ya validado (o lo valida al vuelo) y devuelve el efecto.
export function applyRuleChange(room, change) {
  const rp = change?.op && change?.text && !change.key ? change : resolveRuleProposal(room, change);
  if (!rp) return null;
  const before = rp.op === 'phaseMs' ? room.settings.phaseMs[rp.phase] : room.settings[rp.op];
  if (rp.op === 'phaseMs') room.settings.phaseMs[rp.phase] = rp.value;
  else room.settings[rp.op] = rp.value;
  const after = rp.op === 'phaseMs' ? room.settings.phaseMs[rp.phase] : room.settings[rp.op];
  if (before === after) return null;
  return { op: rp.op, phase: rp.phase, before, after, text: rp.text };
}

// Una propuesta de regla se aplica si la ratifica la mayoría de los activos
// (o si es un cambio «sin oposición» cuando nadie se pronuncia).
export function ratifyRuleProposals(room, activeIds) {
  const applied = [];
  for (const rp of room.artifacts.ruleProposals) {
    if (rp.applied) continue;
    const ratifications = new Set(rp.ratifications || []);
    const majority = Math.floor(activeIds.length / 2) + 1;
    if (ratifications.size >= Math.min(majority, Math.max(1, activeIds.length - 1)) || ratifications.size >= activeIds.length) {
      const effect = applyRuleChange(room, { op: rp.op, value: rp.value, phase: rp.phase, text: rp.text });
      if (effect) { rp.applied = true; applied.push({ proposalId: rp.id, text: rp.text, ...effect }); }
    }
  }
  return applied;
}
