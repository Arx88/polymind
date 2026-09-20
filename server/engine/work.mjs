// AGORA v2 — trabajo conjunto sobre un repo.
//
// La cadena completa, sin inventar nada:
//
//   1. AUDITORÍA   cada agente lee el repo y deja HALLAZGOS anclados a archivos
//                  (qué está mal, con qué evidencia y qué mejora concreta).
//   2. DEBATE      los hallazgos agrupados se convierten en puntos de agenda:
//                  «¿aplicamos esta mejora?». El debate decide, con posiciones y
//                  recuento exacto, qué entra y qué no.
//   3. TRABAJO     las mejoras APROBADAS se convierten en tareas. Un agente la
//                  reclama, entrega un parche, OTRO agente lo revisa (nadie
//                  aprueba su propio trabajo), el servidor ejecuta el comando de
//                  verificación declarado por el humano y solo entonces commitea.
//
// Nada de esto ejecuta código escrito por agentes: ellos escriben parches, el
// servidor aplica y verifica.

import { now, uid, slug, clampStr, clampText, arr, obj, oneOf, gist, jaccard, plural, fit, fitList, DebateError } from './util.mjs';
import { CAPS, claimIdleThresholdMs } from './settings.mjs';
import { log, nameOf, activeAgents, proposalOf } from './state.mjs';
import { consensusReport, normalizeAgenda } from './agenda.mjs';
import {
  stagePatch, unstagePatch, commitStaged, runVerify, workStats, commitLog, repoIndex,
  baselineInBackground, revertCommit, commitFiles,
} from './repo.mjs';

// Un único gancho para que el trabajo asíncrono (verificación) persista y avise
// al panel: lo instala el transporte HTTP al arrancar.
let notifier = null;
export function setWorkNotifier(fn) { notifier = typeof fn === 'function' ? fn : null; }

// El informe congelado (result.mjs) también se queda viejo cuando el trabajo cambia
// después de cerrar la sala: deshacer una mejora o terminar su verificación. El motor no
// depende de result.mjs; el transporte instala aquí el refresco, igual que el notificador.
let refresher = null;
export function setResultRefresher(fn) { refresher = typeof fn === 'function' ? fn : null; }
function refreshResult(room) {
  try { refresher?.(room); } catch { /* el informe no debe tumbar el trabajo */ }
}

function changed(room) {
  room.__changed = true;
  try { notifier?.(room); } catch { /* el transporte no debe romper el motor */ }
}

const SEV_WEIGHT = { high: 1.5, med: 1, low: 0.5 };
const SEV_ORDER = { high: 3, med: 2, low: 1 };
export const WORK_OPTION_IDS = ['aplicar', 'aplazar', 'descartar'];
const TERMINAL = new Set(['integrated', 'reverted', 'failed', 'skipped']);

