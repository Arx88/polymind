// AGORA v2 — cierre y resultado congelado: plan ganador, verificación, consenso
// por punto, disenso, coste real y checksum verificable.

import fs from 'node:fs';
import path from 'node:path';
import { now, checksumOf, gist, estTokens, plural } from './util.mjs';
import { log, nameOf } from './state.mjs';
import { rosterSummary } from './roster.mjs';
import {
  consensusReport, positionsOf, recordStageConsensus, stageConsensus,
  dissentReport, proposalSimilarity,
} from './agenda.mjs';
import { macroOf, recursionRounds } from './settings.mjs';
import { buildWorkResult, repoSummary } from './work.mjs';
import { collaborationReport } from './collaboration.mjs';

// Qué se lleva el humano de esta sala: CÓDIGO (en un repo ajeno o en un proyecto nuevo) o un
// plan. Una sala puede acabar sin archivos por motivos muy distintos —repo ajeno mejorado,
// proyecto nuevo, solo planificación pedida, o un proyecto que no se pudo preparar— y el informe
// lo dice en vez de dejar que se deduzca del registro. «No hay código» deja de ser un misterio.
function buildDelivery(room, work) {
  const integradas = (work?.items || []).filter(i => i.status === 'integrated');
  const planOnly = !!room.settings?.planOnly;
  if (planOnly || !room.repo) {
    return {
      kind: 'plan',
      reason: planOnly ? 'solo-planificacion' : 'sin-proyecto',
      note: planOnly
        ? 'La sala está configurada como SOLO PLANIFICACIÓN: el resultado es el plan, sin código.'
        : (room.artifacts.deliveryWarning || 'La sala no tuvo proyecto donde escribir código.'),
    };
  }
  return {
    kind: 'code',
    reason: room.repo.greenfield ? 'proyecto-nuevo' : 'repo',
    branch: room.repo.branch,
    source: room.repo.source,
    head: room.repo.head,
    files: repoSummary(room)?.files ?? room.repo.files,
    items: work?.items?.length || 0,
    integrated: integradas.length,
    note: room.repo.greenfield
      ? `Código escrito en un proyecto nuevo (rama ${room.repo.branch}).`
      : `Mejoras integradas en la rama ${room.repo.branch} del proyecto.`,
  };
}

// Mejora recursiva: cuántas rondas se dieron, cuántas mejoras integró cada una y POR QUÉ se
// paró. Sin esto, «hasta que no haya más que mejorar» no se puede auditar después: es la
// diferencia entre «la sala lo decidió» y «se acabó un tope».
function recursionReport(room) {
  return {
    rounds: room.rounds || 1,
    cap: recursionRounds(room),
    history: room.roundHistory || [],
    stop: room.artifacts.recursionStop || null,
  };
}

export function dismissRoomState(room) {
  room.status = 'closed';
  room.phase = { name: 'closed', startedAt: now(), deadline: now(), data: {} };
}

export function buildCost(room) {
  const ledger = room.artifacts.ledger || [];
  const perPhase = {};
  let totalChars = 0;
  for (const e of ledger) {
    const p = e.phase || 'lobby';
    perPhase[p] = (perPhase[p] || 0) + (e.chars || 0);
    totalChars += e.chars || 0;
  }
  const perAgent = room.order.map(id => {
    const a = room.agents[id] || {};
    const served = a.servedChars || 0;
    const sent = a.sentChars || 0;
    return {
      id,
      name: a.name || id,
      harness: a.harness || null,
      role: a.role || null,
      servedChars: served,
      sentChars: sent,
      estTokens: estTokens(served + sent),
    };
  });
  return {
    totalChars,
    estTokens: estTokens(totalChars),
    perPhaseTokens: Object.fromEntries(Object.entries(perPhase).map(([k, v]) => [k, estTokens(v)])),
    perAgent,
    avgPerAgent: perAgent.length ? Math.round(perAgent.reduce((s, a) => s + a.estTokens, 0) / perAgent.length) : 0,
  };
}

// Marcador por harness: qué hizo cada agente, con la identidad que declaró (harness) y
// sin etiquetas que nadie le dio. Todo sale del registro del debate, no de una
// impresión: acertar es haber puesto al ganador el primero en el voto secreto, disidir
// es haber sostenido una opción distinta de la mayoritaria, y cambiar de opinión es
// haber publicado una versión nueva de tu propuesta después de la crítica.
export function buildScoreboard(room, report) {
  const winnerId = room.result?.winner?.id || room.phase?.data?.winnerId || room.artifacts.winnerId || null;
  const proposals = Object.values(room.artifacts.proposals || {});
  const objections = room.artifacts.objections || [];
  const checks = room.artifacts.checks || [];
  const findings = room.artifacts.findings || [];
  const work = room.work;
  const patches = work ? Object.values(work.patches || {}) : [];
  const items = work ? work.order.map(id => work.items[id]) : [];

  // Disenso: cada punto donde la elección de un agente no es la mayoritaria.
  const dissent = new Map();
  const agree = new Map();
  for (const point of report.points || []) {
    const modal = point.modal?.id;
    for (const choice of point.choices || []) {
      for (const agentId of choice.agents || []) {
        const bucket = choice.id === modal ? agree : dissent;
        bucket.set(agentId, (bucket.get(agentId) || 0) + 1);
      }
    }
  }

  const byAgent = room.order.map(id => {
    const a = room.agents[id] || {};
    const mine = proposals.filter(p => p.author === id);
    const ballot = room.lastBallots?.[id] || null;
    const myFindings = findings.filter(f => f.by === id);
    const myPatches = patches.filter(p => p.author === id);
    const myItems = items.filter(i => i.claimant === id && i.status === 'integrated');
    // Una mejora que se deshizo después cuenta aparte: integrarla sí, quedarse no.
    const myUndone = items.filter(i => i.claimant === id && i.status === 'reverted');
    return {
      id,
      name: a.name || id,
      harness: a.harness || null,
      model: a.model || null,
      status: a.status || 'active',
      moves: a.movesCount || 0,
      tokens: Math.round(((a.servedChars || 0) + (a.sentChars || 0)) / 3.5),
      votedWinner: !!(ballot && winnerId && ballot[0] === winnerId),
      wonProposal: !!(winnerId && mine.some(p => p.id === winnerId)),
      agreedPoints: agree.get(id) || 0,
      dissentPoints: dissent.get(id) || 0,
      proposals: mine.length,
      revised: mine.filter(p => (p.v || 1) > 1).length,
      conceded: mine.filter(p => p.conceded).length,
      objections: objections.filter(o => o.by === id).length,
      blockers: objections.filter(o => o.by === id && o.severity === 'blocker').length,
      checks: checks.filter(c => c.by === id).length,
      verifier: room.artifacts.verification?.by === id,
      findings: myFindings.length,
      corroboratedFindings: myFindings.filter(f => (f.corroborations || 1) > 1).length,
      patches: myPatches.length,
      reviews: a.workReviews || 0,
      integrated: myItems.length,
      reverted: myUndone.length,
      rejectedPatches: myPatches.filter(p => p.superseded).length,
    };
  });

  // Quién destacó y en qué, en una línea por hecho comprobable.
  const pick = (label, key, { min = 1, asc = false } = {}) => {
    const ranked = byAgent.filter(r => r[key] >= min);
    if (!ranked.length) return null;
    // Si todos empatan, no destaca nada: un «todos hicieron lo mismo» no distingue a
    // nadie y solo ensucia el marcador.
    if (ranked.length === byAgent.length && new Set(byAgent.map(r => r[key])).size === 1) return null;
    const best = ranked.reduce((x, y) => {
      if (x[key] === y[key]) return x;
      return (asc ? x[key] < y[key] : x[key] > y[key]) ? x : y;
    });
    if (!best || best[key] <= 0) return null;
    return { label, value: best[key], names: ranked.filter(r => r[key] === best[key]).map(r => r.name) };
  };
  return {
    byAgent,
    highlights: [
      pick('más disintió del acuerdo', 'dissentPoints'),
      pick('más puntos acordó', 'agreedPoints'),
      pick('cambió de opinión tras la crítica', 'revised'),
      pick('retiró su propuesta', 'conceded'),
      pick('vetó con un bloqueante', 'blockers'),
      pick('hallazgos en la auditoría', 'findings'),
      pick('parches entregados', 'patches'),
      pick('revisiones hechas a otros', 'reviews'),
      pick('mejoras integradas', 'integrated'),
      pick('propuestas verificadas con checks', 'checks'),
    ].filter(Boolean),
  };
}

// Disenso protegido: la parte del informe que impide leer una convergencia como un
// acuerdo. Minorías con nombre, qué se resolvió por autoridad sin evidencia nueva y cuánto
// se movió la gente sin decir por qué. Sin esto, «7 de 8 unánimes» parece consenso cuando
// puede ser diversidad disuelta: nadie sostuvo la otra mitad y el punto 1 del plan propio
// se pierde sin que quede escrito.
function buildDissentProtection(room, report) {
  const dis = dissentReport(room, report, id => nameOf(room, id));
  const drifts = room.artifacts.drift || [];
  const sim = room.artifacts.similaritySnapshot || proposalSimilarity(room);
  const labelOfPoint = id => room.agenda.find(p => p.id === id)?.label || id;
  const resolutions = room.artifacts.synthesis?.pointResolutions || [];
  const choiceLabel = (pointId, choiceId) =>
    room.agenda.find(p => p.id === pointId)?.options.find(o => o.id === choiceId)?.label || null;
  return {
    measured: dis.measured,
    // Cuota de puntos donde todos eligieron lo mismo. Se publica junto al disenso, no en su
    // lugar: unanimidad total sobre una agenda repartida es una señal, no un logro.
    unanimity: dis.unanimity,
    contestedCount: dis.count,
    contestedShare: dis.contestedShare,
    contestedPoints: dis.contested.map(p => ({
      id: p.id, label: p.label, status: p.status, share: p.share,
      majority: p.majority ? { label: p.majority.label, share: p.majority.share, by: p.majority.by } : null,
      minority: p.minority.map(m => ({ label: m.label, share: m.share, by: m.by })),
      // Lo que se argumentó sobre este punto, anclado a él en la crítica.
      reasons: (p.reasons || []).map(r => ({ by: nameOf(room, r.by), severity: r.severity, text: r.text })),
    })),
    resolutions: resolutions.map(r => ({
      pointId: r.pointId,
      pointLabel: labelOfPoint(r.pointId),
      choiceLabel: choiceLabel(r.pointId, r.choiceId),
      basis: r.basis || 'authority',
      evidence: r.evidence || null,
      note: r.note || null,
    })),
    // Resuelto por autoridad de síntesis: sin dato nuevo que lo justifique. No es un fallo
    // del protocolo —alguien tiene que cerrar— pero el informe dice exactamente dónde pasó.
    byAuthority: resolutions.filter(r => r.basis === 'authority').map(r => labelOfPoint(r.pointId)),
    // Puntos con minoría real que la síntesis no resolvió: no mencionarlos no los cierra, y
    // si el informe no los listara parecería que todo quedó cerrado porque nadie los nombró.
    unresolved: (room.artifacts.synthesis?.unresolved || []).map(u => ({ id: u.id, label: u.label || labelOfPoint(u.id) })),
    convergenceWithoutEvidence: {
      count: drifts.filter(d => !d.evidenced).length,
      total: drifts.length,
      moves: drifts.map(d => ({
        by: nameOf(room, d.by), point: d.pointLabel,
        from: d.fromLabel || d.from, to: d.toLabel || d.to,
        because: d.because || null, evidenced: !!d.evidenced,
      })),
    },
    // Las propuestas que llegaron a la votación: si coincidían en casi todo, la votación
    // decidió matices, y el informe lo dice con nombres y porcentaje.
    vote: {
      collapsed: !!sim?.collapsed,
      maxSimilarity: sim?.max ?? 0,
      threshold: sim?.threshold ?? (room.settings?.diversityMax ?? 0.8),
      closest: sim?.closest
        ? { a: sim.closest.aTitle, b: sim.closest.bTitle, similarity: sim.closest.similarity }
        : null,
    },
  };
}