// ---------------------------------------------------------------- 1. auditoría
export function recordFinding(room, agentId, payload = {}) {
  const agent = room.agents[agentId];
  const p = obj(payload);
  // Cada recorte del techo se devuelve como aviso: un hallazgo largo no se acorta en
  // silencio, el agente se entera y puede mandarlo por partes.
  const cuts = [];
  const claim = fit(p.claim ?? p.problem ?? p.what ?? p.text, CAPS.findingClaim, 'claim', cuts);
  const action = fit(p.action ?? p.improvement ?? p.proposal ?? p.fix, CAPS.findingAction, 'action', cuts);
  if (claim.length < 15 || action.length < 10) {
    throw new DebateError('bad_payload',
      'payload: {file:"ruta/en/el/repo", line?, symbol?, severity: high|med|low, ' +
      'claim:"qué está mal, 15+ caracteres (sin tope)", evidence:"por qué lo sabes, libre", ' +
      'action:"mejora concreta, 10+ caracteres"}. Sin file el hallazgo no se puede aplicar.');
  }
  const file = clampStr(p.file ?? p.path ?? p.target, CAPS.findingFile) || null;
  const finding = {
    id: uid('h'),
    by: agentId,
    at: now(),
    // Ronda en la que se encontró: la mejora recursiva vuelve a auditar el mismo repo, así que
    // sin este sello el cierre de la ronda 2 agruparía también los hallazgos de la ronda 1 —ya
    // integrados— y los volvería a proponer como mejoras pendientes, para siempre.
    round: room.rounds || 1,
    severity: oneOf(clampStr(p.severity, 10), ['high', 'med', 'low'], 'med'),
    file,
    line: Number.isFinite(Number(p.line)) ? Math.max(0, Math.round(Number(p.line))) : null,
    symbol: clampStr(p.symbol ?? p.function ?? p.symbolName, CAPS.findingSymbol) || null,
    claim,
    evidence: fit(p.evidence ?? p.why ?? p.reason, CAPS.findingEvidence, 'evidence', cuts, { keepLines: true }),
    action,
    groupKey: null,
    pointId: null,
  };
  const dupe = room.artifacts.findings.find(f => f.by === agentId && f.file === finding.file && slug(f.action, 40) === slug(finding.action, 40));
  if (dupe) {
    throw new DebateError('duplicate',
      `Ya registraste ese hallazgo sobre ${finding.file || '(sin archivo)'}. Amplíalo con otro hallazgo distinto o pasa.`);
  }
  room.artifacts.findings.push(finding);
  const over = room.artifacts.findings.filter(f => f.by === agentId).length > CAPS.findingsPerAgent;
  if (over) {
    return { finding, warnings: [...cuts, `${CAPS.findingsPerAgent} hallazgos tuyos son muchos para una auditoría: este se registra igual, pero prioriza los que más muevan la aguja y deja el resto para el informe.`] };
  }
  log(room, agentId, 'finding',
    `${nameOf(room, agentId)} [${finding.severity}] ${finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''} — ` : ''}${gist(finding.claim, 130)} → ${gist(finding.action, 110)}`);
  return { finding, warnings: cuts };
}

// Agrupa hallazgos equivalentes (mismo archivo y misma mejora) y convierte los
// mejor valorados en puntos de agenda: el debate decide aplicarlos o no.
export function closeAudit(room) {
  // Solo los hallazgos de ESTA ronda: lo de rondas anteriores ya se integró (o se aplazó) y
  // volver a proponerlo convertiría la recursión en un bucle que repite trabajo hecho.
  const ronda = room.rounds || 1;
  const findings = room.artifacts.findings.filter(f => (f.round || 1) === ronda);
  const groups = [];
  for (const f of findings) {
    const key = `${f.file || '—'}|${slug(f.action, 44)}`;
    let g = groups.find(x => x.key === key);
    if (!g) {
      // Fusión por parecido dentro del mismo archivo: dos formas de pedir lo mismo
      // son una corroboración, no dos tareas. Mismo símbolo también fusiona.
      g = groups.find(x => x.file && x.file === f.file && (
        jaccard(tokensOf(x.action), tokensOf(f.action)) >= 0.45 ||
        overlap(tokensOf(x.action), tokensOf(f.action)) >= 0.6 ||
        (!!x.symbol && x.symbol === f.symbol)
      ));
    }
    if (g) {
      g.findings.push(f);
      if (SEV_ORDER[f.severity] > SEV_ORDER[g.severity]) g.severity = f.severity;
      if (!g.evidence && f.evidence) g.evidence = f.evidence;
    } else {
      groups.push({
        key,
        file: f.file,
        symbol: f.symbol || null,
        severity: f.severity,
        action: f.action,
        claim: f.claim,
        evidence: f.evidence,
        findings: [f],
      });
    }
  }

  for (const g of groups) {
    const authors = new Set(g.findings.map(f => f.by));
    g.corroborations = authors.size;
    g.weight = Math.min(4, 1 + SEV_WEIGHT[g.severity] + 0.5 * (authors.size - 1));
    g.agents = [...authors];
    for (const f of g.findings) f.groupKey = g.key;
  }
  groups.sort((a, b) => b.weight - a.weight || b.findings.length - a.findings.length || a.action.localeCompare(b.action));

  const room0 = room.agenda.length;
  const roomForPoints = Math.max(0, Math.min(CAPS.maxFindingPoints, CAPS.maxPoints + CAPS.maxFindingPoints - room0));
  const accepted = groups.slice(0, roomForPoints);
  const deferred = groups.slice(roomForPoints);

  const created = [];
  for (const g of accepted) {
    // Un punto de agenda es una etiqueta, no el informe entero: el texto completo de la
    // acción viaja en el punto (audit.action) y en el diff que verá quien lo trabaje.
    const label = `Mejora: ${gist(g.action, 160)}`;
    const point = normalizeAgenda([{
      label,
      weight: g.weight,
      options: [
        { id: 'aplicar', label: 'Aplicar esta mejora' },
        { id: 'aplazar', label: 'Aplazarla' },
        { id: 'descartar', label: 'Descartarla' },
      ],
    }])[0];
    if (!point) continue;
    if (room.agenda.some(p => p.id === point.id)) continue;
    point.source = 'finding';
    point.findingIds = g.findings.map(f => f.id);
    point.createdBy = g.agents[0] || null;
    point.audit = {
      file: g.file,
      severity: g.severity,
      corroborations: g.corroborations,
      claim: g.claim,
      evidence: g.evidence,
      action: g.action,
    };
    room.agenda.push(point);
    for (const f of g.findings) f.pointId = point.id;
    created.push(point);
    log(room, null, 'work',
      `Mejora a debate: «${g.action}»${g.file ? ` (${g.file})` : ''} — ${g.severity}${g.corroborations > 1 ? `, corroborado por ${g.corroborations} agentes` : ''}.`);
  }

  const noFile = groups.filter(g => !g.file).length;
  return {
    groups: groups.length,
    points: created.map(p => p.id),
    accepted: created.length,
    deferred: deferred.length,
    findings: findings.length,
    filesWithoutFindings: noFile,
  };
}

function tokensOf(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9áéíóúñ]+/).filter(w => w.length > 3);
}

// Solapamiento (coeficiente de contención): el conjunto pequeño cabe en el grande.
// Dos frases que comparten el núcleo describen la misma mejora aunque una sea más
// larga; con Jaccard a secas, la más detallada nunca se fusionaría.
function overlap(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

// ---------------------------------------------------------------- 2. aprobación
// Una mejora está aprobada si la opción modal es «aplicar» y alguien la votó.
export function approvedImprovements(room) {
  const report = consensusReport(room);
  const out = [];
  for (const p of report.points) {
    const point = room.agenda.find(x => x.id === p.id);
    if (!point || point.source !== 'finding') continue;
    const applyShare = (p.choices.find(c => c.id === 'aplicar')?.share) || 0;
    if (p.modal?.id !== 'aplicar' || p.voters === 0) continue;
    out.push({
      pointId: point.id,
      title: point.audit?.action || point.label,
      label: point.label,
      files: point.audit?.file ? [point.audit.file] : [],
      severity: point.audit?.severity || 'med',
      claim: point.audit?.claim || '',
      evidence: point.audit?.evidence || '',
      findingIds: point.findingIds || [],
      share: applyShare,
      voters: p.voters,
      dissenting: p.choices.slice(1).flatMap(c => c.agents),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 3bis. plan → tareas
// En un PROYECTO NUEVO no hay nada que auditar: no existe código viejo que criticar. El trabajo
// ES el plan que el debate aprobó, así que se convierte en tareas. Cada punto de agenda que el
// debate decidió es una parte del producto que hay que escribir, con la decisión tomada como
// enunciado. Si no hay puntos decididos se reparte el plan por sus secciones y, si tampoco las
// tiene, queda UNA tarea con el plan entero: una sala sin repo nunca acaba «solo en plan».
const PLAN_FILE_RE = /[\w][\w./-]*\.(?:mjs|js|ts|tsx|jsx|glsl|vert|frag|html|css|json|md|py|go|rs|java|c|cpp|h|sh|yml|yaml)\b/gi;
const MAX_PLAN_CLAIM = 4_000;

// El plan ganador: la síntesis si la hay, y si no el plan de la propuesta que ganó.
export function planText(room) {
  const syn = room.artifacts?.synthesis;
  if (syn?.final) return String(syn.final);
  const winner = room.lastWinnerId ? room.artifacts?.proposals?.[room.lastWinnerId] : null;
  return String(winner?.plan || '');
}

// Rutas de archivo que el propio plan nombra: son la pista de dónde va cada tarea.
function filesInPlan(text, limit = 3) {
  const out = [];
  for (const m of String(text || '').matchAll(PLAN_FILE_RE)) {
    const p = m[0].replace(/^\.\//, '').replace(/[.,;:)]+$/, '');
    if (p.length <= 120 && !out.includes(p)) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// Secciones de un plan largo: los encabezados con los que un agente lo escribe («A) …», «## …»,
// «1. …», una línea en mayúsculas). Un plan sin encabezados es una sola tarea.
function planSectionList(plan, max) {
  const lineas = String(plan || '').split('\n');
  const esTitulo = l => /^#{1,4}\s+\S/.test(l)
    || /^[A-Z][.)]\s+\S/.test(l)
    || /^\d{1,2}[.)]\s+\S/.test(l)
    || /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 ,:/()\-–—]{6,}$/.test(l.trim());
  const out = [];
  let actual = null;
  const empujar = () => {
    if (!actual) return;
    const cuerpo = actual.cuerpo.join('\n').trim();
    if (actual.titulo || cuerpo) out.push({ titulo: actual.titulo || 'Plan ganador', cuerpo });
    actual = null;
  };
  for (const linea of lineas) {
    if (esTitulo(linea)) { empujar(); actual = { titulo: linea.replace(/^#{1,4}\s*/, '').trim(), cuerpo: [] }; continue; }
    if (!actual) actual = { titulo: '', cuerpo: [] };
    actual.cuerpo.push(linea);
  }
  empujar();
  return out.slice(0, max);
}

export function planImprovements(room) {
  if (!room.repo?.greenfield) return [];
  const syn = room.artifacts?.synthesis || {};
  const resueltos = new Map((syn.pointResolutions || []).map(r => [r.pointId, r]));
  const report = consensusReport(room);
  const out = [];
  for (const p of report.points) {
    const point = (room.agenda || []).find(x => x.id === p.id);
    // Los puntos de reglas no se construyen: son protocolo, no producto.
    if (!point || point.source === 'rule') continue;
    const decision = p.modal && p.modal.id ? p.modal : null;
    const r = resueltos.get(p.id) || null;
    if (!decision && !r) continue;      // sin decidir: no se convierte en tarea
    const decidido = decision?.label ? `«${decision.label}»` : '';
    const nota = String(r?.note || r?.evidence || '').trim();
    out.push({
      pointId: point.id,
      title: clampStr(point.label, 140),
      label: point.label,
      files: filesInPlan(`${point.label} ${nota} ${decidido}`),
      severity: p.status === 'agreed' ? 'high' : 'med',
      claim: clampStr(`Implementa esta parte del plan: ${point.label}. Decisión del debate: ${decidido || 'la del plan ganador'}.` +
        (nota ? ` ${nota}` : ''), MAX_PLAN_CLAIM),
      evidence: `Plan ganador de la sala, síntesis del debate (${p.source === 'finding' ? 'hallazgo auditado' : 'punto de agenda'}, ${p.voters} votos, ${Math.round((p.share || 0) * 100)}% de acuerdo).`,
      findingIds: [],
      share: p.share || 0,
      voters: p.voters || 0,
      dissenting: (p.choices || []).slice(1).flatMap(c => c.agents),
    });
  }
  if (out.length) return out;

  // Sin puntos decididos, el plan habla por sí solo: una tarea por sección.
  const max = Number(room.settings?.repo?.maxWorkItems) || 6;
  const plan = planText(room);
  const secciones = planSectionList(plan, max);
  if (!secciones.length) return [];
  return secciones.map((s, i) => ({
    pointId: null,
    title: clampStr(s.titulo || `Parte ${i + 1} del plan`, 140),
    label: s.titulo,
    files: filesInPlan(`${s.titulo} ${s.cuerpo}`),
    severity: i === 0 ? 'high' : 'med',
    claim: clampStr(s.cuerpo || s.titulo, MAX_PLAN_CLAIM),
    evidence: 'Sección del plan ganador (la síntesis no llegó a resolver puntos de agenda).',
    findingIds: [],
    share: 0,
    voters: 0,
    dissenting: [],
  }));
}

// Lo que hay que trabajar en ESTA ronda: las mejoras aprobadas de una auditoría (un repo con
// historia, o una ronda posterior de un proyecto nuevo, que ya tiene código que leer) o el plan
// mismo (proyecto nuevo, ronda 1: todavía no hay nada que auditar).
export function workFrom(room) {
  if (room.repo?.greenfield && (room.rounds || 1) === 1) return planImprovements(room);
  return approvedImprovements(room);
}

// ---------------------------------------------------------------- 3. trabajo
export function startWork(room, winnerId) {
  const approved = workFrom(room);
  const winner = room.artifacts.proposals[winnerId] || null;
  const work = {
    branch: room.repo?.branch || null,
    baseCommit: room.repo?.baseCommit || null,
    head: room.repo?.head || null,
    startedAt: now(),
    finishedAt: null,
    seq: 0,
    patchSeq: 0,
    items: {},
    order: [],
    patches: {},
    pending: null,          // parche aplicado esperando revisión o verificación
    verifyRuns: 0,
    baseline: room.repo?.baseline || null,
    deferred: room.artifacts.findings.filter(f => !f.pointId).length,
    approvedTotal: approved.length,
    notes: [],
  };
  const cap = Number(room.settings?.repo?.maxWorkItems) || 6;
  const chosen = approved.slice(0, cap);
  for (const imp of chosen) {
    const id = `w${++work.seq}`;
    work.items[id] = {
      id,
      pointId: imp.pointId,
      title: clampStr(imp.title, 140),
      claim: imp.claim,
      evidence: imp.evidence,
      files: imp.files,
      severity: imp.severity,
      findingIds: imp.findingIds,
      share: imp.share,
      voters: imp.voters,
      round: room.rounds || 1,
      status: 'open',
      claimant: null,
      claimedAt: null,
      attempts: 0,
      verifyFailures: 0,
      patches: [],
      review: null,
      verify: null,
      commit: null,
      reviewer: null,
      lastError: null,
      note: null,
      startedAt: null,
      finishedAt: null,
    };
    work.order.push(id);
  }
  work.skippedByCap = approved.length - chosen.length;
  room.work = work;
  return work;
}

// Vuelta a trabajar en una ronda posterior: las mejoras aprobadas en ESTA ronda que aún no
// tienen tarea se añaden a la cola que ya existe. `startWork` construye la cola desde cero (lo
// correcto en la ronda 1); esto es lo mismo pero aditivo, con el mismo formato de tarea.
export function ensureWorkItems(room, { max = 0 } = {}) {
  const work = room.work;
  if (!work) return [];
  // Ojo: las tareas nacidas del PLAN (proyecto nuevo) no tienen punto de agenda con relleno
  // agotable — se identifican por su id de punto o, si no lo tienen, por su título. Sin esto, la
  // vuelta al trabajo volvía a crear las mismas secciones de plan.
  const yaTienen = new Set(work.order.map(id => work.items[id]?.pointId || work.items[id]?.title).filter(Boolean));
  const pendientes = workFrom(room).filter(imp => !yaTienen.has(imp.pointId || imp.title));
  const limite = max || Number(room.settings?.repo?.maxWorkItems) || 6;
  const hueco = Math.max(0, limite - work.order.length);
  const creadas = [];
  for (const imp of pendientes.slice(0, hueco)) {
    const id = `w${++work.seq}`;
    work.items[id] = {
      id,
      pointId: imp.pointId,
      title: clampStr(imp.title, 140),
      claim: imp.claim,
      evidence: imp.evidence,
      files: imp.files,
      severity: imp.severity,
      findingIds: imp.findingIds,
      share: imp.share,
      voters: imp.voters,
      round: room.rounds || 1,
      from: 'recursion',
      status: 'open',
      claimant: null,
      claimedAt: null,
      attempts: 0,
      verifyFailures: 0,
      patches: [],
      review: null,
      verify: null,
      commit: null,
      reviewer: null,
      lastError: null,
      note: null,
      startedAt: null,
      finishedAt: null,
    };
    work.order.push(id);
    creadas.push(work.items[id]);
    log(room, null, 'work',
      `Nueva tarea ${id} de la ronda ${room.rounds || 1}: «${gist(imp.title, 90)}»${imp.files.length ? ` (${imp.files.join(', ')})` : ''}.`);
  }
  work.skippedByCap = Math.max(work.skippedByCap || 0, pendientes.length - creadas.length);
  work.approvedTotal = workFrom(room).length;
  return creadas;
}

export function workItem(room, ref) {
  const id = clampStr(ref, 20);
  if (!id) return null;
  return room.work?.items?.[id] || null;
}

export function openItems(room) {
  return (room.work?.order || []).map(id => room.work.items[id]).filter(i => i && !TERMINAL.has(i.status));
}

export function workIsFinished(room) {
  const work = room.work;
  if (!work) return true;
  if (!work.order.length) return true;
  return openItems(room).length === 0;
}

function canWork(room, agentId) {
  const a = room.agents[agentId];
  return !!a && a.status !== 'absent' && !a.overBudget && !a.workOptOut;
}

function claimedItemOf(room, agentId) {
  return (room.work?.order || []).map(id => room.work.items[id])
    .find(i => i && i.claimant === agentId && !TERMINAL.has(i.status)) || null;
}

// Reparto del trabajo: quien más ha reclamado se queda al final de la cola, y el
// revisor de un parche nunca es su autor.
export function claimItem(room, agentId, payload = {}) {
  const work = room.work;
  const agent = room.agents[agentId];
  if (!canWork(room, agentId)) {
    throw new DebateError('unauthorized', `No puedes reclamar trabajo ahora (${agent?.overBudget ? 'presupuesto agotado' : agent?.workOptOut ? 'te retiraste del trabajo' : 'no disponible'}).`);
  }
  const mine = claimedItemOf(room, agentId);
  if (mine) {
    throw new DebateError('duplicate',
      `Ya tienes la tarea ${mine.id} («${gist(mine.title, 60)}») en curso. Termínala con submit-patch antes de tomar otra.`);
  }
  const open = openItems(room).filter(i => i.status === 'open');
  if (!open.length) {
    const busy = openItems(room).map(i => `${i.id}:${i.status}`).join(', ');
    throw new DebateError('bad_payload', `No hay tareas libres ahora mismo${busy ? ` (en curso: ${busy})` : ''}.`);
  }
  const ref = clampStr(payload.itemId || payload.id, 20);
  let item = ref ? work.items[ref] : null;
  if (ref && !item) {
    throw new DebateError('bad_payload', `Tarea desconocida: ${ref}. Libres: ${open.map(i => i.id).join(', ')}.`);
  }
  if (!item) item = [...open].sort((a, b) => a.seq - b.seq)[0];
  if (item.status !== 'open') {
    throw new DebateError('bad_payload',
      `La tarea ${item.id} está «${item.status}»${item.claimant ? ` (la tiene ${nameOf(room, item.claimant)})` : ''}. Libres: ${open.filter(i => i.status === 'open').map(i => i.id).join(', ') || 'ninguna'}.`);
  }
  item.status = 'claimed';
  item.claimant = agentId;
  item.claimedAt = now();
  item.startedAt = item.startedAt || now();
  item.lastError = null;
  agent.workClaims = (agent.workClaims || 0) + 1;
  log(room, agentId, 'work',
    `${nameOf(room, agentId)} toma la tarea ${item.id}: «${gist(item.title, 110)}»${item.files.length ? ` (${item.files.join(', ')})` : ''}.`);
  return item;
}

export function submitPatch(room, agentId, payload = {}) {
  const p = obj(payload);
  const work = room.work;
  const item = workItem(room, p.itemId ?? p.id ?? claimedItemOf(room, agentId)?.id);
  if (!item) {
    throw new DebateError('bad_payload',
      `payload: {itemId:"w1", summary:"≤200", diff:"diff unificado"} o {itemId, summary, files:[{path, content}]}. Tareas: ${(work?.order || []).join(', ') || 'ninguna'}.`);
  }
  if (item.claimant !== agentId || TERMINAL.has(item.status)) {
    throw new DebateError('not_claimed',
      `La tarea ${item.id} no es tuya ahora mismo (estado ${item.status}${item.claimant ? `, la trabaja ${nameOf(room, item.claimant)}` : ''}). Reclámala con claim-item.`);
  }
  if (work.pending) {
    const busy = work.patches[work.pending];
    throw new DebateError('busy',
      `Hay un parche de la tarea ${busy?.itemId} esperando ${busy?.review ? 'verificación' : 'revisión'}. No se aplican dos parches a la vez sobre el mismo árbol: reintenta en un momento.`);
  }
  const cuts = [];
  const summary = fit(p.summary ?? p.note, CAPS.patchSummary, 'summary', cuts) || gist(item.title, 120);
  const files = fitList(p.files, CAPS.patchFilesMax, 'files', cuts).map((f, i) => {
    const o = obj(f);
    const filePath = clampStr(o.path ?? o.file, CAPS.findingFile);
    return {
      path: filePath,
      // El contenido de un archivo es del agente, palabra por palabra: se le aplica el
      // techo y nada más (normalizarlo le quitaría los espacios finales y los CRLF).
      content: typeof o.content === 'string'
        ? fit(o.content, CAPS.patchFileMax, `files[${i}] (${filePath || 'sin ruta'})`, cuts, { raw: true })
        : '',
    };
  }).filter(f => f.path);
  // Un diff unificado no se normaliza: quitarle los espacios finales de las líneas de
  // contexto lo deja corrupto y `git apply` lo rechaza (pasó al probarlo).
  const diff = typeof p.diff === 'string' ? fit(p.diff, CAPS.patchDiffMax, 'diff', cuts, { raw: true }) : '';
  if (!diff && !files.length) {
    throw new DebateError('bad_payload',
      'payload: {itemId, summary, diff:"--- a/… +++ b/… @@ …"} o {itemId, summary, files:[{path, content}]}. Usa files[] para reescribir un archivo completo.');
  }

  const res = stagePatch(room, { diff, files });
  item.attempts += 1;
  if (!res.ok) {
    item.lastError = clampText(res.error, 6_000);
    throw new DebateError('patch_failed',
      `El parche no se pudo aplicar sobre ${work.branch} (intento ${item.attempts}). ${res.error}`);
  }

  const id = `g${++work.patchSeq}`;
  const patch = {
    id,
    itemId: item.id,
    author: agentId,
    at: now(),
    summary,
    mode: diff ? (files.length ? 'diff+files' : 'diff') : 'files',
    diff: res.diff,
    stat: res.stat,
    headBefore: res.headBefore,
    reviewer: null,
    review: null,
    verify: null,
    committed: false,
    sha: null,
    superseded: false,
  };
  patch.reviewer = assignReviewer(room, item, agentId);
  work.patches[id] = patch;
  item.patches.push(id);
  item.status = 'in-review';
  item.reviewer = patch.reviewer;
  item.lastError = null;
  work.pending = id;
  log(room, agentId, 'patch',
    `${nameOf(room, agentId)} entrega el parche ${id} para ${item.id} (${plural(res.stat.fileCount, 'archivo')}, +${res.stat.insertions}/-${res.stat.deletions})${patch.reviewer ? `; lo revisa ${nameOf(room, patch.reviewer)}` : '; sin revisor disponible'}.`);
  if (!patch.reviewer) cuts.push('no hay otro agente disponible: el parche se integrará marcado como no revisado');
  return { item, patch, warnings: cuts };
}

function assignReviewer(room, item, authorId) {
  const candidates = activeAgents(room).filter(id => id !== authorId && canWork(room, id));
  if (!candidates.length) {
    const anyOther = activeAgents(room).filter(id => id !== authorId);
    return anyOther[0] || null;
  }
  const load = id => {
    const a = room.agents[id];
    return (a.workReviews || 0) * 2 + (a.workClaims || 0);
  };
  return [...candidates].sort((a, b) => load(a) - load(b) || (room.agents[a].joinedAt - room.agents[b].joinedAt))[0];
}

export function reviewPatch(room, agentId, payload = {}) {
  const p = obj(payload);
  const work = room.work;
  const patchId = clampStr(p.patchId ?? p.id, 20) || work.pending;
  const patch = patchId ? work.patches[patchId] : null;
  if (!patch) {
    throw new DebateError('bad_payload', `Parche desconocido. Pendiente de revisión: ${work.pending || 'ninguno'}.`);
  }
  const item = work.items[patch.itemId];
  if (patch.review) throw new DebateError('duplicate', `El parche ${patch.id} ya fue revisado por ${nameOf(room, patch.review?.by)}.`);
  if (patch.author === agentId) {
    throw new DebateError('self_review',
      `Nadie revisa su propio parche: ${patch.id} lo escribiste tú. La revisión es de otro agente (${patch.reviewer ? `asignada a ${nameOf(room, patch.reviewer)}` : 'sin asignar: cualquiera menos tú'}).`);
  }
  if (item.status !== 'in-review') {
    throw new DebateError('wrong_phase', `La tarea ${item.id} no está en revisión (estado ${item.status}).`);
  }
  const verdict = p.verdict === 'changes' || p.verdict === 'reject' || p.approve === false ? 'changes' : 'approve';
  const cuts = [];
  const notes = fit(p.notes ?? p.note ?? p.reason, CAPS.reviewNotes, 'notes', cuts, { keepLines: true });
  if (verdict === 'changes' && notes.length < 3) {
    throw new DebateError('bad_payload', 'Para pedir cambios hace falta el motivo: payload:{verdict:"changes", notes:"qué está mal y qué esperas"}');
  }
  const agent = room.agents[agentId];
  agent.workReviews = (agent.workReviews || 0) + 1;
  patch.review = { by: agentId, verdict, notes, at: now() };

  if (verdict === 'changes') {
    unstagePatch(room);
    patch.superseded = true;
    item.status = 'open';
    item.claimant = null;
    item.reviewer = null;
    item.review = patch.review;
    item.lastError = clampText(`Revisión de ${nameOf(room, agentId)}: ${notes}`, 6_000);
    work.pending = null;
    log(room, agentId, 'review',
      `${nameOf(room, agentId)} rechaza el parche ${patch.id} de «${gist(item.title, 80)}»: ${gist(notes, 140)}. El árbol vuelve atrás y la tarea queda libre.`);
    return { item, patch, verdict, warnings: cuts };
  }

  log(room, agentId, 'review',
    `${nameOf(room, agentId)} aprueba el parche ${patch.id} de «${gist(item.title, 80)}»${notes ? `: ${gist(notes, 120)}` : ''}.`);
  if (!room.repo?.verify) {
    const integration = integrate(room, item, patch, { ran: false, reason: 'sin comando de verificación declarado' });
    return { item, patch, verdict, integration, warnings: [...cuts, 'no hay comando de verificación: el parche se integra sin comprobar'] };
  }
  item.status = 'verifying';
  patch.verify = { ran: false, status: 'running', command: room.repo.verify.command, at: now() };
  // La promesa viva es la marca de «esto está corriendo ahora»: si el proceso muere,
  // la marca desaparece con él y recoverInterruptedWork sabe que debe retomarlo.
  const promise = verifyThenIntegrate(room, item, patch);
  room.__pendingVerify = promise;
  promise.catch(() => null).finally(() => {
    if (room.__pendingVerify === promise) delete room.__pendingVerify;
  });
  return { item, patch, verdict, warnings: [...cuts, `verificando «${room.repo.verify.command}» en segundo plano; vuelve a /turn para ver el resultado`] };
}

async function verifyThenIntegrate(room, item, patch) {
  const out = await runVerify(room);
  if (room.status === 'closed' || item.status !== 'verifying' || room.work?.pending !== patch.id) return null;
  room.work.verifyRuns += 1;
  const baselineFailed = room.repo?.baseline?.status === 'done' && room.repo.baseline.ran && !room.repo.baseline.ok;
  if (out.ok) return integrate(room, item, patch, out);

  patch.verify = { ...out, status: 'done' };
  item.verify = { ...out, ok: false };
  if (baselineFailed) {
    // La suite ya estaba en rojo antes de tocar nada: el fallo no es de este parche.
    log(room, null, 'work',
      `Verificación en rojo, pero la línea base de la sala también lo estaba antes del parche: se integra marcado como «fallo preexistente» y se conserva su salida.`);
    return integrate(room, item, patch, out, { preExisting: true });
  }
  unstagePatch(room);
  room.work.pending = null;
  patch.superseded = true;
  patch.committed = false;
  item.verifyFailures += 1;
  item.status = item.verifyFailures >= 3 ? 'failed' : 'open';
  item.claimant = null;
  item.reviewer = null;
  item.lastError = clampText(
    `La verificación «${out.command}» falló con código ${out.exitCode}:\n${out.outputTail}`, 12_000);
  if (item.status === 'failed') {
    item.note = `Se intentó 3 veces y la verificación siguió fallando: la sala lo deja registrado como fallo, no como éxito.`;
    log(room, null, 'work', `La tarea ${item.id} «${gist(item.title, 80)}» se marca como fallida tras 3 intentos: no se integra.`);
  } else {
    log(room, null, 'work',
      `Verificación en rojo para ${item.id} (${out.command}: ${out.exitCode}); el árbol vuelve atrás y la tarea queda libre con la salida a la vista.`);
  }
  changed(room);
  return null;
}

function integrate(room, item, patch, verify, extra = {}) {
  const work = room.work;
  const author = room.agents[patch.author];
  const reviewer = patch.review?.by ? room.agents[patch.review.by] : null;
  const lines = [
    `agora(${room.code}): ${item.title}`,
    '',
    `Tarea ${item.id} aprobada en el debate ${room.code} (punto ${item.pointId}).`,
    `Parche ${patch.id} por ${author?.name || patch.author}${author?.harness ? ` (${author.harness})` : ''}` +
    `${reviewer ? ` · revisado por ${reviewer.name}${reviewer.harness ? ` (${reviewer.harness})` : ''}` : ' · SIN revisión independiente'}.`,
    verify?.ran
      ? `Verificación «${verify.command}» → código ${verify.exitCode}${extra.preExisting ? ' (el fallo ya existía antes del parche)' : ''}.`
      : `Sin verificación ejecutable declarada en la sala.`,
  ];
  const commit = commitStaged(room, {
    message: lines.join('\n'),
    authorName: `${author?.name || patch.author}${author?.harness ? ` (${author.harness})` : ''}`,
  });
  patch.verify = verify?.ran ? { ...verify, status: 'done' } : { ran: false, reason: verify?.reason || 'sin verificación', status: 'done' };
  patch.committed = !!commit.ok;
  patch.sha = commit.sha || null;
  patch.commitError = commit.ok ? null : commit.error;
  item.status = 'integrated';
  item.commit = commit.sha || null;
  item.verify = patch.verify;
  item.review = patch.review;
  item.finishedAt = now();
  work.pending = null;
  work.head = room.repo?.head || work.head;
  if (extra.preExisting) item.verifyPreExisting = true;
  if (!patch.review) item.unreviewed = true;
  log(room, null, 'work',
    `Tarea ${item.id} integrada${commit.sha ? ` en ${String(commit.sha).slice(0, 8)}` : commit.ok ? '' : ` (el commit falló: ${gist(commit.error || '', 80)})`}` +
    `${verify?.ran ? ` · verificación ${verify.exitCode === 0 ? 'en verde' : `en rojo (${verify.exitCode})`}` : ' · sin verificación'}.`);
  changed(room);
  return { ok: commit.ok, sha: commit.sha || null };
}

export function passWork(room, agentId, payload = {}) {
  const agent = room.agents[agentId];
  const item = claimedItemOf(room, agentId);
  const cuts = [];
  if (item) {
    // Retirarse con una tarea en curso la devuelve al montón: no se bloquea el trabajo.
    item.status = 'open';
    item.claimant = null;
    item.note = fit(payload.reason, CAPS.workNote, 'reason', cuts, { keepLines: true }) || 'el agente se retiró del trabajo';
    log(room, agentId, 'work', `${nameOf(room, agentId)} devuelve la tarea ${item.id} al montón (${item.note}).`);
  }
  agent.workOptOut = true;
  log(room, agentId, 'work', `${nameOf(room, agentId)} deja el trabajo del repo y pasa a observador.`);
  return { warnings: cuts };
}

// Una tarea reclamada por alguien que ya no está (ausente, o sin dar señales desde
// hace rato) no puede dejar la sala esperando al plazo: vuelve al montón para que
// otro la tome. Nunca se libera si su parche está en manos del servidor (pendiente de
// revisión o de verificación), porque ahí el trabajo sí sigue vivo.
export function sweepClaims(room) {
  const work = room.work;
  if (!work || work.finishedAt || !work.order.length) return false;
  const t = now();
  const idleMs = claimIdleThresholdMs(room);
  const pendingItem = work.pending ? work.patches[work.pending]?.itemId : null;
  let released = false;

  for (const id of work.order) {
    const item = work.items[id];
    if (!item?.claimant || TERMINAL.has(item.status) || item.id === pendingItem) continue;
    const agent = room.agents[item.claimant];
    if (!agent) continue;
    const since = agent.lastSeenAt || item.claimedAt || t;
    const silentMs = t - since;
    const gone = agent.status === 'absent' || silentMs > idleMs;
    if (!gone) continue;

    const min = Math.max(1, Math.round(silentMs / 60_000));
    const why = agent.status === 'absent'
      ? `${agent.name} pasó a ausente`
      : `${agent.name} lleva ${min} min sin dar señales`;
    item.status = 'open';
    item.claimant = null;
    item.reviewer = null;
    item.note = `La tarea vuelve al montón: ${why}.`;
    log(room, null, 'work',
      `La tarea ${item.id} «${gist(item.title, 80)}» vuelve al montón: ${why}.${item.patches?.length ? ` Conserva el parche ${item.patches[item.patches.length - 1]} para quien la retome.` : ''}`);
    released = true;
  }
  if (released) changed(room);
  return released;
}

// Cuando nadie puede trabajar, el trabajo se cierra con lo que haya: mejor decir
// «no se hizo» que esperar media hora a que expire el plazo.
export function maybeFinishWork(room) {
  const work = room.work;
  if (!work) return true;
  if (workIsFinished(room)) return true;
  const able = activeAgents(room).filter(id => canWork(room, id));
  const pending = work.pending ? work.patches[work.pending] : null;
  if (!able.length && !pending) return true;
  return false;
}

// ---------------------------------------------------------------- deshacer
// La verificación puede pasar en verde y aun así el cambio ser un error: el juicio
// final es del humano. Deshacer se hace revirtiendo el commit REAL (`git revert`: queda
// en el historial, no se reescribe nada) y después se vuelve a verificar, porque «ya no
// está» tampoco se da por bueno sin comprobarlo.
export function revertItem(room, { itemId = null, reason = '', by = null } = {}) {
  const work = room.work;
  const repo = room.repo;
  if (!repo?.dir) return { ok: false, error: 'Esta sala no tiene repositorio.' };
  if (!work) return { ok: false, error: 'Esta sala no tiene trabajo conjunto.' };
  if (work.pending) {
    return { ok: false, error: `Hay un parche sin resolver (${work.pending}): espera a que termine antes de deshacer nada.` };
  }
  const done = work.order.map(id => work.items[id]).filter(i => i.status === 'integrated' && i.commit);
  if (!done.length) return { ok: false, error: 'No hay ninguna mejora integrada con commit que deshacer.' };
  const item = itemId ? work.items[itemId] : done[done.length - 1];
  if (!item) return { ok: false, error: `La tarea ${itemId} no existe en esta sala.` };
  if (item.status !== 'integrated') {
    return { ok: false, error: `La tarea ${item.id} está en «${item.status}»: solo se deshace lo que está integrado.` };
  }
  if (!item.commit) return { ok: false, error: `La tarea ${item.id} no dejó commit: no hay nada que revertir.` };

  const why = clampStr(reason, 400);
  const message = [
    `agora(${room.code}): deshace «${item.title}»`,
    '',
    `Revierte el commit ${String(item.commit).slice(0, 8)} que integró la tarea ${item.id} (punto ${item.pointId})`,
    `tras la verificación de la sala. Decisión del humano sobre la rama ${repo.branch}.`,
    why ? `Motivo: ${why}.` : 'Sin motivo escrito.',
    '',
    `Revirtiendo un commit revisado y verificado en el debate ${room.code}.`,
  ].join('\n');

  const res = revertCommit(room, { sha: item.commit, message, authorName: by || 'humano' });
  if (!res.ok) {
    log(room, null, 'work',
      `No se pudo deshacer «${gist(item.title, 70)}»: ${res.error}`);
    changed(room);
    return res;
  }

  const touched = commitFiles(room, item.commit);
  item.status = 'reverted';
  item.finishedAt = item.finishedAt || now();
  item.revert = {
    of: item.commit,
    commit: res.sha,
    reason: why || null,
    by: by || 'humano',
    at: now(),
    files: touched.files,
    stat: touched.stat,
    verify: repo.verify ? { status: 'running', ran: false, command: repo.verify.command, at: now() } : null,
  };
  work.head = repo.head;
  log(room, null, 'work',
    `Deshecha la tarea ${item.id} «${gist(item.title, 80)}»: se revirtió ${String(item.commit).slice(0, 8)} en ${String(res.sha).slice(0, 8)} sobre la rama ${repo.branch}${why ? ` (motivo: ${gist(why, 120)})` : ''}.`);
  // El informe congelado no puede seguir contando como integrado lo que ya no está, ni
  // seguir diciendo «verificando» cuando la verificación ya terminó.
  refreshResult(room);
  changed(room);

  if (item.revert.verify) {
    const p = verifyAfterRevert(room, item);
    room.__pendingRevertVerify = p;
    p.catch(() => null).finally(() => {
      if (room.__pendingRevertVerify === p) delete room.__pendingRevertVerify;
    });
  }
  return { ok: true, item: item.id, of: item.commit, commit: res.sha, branch: repo.branch, head: repo.head };
}

// Volver a aplicarlo es la vuelta atrás de la vuelta atrás: se revierte la reversión (el
// historial conserva lo que pasó) y se vuelve a verificar. Un botón junto a datos tiene que
// poder deshacerse; si no, un clic equivocado obliga a tocar git a mano.
export function reapplyItem(room, { itemId = null, reason = '', by = null } = {}) {
  const work = room.work;
  const repo = room.repo;
  if (!repo?.dir) return { ok: false, error: 'Esta sala no tiene repositorio.' };
  if (!work) return { ok: false, error: 'Esta sala no tiene trabajo conjunto.' };
  if (work.pending) {
    return { ok: false, error: `Hay un parche sin resolver (${work.pending}): espera a que termine antes de tocar la rama.` };
  }
  const undone = work.order.map(id => work.items[id]).filter(i => i.status === 'reverted' && i.revert?.commit);
  if (!undone.length) return { ok: false, error: 'No hay ninguna mejora deshecha que volver a aplicar.' };
  const item = itemId ? work.items[itemId] : undone[undone.length - 1];
  if (!item) return { ok: false, error: `La tarea ${itemId} no existe en esta sala.` };
  if (item.status !== 'reverted') {
    return { ok: false, error: `La tarea ${item.id} está en «${item.status}»: solo se vuelve a aplicar lo que está deshecho.` };
  }

  const why = clampStr(reason, 400);
  const message = [
    `agora(${room.code}): vuelve a aplicar «${item.title}»`,
    '',
    `Revierte la reversión ${String(item.revert.commit).slice(0, 8)} y devuelve al proyecto la mejora de la tarea ${item.id}`,
    `(punto ${item.pointId}), tal como la aprobó el debate ${room.code}.`,
    why ? `Motivo: ${why}.` : 'Sin motivo escrito.',
  ].join('\n');

  const res = revertCommit(room, { sha: item.revert.commit, message, authorName: by || 'humano' });
  if (!res.ok) {
    log(room, null, 'work',
      `No se pudo volver a aplicar «${gist(item.title, 70)}»: ${res.error}`);
    changed(room);
    return res;
  }

  item.status = 'integrated';
  item.commit = res.sha;
  item.reapplied = {
    of: item.revert.commit,
    commit: res.sha,
    reason: why || null,
    by: by || 'humano',
    at: now(),
    revertedAt: item.revert.at,
    verify: repo.verify ? { status: 'running', ran: false, command: repo.verify.command, at: now() } : null,
  };
  work.head = repo.head;
  log(room, null, 'work',
    `Vuelta a aplicar la tarea ${item.id} «${gist(item.title, 80)}»: se revirtió la reversión ${String(item.revert.commit).slice(0, 8)} en ${String(res.sha).slice(0, 8)} sobre la rama ${repo.branch}${why ? ` (motivo: ${gist(why, 120)})` : ''}.`);
  refreshResult(room);
  changed(room);

  if (item.reapplied.verify) {
    const p = verifyAfterChange(room, item, item.reapplied, 'volver a aplicar');
    room.__pendingRevertVerify = p;
    p.catch(() => null).finally(() => {
      if (room.__pendingRevertVerify === p) delete room.__pendingRevertVerify;
    });
  }
  return { ok: true, item: item.id, of: item.revert.commit, commit: res.sha, branch: repo.branch, head: repo.head };
}

// Ni deshacer ni volver a aplicar eximen de comprobar: si la suite queda en rojo, se dice.
async function verifyAfterChange(room, item, holder, verb) {
  const out = await runVerify(room);
  if (!holder) return null;
  holder.verify = {
    status: 'done', ran: !!out.ran, ok: out.ok ?? null, exitCode: out.exitCode ?? null,
    command: out.command || null, durationMs: out.durationMs || null,
    outputTail: out.ok === false ? String(out.outputTail || '').slice(0, 2_000) : null,
    at: now(),
  };
  log(room, null, 'work', out.ran
    ? (out.ok
      ? `Tras ${verb} la tarea ${item.id}, la verificación «${out.command}» vuelve a pasar en verde.`
      : `Tras ${verb} la tarea ${item.id}, la verificación «${out.command}» queda en ROJO (código ${out.exitCode}): la rama quedó peor, revísalo.`)
    : `Tarea ${item.id}: no hay comando de verificación en la sala, no hay nada que comprobar.`);
  refreshResult(room);
  changed(room);
  return out;
}

const verifyAfterRevert = (room, item) => verifyAfterChange(room, item, item.revert, 'deshacer');

// ---------------------------------------------------------------- reanudación
// Lo único que no sobrevive a un reinicio es lo que corre en memoria: el sondeo de
// la línea base y la verificación de un parche aprobado. Si el servidor se cae
// justo ahí, la sala quedaba con una tarea «verificando» para siempre y el trabajo
// no volvía a moverse. La recuperación no adivina ni da nada por bueno: vuelve a
// ejecutar el mismo comando sobre el mismo árbol (el parche sigue aplicado en el
// clon) y sigue por donde iba.
// Una promesa viva es la única prueba de que el trabajo de fondo sigue en marcha. Se
// comprueba que sea una promesa de verdad y no un `{}` heredado de un JSON viejo.
function livePromise(value) {
  return typeof value?.then === 'function';
}

export function recoverInterruptedWork(room) {
  if (!room || room.status === 'closed') return null;
  const resumed = [];
  const promises = [];

  if (room.repo?.baseline?.status === 'running' && !livePromise(room.__baselinePromise)) {
    room.repo.baseline = { ...room.repo.baseline, at: now(), resumedAt: now() };
    const p = baselineInBackground(room, changed);
    if (p) promises.push(p);
    resumed.push('baseline');
  }

  const work = room.work;
  const patch = work?.pending ? work.patches[work.pending] : null;
  const item = patch ? work.items[patch.itemId] : null;
  if (patch && item && patch.verify?.status === 'running' && !livePromise(room.__pendingVerify)) {
    patch.verify = { ...patch.verify, status: 'running', resumedAt: now() };
    log(room, null, 'work',
      `La verificación del parche ${patch.id} (tarea ${item.id}) quedó a medias por un reinicio del servidor: se retoma «${patch.verify.command}» sobre el mismo árbol, no se da nada por bueno.`);
    const p = verifyThenIntegrate(room, item, patch);
    room.__pendingVerify = p;
    promises.push(p.catch(() => null).finally(() => {
      if (room.__pendingVerify === p) delete room.__pendingVerify;
      changed(room);
    }));
    resumed.push(patch.id);
  }

  // Deshacer (y volver a aplicar) también verifican en segundo plano: si el servidor muere
  // ahí, se retoma. Vale para las dos direcciones: la marca la pone quien la lanzó.
  const changedJob = (work?.order || [])
    .map(id => work.items[id])
    .map(item => {
      if (item?.revert?.verify?.status === 'running') return { item, holder: item.revert, verb: 'deshacer' };
      if (item?.reapplied?.verify?.status === 'running') return { item, holder: item.reapplied, verb: 'volver a aplicar' };
      return null;
    })
    .find(job => job && !livePromise(room.__pendingRevertVerify));
  if (changedJob) {
    const { item, holder, verb } = changedJob;
    holder.verify = { ...holder.verify, resumedAt: now() };
    log(room, null, 'work',
      `La verificación posterior a ${verb} la tarea ${item.id} quedó a medias por un reinicio: se vuelve a ejecutar «${holder.verify.command || 'la verificación de la sala'}» sobre el mismo árbol.`);
    const p = verifyAfterChange(room, item, holder, verb);
    room.__pendingRevertVerify = p;
    promises.push(p.catch(() => null).finally(() => {
      if (room.__pendingRevertVerify === p) delete room.__pendingRevertVerify;
      changed(room);
    }));
    resumed.push(`${verb === 'deshacer' ? 'revert' : 'reapply'}:${item.id}`);
  }

  return resumed.length ? { resumed, promise: Promise.all(promises) } : null;
}

export function closeWork(room, reason = 'plazo agotado') {
  const work = room.work;
  if (!work || work.finishedAt) return;
  if (work.pending) {
    const patch = work.patches[work.pending];
    const item = patch ? work.items[patch.itemId] : null;
    unstagePatch(room);
    if (patch) patch.superseded = true;
    if (item && !TERMINAL.has(item.status)) item.lastError = `Parche sin resolver al cerrar el trabajo (${reason}).`;
    work.pending = null;
  }
  for (const id of work.order) {
    const item = work.items[id];
    if (TERMINAL.has(item.status)) continue;
    item.status = 'skipped';
    item.note = `No se llegó a integrar: ${reason}.`;
    item.finishedAt = now();
    log(room, null, 'work', `Tarea ${item.id} «${gist(item.title, 80)}» no se integró (${reason}).`);
  }
  work.finishedAt = now();
  const integrated = work.order.filter(id => work.items[id].status === 'integrated').length;
  log(room, null, 'work',
    `Trabajo cerrado: ${integrated}/${work.order.length} mejoras integradas en la rama ${work.branch} (${reason}).`);
}

// ---------------------------------------------------------------- revisión posterior
// El trabajo integrado se revisa COMO CONJUNTO después de cerrarlo: cada pieza puede pasar
// su verificación y el resultado completo no ser lo que el debate quería. La revisión no es
// una formalidad: cada ítem recibe un veredicto de alguien que no lo escribió, y si con
// «trabajo extraordinario» aparece algo mejorable, vuelve a la cola de trabajo.
function integradasDe(room) {
  const work = room.work;
  if (!work) return [];
  return work.order.map(id => work.items[id]).filter(i => i && i.status === 'integrated');
}

// Qué le toca revisar a cada uno: todos los ítems integrados, repartidos entre los agentes
// activos evitando que quien lo escribió lo apruebe (si hay alguien más).
export function reviewAssignments(room, agentId) {
  const items = integradasDe(room);
  const ronda = { revisados: {}, ...(room.phase?.data?.review || {}) };
  const soloAutor = !!ronda.soloAutor;
  const done = ronda.revisados?.[agentId] || {};
  const revisados = {};
  for (const item of items) {
    // Un veredicto del propio autor NO da la mejora por revisada: para eso existe la
    // revisión. Solo cuenta el de otro agente (o el del autor cuando era el único que
    // podía mirarla). Antes cualquier veredicto marcaba el ítem como visto y dejaba a
    // los demás sin nada que revisar, con la fase esperando un veredicto que ya nadie
    // podía emitir.
    revisados[item.id] = Object.entries(ronda.revisados || {}).some(([who, porItem]) => (
      !!porItem?.[item.id] && (soloAutor || who !== item.claimant)
    ));
  }
  const mio = items.filter(i => i.claimant === agentId);
  const otros = items.filter(i => i.claimant !== agentId);
  const pendientes = (otros.length ? otros : mio).filter(i => !revisados[i.id]);
  return { items, pendientes, done, revisados };
}

// Estado de la revisión posterior, para el panel: qué mejoras integradas ya tienen veredicto
// de alguien que no las escribió, cuáles faltan y qué se propuso sin ejecutar. Se calcula con
// la MISMA regla que cierra la fase, así que lo que se ve es lo que falta de verdad.
export function reviewState(room) {
  const items = integradasDe(room);
  const ronda = room.phase?.name === 'review' ? (room.phase.data?.review || null) : null;
  // Fuera de la fase, los veredictos no se pierden: quedan en el artefacto. Sin esto, el
  // informe congelado diría «0 revisadas» de un trabajo que sí se revisó (mentira cómoda).
  if (!ronda) {
    const snap = room.artifacts?.reviewSnapshot;
    const propuestas = (room.artifacts.reviewPending || []).map(s => ({
      title: s.title, files: s.files || [], severity: s.severity || 'med', action: s.action, byName: s.by || null,
    }));
    if (snap) return { ...snap, active: false, proposals: propuestas };
    return {
      active: false,
      round: room.work?.reviewRounds || 0,
      maxRounds: room.settings?.repo?.reviewRounds || 2,
      extraordinary: !!room.settings?.extraordinary,
      total: items.length,
      // null = no hay registro de la revisión (sala anterior a esta pieza): se dice así
      // en vez de inventarse un cero.
      reviewed: items.length ? null : 0,
      reviewedItems: [],
      pending: [],
      unknown: items.length > 0,
      proposals: propuestas,
    };
  }
  const soloAutor = !!ronda?.soloAutor;
  const reviewed = [];
  const pending = [];
  for (const item of items) {
    const who = Object.entries(ronda?.revisados || {})
      .filter(([agentId, porItem]) => !!porItem?.[item.id] && (soloAutor || agentId !== item.claimant))
      .map(([agentId]) => nameOf(room, agentId));
    if (who.length) reviewed.push({ id: item.id, by: who });
    else pending.push({
      id: item.id,
      title: item.title,
      files: item.files || [],
      byName: item.claimant ? nameOf(room, item.claimant) : null,
    });
  }
  return {
    active: room.phase?.name === 'review',
    round: room.phase?.data?.review?.round || room.work?.reviewRounds || 0,
    maxRounds: room.settings?.repo?.reviewRounds || 2,
    extraordinary: !!room.settings?.extraordinary,
    total: items.length,
    reviewed: reviewed.length,
    reviewedItems: reviewed,
    pending,
    // Lo que la revisión propuso y no se llegó a ejecutar (sin trabajo extraordinario o
    // sin rondas): queda a la vista en lugar de desaparecer al cerrar la sala.
    proposals: (room.artifacts.reviewPending || []).map(s => ({
      title: s.title, files: s.files || [], severity: s.severity || 'med', action: s.action, byName: s.by || null,
    })),
  };
}

export function reviewIsCovered(room) {
  const items = integradasDe(room);
  if (!items.length) return true;
  const vistos = new Set();
  for (const [agentId, porItem] of Object.entries(room.phase.data.review?.revisados || {})) {
    for (const id of Object.keys(porItem || {})) {
      const item = room.work.items[id];
      if (!item || item.status !== 'integrated') continue;
      // Vale el veredicto de cualquiera que no la haya escrito; si nadie más podía, se acepta igual.
      if (room.phase.data.review?.soloAutor || item.claimant !== agentId) vistos.add(id);
    }
  }
  return items.every(i => vistos.has(i.id));
}

// Un veredicto: «está bien» o «esto aún se puede mejorar, así». Nada de prosa suelta: la
// mejora llega con acción concreta, como un hallazgo de la auditoría.
export function applyRecheck(room, agentId, payload = {}) {
  const d = room.phase.data;
  if (!d.review) d.review = { revisados: {}, round: 0 };
  const p = obj(payload);
  const itemId = clampStr(p.itemId ?? p.item, 40);
  const items = integradasDe(room);
  const item = itemId ? room.work?.items?.[itemId] : null;
  if (!item || item.status !== 'integrated') {
    throw new DebateError('bad_payload',
      `Para revisar hace falta el itemId de una mejora integrada: ${items.map(i => i.id).join(', ') || 'no hay ninguna'}`);
  }
  const cuts = [];
  const verdict = oneOf(clampStr(p.verdict ?? p.result, 20).toLowerCase(), ['ok', 'improve'], 'ok');
  const claim = fit(p.claim ?? p.what, CAPS.recheckClaim, 'claim', cuts, { keepLines: true });
  const action = fit(p.action ?? p.improvement ?? p.fix, CAPS.recheckAction, 'action', cuts, { keepLines: true });
  const evidence = fit(p.evidence ?? p.why, CAPS.recheckEvidence, 'evidence', cuts, { keepLines: true });
  if (verdict === 'improve' && action.length < 10) {
    throw new DebateError('bad_payload',
      'Si crees que aún se puede mejorar, dilo con una acción concreta: payload:{itemId, verdict:"improve", ' +
      'claim:"qué falta", action:"qué harías (10+ caracteres)", evidence?}. Si no, verdict:"ok".');
  }
  const agente = room.agents[agentId];
  agente.workReviews = (agente.workReviews || 0) + 1;
  const porItem = d.review.revisados[agentId] || (d.review.revisados[agentId] = {});
  porItem[item.id] = {
    verdict, claim: verdict === 'improve' ? claim : null, action: verdict === 'improve' ? action : null,
    evidence: verdict === 'improve' ? evidence : null,
    file: clampStr(p.file, CAPS.findingFile) || (item.files || [])[0] || null,
    line: Number.isFinite(Number(p.line)) ? Number(p.line) : null,
    severity: oneOf(clampStr(p.severity, 10).toLowerCase(), ['high', 'med', 'low'], item.severity || 'med'),
    at: now(),
  };
  if (verdict === 'improve') {
    log(room, agentId, 'review',
      `${nameOf(room, agentId)} revisa ${item.id} y ve que aún se puede mejorar: ${gist(action, 160)}`);
  } else {
    log(room, agentId, 'review', `${nameOf(room, agentId)} da por bueno ${item.id} «${gist(item.title, 70)}».`);
  }
  changed(room);
  return { item, verdict, pending: reviewAssignments(room, agentId).pendientes.map(i => i.id), warnings: cuts };
}

// Lo que se propone en la revisión se convierte (solo con trabajo extraordinario) en tareas
// nuevas: el debate ya las había aprobado de facto al exigir que se busque más.
export function improvementsFromReview(room, { round = 1 } = {}) {
  const d = room.phase?.data?.review;
  if (!d) return [];
  const work = room.work;
  const nuevas = [];
  let fuera = 0;
  const seen = new Set();
  for (const [agentId, porItem] of Object.entries(d.revisados || {})) {
    for (const [itemId, r] of Object.entries(porItem || {})) {
      if (r.verdict !== 'improve' || !r.action) continue;
      const clave = `${r.file || ''}|${r.action}`.toLowerCase();
      if (seen.has(clave)) continue;
      seen.add(clave);
      if (work.order.length + nuevas.length >= room.settings.repo.maxWorkItems) { fuera += 1; continue; }
      nuevas.push({
        title: clampStr(r.claim || r.action, 110),
        files: r.file ? [r.file] : [],
        severity: r.severity || 'med',
        claim: clampStr(r.claim || 'Detectado en la revisión posterior al trabajo.', CAPS.findingClaim),
        evidence: clampStr(`Revisión de ${itemId} (ronda ${round}) por ${nameOf(room, agentId)}${r.evidence ? `: ${r.evidence}` : '.'}`, CAPS.findingEvidence),
        action: r.action,
        source: 'review',
        de: itemId,
        by: agentId,
      });
    }
  }
  // Un techo de cola no puede borrar una propuesta de la revisión: si no cabe ahora, se
  // dice cuántas quedaron fuera y por qué, y salen en el resultado como no ejecutadas.
  if (fuera) {
    log(room, null, 'work',
      `${plural(fuera, 'mejora')} de la revisión no ${fuera === 1 ? 'entra' : 'entran'} en la cola de trabajo: ` +
      `la sala trabaja como máximo ${room.settings.repo.maxWorkItems} tareas a la vez. Quedan registradas como propuestas sin ejecutar.`);
  }
  return nuevas;
}

export function addReviewItems(room, sugerencias) {
  const work = room.work;
  const creadas = [];
  for (const s of sugerencias) {
    const id = `w${++work.seq}`;
    const item = {
      id, pointId: null, title: clampStr(s.title, 110), files: s.files || [], severity: s.severity || 'med',
      claim: s.claim, evidence: s.evidence, action: s.action, findingIds: [],
      share: 0, voters: 0, status: 'open', claimant: null, claimedAt: null,
      attempts: 0, verifyFailures: 0, patches: [], review: null, verify: null, commit: null,
      reviewer: null, lastError: null, note: null, startedAt: null, finishedAt: null,
      from: 'review', reviewOf: s.de || null, by: s.by || null,
    };
    work.items[id] = item;
    work.order.push(id);
    creadas.push(item);
    log(room, null, 'work',
      `Nueva tarea ${id} desde la revisión: «${gist(item.title, 90)}»${item.files.length ? ` (${item.files.join(', ')})` : ''}.`);
  }
  return creadas;
}

// Por qué NO se puede cerrar el trabajo todavía: hay un parche en vuelo o alguien está
// trabajando en una tarea (visto hace poco). Devuelve el motivo, o null si se puede cerrar.
export function workBusyReason(room) {
  const work = room.work;
  if (!work) return null;
  const pending = work.pending ? work.patches[work.pending] : null;
  if (pending) {
    const item = work.items[pending.itemId];
    const fase = pending.verify?.status === 'running' ? 'verificándose ahora mismo' : pending.review ? 'esperando integración' : 'esperando revisión';
    return `el parche ${pending.id} de la tarea ${pending.itemId}${item ? ` «${gist(item.title, 50)}»` : ''} está ${fase}`;
  }
  const idle = claimIdleThresholdMs(room);
  const t = now();
  for (const id of work.order) {
    const item = work.items[id];
    if (!item?.claimant || !['claimed', 'in-review'].includes(item.status)) continue;
    const agent = room.agents[item.claimant];
    if (!agent) continue;
    const since = agent.lastSeenAt || item.claimedAt || t;
    if (t - since < idle) return `${nameOf(room, item.claimant)} está trabajando en ${item.id} «${gist(item.title, 50)}»`;
  }
  return null;
}

// El latido de un agente que trabaja: renueva su reclamo y deja constancia, sin gastar
// tokens en un movimiento completo. Con esto, «20 minutos sin señales» deja de ser una
// trampa para quien se pasa un rato verificando su parche en local.
export function holdClaim(room, agentId, payload = {}) {
  const item = claimedItemOf(room, agentId);
  if (!item) {
    throw new DebateError('not_claimed', 'No tienes ninguna tarea reclamada que mantener. Reclama una con claim-item.');
  }
  const p = obj(payload);
  const cuts = [];
  const nota = fit(p.note ?? p.status ?? p.text, CAPS.progressNote, 'note', cuts, { keepLines: true });
  const agent = room.agents[agentId];
  agent.lastSeenAt = now();
  item.claimedAt = item.claimedAt || now();
  item.heartbeats = (item.heartbeats || 0) + 1;
  item.lastHeartbeatAt = now();
  if (nota) item.note = nota;
  log(room, agentId, 'work',
    `${nameOf(room, agentId)} sigue en ${item.id} «${gist(item.title, 60)}»${nota ? `: ${gist(nota, 140)}` : '.'}`);
  changed(room);
  return { item, heartbeats: item.heartbeats, warnings: cuts };
}

export function workItemForTurn(room, agentId) {
  const work = room.work;
  if (!work) return null;
  const mine = claimedItemOf(room, agentId);
  const pending = work.pending ? work.patches[work.pending] : null;
  const reviewing = pending && !pending.review && pending.author !== agentId && pending.itemId !== mine?.id;
  return {
    mine,
    reviewing,
    pending,
    open: openItems(room).filter(i => i.status === 'open').map(i => ({ id: i.id, title: i.title, files: i.files, severity: i.severity })),
  };
}

// ---------------------------------------------------------------- resumen
export function workSummary(room) {
  const work = room.work;
  const repo = room.repo;
  if (!work) return null;
  const items = work.order.map(id => {
    const i = work.items[id];
    return {
      id: i.id,
      pointId: i.pointId,
      title: i.title,
      status: i.status,
      severity: i.severity,
      // De dónde salió la tarea: del debate (auditoría/hallazgo) o de la revisión posterior.
      from: i.from || (i.pointId ? 'debate' : null),
      reviewOf: i.reviewOf || null,
      files: i.files,
      share: i.share,
      voters: i.voters,
      claim: i.claim,
      evidence: i.evidence,
      attempt: i.attempts,
      verifyFailures: i.verifyFailures,
      byName: i.claimant ? nameOf(room, i.claimant) : null,
      reviewerName: i.reviewer ? nameOf(room, i.reviewer) : (i.review?.by ? nameOf(room, i.review.by) : null),
      commit: i.commit,
      unreviewed: !!i.unreviewed,
      // Deshacer es una decisión del humano, no del debate: viaja con el motivo y con
      // la verificación posterior, para que el panel no tenga que interpretarlo.
      revert: i.revert
        ? {
          of: i.revert.of,
          commit: i.revert.commit || null,
          reason: i.revert.reason || null,
          by: i.revert.by || null,
          at: i.revert.at,
          files: (i.revert.files || []).slice(0, 20),
          verify: i.revert.verify
            ? {
              status: i.revert.verify.status || 'done',
              ran: !!i.revert.verify.ran,
              ok: i.revert.verify.ok ?? null,
              exitCode: i.revert.verify.exitCode ?? null,
              command: i.revert.verify.command || null,
              durationMs: i.revert.verify.durationMs || null,
              outputTail: i.revert.verify.ok === false ? String(i.revert.verify.outputTail || '').slice(0, 2_000) : null,
            }
            : null,
        }
        : null,
      // Y si se volvió a aplicar, queda escrito: deshacer no borra la historia.
      reapplied: i.reapplied
        ? {
          of: i.reapplied.of,
          commit: i.reapplied.commit || null,
          reason: i.reapplied.reason || null,
          by: i.reapplied.by || null,
          at: i.reapplied.at,
          revertedAt: i.reapplied.revertedAt || null,
          verify: i.reapplied.verify
            ? {
              status: i.reapplied.verify.status || 'done',
              ran: !!i.reapplied.verify.ran,
              ok: i.reapplied.verify.ok ?? null,
              exitCode: i.reapplied.verify.exitCode ?? null,
              command: i.reapplied.verify.command || null,
              durationMs: i.reapplied.verify.durationMs || null,
              outputTail: i.reapplied.verify.ok === false ? String(i.reapplied.verify.outputTail || '').slice(0, 2_000) : null,
            }
            : null,
        }
        : null,
      verify: i.verify ? {
        // `status` es lo que distingue «verificando» de «verificado»: sin él, un informe
        // congelado no tenía forma de saber que la verificación había terminado.
        status: i.verify.status || 'done',
        ran: !!i.verify.ran, ok: i.verify.ok ?? null, exitCode: i.verify.exitCode ?? null,
        command: i.verify.command || null, durationMs: i.verify.durationMs || null,
        preExisting: !!i.verifyPreExisting,
      } : null,
      lastError: i.lastError || null,
      note: i.note || null,
      patchId: i.patches[i.patches.length - 1] || null,
      patches: i.patches.length,
      startedAt: i.startedAt,
      finishedAt: i.finishedAt,
    };
  });
  const stats = workStats(room);
  const patches = Object.values(work.patches).map(p => ({
    id: p.id,
    itemId: p.itemId,
    authorName: nameOf(room, p.author),
    mode: p.mode,
    summary: p.summary,
    stat: p.stat ? { files: p.stat.fileCount, insertions: p.stat.insertions, deletions: p.stat.deletions, list: p.stat.files } : null,
    committed: !!p.committed,
    superseded: !!p.superseded,
    sha: p.sha,
    at: p.at,
    diffLines: p.diff ? p.diff.split('\n').length : 0,
    review: p.review ? { byName: nameOf(room, p.review.by), verdict: p.review.verdict, notes: p.review.notes } : null,
    verify: p.verify ? {
      ran: !!p.verify.ran, ok: p.verify.ok ?? null, exitCode: p.verify.exitCode ?? null,
      command: p.verify.command || null, durationMs: p.verify.durationMs || null,
      status: p.verify.status || 'done',
      outputTail: p.verify.ok === false ? (p.verify.outputTail || '').slice(0, 4_000) : null,
    } : null,
  }));
  return {
    branch: work.branch,
    baseCommit: work.baseCommit,
    head: work.head || repo?.head || null,
    startedAt: work.startedAt,
    finishedAt: work.finishedAt,
    items,
    patches,
    pending: work.pending ? { patchId: work.pending, itemId: work.patches[work.pending].itemId, status: 'waiting' } : null,
    stats: {
      items: items.length,
      integrated: items.filter(i => i.status === 'integrated').length,
      reverted: items.filter(i => i.status === 'reverted').length,
      failed: items.filter(i => i.status === 'failed').length,
      skipped: items.filter(i => i.status === 'skipped').length,
      open: items.filter(i => !TERMINAL.has(i.status)).length,
      unreviewed: items.filter(i => i.unreviewed).length,
      deferredFindings: work.deferred,
      skippedByCap: work.skippedByCap || 0,
      verifyRuns: work.verifyRuns,
      ...stats,
    },
    baseline: work.baseline || repo?.baseline || null,
    verifyCommand: repo?.verify?.command || null,
    verifySource: repo?.verifySource || null,
    // Revisión posterior al trabajo: quién la ha mirado ya y qué falta.
    review: reviewState(room),
    // Con una verificación posterior en marcha (deshacer/vuelta a aplicar), el panel
    // tiene que poder decirlo: si no, se ve «deshecha» y nada más.
    rechecks: (work.order || [])
      .map(id => work.items[id])
      .filter(Boolean)
      .flatMap(item => {
        const out = [];
        if (item.revert?.verify?.status === 'running') out.push({ of: item.id, kind: 'revert', command: item.revert.verify.command || null });
        if (item.reapplied?.verify?.status === 'running') out.push({ of: item.id, kind: 'reapply', command: item.reapplied.verify.command || null });
        return out;
      }),
    // Se está trabajando en alguna tarea ahora mismo (vista reciente): la sala NO se cierra
    // por plazo mientras alguien tenga una tarea reclamada y siga dando señales.
    busy: workBusyReason(room),
  };
}

export function repoSummary(room) {
  const repo = room.repo;
  if (!repo) return null;
  const index = repoIndex(room);
  return {
    source: repo.source,
    kind: repo.kind,
    ref: repo.ref,
    branch: repo.branch,
    baseCommit: repo.baseCommit,
    head: repo.head,
    files: index?.total ?? repo.files,
    directories: index?.dirs?.slice(0, 12) || [],
    extensions: index?.extensions?.slice(0, 10) || [],
    verify: repo.verify ? repo.verify.command : null,
    // De dónde salió el comando de verificación: declarado por el humano o detectado en
    // el propio proyecto. Sin esto, el panel no puede decir «esto lo elegí yo por ti».
    verifySource: repo.verifySource || null,
    verifyTimeoutMs: repo.verify?.timeoutMs || null,
    baseline: repo.baseline || null,
    // Publicación: dónde se puede publicar la rama, hasta qué commit salió y si el
    // remoto se ha quedado atrás (deshacer o integrar cambia el head).
    pushTo: repo.pushTo || null,
    pushed: repo.pushed || [],
    pushedAt: repo.pushedAt || null,
    pushedHead: repo.pushedHead || null,
    pushedOutdated: !!(repo.pushedHead && repo.head && repo.pushedHead !== repo.head),
    attachedAt: repo.attachedAt,
  };
}

// El detalle congelado del trabajo, para el resultado y el export.
export function buildWorkResult(room) {
  const work = room.work;
  if (!work) return null;
  const summary = workSummary(room);
  const commits = commitLog(room).map(c => ({ sha: c.sha, author: c.author, subject: c.subject, at: c.at }));
  return {
    ...summary,
    commits,
    diffChecksumSource: summary.head,
    findings: room.artifacts.findings.map(f => ({
      id: f.id,
      byName: nameOf(room, f.by),
      severity: f.severity,
      file: f.file,
      line: f.line,
      claim: f.claim,
      action: f.action,
      pointId: f.pointId,
    })),
    undebated: room.artifacts.findings.filter(f => !f.pointId).map(f => ({ byName: nameOf(room, f.by), file: f.file, action: f.action })),
  };
}

export function workPlan(room) {
  const work = room.work;
  if (!work) return null;
  return {
    branch: work.branch,
    baseCommit: work.baseCommit,
    head: work.head,
    approved: work.order.map(id => ({ id, title: work.items[id].title, status: work.items[id].status, files: work.items[id].files })),
    verifyCommand: room.repo?.verify?.command || null,
    baseline: work.baseline,
    deferredFindings: work.deferred,
    skippedByCap: work.skippedByCap || 0,
  };
}