// Auditoría del encuadre. Proponer a ciegas impide que el primero que habla ancle a los demás
// MIENTRAS escriben, pero no impide que su pregunta ordene todo lo que viene después: eso solo
// se ve al final, comparando el eje que abrió el marco con el debate que provocó. Y un eje que
// nadie propuso en su turno solo puede entrar en el contraste, así que el informe dice también
// qué entró tarde y por qué. Se publica con nombres porque el anclaje es un juicio sobre gente
// concreta, y callarlo fue justo lo que dejó el problema sin corregir.
function buildAgendaReview(room) {
  const reasons = {};
  for (const c of Object.values(room.artifacts.critiques || {})) {
    for (const o of c.objections || []) {
      if (!o.against) continue;
      (reasons[o.against] ||= []).push({ by: c.author, severity: o.severity });
    }
  }
  const labelOf = id => room.agenda.find(p => p.id === id)?.label || id;
  const contrast = room.artifacts.contrast || {};
  const originOf = p => {
    if (p.source === 'finding') return 'auditoría';
    if (p.source === 'agent') return p.createdIn === 'contrast' ? 'contraste' : 'encuadre';
    return 'humano';
  };

  const axes = room.agenda.map(p => ({
    id: p.id,
    label: p.label,
    origin: originOf(p),
    by: p.createdBy && room.agents?.[p.createdBy] ? nameOf(room, p.createdBy) : null,
    options: p.options.length,
    weight: p.weight || 1,
    // Cuánto debate atrajo este eje: objeciones ancladas a él. Es la medida honesta de si el
    // marco se organizó alrededor de él, en vez de un juicio de quien redacta el informe.
    objections: (reasons[p.id] || []).length,
    challenged: (p.challenged || []).map(c => ({ by: c.byName || nameOf(room, c.by), because: c.because || '' })),
    mergedFrom: (p.mergedFrom || []).map(m => ({ label: m.label, by: m.byName || nameOf(room, m.by) })),
  }));

  const byAgent = new Map();
  for (const p of room.agenda) {
    if (p.source !== 'agent' || !p.createdBy) continue;
    const list = byAgent.get(p.createdBy) || [];
    list.push(p.label);
    byAgent.set(p.createdBy, list);
  }
  const proposers = [...byAgent.entries()]
    .map(([id, labels]) => ({ by: nameOf(room, id), count: labels.length, labels }))
    .sort((a, b) => b.count - a.count || (a.by > b.by ? 1 : -1));
  const agentAxes = proposers.reduce((n, p) => n + p.count, 0);
  const top = proposers[0] || null;

  // El eje que abrió el marco: el primero que propuso un agente. No se acusa a nadie —puede
  // ser el eje correcto—, pero si además es el que más objeciones atrajo, el encuadre ordenó
  // el debate y el informe lo dice con el nombre de quien lo trajo.
  const first = room.agenda
    .filter(p => p.source === 'agent' && originOf(p) === 'encuadre')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0] || null;
  const opened = first
    ? {
      id: first.id,
      label: first.label,
      by: first.createdBy ? nameOf(room, first.createdBy) : null,
      objections: (reasons[first.id] || []).length,
      mostObjected: (reasons[first.id] || []).length > 0 &&
        (reasons[first.id] || []).length >= axes.reduce((m, a) => Math.max(m, a.objections), 0),
    }
    : null;

  return {
    axes,
    proposers,
    agentAxes,
    opened,
    // Ejes que no entraron en el encuadre sino en el contraste: la vuelta que existe justo
    // para eso. Si hay alguno, el encuadre a ciegas se quedó corto y se corrigió después.
    addedLate: axes.filter(a => a.origin === 'contraste').map(a => ({ id: a.id, label: a.label, by: a.by })),
    challenged: axes.filter(a => a.challenged.length).map(a => ({
      id: a.id, label: a.label, by: a.challenged.map(c => c.by), because: a.challenged.map(c => c.because).filter(Boolean),
    })),
    merged: (contrast.applied || []).map(m => ({
      from: m.fromLabel, into: m.intoLabel,
      by: (m.byName || (m.by || []).map(id => nameOf(room, id))),
      because: (m.because || []).filter(Boolean),
      // Las opciones del eje absorbido siguen en el destino: nadie pierde lo que ya eligió.
      options: m.movedOptions || [],
    })),
    keptUnmerged: (contrast.kept || []).map(k => ({
      label: k.label, by: k.byName || (k.by || []).map(id => nameOf(room, id)),
      because: (k.because || []).filter(Boolean),
      wantedMerge: (k.wantedMerge || []).map(labelOf),
    })),
    // Concentración del marco: un agente con casi todos los ejes no es automáticamente malo
    // (quizá era el que tenía el contexto), pero el informe lo dice en vez de presentar la
    // agenda como si fuera de todos.
    concentration: top && agentAxes >= 3
      ? { by: top.by, count: top.count, share: Math.round((top.count / agentAxes) * 1000) / 1000, flagged: top.count * 2 >= agentAxes }
      : null,
    anchored: !!(opened?.mostObjected),
    note: opened
      ? (opened.mostObjected
        ? `El encuadre lo abrió ${opened.by || 'un agente'} con «${opened.label}», y fue el eje que más objeciones atrajo: el marco ordenó el debate, no solo lo abrió.`
        : `El encuadre lo abrió ${opened.by || 'un agente'} con «${opened.label}», que no fue el eje más discutido: el marco no monopolizó el debate.`)
      : (agentAxes
        ? `El encuadre no produjo ningún eje de agente: ${plural(agentAxes, 'eje')} ${agentAxes === 1 ? 'entró' : 'entraron'} después, en el contraste (con la agenda ya a la vista).`
        : 'Ningún agente propuso ejes: la agenda vino del humano o de la auditoría del repo.'),
  };
}

export function finishRoom(room, winnerId = null) {
  if (room.status === 'closed') return;
  // `lastWinnerId` es el del debate: hace falta cuando la sala cierra en una ronda posterior
  // (una auditoría sin hallazgos) y la fase abierta ya no lleva encima ninguna propuesta ganadora.
  const wid = winnerId || room.phase.data?.winnerId || room.lastWinnerId;
  const winner = wid ? room.artifacts.proposals[wid] : null;
  if (!winner) { closeRoom(room, 'failed', 'Sin propuesta ganadora identificable.'); return; }

  const synthesis = room.phase.data?.synthesis || room.artifacts.synthesis || null;
  const verification = room.artifacts.verification || null;
  const report = consensusReport(room);
  // La etapa que estaba en curso al cerrar también se fotografía: si no, el resultado
  // final aparecería sin la etapa que más importa (donde estaban trabajando).
  recordStageConsensus(room, macroOf(room.phase.name), room.phase.name, report);

  const dissent = room.artifacts.objections.map(o => ({
    by: nameOf(room, o.by),
    text: o.text,
    severity: o.severity,
    addressed: !!o.addressed,
  }));
  for (const point of report.points) {
    if (point.status === 'agreed') continue;
    const odd = point.choices.slice(1);
    for (const choice of odd) {
      for (const agentId of choice.agents) {
        dissent.push({
          by: nameOf(room, agentId),
          text: `En «${point.label}» sostiene «${choice.label}», frente a «${point.modal?.label || '—'}».`,
          severity: point.status === 'open' ? 'concern' : 'low',
          addressed: false,
          point: point.id,
        });
      }
    }
  }

  const checks = (room.artifacts.checks || []).map(c => ({
    id: c.id,
    by: nameOf(room, c.by),
    point: c.pointId || null,
    claim: c.claim,
    method: c.method,
    expectation: c.expectation,
    verdict: c.verdict || 'pass',
  }));

  // Una sola lectura del trabajo y de la entrega: el informe congelado no vuelve a recorrer el
  // historial de commits dos veces por el mismo dato.
  const workResult = buildWorkResult(room);
  const deliveryInfo = buildDelivery(room, workResult);

  const result = {
    task: room.task,
    title: room.title,
    language: room.settings.language,
    outcome: 'decided',
    winner: {
      id: winner.id,
      title: winner.title,
      author: nameOf(room, winner.author),
      authorId: winner.author,
      version: winner.v,
      plan: winner.plan,
      approach: winner.approach || null,
      premortem: winner.premortem || null,
      risks: winner.risks || null,
      positions: positionsOf(winner),
    },
    final: synthesis ? synthesis.final : winner.plan,
    finalSource: synthesis ? 'synthesis' : 'winner',
    synthesisBy: synthesis?.by ? nameOf(room, synthesis.by) : null,
    pointResolutions: synthesis?.pointResolutions || [],
    merges: synthesis?.merges || [],
    collaboration: collaborationReport(room),
    checks,
    verification: verification ? {
      by: nameOf(room, verification.by),
      verdict: verification.verdict,
      selfVerified: !!verification.selfVerified,
      findings: verification.findings || [],
      repaired: !!verification.repaired,
    } : null,
    consensus: {
      global: report.global,
      method: report.method,
      threshold: report.threshold,
      agreed: report.agreed,
      discussing: report.discussing,
      open: report.open,
      pending: report.pending,
      total: report.total,
      // La evolución por etapa, no solo el número final: el informe puede decir si la
      // sala se acercó o se atrincheró entre presentación, debate, síntesis y decisión.
      stages: stageConsensus(room, macroOf(room.phase.name)),
      points: report.points.map(p => ({
        id: p.id,
        label: p.label,
        status: p.status,
        share: p.share,
        // Un eje impugnado en el contraste sigue contando, pero se publica que su existencia
        // misma se discutió: si el debate decide «sí» sobre un eje en duda, eso importa.
        contested: !!p.contested,
        challenged: p.challenged || [],
        mergedFrom: p.mergedFrom || [],
        modal: p.modal ? { id: p.modal.id, label: p.modal.label, agents: p.modal.agents.map(a => nameOf(room, a)) } : null,
        choices: p.choices.map(c => ({ label: c.label, count: c.count, share: c.share, agents: c.agents.map(a => nameOf(room, a)) })),
      })),
    },
    dissent,
    dissentProtection: buildDissentProtection(room, report),
    agendaReview: buildAgendaReview(room),
    recursion: recursionReport(room),
    ruleChanges: (room.artifacts.ruleProposals || []).filter(r => r.applied).map(r => ({
      text: r.text, by: nameOf(room, r.by), op: r.appliedOp || null,
    })),
    medians: room.lastMedians
      ? Object.fromEntries(Object.entries(room.lastMedians).map(([k, v]) => [room.artifacts.proposals[k]?.title || k, v]))
      : {},
    ballots: room.lastBallots
      ? Object.fromEntries(Object.entries(room.lastBallots).map(([aid, r]) => [nameOf(room, aid), r.map(id => room.artifacts.proposals[id]?.title || id)]))
      : {},
    cost: buildCost(room),
    roster: rosterSummary(room),
    // Marcador por harness: quién acertó, quién disintió y quién cambió de opinión.
    scoreboard: buildScoreboard(room, report),
    // Trabajo conjunto: repo auditado, mejoras aprobadas y lo que pasó con cada una.
    repo: repoSummary(room),
    work: workResult,
    delivery: deliveryInfo,
    stats: {
      agents: room.order.length,
      active: room.order.filter(id => room.agents[id].status !== 'absent').length,
      proposals: Object.keys(room.artifacts.proposals).length,
      critiques: Object.keys(room.artifacts.critiques).length,
      objections: room.artifacts.objections.length,
      checks: checks.length,
      findings: room.artifacts.findings.length,
      workItems: room.work ? room.work.order.length : 0,
      integrated: room.work ? room.work.order.filter(id => room.work.items[id].status === 'integrated').length : 0,
      durationMin: Math.round((now() - room.createdAt) / 60_000),
    },
    closedAt: now(),
  };
  result.checksum = checksumOf({
    code: room.code,
    task: result.task,
    winner: { id: winner.id, version: winner.v, plan: winner.plan },
    final: result.final,
    consensus: result.consensus.points.map(p => [p.id, p.status, p.share]),
  });

  room.result = result;
  dismissRoomState(room);
  log(room, null, 'closed',
    `DEBATE CERRADO. Resultado: «${winner.title}». Consenso ${Math.round(report.global * 100)}%, ` +
    `${plural(checks.length, 'comprobación', 'comprobaciones')}. Checksum ${result.checksum.slice(0, 19)}…`);
  // La entrega, en una línea y sin adornos: es lo primero que busca el humano al abrir la sala.
  log(room, null, deliveryInfo.kind === 'code' ? 'work' : 'closed', deliveryInfo.kind === 'code'
    ? `Entrega: ${plural(deliveryInfo.integrated, 'parte del plan integrada', 'partes del plan integradas')} en la rama ` +
      `${deliveryInfo.branch} (${deliveryInfo.files} archivos, ${plural(deliveryInfo.items, 'tarea')} de trabajo). ${deliveryInfo.note}`
    : `Sin código en esta entrega (${deliveryInfo.reason}): ${deliveryInfo.note}`);
}

export function closeRoom(room, outcome, reason) {
  if (room.status === 'closed') return;
  const report = consensusReport(room);
  const workResult = buildWorkResult(room);
  const deliveryInfo = buildDelivery(room, workResult);
  recordStageConsensus(room, macroOf(room.phase.name), room.phase.name, report);
  room.result = {
    task: room.task,
    title: room.title,
    language: room.settings.language,
    outcome,
    reason,
    winner: null,
    final: '',
    finalSource: null,
    checks: [],
    verification: null,
    consensus: {
      global: report.global,
      method: report.method,
      threshold: report.threshold,
      agreed: report.agreed, discussing: report.discussing, open: report.open, pending: report.pending,
      total: report.total,
      stages: stageConsensus(room, macroOf(room.phase.name)),
      points: report.points.map(p => ({
        id: p.id, label: p.label, status: p.status, share: p.share,
        modal: p.modal ? { id: p.modal.id, label: p.modal.label, agents: p.modal.agents.map(a => nameOf(room, a)) } : null,
        choices: p.choices.map(c => ({ label: c.label, count: c.count, share: c.share, agents: c.agents.map(a => nameOf(room, a)) })),
      })),
    },
    dissent: room.artifacts.objections.map(o => ({
      by: nameOf(room, o.by), text: o.text, severity: o.severity, addressed: !!o.addressed,
    })),
    dissentProtection: buildDissentProtection(room, report),
    recursion: recursionReport(room),
    ruleChanges: [],
    medians: {},
    ballots: {},
    cost: buildCost(room),
    roster: rosterSummary(room),
    repo: repoSummary(room),
    work: workResult,
    delivery: deliveryInfo,
    stats: { agents: room.order.length, durationMin: Math.round((now() - room.createdAt) / 60_000) },
    closedAt: now(),
  };
  room.result.checksum = checksumOf({ code: room.code, outcome, reason, task: room.task });
  dismissRoomState(room);
  log(room, null, 'closed', `DEBATE CERRADO (${outcome}): ${reason}`);
}

// ---------------------------------------------------------------- export
// El informe congelado se queda viejo en cuanto el humano deshace una mejora integrada:
// un resultado que sigue contando como integrado lo que ya no está en la rama es una
// mentira. Se recalcula solo lo que cambió (trabajo, repo, marcador y contadores).
export function refreshFrozenResult(room) {
  const r = room.result;
  if (!r) return null;
  r.repo = repoSummary(room);
  r.work = buildWorkResult(room);
  const work = room.work;
  r.stats.integrated = work ? work.order.filter(id => work.items[id].status === 'integrated').length : 0;
  r.stats.reverted = work ? work.order.filter(id => work.items[id].status === 'reverted').length : 0;
  r.stats.workItems = work ? work.order.length : 0;
  r.scoreboard = buildScoreboard(room, consensusReport(room));
  return r;
}

// ¿El informe congelado se contradice con lo que de verdad pasó? Comprobar es barato
// (estados ya cargados); el coste de recalcular solo se paga cuando hay contradicción.
// Un resultado congelado que dice «integrada» o «verificando» sobre algo que ya no es así
// es peor que no tener informe.
export function frozenResultIsStale(room) {
  const r = room.result;
  const work = room.work;
  if (!r?.work || !work) return false;
  if (r.work.items.length !== work.order.length) return true;
  const frozenById = new Map(r.work.items.map(i => [i.id, i]));
  for (const id of work.order) {
    const live = work.items[id];
    const frozen = frozenById.get(id);
    if (!frozen || frozen.status !== live.status) return true;
    if (!!frozen.revert !== !!live.revert) return true;
    // La verificación de un ítem termina en segundo plano: si el informe se congeló
    // mientras decía «verificando», deja de ser cierto sin que nadie toque nada.
    if ((frozen.verify?.status || null) !== (live.verify?.status || null)) return true;
    if ((frozen.verify?.exitCode ?? null) !== (live.verify?.exitCode ?? null)) return true;
    if (frozen.revert && live.revert) {
      if (frozen.revert.commit !== live.revert.commit) return true;
      const liveV = live.revert.verify?.status || null;
      const frozenV = frozen.revert.verify?.status || null;
      if (liveV !== frozenV) return true;
    }
    if (!!frozen.reapplied !== !!live.reapplied) return true;
    if (frozen.reapplied && live.reapplied) {
      if (frozen.reapplied.commit !== live.reapplied.commit) return true;
      if ((frozen.reapplied.verify?.status || null) !== (live.reapplied.verify?.status || null)) return true;
    }
  }
  return false;
}

// Recorre las salas guardadas y recalcula los informes que se contradicen con el trabajo
// real. Devuelve los códigos arreglados. Comprobar es barato (estados ya cargados): el
// coste de recalcular solo se paga cuando hay contradicción de verdad.
export function healFrozenResults(hall) {
  const fixed = [];
  let files = [];
  try { files = fs.readdirSync(hall.dir); } catch { return fixed; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let room = null;
    try { room = hall.get(f.slice(0, -5)); } catch { continue; }
    if (!room?.result?.work) continue;
    let stale = false;
    try { stale = frozenResultIsStale(room); } catch { continue; }
    if (!stale) continue;
    try {
      refreshFrozenResult(room);
      hall.persist(room);
      fixed.push(room.code);
    } catch { /* si el clon ya no está o no se puede escribir, se sigue sirviendo */ }
  }
  return fixed.sort();
}

export function exportMarkdown(room) {
  const r = room.result;
  if (!r) return `# AGORA ${room.code}\n\nSin resultado todavía (fase ${room.phase.name}).\n`;
  const L = [];
  L.push(`# ${r.title || gist(r.task, 80)}`);
  L.push('');
  L.push(`**Sala:** ${room.code} · **Estado:** ${r.outcome} · **Consenso:** ${Math.round((r.consensus.global || 0) * 100)}% · **Checksum:** \`${r.checksum}\``);
  L.push('');
  L.push('## Tarea');
  L.push('');
  L.push(r.task);
  if (room.context) { L.push(''); L.push('## Contexto'); L.push(''); L.push(room.context); }
  if (room.criteria) { L.push(''); L.push('## Criterios de éxito'); L.push(''); L.push(room.criteria); }

  if (r.winner) {
    L.push('');
    L.push(`## Plan ganador — «${r.winner.title}» (v${r.winner.version}, por ${r.winner.author})`);
    L.push('');
    if (r.winner.approach) { L.push(`_Enfoque:_ ${r.winner.approach}`); L.push(''); }
    L.push(r.winner.plan);
    if (r.winner.premortem) { L.push(''); L.push(`_Pre-mortem del autor:_ ${r.winner.premortem}`); }
  }
  if (r.final && r.final !== r.winner?.plan) {
    L.push('');
    L.push(`## Plan final (${r.finalSource === 'synthesis' ? `síntesis por ${r.synthesisBy || '—'}` : 'ganador sin síntesis'})`);
    L.push('');
    L.push(r.final);
  }
  if (r.collaboration?.length) {
    L.push('', '## Mejoras compartidas y decisión de síntesis', '', 'Atribución declarada; no equivale a una prueba ejecutada.');
    for (const idea of r.collaboration) {
      L.push('', `- **${idea.by}**: ${idea.change}`,
        `  - Destino final: ${idea.finalResponse?.disposition || 'sin resolución final'}.`,
        `  - Motivo: ${idea.finalResponse?.reason || 'no declarado'}`);
      if (idea.validation) L.push(`  - Validación propuesta: ${idea.validation}`);
    }
  }
  if (r.consensus.points.length) {
    L.push('');
    L.push('## Puntos de decisión');
    L.push('');
    L.push('| Punto | Acuerdo | Opción mayoritaria | Estado |');
    L.push('|---|---|---|---|');
    for (const p of r.consensus.points) {
      const label = { agreed: 'acordado', discussing: 'en discusión', open: 'abierto', pending: 'pendiente' }[p.status] || p.status;
      L.push(`| ${p.label} | ${Math.round((p.share || 0) * 100)}% | ${p.modal?.label || '—'} | ${label} |`);
    }
  }
  if (r.checks.length) {
    L.push('');
    L.push(`## Comprobaciones de la verificación (${r.verification?.selfVerified ? 'autoverificado' : `por ${r.verification?.by || '—'}`})`);
    L.push('');
    for (const c of r.checks) {
      L.push(`- **${c.claim}** — comprobar: ${c.method}. Esperado: ${c.expectation}.${c.point ? ` _(punto: ${c.point})_` : ''}`);
    }
  }
  const ar = r.agendaReview;
  if (ar && (ar.opened || ar.addedLate.length || ar.merged.length || ar.challenged.length)) {
    L.push('');
    L.push('## El encuadre, auditado después');
    L.push('');
    // El anclaje del marco no se arregla con proponer a ciegas: se mide después, y con nombres.
    L.push(ar.note);
    if (ar.concentration) {
      L.push('');
      L.push(`${ar.concentration.by} trajo ${ar.concentration.count} de los ${ar.agentAxes} ejes propuestos por agentes ` +
        `(${Math.round(ar.concentration.share * 100)}%)${ar.concentration.flagged ? ': el marco se concentró en una sola cabeza.' : '.'}`);
    }
    if (ar.opened) {
      L.push('');
      L.push(`Eje que abrió el marco: **«${ar.opened.label}»** (${ar.opened.by || '—'}), con ${plural(ar.opened.objections, 'objeción', 'objeciones')} ancladas.`);
    }
    if (ar.addedLate.length) {
      L.push('');
      L.push(`Ejes que no entraron en el encuadre y tuvieron que entrar en el contraste: ${ar.addedLate.map(a => `«${a.label}» (${a.by || '—'})`).join(', ')}.`);
    }
    for (const m of ar.merged) {
      L.push('');
      L.push(`- **Fusionados**: «${m.from}» → «${m.into}» (lo pidieron ${m.by.join(', ')})` +
        `${m.options?.length ? `; sus opciones siguen en el eje: ${m.options.join(', ')}` : ''}.`);
    }
    for (const c of ar.challenged) {
      L.push(`- **Impugnado y en pie**: «${c.label}» — ${c.by.join(', ')}${c.because?.length ? `: ${c.because.join(' · ')}` : ''}.`);
    }
    if (ar.merged.length || ar.challenged.length) {
      L.push('');
      L.push('Un eje impugnado no se borra por mayoría: se debate sabiendo que se discute.');
    }
  }
  if (r.verification?.findings?.length) {
    L.push('');
    L.push('## Hallazgos de la verificación');
    L.push('');
    for (const f of r.verification.findings) L.push(`- [${f.severity}] ${f.text}`);
  }
  if (r.dissentProtection?.measured) {
    const p = r.dissentProtection;
    L.push('');
    L.push('## Disenso protegido');
    L.push('');
    L.push(`Unanimidad **${Math.round((p.unanimity || 0) * 100)}%** de los puntos votados · ` +
      `**${p.contestedCount}** con minoría real · ` +
      `movimientos de posición sin evidencia: **${p.convergenceWithoutEvidence.count}**` +
      `${p.vote.collapsed ? ` · la votación llegó con propuestas idénticas al ${Math.round(p.vote.maxSimilarity * 100)}%` : ''}.`);
    L.push('');
    L.push('La unanimidad alta no es un logro en sí misma: significa que nadie sostuvo la otra mitad. Esto es lo que no se acordó, con nombres.');
    for (const point of p.contestedPoints) {
      L.push('');
      L.push(`### ${point.label}`);
      L.push('');
      L.push(`- **Mayoría**: ${point.majority ? `${point.majority.label} — ${point.majority.by.join(', ')} (${Math.round(point.majority.share * 100)}%)` : '—'}`);
      for (const alt of point.minority) L.push(`- **Minoría**: ${alt.label} — ${alt.by.join(', ')} (${Math.round(alt.share * 100)}%)`);
      for (const reason of point.reasons || []) {
        L.push(`  - _${reason.by}_ (${reason.severity}): ${reason.text}`);
      }
    }
    if (p.resolutions.length) {
      L.push('');
      L.push('### Cómo se cerró cada punto abierto');
      L.push('');
      const BASIS_ES = { evidence: 'con evidencia', 'adopted-dissent': 'adoptó la minoría', authority: 'por autoridad' };
      for (const res of p.resolutions) {
        L.push(`- **${res.pointLabel}**: ${res.choiceLabel || res.choiceId || '—'} — ${BASIS_ES[res.basis] || res.basis}` +
          `${res.evidence ? `: ${res.evidence}` : ''}${res.note ? ` _(${res.note})_` : ''}`);
      }
      if (p.byAuthority.length) {
        L.push('');
        L.push(`Puntos resueltos por autoridad de síntesis, sin dato nuevo: ${p.byAuthority.join(', ')}.`);
      }
    }
    if (p.unresolved?.length) {
      L.push('');
      L.push(`Puntos con minoría real que la síntesis dejó **sin resolver**: ${p.unresolved.map(u => u.label).join(', ')}.`);
      L.push('');
      L.push('Un punto abierto que no se resuelve tampoco se cierra por omisión: queda aquí, con su minoría.');
    }
    const sinEv = p.convergenceWithoutEvidence.moves.filter(m => !m.evidenced);
    if (sinEv.length) {
      L.push('');
      L.push('### Convergencia sin evidencia');
      L.push('');
      for (const m of sinEv) L.push(`- **${m.by}** en «${m.point}»: ${m.from} → ${m.to} (sin citar qué lo movió)`);
    }
  }
  if (r.dissent.length) {
    L.push('');
    L.push('## Objeciones y minorías registradas');
    L.push('');
    for (const d of r.dissent) L.push(`- _${d.by}_ (${d.severity}${d.addressed ? ', atendido' : ''}): ${d.text}`);
  }
  if (r.work) {
    const w = r.work;
    L.push('');
    L.push('## Trabajo conjunto sobre el repositorio');
    L.push('');
    L.push(`**Repo:** \`${r.repo?.source || '—'}\` · **Rama:** \`${w.branch}\` · **Commit base:** \`${(w.baseCommit || '').slice(0, 12)}\` · **Último commit:** \`${(w.head || '').slice(0, 12)}\``);
    if (w.verifyCommand) L.push(`**Verificación:** \`${w.verifyCommand}\`${w.baseline?.ran ? ` (línea base: ${w.baseline.ok ? 'en verde' : `en rojo, código ${w.baseline.exitCode}`})` : ''}`);
    L.push('');
    const STATUS_ES = { integrated: 'integrada', reverted: 'deshecha', failed: 'fallida', skipped: 'no se hizo', open: 'abierta', claimed: 'en manos de un agente', 'in-review': 'en revisión', verifying: 'verificando' };
    L.push(`Mejoras aprobadas por el debate e integradas: **${w.stats.integrated}/${w.stats.items}**` +
      `${w.stats.reverted ? ` · deshechas por el humano: **${w.stats.reverted}**` : ''} · diff de ${plural(w.stats.files, 'archivo')} (+${w.stats.insertions}/-${w.stats.deletions}).`);
    L.push('');
    L.push('| Tarea | Mejora | Estado | Parche | Revisor | Verificación | Commit |');
    L.push('|---|---|---|---|---|---|---|');
    for (const it of w.items) {
      L.push(`| ${it.id} | ${it.title} | ${STATUS_ES[it.status] || it.status}${it.unreviewed ? ' (sin revisar)' : ''} | ${it.patchId || '—'} | ${it.reviewerName || '—'} | ${it.verify ? (it.verify.ran ? (it.verify.ok ? 'verde' : `rojo (${it.verify.exitCode})`) : 'no ejecutada') : '—'} | ${it.commit ? `\`${it.commit.slice(0, 9)}\`` : '—'} |`);
    }
    const undone = w.items.filter(i => i.revert);
    if (undone.length) {
      L.push('');
      L.push(`### Mejoras deshechas después del debate (${undone.length})`);
      L.push('');
      L.push('El debate las aprobó y se integraron; el humano las revirtió. Queda la reversión en el historial, no se borró nada.');
      L.push('');
      for (const it of undone) {
        const rv = it.revert;
        L.push(`- **${it.id} · ${it.title}** — se revirtió el commit \`${String(rv.of || '').slice(0, 9)}\` con \`${String(rv.commit || '').slice(0, 9)}\`${rv.by ? ` (${rv.by})` : ''}${rv.reason ? `: _${rv.reason}_` : ''}.`);
        if (rv.files?.length) L.push(`  - Archivos devueltos: ${rv.files.map(f => `\`${f}\``).join(', ')}.`);
        if (rv.verify) {
          L.push(`  - Verificación tras deshacer: ${rv.verify.ran
            ? (rv.verify.ok ? 'en verde' : `en ROJO (código ${rv.verify.exitCode})`)
            : 'no se pudo ejecutar'}${rv.verify.command ? ` · \`${rv.verify.command}\`` : ''}.`);
        }
        if (it.reapplied) {
          L.push(`  - **Vuelta a aplicar** en \`${String(it.reapplied.commit || '').slice(0, 9)}\`${it.reapplied.by ? ` (${it.reapplied.by})` : ''}${it.reapplied.reason ? `: _${it.reapplied.reason}_` : ''}.`);
          if (it.reapplied.verify) {
            L.push(`    - Verificación tras volver a aplicarla: ${it.reapplied.verify.ran
              ? (it.reapplied.verify.ok ? 'en verde' : `en ROJO (código ${it.reapplied.verify.exitCode})`)
              : 'no se pudo ejecutar'}.`);
          }
        }
      }
    }
    // Revisión posterior del trabajo: quién miró qué y, sobre todo, qué se propuso mejorar
    // y no se llegó a ejecutar. Un informe que lo escondiera estaría fingiendo un cierre.
    const rev = w.review;
    if (rev && (rev.total > 0 || rev.proposals?.length)) {
      L.push('');
      L.push('### Revisión posterior del trabajo');
      L.push('');
      const una = rev.total === 1;
      L.push((rev.reviewed === null
        ? 'sin registro de veredictos de la revisión posterior'
        : `${rev.reviewed} de ${plural(rev.total, 'mejora')} integrada${una ? '' : 's'} revisada${una ? '' : 's'} ` +
          `por un agente que no ${una ? 'la' : 'las'} escribió`) +
        `${rev.unknown ? ' (sala anterior a la revisión posterior: no hay veredictos guardados)' : ''}` +
        `${rev.extraordinary ? ' · la sala exigía **trabajo extraordinario**' : ''}` +
        `${rev.round ? ` · ronda ${rev.round}/${rev.maxRounds}` : ''}.`);
      if (rev.pending?.length) {
        L.push('');
        L.push('Sin veredicto al cerrar:');
        for (const it of rev.pending) L.push(`- ${it.id} · ${it.title}${it.byName ? ` _(trabajo de ${it.byName})_` : ''}`);
      }
      if (rev.proposals?.length) {
        L.push('');
        L.push(`Mejoras propuestas en la revisión y **no ejecutadas** (${rev.proposals.length}):`);
        for (const p of rev.proposals) {
          L.push(`- ${p.severity ? `[${p.severity}] ` : ''}${p.title}${p.byName ? ` _(${p.byName})_` : ''}`);
          if (p.action) L.push(`  - Qué habría que hacer: ${p.action}${p.files?.length ? ` (${p.files.join(', ')})` : ''}.`);
        }
      }
    }
    if (r.repo?.pushTo) {
      L.push('');
      L.push(r.repo.pushedHead
        ? `Publicado en \`${r.repo.pushTo}\` hasta \`${String(r.repo.pushedHead).slice(0, 12)}\`${r.repo.pushedOutdated ? ` — **el remoto se ha quedado atrás**: la rama va por \`${String(r.repo.head).slice(0, 12)}\`.` : '.'}`
        : `Destino de publicación declarado (\`${r.repo.pushTo}\`) todavía sin usar.`);
    }
    if (w.commits.length) {
      L.push('');
      L.push('### Commits de la sala');
      L.push('');
      for (const c of w.commits) L.push(`- \`${c.sha.slice(0, 12)}\` — ${c.subject} _(${c.author})_`);
    }
    if (w.undebated?.length) {
      L.push('');
      L.push(`### Hallazgos que no entraron a debate (${w.undebated.length})`);
      L.push('');
      for (const f of w.undebated) L.push(`- _${f.byName}_: ${f.file || '(sin archivo)'} — ${f.action}`);
    }
    L.push('');
    L.push('Para traerte el trabajo:');
    L.push('');
    L.push('```bash');
    L.push(`git fetch <ruta-del-servidor-agora> ${w.branch}`);
    L.push(`git diff ${(w.baseCommit || 'HEAD').slice(0, 12)} FETCH_HEAD   # revisar`);
    L.push(`git merge FETCH_HEAD                                        # aplicar`);
    L.push('```');
    if (w.stats.unreviewed) L.push(`\n> Aviso: ${plural(w.stats.unreviewed, 'tarea')} se ${w.stats.unreviewed === 1 ? 'integró' : 'integraron'} sin revisión independiente (está marcado arriba).`);
  }
  if (r.scoreboard?.byAgent?.length) {
    L.push('');
    L.push('## Marcador por harness');
    L.push('');
    L.push('| Harness | Acertó | Disintió | Acordó | Cambió de opinión | Vetos | Hallazgos | Parches | Revisiones | Verificó | Mejoras integradas |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const row of r.scoreboard.byAgent) {
      L.push(`| ${row.harness || '—'} · ${row.name} | ${row.votedWinner ? 'sí' : 'no'} | ${row.dissentPoints} | ${row.agreedPoints} | ` +
        `${row.revised}${row.conceded ? ` (retiró ${row.conceded})` : ''} | ${row.blockers} | ${row.findings}${row.corroboratedFindings ? ` (${row.corroboratedFindings} corroborado${row.corroboratedFindings === 1 ? '' : 's'})` : ''} | ` +
        `${row.patches}${row.rejectedPatches ? ` (${row.rejectedPatches} rechazado${row.rejectedPatches === 1 ? '' : 's'})` : ''} | ${row.reviews} | ${row.verifier ? 'sí' : 'no'} | ` +
        `${row.integrated}${row.reverted ? ` (${row.reverted} deshecha${row.reverted === 1 ? '' : 's'} después)` : ''} |`);
    }
    if (r.scoreboard.highlights?.length) {
      L.push('');
      for (const h of r.scoreboard.highlights) L.push(`- ${h.names.join(', ')}: ${h.label} (${h.value}).`);
    }
  }
  L.push('');
  L.push('## Coste medido');
  L.push('');
  L.push(`- Total: ~${r.cost.estTokens} tokens (${r.cost.totalChars} caracteres).`);
  L.push(`- Media por agente: ~${r.cost.avgPerAgent} tokens en ${plural(r.stats.agents, 'participante')}.`);
  L.push('');
  L.push('_Resultado congelado por AGORA. El checksum identifica exactamente esta versión._');
  return L.join('\n');
}
