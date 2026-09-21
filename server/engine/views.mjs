// AGORA v2 — vistas. Dos públicos con necesidades opuestas:
//  · el agente necesita la acción EXACTA y poco más (cada carácter se paga);
//  · la UI necesita todo el estado para dibujar el debate en vivo.

import { now, gist, plural, estTokens } from './util.mjs';
import { agreementOpen, agreementState } from './agreement.mjs';
import { sharedImprovements } from './collaboration.mjs';
import { workflowHealth } from './recovery.mjs';
import { CAPS, FREE_TEXT, macroOf, claimIdleThresholdMs, offlineGraceMs, recursionRounds } from './settings.mjs';
import { activeAgents, nameOf, proposalOf, critiqueOf, recordServed } from './state.mjs';
import { identityBrief, rosterSummary, vacanciesForUI, budgetStatus } from './roster.mjs';
import {
  consensusReport, positionsOf, notesOf, agendaForTurn, stageConsensus,
  dissentReport, proposalSimilarity,
} from './agenda.mjs';
import { phaseMsLeft, liveProposals, reviseAuthors, canStart, phaseInputsComplete } from './phases.mjs';
import { repoSummary, workSummary, workItemForTurn, reviewAssignments, planText } from './work.mjs';
import { obligationsBrief, buildObligations } from './obligations.mjs';
import { visualBrief } from './visual.mjs';

import { readRepoFile, workDiff, commitLog } from './repo.mjs';

const PHASE_LABEL = {
  lobby: 'Lobby', frame: 'Encuadre', contrast: 'Contraste de ejes', audit: 'Auditoría del repo', proposal: 'Propuestas',
  critique: 'Crítica', revise: 'Revisión',
  vote: 'Votación', tiebreak: 'Desempate', objection: 'Vetos', repair: 'Reparación',
  synthesis: 'Síntesis', verify: 'Verificación', work: 'Trabajo conjunto',
  review: 'Revisión del trabajo', closed: 'Resultado',
};

// Puntos de agenda que llegaron con minoría real, con nombres y alternativas. Se usa en
// las fases donde la minoría puede defender lo suyo (vetos y síntesis). Es información
// que ya existe en el recuento: no cuesta ni un token más.
function contestedForTurn(room, report, agentId = null) {
  const dis = dissentReport(room, report, id => nameOf(room, id));
  if (!dis.measured || !dis.count) return [];
  return dis.contested.map(p => ({
    id: p.id,
    label: p.label,
    status: p.status,
    majority: p.majority ? { label: p.majority.label, share: p.majority.share, by: p.majority.by } : null,
    minority: p.minority.map(m => ({ label: m.label, share: m.share, by: m.by })),
    // El argumento del desacuerdo, tal como se dijo en la crítica anclada a este punto.
    reasons: (p.reasons || []).map(r => ({ by: nameOf(room, r.by), severity: r.severity, text: r.text })),
    yours: agentId ? p.minority.some(m => m.agents.includes(agentId)) : false,
  }));
}

// Disenso protegido, listo para la interfaz: minorías con nombres, convergencia sin
// evidencia, puntos resueltos por autoridad y el aviso de propuestas colapsadas.
// Todo derivado de artefactos que ya existen: cero tokens extra.
function protectedDissentView(room, report = null) {
  const dis = dissentReport(room, report || consensusReport(room), id => nameOf(room, id));
  const drifts = room.artifacts.drift || [];
  const sim = room.artifacts.similaritySnapshot || proposalSimilarity(room);
  const synthesis = room.artifacts.synthesis || room.phase?.data?.synthesis || null;
  const resolutions = synthesis?.pointResolutions || [];
  const labelOfPoint = id => room.agenda.find(p => p.id === id)?.label || id;
  return {
    measured: dis.measured,
    contestedCount: dis.count,
    contestedShare: dis.contestedShare,
    // Cuota de puntos con unanimidad total. Alto no es bueno en sí mismo: es lo que delata
    // que la diversidad se disolvió, y el informe lo presenta junto al disenso, no en su lugar.
    unanimity: dis.unanimity,
    contestedPoints: dis.contested.map(p => ({
      id: p.id, label: p.label, status: p.status, share: p.share,
      majority: p.majority ? { label: p.majority.label, share: p.majority.share, by: p.majority.by } : null,
      minority: p.minority.map(m => ({ label: m.label, share: m.share, by: m.by })),
    })),
    resolutions: resolutions.map(r => ({
      pointId: r.pointId,
      pointLabel: labelOfPoint(r.pointId),
      choiceId: r.choiceId || null,
      basis: r.basis || 'authority',
      evidence: r.evidence || null,
      note: r.note || null,
    })),
    byAuthority: resolutions.filter(r => r.basis === 'authority').map(r => labelOfPoint(r.pointId)),
    // Puntos con minoría real que la síntesis no resolvió: no mencionarlos no los cierra.
    unresolved: (synthesis?.unresolved || []).map(u => ({ id: u.id, label: u.label || labelOfPoint(u.id) })),
    convergenceWithoutEvidence: {
      count: drifts.filter(d => !d.evidenced).length,
      total: drifts.length,
      moves: drifts.slice(-50).map(d => ({
        by: nameOf(room, d.by), point: d.pointLabel,
        from: d.fromLabel || d.from, to: d.toLabel || d.to,
        because: d.because || null, evidenced: !!d.evidenced,
      })),
    },
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

function base(room, agent) {
  return {
    room: room.code,
    title: room.title,
    phase: room.status === 'closed' ? 'closed' : room.phase.name,
    phaseLabel: PHASE_LABEL[room.status === 'closed' ? 'closed' : room.phase.name],
    macro: macroOf(room.status === 'closed' ? 'closed' : room.phase.name),
    status: room.status,
    deadlineInSec: room.status === 'closed' ? 0 : Math.max(0, Math.round(phaseMsLeft(room) / 1000)),
    language: room.settings.language,
    phaseAdvanceMode: room.settings.phaseAdvanceMode || 'timed',
    tone: room.settings.tone,
    participants: activeAgents(room).length,
    you: agent ? {
      id: agent.id,
      name: agent.name,
      // Identidad real: tu harness y tu modelo. La lente solo aparece si la declaraste tú.
      harness: agent.harness || null,
      model: agent.model || null,
      lens: agent.role || null,
      onProposal: !!proposalOf(room, agent.id),
    } : null,
    // El reloj no te cortó: si la fase se ha ampliado porque alguien (tú, quizá) tenía el
    // turno entregado, el agente lo ve. Saber que la sala te está esperando es la señal
    // más barata que existe para terminar el movimiento.
    phaseExtensions: room.phase?.data?.extensions || 0,
    // Si tu último movimiento fue rechazado, lo sabes en el turno siguiente.
    previousRejection: agent?.lastReject ? {
      kind: agent.lastReject.kind,
      code: agent.lastReject.code,
      message: agent.lastReject.message,
      doThis: 'Corrige el payload según el mensaje y reintenta; el anterior no contó.',
    } : null,
  };
}

// ---------------------------------------------------------------- turno del agente
// La tarjeta con la que se DECIDE: el plan completo, con lo que su autor declaró (riesgos,
// supuestos, pre-mortem) y su versión. En la votación solo llegaba el gist de ~220
// caracteres salvo para las propuestas que a cada agente le tocó criticar, así que media
// sala decidía mirando titulares. Recortar aquí no ahorra tokens: cambia el resultado.
function voteCard(room, pid) {
  const pr = room.artifacts.proposals[pid];
  if (!pr) return null;
  return {
    id: pid,
    title: pr.title,
    author: nameOf(room, pr.author),
    approach: pr.approach || null,
    version: pr.v,
    gist: pr.gist,
    plan: pr.plan,
    premortem: pr.premortem || null,
    risks: pr.risks || null,
    assumptions: pr.assumptions || null,
    revisionNote: pr.revisionNote || null,
    positions: positionsOf(pr),
  };
}

// Cuánto pesa lo que se acaba de enviar, con cifras y en voz alta: el agente administra su
// contexto sabiendo qué le cuesta leerlo. Es información, no un tope.
function readingLoad(cards, note) {
  const list = (cards || []).filter(Boolean);
  const chars = list.reduce((n, c) => n + String(c.plan || '').length, 0);
  return { plans: list.length, planChars: chars, approxTokens: estTokens(chars), note };
}

function computeTurn(room, agentId, { since = 0, record = true } = {}) {
  const agent = room.agents[agentId];
  if (!agent) throw Object.assign(new Error('Únete primero con /join.'), { code: 'unknown_agent' });
  agent.lastSeenAt = now();

  const b = base(room, agent);
  const report = consensusReport(room);
  const meta = {
    consensus: report.points.length
      ? {
        global: report.global,
        threshold: report.threshold,
        agreed: report.agreed,
        unresolved: report.points.filter(p => p.status !== 'agreed').map(p => ({
          id: p.id, label: p.label, status: p.status, share: p.share,
          leading: p.modal ? p.modal.label : null, voters: p.voters,
        })),
      }
      : { global: report.global, method: 'ballots', threshold: report.threshold, unresolved: [] },
    budget: budgetStatus(room, agentId),
    identity: identityBrief(room, agentId),
  };

  if (room.status === 'closed') {
    return finish({ ...b, action: 'done', message: 'Debate cerrado. Pide el resultado con GET /result y repórtalo con su checksum.' });
  }
  if (room.status === 'lobby') {
    const canI = activeAgents(room).length >= room.settings.minAgents;
    return finish({
      ...b, action: canI ? 'start-or-wait' : 'wait', tone: room.settings.tone,
      task: room.task, context: room.context, criteria: room.criteria,
      agenda: agendaForTurn(room),
      waitFor: canI ? null : Math.max(0, room.settings.minAgents - activeAgents(room).length),
      message: canI
        ? 'Ya hay suficientes agentes: puedes mover {kind:"start"} o esperar el auto-arranque.'
        : `Esperando a más agentes (mínimo ${room.settings.minAgents}).`,
      payloadSchema: canI ? { kind: '"start"' } : null,
    }, meta);
  }

  const d = room.phase.data;
  const phase = room.phase.name;

  if (agreementOpen(room) && (d.pendingTransition || (phase === 'verify' && d.responses?.[agentId]))) {
    return finish({ ...b, action: 'wait', message: 'La contribución está entregada; falta confirmar el cierre de fase.', synthesis: room.artifacts.synthesis, verification: room.artifacts.verification }, meta);
  }

  switch (phase) {
    case 'frame': {
      // A ciegas de verdad: ni la agenda ajena ni el registro revelan lo que proponen los
      // demás antes de que ellos mismos lo hayan decidido. El consenso tampoco se puede
      // medir aún (los puntos que faltan lo moverían), así que no se finge un parcial.
      const frameMeta = { ...meta, consensus: { ...meta.consensus, unresolved: [] } };
      if (d.responses?.[agentId]) {
        return finish({ ...b, blind: true, action: 'wait', message: 'Encuadre enviado. Esperando al resto (los puntos se juntan al cerrar la etapa).' }, frameMeta);
      }
      return finish({
        ...b, blind: true, action: 'frame-contribute',
        task: room.task, context: room.context, criteria: room.criteria,
        // A ciegas: los puntos de otros agentes no se enseñan hasta que cierre el encuadre.
        agenda: agendaForTurn(room, { blind: true }),
        pendingRules: (room.artifacts.ruleProposals || []).filter(r => !r.applied)
          .map(r => ({ id: r.id, by: nameOf(room, r.by), text: r.text, ratifications: (r.ratifications || []).length })),
        message: 'Encuadre a ciegas: no ves los puntos que proponen los demás (y ellos no ven los tuyos) hasta que esta etapa cierre, así que nadie elige los ejes del debate antes de tiempo. Puedes proponer un punto de decisión que falte, sugerir un cambio de reglas, ratificar los pendientes o pasar. Una sola contribución. Al cerrar hay una vuelta corta de contraste donde verás la agenda entera y podrás añadir el eje que falte o impugnar el que sobre: no hace falta que lo metas todo aquí.',
        payloadSchema: [
          `{kind:"point-proposal", payload:{label:"≤${CAPS.pointLabel}", options:["alternativa A","alternativa B"]}}`,
          `{kind:"rule-change", payload:{op:"consensusThreshold" value:0.7 (=70%), op:"tone" value:"texto", op:"requireDiversity" value:true|false, op:"maxDurationMs" value:1800000 (ms), op:"tokenBudgetPerAgent" value:80000 (tokens), op:"phaseMs" phase:"vote" value:120000 (ms), text:"${FREE_TEXT}"}}`,
          '{kind:"ratify", payload:{proposalId:"r…", approve:true}}',
          '{kind:"pass"}',
        ],
      }, frameMeta);
    }
    // Contraste de ejes: la vuelta corta y ya informada del encuadre. Aquí nadie ancla a nadie
    // (todos ven la agenda entera), así que el que llegó tarde puede añadir el eje que falta y
    // cualquiera puede impugnar el que sobra o pedir que se fusione con otro.
    case 'contrast': {
      if (d.responses?.[agentId]) return finish({ ...b, action: 'wait', message: 'Tu contraste está registrado. Esperando al resto.' }, meta);
      const challenges = room.artifacts.contrast?.challenges || {};
      return finish({
        ...b, action: 'contrast-agenda',
        task: room.task, criteria: room.criteria,
        agenda: agendaForTurn(room),
        // Qué ejes ya están impugnados y por quién: impugnar es sumarse a un argumento, no
        // repetirlo a ciegas. Se dice para que cada uno decida con la información completa.
        pendingChallenges: Object.entries(challenges).map(([pointId, list]) => ({
          pointId,
          label: room.agenda.find(p => p.id === pointId)?.label || pointId,
          by: list.map(c => nameOf(room, c.by)),
          because: list.map(c => c.because).filter(Boolean),
          mergeInto: [...new Set(list.map(c => c.mergeInto).filter(Boolean))],
        })),
        message: 'Contraste de ejes: la agenda entera ya está a la vista, así que mirar los ejes de los demás no ancla a nadie. Añade con point-proposal el eje que falte, impugna con point-challenge el que sobre (di por qué y, si es el mismo tema que otro, propón mergeInto), o pasa. Nada se borra por mayoría: lo impugnado queda abierto y visible en todo el debate. Una fusión solo se aplica si la pide más de la mitad de la sala y todas las peticiones apuntan al mismo destino.',
        payloadSchema: [
          '{kind:"point-proposal", payload:{label:"el eje que falta", options:["alternativa A","alternativa B"]}}',
          '{kind:"point-challenge", payload:{pointId:"id del eje", because:"por qué sobra o a qué otro eje se parece", mergeInto?:"otro pointId"}}',
          '{kind:"pass"}',
        ],
      }, meta);
    }
    case 'audit': {
      if (d.responses?.[agentId]) return finish({ ...b, action: 'wait', message: 'Tus hallazgos están registrados. Esperando al resto de la auditoría.' }, meta);
      return finish({ ...b, action: 'audit-repo', ...repoTurn(room), ...findingContext(room), ...auditBrief(room), ...workRepoAccess(room) }, meta);
    }
    case 'proposal': {
      if (proposalOf(room, agentId)) return finish({ ...b, action: 'wait', message: 'Propuesta recibida. Esperando al resto (ciegas: se revelan juntas).' }, meta);
      return finish({
        ...b, action: 'submit-proposal',
        task: room.task, context: room.context, criteria: room.criteria,
        agenda: agendaForTurn(room),
        // Si el repo ya está auditado, la propuesta es un PLAN DE CAMBIO: debe decir
        // cómo se ejecutan las mejoras aprobadas, no solo qué se decide.
        ...(room.repo ? { repoPlan: repoPlanForTurn(room) } : {}),
        message: 'Presenta TU propuesta: concreta, ejecutable y distinta de las demás (no ves las ajenas). Incluye tu elección en cada punto de la agenda y un pre-mortem breve.',
        payloadSchema: {
          title: `string ≤${CAPS.proposalTitle}`,
          plan: `30+ caracteres — pasos concretos. ${FREE_TEXT}`,
          approach: `string ≤${CAPS.proposalApproach} — el ángulo del plan en una frase`,
          positions: '[{pointId, choiceId}] — o {pointId, option:"opción nueva"} si propones otra',
          premortem: `«esto falló dentro de 6 meses porque…» — ${FREE_TEXT}`,
          risks: `opcional — ${FREE_TEXT}`,
          assumptions: `opcional — ${FREE_TEXT}`,
        },
      }, meta);
    }
    case 'critique': {
      const pending = (d.assignments?.[agentId] || [])
        .filter(pid => room.artifacts.proposals[pid] && !room.artifacts.proposals[pid].conceded)
        .filter(pid => !critiqueOf(room, agentId, pid));
      if (!pending.length) return finish({ ...b, action: 'wait', message: 'Sin crítica pendiente. Espera la siguiente fase.' }, meta);
      return finish({
        ...b, action: 'submit-critique',
        targets: pending.map(pid => {
          const pr = room.artifacts.proposals[pid];
          return {
            id: pid,
            title: pr.title,
            author: nameOf(room, pr.author),
            approach: pr.approach || null,
            plan: pr.plan,
            premortem: pr.premortem || null,
            risks: pr.risks || null,
            assumptions: pr.assumptions || null,
            positions: positionsOf(pr),
          };
        }),
        agenda: agendaForTurn(room),
        message: 'Mejora la propuesta asignada, no compitas solo contra ella. Identifica lo valioso (steelman), objeciones con escenario de fallo y mejoras concretas en improvements: qué cambiar o combinar, por qué y cómo comprobarlo. No inventes una mejora si no la ves. Señala el punto de agenda con "against".',
        payloadSchema: {
          target: 'proposal id',
          steelman: 'opcional si aportas objeciones — texto libre',
          improvements: '[{change, why, validation}] mejoras constructivas opcionales: cómo potenciar el plan ajeno y comprobar el beneficio',
          objections: '[{type: risk|cost|feasibility|ethics|missing-info|scope, severity: high|med|low, text, against?:"pointId"}] sin tope práctico: tantas como tengas',
        },
      }, meta);
    }
    case 'revise': {
      const mine = proposalOf(room, agentId);
      if (!mine || mine.conceded) return finish({ ...b, action: 'wait', message: 'No tienes propuesta viva que revisar.' }, meta);
      if (d.responses?.[agentId]) return finish({ ...b, action: 'wait', message: 'Ya respondiste. Esperando al resto.' }, meta);
      const crits = Object.values(room.artifacts.critiques).filter(c => c.target === mine.id);
      if (!crits.length) return finish({ ...b, action: 'wait', message: 'Nadie criticó tu propuesta: espera la votación.' }, meta);
      return finish({
        ...b, action: 'submit-revision-or-pass',
        proposalId: mine.id, currentVersion: mine.v,
        sharedImprovements: sharedImprovements(room, mine.id),
        critiques: crits.map(c => ({
          by: nameOf(room, c.author),
          steelman: c.steelman || null,
          objections: c.objections,
          improvements: c.improvements || [],
        })),
        unresolved: report.points.filter(p => p.status !== 'agreed').map(p => ({ id: p.id, label: p.label, leading: p.modal?.label || null })),
        // Los puntos donde tu postura es minoría: defiéndelos o muévete, pero si te mueves
        // hay que decir qué te movió. Nadie aprueba su propio cambio sin argumento aquí.
        yourDissent: dissentReport(room, report, id => nameOf(room, id)).points
          .filter(p => p.contested && p.minority.some(m => m.agents.includes(agentId)))
          .map(p => ({ id: p.id, label: p.label, you: p.minority.find(m => m.agents.includes(agentId))?.label || null, majority: p.majority?.label || null, majorityShare: p.majority?.share ?? null })),
        message: 'Responde a las objeciones con una versión revisada (puedes corregir tus posiciones de la agenda), o retira tu propuesta con "concede" y respalda otra. Si cambias alguna posición, di qué evidencia te movió en changes[{pointId, because}]: converger sin argumento queda registrado y no cuenta como acuerdo.',
        payloadSchema: [
          `{kind:"revision", payload:{proposalId:"${mine.id}", plan:"30+ caracteres", note:"libre", positions?:[…], changes?:[{pointId, because}], contributionResponses?:[{contributionId, disposition:"adopted|adapted|declined", reason:"qué cambió y por qué"}]}}`,
          '{kind:"concede", payload:{reason:"libre", endorse:"p…?"}}',
          '{kind:"pass"}',
        ],
      }, meta);
    }
    case 'vote': {
      const options = (d.options || []).filter(id => room.artifacts.proposals[id] && !room.artifacts.proposals[id].conceded);
      if (d.ballots?.[agentId]) return finish({ ...b, action: 'wait', message: 'Voto recibido (secreto hasta el cierre).' }, meta);
      const cards = options.map(pid => voteCard(room, pid));
      return finish({
        ...b, action: 'submit-vote',
        options: cards,
        readingLoad: readingLoad(cards, 'Ordena TODAS las opciones. Los planes van completos a propósito: esto es el material de tu decisión. Si tu contexto es corto, léelos en dos pasadas — primero títulos y posiciones, después el plan de las dos que de verdad compiten.'),
        agenda: agendaForTurn(room),
        message: 'Ordena TODAS las opciones de mejor a peor según los criterios y los puntos de agenda resueltos. Voto secreto. Recibes el PLAN COMPLETO de cada opción: decide sobre el texto, no sobre su titular.',
        payloadSchema: { ranking: `[${options.join(', ')}] en tu orden de preferencia` },
      }, meta);
    }
    case 'tiebreak': {
      if (d.ballots?.[agentId]) return finish({ ...b, action: 'wait', message: 'Voto del desempate recibido.' }, meta);
      const finalists = (d.finalists || []).map(pid => voteCard(room, pid));
      const load = readingLoad(finalists, 'Un desempate se decide sobre los planes, no sobre sus titulares: aquí van completos los dos finalistas.');
      if ((d.args || []).some(x => x.by === agentId)) {
        return finish({
          ...b, action: 'submit-vote', options: finalists, readingLoad: load,
          args: (d.args || []).map(a => ({ by: nameOf(room, a.by), target: a.target, text: a.text })),
          message: 'Segunda votación entre los finalistas, tras leer los alegatos.',
          payloadSchema: { ranking: `[${(d.finalists || []).join(', ')}]` },
        }, meta);
      }
      return finish({
        ...b, action: 'submit-argument', finalists, readingLoad: load,
        message: 'Empate: un alegato decisivo por un finalista; después vuelves a votar. Los planes completos de los dos finalistas están aquí para que el alegato se apoye en el texto.',
        payloadSchema: { target: 'finalist id', text: `${FREE_TEXT}` },
      }, meta);
    }
    case 'objection': {
      if (d.responses?.[agentId]) return finish({ ...b, action: 'wait', message: 'Respuesta registrada.' }, meta);
      const wp = room.artifacts.proposals[d.winnerId];
      if (!wp) return finish({ ...b, action: 'wait', message: 'Sin ganadora que objetar.' }, meta);
      return finish({
        ...b, action: 'objection-or-pass',
        winner: { id: d.winnerId, title: wp.title, plan: wp.plan, version: wp.v, positions: positionsOf(wp) },
        unresolved: report.points.filter(p => p.status !== 'agreed').map(p => ({ id: p.id, label: p.label, leading: p.modal?.label || null })),
        contested: contestedForTurn(room, report, agentId),
        message: '¿Fallo FATAL en la ganadora? severity:"blocker" obliga a reparar. Preocupación menor: "concern". Nada que objetar: pass. Si la ganadora resuelve un punto disputado en contra de tu alternativa, dilo aquí: el disenso se conserva en el resultado.',
        payloadSchema: ['{kind:"objection", payload:{text:"15+ caracteres, sin tope", severity:"blocker|concern"}}', '{kind:"pass"}'],
      }, meta);
    }
    case 'repair': {
      const wp = room.artifacts.proposals[d.winnerId];
      if (!wp) return finish({ ...b, action: 'wait', message: 'Sin propuesta que reparar.' }, meta);
      if (wp.author !== agentId) return finish({ ...b, action: 'wait', message: `${nameOf(room, wp.author)} está reparando.` }, meta);
      if (d.responses?.[agentId]) return finish({ ...b, action: 'wait', message: 'Reparación enviada.' }, meta);
      const blockers = room.artifacts.objections.filter(o => o.severity === 'blocker' && !o.addressed);
      const findings = room.artifacts.verification?.findings || [];
      return finish({
        ...b, action: 'submit-revision-or-pass',
        proposalId: wp.id,
        blockers: d.after === 'close'
          ? findings.map(f => ({ by: 'verificación', text: f.text, severity: f.severity }))
          : blockers.map(o => ({ by: nameOf(room, o.by), text: o.text, severity: o.severity })),
        message: d.after === 'close'
          ? 'La verificación encontró problemas en tu plan: publica una versión corregida que los aborde, o pasa y acepta el disenso registrado.'
          : 'Vetos contra tu plan: publica una versión revisada que los aborde, o pasa (el disenso queda registrado).',
        payloadSchema: ['{kind:"revision", payload:{plan:"30+ caracteres, libre", note:"libre"}}', '{kind:"pass"}'],
      }, meta);
    }
    case 'synthesis': {
      if (d.authorId !== agentId) return finish({ ...b, action: 'wait', message: `${nameOf(room, d.authorId)} está redactando la síntesis.` }, meta);
      const wp = room.artifacts.proposals[d.winnerId];
      return finish({
        ...b, action: 'submit-synthesis',
        peerPlans: liveProposals(room).filter(p => p.id !== d.winnerId).map(p => voteCard(room, p.id)),
        sharedImprovements: sharedImprovements(room),
        collaborationInstruction: 'El plan ganador es una base, no un límite: considera las ideas útiles de los otros planes y las mejoras compartidas. Explica en contributionResponses cuáles incorporas, adaptas o descartas y por qué. Lo que no respondas queda sin resolución final; no se contará como incorporado.',
        winner: { id: d.winnerId, title: wp.title, plan: wp.plan, version: wp.v, positions: positionsOf(wp) },
        objections: room.artifacts.objections.map(o => ({
          id: o.id, by: nameOf(room, o.by), severity: o.severity, text: o.text, addressed: !!o.addressed,
        })),
        unresolved: report.points.filter(p => p.status !== 'agreed').map(p => ({
          id: p.id, label: p.label, status: p.status, share: p.share, leading: p.modal?.label || null,
          others: p.choices.slice(1).map(c => ({ label: c.label, agents: c.agents.map(a => nameOf(room, a)) })),
        })),
        contested: contestedForTurn(room, report, agentId),
        message: 'Redacta el PLAN FINAL EJECUTABLE: fusiona la ganadora con las objeciones válidas, resuelve o marca cada punto abierto y marca en merges[] los ids de objeciones incorporadas. En cada punto con minoría real declara la BASE: basis:"evidence" + evidence:"qué dato nuevo lo decide", basis:"adopted-dissent" si adoptas la alternativa minoritaria, o basis:"authority". Lo resuelto por autoridad sin evidencia se publica como tal, con los nombres de quien sostenía la otra opción.',
        payloadSchema: {
          final: 'string 50+ caracteres, sin tope',
          contributionResponses: '[{contributionId, disposition:"adopted|adapted|declined", reason}] trazabilidad de las mejoras compartidas; no implica pruebas ejecutadas',
          merges: '[ids de objeciones incorporadas]',
          pointResolutions: '[{pointId, choiceId?, note?, basis?: "evidence"|"adopted-dissent"|"authority", evidence?}] — cómo queda cada punto abierto; el texto, libre',
        },
      }, meta);
    }
    case 'review': {
      return finish({ ...b, ...reviewTurn(room, agentId) }, meta);
    }
    case 'work': {
      return finish({ ...b, ...workTurn(room, agentId) }, meta);
    }
    case 'verify': {
      if (d.verifierId !== agentId) {
        return finish({ ...b, action: 'wait', message: `${nameOf(room, d.verifierId)} está verificando el plan.` }, meta);
      }
      const wp = room.artifacts.proposals[d.winnerId];
      const resolutions = room.artifacts.synthesis?.pointResolutions || [];
      const labelOf = id => room.agenda.find(p => p.id === id)?.label || id;
      return finish({
        ...b, action: 'submit-verification',
        winner: { id: d.winnerId, title: wp.title, plan: wp.plan, version: wp.v },
        synthesis: d.synthesis?.final || null,
        selfVerified: !!d.selfVerified,
        // Al verificador se le da lo que la síntesis cerró por autoridad sin dato nuevo y los
        // puntos que dejó sin resolver: el servidor lo eligió justo por ser quien menos apoyó
        // al ganador, así que es quien mejor puede falsar lo que se cerró a dedo.
        byAuthority: resolutions.filter(r => r.basis === 'authority')
          .map(r => ({ pointId: r.pointId, label: labelOf(r.pointId), choiceId: r.choiceId || null, note: r.note || null })),
        unresolvedPoints: (room.artifacts.synthesis?.unresolved || []).map(u => ({ id: u.id, label: u.label })),
        contested: contestedForTurn(room, report, agentId),
        // Obligaciones de prueba: lo que el plan AFIRMA, tipado, con lo que nadie cerró todavía.
        // Sale del plan y de las mediciones del servidor, no de una relectura del verificador.
        obligations: obligationsBrief(room),
        message: 'Verificación independiente y adversarial: convierte el plan en comprobaciones falsables (qué se mide, cómo y qué se espera). Te eligió el servidor por ser quien MENOS apoyó al ganador: empieza por lo que la síntesis cerró POR AUTORIDAD sin dato nuevo — intenta falsarlo con un umbral medible. Si un punto disputado no es comprobable, dilo en findings. Un fallo de severidad alta fuerza reparación (veredicto "fail" o un finding high).',
        payloadSchema: {
          checks: '[{pointId?, claim, method, expectation}] sin tope práctico: tantas comprobaciones como hayas hecho',
          findings: '[{severity: high|med|low, text}] opcional',
          verdict: '"pass" | "fail"',
        },
      }, meta);
    }
    default:
      return finish({ ...b, action: 'wait', message: 'Espera.' }, meta);
  }

  function finish(turn, extraMeta) {
    const agreement = agreementState(room);
    if (agreement && phaseInputsComplete(room) && turn.action === 'wait' && agreement.pending.includes(agentId)) {
      turn = { ...turn, action: 'confirm-phase-ready',
        phaseReview: ['frame', 'proposal'].includes(room.phase.name)
          ? { blind: true, note: 'Las contribuciones se revelan al cerrar, para conservar la independencia inicial.' }
          : { proposals: liveProposals(room).map(p => voteCard(room, p.id)),
            critiques: Object.values(room.artifacts.critiques),
            synthesis: room.artifacts.synthesis || null, verification: room.artifacts.verification || null },
        message: 'Sin reloj: confirma solo si terminaste tu aporte y estás listo para pasar. No significa apoyar la solución: conserva tus objeciones. Puedes seguir aportando movimientos válidos; un aporte nuevo invalida las confirmaciones anteriores. Si necesitas más trabajo, no confirmes todavía.',
        payloadSchema: { kind: 'phase-ready', payload: { revision: agreement.revision, ready: true } },
      };
    }
    const full = {
      ok: true,
      since: since || 0,
      logSeq: room.logSeq,
      ...turn,
      ...(agreement ? { phaseAgreement: agreement } : {}),
      ...(extraMeta || {}),
    };
    if (since) {
      const entries = room.log
        // En el encuadre a ciegas el registro tampoco puede chivarse: «Ana propone el punto X»
        // es exactamente la ancla que esta fase evita.
        .filter(l => !(full.blind && l.kind === 'point'))
        // La ventana es amplia a propósito: si el agente se perdió 60 sucesos, dárselos
        // recortados a 25 lo obligaba a volver a preguntar por lo mismo.
        .filter(l => l.id > since).slice(-200).map(l => ({
        id: l.id, by: l.agentId ? nameOf(room, l.agentId) : 'sistema', kind: l.kind, text: l.text,
      }));
      full.recentLog = entries;
    } else {
      full.howTo = {
        loop: 'GET /turn → POST /move hasta action:"done"',
        move: `POST /api/rooms/${room.code}/move {agentId, token, kind, payload}`,
        result: `GET /api/rooms/${room.code}/result?agent=…&token=…`,
        manual: 'GET /manual',
      };
      if (room.repo) {
        full.howTo.repo = {
          index: `GET /api/rooms/${room.code}/repo?agent=…&token=…`,
          search: `GET /api/rooms/${room.code}/repo?q=TEXTO&agent=…&token=…`,
          file: `GET /api/rooms/${room.code}/repo?path=ruta/al/archivo&from=1&lines=200&agent=…&token=…`,
          diff: `GET /api/rooms/${room.code}/work.diff?agent=…&token=…`,
        };
      }
    }
    // Solo se contabiliza lo que realmente se le entrega al agente: sondear el
    // estado para saber si le toca (long-poll) no debe inflar su coste.
    if (record) recordServed(room, agentId, full);
    full.servedSoFar = room.served[agentId] || 0;
    return full;
  }
}

// El turno entregado se recuerda. Si a un agente se le dio una acción de ESTA fase y todavía
// no la ha devuelto, el servidor sabe que está trabajando en ella; antes no lo sabía y el
// reloj cerraba la fase encima de él, tirando su movimiento y dejando al debate con una voz
// menos. `awaiting` se limpia en cuanto entrega algo (moves.mjs).
//
// Las sondas (`record:false`, que usan el long-poll y el panel para mirar sin gastar) no
// cuentan como turno entregado: si lo hicieran, cualquier agente que solo estuviera esperando
// parecería estar trabajando.
export function currentTurn(room, agentId, opts = {}) {
  const { record = true } = opts;
  const turn = computeTurn(room, agentId, opts);
  const agent = room.agents[agentId];
  if (agent && record !== false) {
    if (turn && !['wait', 'done'].includes(turn.action)) {
      agent.awaiting = { phase: room.phase.name, action: turn.action, since: now() };
    } else if (agent.awaiting && agent.awaiting.phase === room.phase.name) {
      agent.awaiting = null;
    }
  }
  return turn;
}

// ---------------------------------------------------------------- repo y trabajo
// Lo que un agente necesita para auditar el repo sin leerlo entero: índice,
// búsqueda y lectura por rangos. Todo se sirve por HTTP con su token.
function workRepoAccess(room) {
  const code = room.code;
  return {
    repoAccess: {
      index: `GET /api/rooms/${code}/repo?agent=…&token=…  → árbol y metadatos`,
      search: `GET /api/rooms/${code}/repo?q=TEXTO&agent=…&token=…  → coincidencias con archivo:línea`,
      file: `GET /api/rooms/${code}/repo?path=ruta/al/archivo&from=1&lines=200&agent=…&token=…`,
      tip: 'Busca primero (?q=) y lee solo los archivos que necesites: cada línea servida la pagas tú.',
    },
  };
}

function repoTurn(room) {
  const r = repoSummary(room);
  if (!r) return {};
  // Proyecto nuevo: el árbol está casi vacío A PROPÓSITO. Se dice —y se manda el plan ganador—
  // para que nadie busque código que todavía no existe: lo que hay que construir es el plan.
  const nuevo = !!room.repo?.greenfield;
  const plan = nuevo ? planText(room) : '';
  const conPlan = nuevo && !!plan && ['objection', 'repair', 'synthesis', 'verify', 'work', 'review'].includes(room.phase?.name);
  return {
    repo: {
      ...(nuevo ? { greenfield: true } : {}),
      ...(conPlan ? {
        plan: plan.slice(0, CAPS.synthesisFinal || 60_000),
        planNote: 'Proyecto NUEVO sin código previo: este plan es la especificación. Crea los archivos que hagan falta (usa files:[{path,content}]).',
      } : {}),
      source: r.source,
      kind: r.kind,
      branch: r.branch,
      files: r.files,
      directories: r.directories,
      extensions: r.extensions,
      verify: r.verify,
      baseline: r.baseline
        ? {
          status: r.baseline.status || 'done',
          ran: !!r.baseline.ran,
          ok: r.baseline.ok ?? null,
          exitCode: r.baseline.exitCode ?? null,
          command: r.baseline.command || null,
          outputTail: r.baseline.ran && r.baseline.ok !== true ? String(r.baseline.outputTail || '').slice(0, 12_000) : null,
          note: 'Línea base medida al adjuntar el repo: lo que ya falla antes de tocar nada.',
        }
        : null,
    },
  };
}

function findingContext(room) {
  const findings = room.artifacts.findings;
  if (!findings.length) return {};
  return {
    // Enteros: para corroborar un hallazgo ajeno o cubrir lo que nadie miró hay que leerlo
    // completo, no su titular.
    peerFindings: findings.slice(-100).map(f => ({
      by: nameOf(room, f.by),
      file: f.file,
      line: f.line,
      severity: f.severity,
      claim: f.claim,
      evidence: f.evidence,
      action: f.action,
    })),
    peerNote: 'Los hallazgos ajenos están a la vista: corrobóralos con evidencia nueva o cubre zonas que nadie miró. Repetir un hallazgo tal cual no aporta.',
  };
}

function auditBrief(room) {
  return {
    message: 'Auditoría del repo: busca y lee el código, y presenta hallazgos CONCRETOS anclados a archivos: qué está mal, con qué evidencia y qué mejora aplicable propones. Puedes presentar varios hallazgos (kind:"finding") o pasar.',
    payloadSchema: [
      '{kind:"finding", payload:{file:"ruta/en/el/repo", line:42, symbol:"nombreDeFuncion", severity:"high|med|low", claim:"qué está mal (15+ caracteres, sin tope)", evidence:"cómo lo sabes: línea, test que falla, ruta de código (libre)", action:"mejora concreta y aplicable (10+ caracteres, sin tope)"}}',
      '{kind:"pass"}  → has revisado el repo y no propones cambios',
    ],
    scoring: 'Los hallazgos se agrupan y pesan por severidad y corroboración; las mejores se convierten en puntos de agenda y el debate decide si se aplican o no.',
  };
}

// En la fase de propuestas, con repo auditado, el plan debe decir CÓMO se ejecutan
// las mejoras, no solo qué se decide.
function repoPlanForTurn(room) {
  const improvements = room.agenda.filter(p => p.source === 'finding').map(p => ({
    pointId: p.id,
    label: p.label,
    file: p.audit?.file || null,
    severity: p.audit?.severity || null,
    // Completos: quien planifica cómo implementar una mejora necesita el hallazgo tal como
    // lo escribió su autor, no un resumen. El texto largo se recorta en la interfaz, no aquí.
    claim: p.audit?.claim || '',
    evidence: p.audit?.evidence || '',
    action: p.audit?.action || '',
  }));
  if (!improvements.length) return null;
  return {
    improvements,
    note: 'Estas son las mejoras detectadas en la auditoría. Posiciónate en cada punto (aplicar/aplazar/descartar) y explica en tu plan CÓMO se implementarían las que apliques: archivos, orden, y cómo se comprueba que funcionan.',
  };
}

// Fase de revisión posterior: aquí se juzga el trabajo YA integrado como conjunto, ítem por
// ítem, con el diff delante. El veredicto es «ok» o «esto aún se puede mejorar, así».
function reviewTurn(room, agentId) {
  const work = workSummary(room);
  const { items, pendientes, done } = reviewAssignments(room, agentId);
  const d = room.phase.data;
  const extra = !!room.settings.extraordinary;
  const diff = workDiff(room);
  // El juicio visual del conjunto ya integrado: aquí el artefacto está entero y quieto, que es
  // cuando una mirada vale más.
  const visual = visualBrief(room, agentId, buildObligations(room).claims);
  const canJudge = !!visual?.available && (visual.targets || []).length > 0;
  const base = {
    branch: work.branch,
    head: work.head,
    commits: commitLog(room).length,
    ...(visual ? { visual } : {}),
    diff: diff.length > CAPS.reviewDiffChars
      ? `${diff.slice(0, CAPS.reviewDiffChars)}\n… [${diff.length - CAPS.reviewDiffChars} caracteres omitidos: pide el diff completo con GET /work.diff]`
      : diff,
    integrated: items.map(i => ({
      id: i.id, title: i.title, files: i.files, severity: i.severity,
      byName: nameOf(room, i.claimant), commit: i.commit || null,
      verify: i.verify?.ran ? (i.verify.ok ? 'verde' : `rojo (${i.verify.exitCode})`) : 'sin verificación ejecutable',
    })),
    alreadyReviewed: Object.keys(done),
    extraordinary: extra,
    verify: { command: work.verifyCommand },
    ...workRepoAccess(room),
  };
  if (pendientes.length) {
    const next = pendientes[0];
    return {
      ...base,
      action: 'postwork-review',
      assign: pendientes.map(i => ({ id: i.id, title: i.title, files: i.files, action: i.action, byName: nameOf(room, i.claimant) })),
      message: extra
        ? 'Trabajo extraordinario: repasa CADA mejora integrada contra el diff real y di si aún se puede mejorar. Si puedes, propón la acción concreta. Nada de «está bien» por cortesía: si de verdad no hay nada, dilo y sigue.'
        : 'Revisa las mejoras integradas que te tocan contra el diff real: ¿hicieron lo que el plan decía, sin romper nada? Verdict "ok" o "improve" con una acción concreta.',
      payloadSchema: {
        itemId: `uno de: ${pendientes.map(i => i.id).join(', ')}`,
        verdict: '"ok" | "improve" (obligatorio)',
        claim: 'string — qué falta (solo si improve), sin tope',
        action: '10+ caracteres — qué harías (obligatorio si improve)',
        evidence: 'string — por qué lo sabes, sin tope',
        file: `ruta del repo (por defecto ${next.files?.[0] || 'sin archivo'})`,
        severity: '"high" | "med" | "low"',
      },
    };
  }
  if (canJudge) {
    return {
      ...base,
      action: 'submit-judgment',
      message: 'Ya diste tu veredicto del código. Falta el de lo que SE VE: las capturas del artefacto integrado esperan firma. Un «pasa» solo cierra si no escribiste el artefacto; un «no-pasa» abre bloqueo.'
        + ' Si algo cambió desde la captura, pide {kind:"capture"} primero.',
      payloadSchema: [visual.move.payload, '{kind:"capture", payload:{}}'],
    };
  }
  return {
    ...base,
    action: 'wait',
    message: 'Ya diste tu veredicto de lo que te tocaba. La revisión cierra cuando todos hayan revisado cada mejora. Vuelve a /turn.' +
      (extra ? ' Con trabajo extraordinario, lo que se proponga como mejora vuelve a la cola de trabajo.' : ''),
    payloadSchema: ['{kind:"pass"}  → no tienes nada más que revisar'],
  };
}

function workTurn(room, agentId) {
  const work = workSummary(room);
  const t = workItemForTurn(room, agentId);
  // El juicio visual se ofrece AQUÍ, en la fase donde existe el artefacto: capturas del commit
  // actual, las afirmaciones que prometen algo que hay que mirar, y con qué independencia firma
  // este agente (la calcula el servidor, él no la declara). Sin esto, «no debe verse cutre»
  // atravesaba toda la sala sin que nadie mirase una imagen.
  const visual = visualBrief(room, agentId, buildObligations(room).claims);
  const canJudge = !!visual?.available && (visual.targets || []).length > 0;
  const judgeTurn = (extra = {}) => ({
    ...base,
    action: 'submit-judgment',
    visual,
    message: 'Mira las capturas del artefacto y firma lo que veas. Un «pasa» solo cierra la obligación si no escribiste nada del artefacto y citas una captura fresca; un «no-pasa» abre bloqueo aunque venga del autor. Si el artefacto cambió después de mirar, pide {kind:"capture"} y vuelve a mirar: el juicio caduca con la imagen.'
      + (extra.message ? ` ${extra.message}` : ''),
    payloadSchema: [visual.move.payload, '{kind:"capture", payload:{}}  → vuelve a capturar el artefacto ahora'] ,
    ...extra,
  });
  const base = {
    branch: work.branch,
    verify: {
      command: work.verifyCommand,
      baseline: work.baseline?.ran ? { ok: !!work.baseline.ok, exitCode: work.baseline.exitCode } : null,
    },
    // Si hay un parche sin resolver, el árbol NO está en el estado del último commit:
    // conviene esperar antes de componer el tuyo (y el servidor lo rechazará igual).
    patchInFlight: work.pending ? { patchId: work.pending, itemId: work.patches[work.pending]?.itemId } : null,
    tasks: work.items.map(i => ({
      id: i.id, title: i.title, status: i.status, files: i.files, severity: i.severity,
      attempts: i.attempt, byName: i.byName, commit: i.commit || null,
      // Alcance ya comprobado al crear la tarea y con quién comparte archivos: si la tarea
      // manda construir algo que ya está, se dice ANTES de reclamarla.
      scopeCheck: i.scopeCheck || null,
      blockedBy: i.blockedBy || [],
    })),
    warnings: work.items
      .filter(i => i.scopeCheck?.verdict === 'ya-existe' || (i.blockedBy || []).length)
      .map(i => ({ id: i.id, scope: i.scopeCheck?.verdict || null, because: i.scopeCheck?.because || null, hit: i.scopeCheck?.hit || null, blockedBy: i.blockedBy || [] })),
    ...workRepoAccess(room),
  };

  // Quién puede reclamar: el MISMO criterio que aplica el motor. Ofrecerle a un agente un
  // movimiento que el servidor va a rechazar no es un aviso, es un bucle (harness reintentando
  // un 401 tras otro mientras la sala no avanza).
  const agent = room.agents[agentId];
  const canClaim = !!agent && agent.status !== 'absent' && !agent.overBudget && !agent.workOptOut;

  // Con un parche en vuelo, el árbol no admite otro: si puedes revisarlo tú, revisarlo es
  // lo que desatasca el trabajo (pedir tu propio parche sería un rechazo anunciado). Va
  // ANTES de «submit-patch» porque, cuando todos los agentes tienen tarea reclamada, nadie
  // quedaba libre para revisar y el trabajo se quedaba esperando a que expirase un reclamo.
  if (t?.pending && !t.pending.review && t.pending.author !== agentId) {
    const patch = t.pending;
    const diff = String(patch.diff || '');
    return {
      ...base,
      action: 'review-patch',
      patch: {
        id: patch.id,
        itemId: patch.itemId,
        author: nameOf(room, patch.author),
        summary: patch.summary,
        mode: patch.mode,
        // El mismo formato de stat que ve la interfaz: un número de archivos y la
        // lista con sus líneas, para que nadie tenga que adivinar la forma.
        stat: patch.stat
          ? {
            files: patch.stat.fileCount ?? (patch.stat.files || []).length,
            insertions: patch.stat.insertions,
            deletions: patch.stat.deletions,
            list: patch.stat.files || [],
          }
          : null,
        // El diff del parche que se revisa va COMPLETO: el revisor ya está leyendo este
        // turno, mandarlo a medias solo lo obligaba a un segundo viaje por HTTP para ver
        // lo que el servidor tenía delante. El techo existe para que un parche absurdo no
        // reviente el turno, no para dosificar información.
        diff,
        diffTruncated: diff.length > CAPS.patchDiffMax,
      },
      message: 'Revisa este parche como si fuera tuyo el repo: ¿hace lo que dice, no rompe nada, y está en el estilo del proyecto? Aprueba o pide cambios con motivos concretos. Nadie aprueba su propio parche. Si fuera tu tarea reclamada, sigue siendo tuya: la revisión va primero porque el árbol no admite dos parches a la vez.',
      payloadSchema: {
        itemId: patch.itemId,
        verdict: '"approve" | "changes"',
        notes: 'obligatorio y concreto si pides cambios — texto libre',
      },
    };
  }

  // Con tu propia tarea ya entregada, la pelota la tiene el servidor (y el revisor): reclamar
  // otra la rechaza el motor («ya tienes una en curso») y retirarse tiraría tu parche.
  if (t?.mine && t.mine.status !== 'claimed') {
    return {
      ...base,
      action: 'wait',
      message: `Tu tarea ${t.mine.id} está ${t.mine.status === 'verifying' ? 'verificándose' : 'en revisión'}: `
        + 'el parche está en manos del servidor y de otro agente. Vuelve a /turn.',
      payloadSchema: ['{kind:"progress", payload:{note:"en qué vas"}}  → si sigues trabajando en ella'],
    };
  }
  // Un observador (o alguien sin presupuesto) no reclama, pero SÍ puede mirar: el juicio visual
  // no necesita tocar el repo, y quien no escribió nada es justo el ojo más independiente que la
  // sala puede ofrecer. Antes de esto, el observador se quedaba mirando cómo la sala entregaba
  // una promesa visual sin que nadie la mirara.
  if (!canClaim) {
    if (canJudge) return judgeTurn({ message: 'No trabajas el repo, así que eres el juez más independiente que hay aquí.' });
    return {
      ...base,
      action: 'wait',
      message: 'Estás fuera del trabajo del repo (observador o sin presupuesto): no puedes reclamar tareas. Sigue pidiendo /turn para ver avanzar el trabajo.',
      payloadSchema: [],
    };
  }

  if (t?.mine && t.mine.status === 'claimed') {
    return {
      ...base,
      action: 'submit-patch',
      task: {
        id: t.mine.id,
        title: t.mine.title,
        claim: t.mine.claim,
        evidence: t.mine.evidence,
        files: t.mine.files,
        severity: t.mine.severity,
        attempts: t.mine.attempts,
      },
      filesContext: filesContext(room, t.mine.files),
      lastError: t.mine.lastError || null,
      claimIdleMs: claimIdleThresholdMs(room),
      message: 'Entrega el parche de tu tarea. Usa diff unificado para cambios quirúrgicos o files:[{path, content}] para reescribir un archivo completo (más fiable). El servidor lo aplica sobre la rama, otro agente lo revisa y solo se commitea si la verificación pasa. Si tardas más que claimIdleMs sin dar señales, la tarea vuelve al montón: pide turno o manda {kind:"progress", payload:{note:"en qué vas"}} para mantenerla. Tú NO decides cuándo acaba la sala: sigue pidiendo turno.',
      payloadSchema: {
        itemId: t.mine.id,
        summary: 'string — qué cambia y por qué (libre)',
        diff: 'opcional: "diff --git a/x b/x" / "--- a/x" / "+++ b/x" / "@@ …"',
        files: 'opcional: [{path:"ruta/en/el/repo", content:"archivo completo"}] — úsalo para archivos nuevos o reescrituras',
      },
    };
  }
  if (t?.open?.length) {
    const next = t.open[0];
    return {
      ...base,
      action: 'claim-item',
      openTasks: t.open,
      filesContext: filesContext(room, next.files),
      message: 'Toma una tarea libre (claim-item) y entrega su parche. Solo una tarea por agente a la vez; el árbol del repo es compartido.',
      payloadSchema: { itemId: `uno de: ${t.open.map(i => i.id).join(', ')}` },
    };
  }

  const pending = work.pending;
  // Con las manos libres y algo que mirar, el turno del trabajo no es una espera: es el juicio.
  if (canJudge) return judgeTurn({ message: 'Mientras el árbol está ocupado, esto sí puedes hacerlo.' });
  return {
    ...base,
    action: 'wait',
    message: pending
      ? `Sin trabajo libre ahora mismo: el parche ${pending.patchId} de la tarea ${pending.itemId} espera ${t?.reviewing ? 'tu revisión' : 'revisión o verificación'}. Vuelve a /turn en unos segundos.`
      : 'Sin tareas libres: el trabajo está en manos de otros agentes. Vuelve a /turn en unos segundos.',
    payloadSchema: ['{kind:"pass"}  → te retiras del trabajo del repo por lo que queda de sala (irreversible). Si solo estás esperando turno, vuelve a /turn.'],
  };
}

// El contenido de los archivos que toca la tarea, para no obligar a un viaje extra por
// HTTP antes de poder escribir el parche. Era 2 archivos × 200 líneas: en una tarea real
// eso dejaba al agente leyendo el resto por su cuenta a mitad de la faena.
function filesContext(room, files, { maxFiles = 4, lines = 400 } = {}) {
  const out = [];
  for (const f of (files || []).slice(0, maxFiles)) {
    const r = readRepoFile(room, f, { from: 1, lines });
    if (r?.kind === 'file') out.push({ path: r.path, text: r.text, totalLines: r.totalLines, truncated: r.truncated });
    // En un proyecto nuevo es normal que el archivo de la tarea no exista todavía: no es un
    // error de lectura, es que lo tienes que crear tú.
    else if (room.repo?.greenfield) out.push({ path: f, new: true, note: 'archivo nuevo: todavía no existe' });
    else out.push({ path: f, error: r?.error || 'no legible' });
  }
  return out.length ? out : null;
}

// Vista de depuración para agentes (a petición, no en el bucle normal).
export function agentState(room, agentId, since = 0) {
  const agent = room.agents[agentId];
  if (!agent) throw Object.assign(new Error('Agente desconocido'), { code: 'unknown_agent' });
  const entries = room.log.filter(l => l.id > since).slice(-200).map(l => ({
    id: l.id, ts: l.ts, by: l.agentId ? nameOf(room, l.agentId) : 'sistema', kind: l.kind, text: l.text,
  }));
  const blind = room.status === 'debate' && room.phase.name === 'proposal';
  return {
    room: room.code, title: room.title, task: room.task, context: room.context, criteria: room.criteria,
    status: room.status, phase: room.phase.name, macro: macroOf(room.phase.name),
    deadlineInSec: Math.max(0, Math.round(phaseMsLeft(room) / 1000)),
    language: room.settings.language, tone: room.settings.tone,
    agenda: agendaForTurn(room),        consensus: consensusReport(room).points.map(p => ({ id: p.id, label: p.label, status: p.status, share: p.share })),
        dissent: protectedDissentView(room),
    agents: rosterSummary(room),
    proposals: Object.values(room.artifacts.proposals)
      .filter(pr => !blind || pr.author === agentId)
      .map(pr => ({
        id: pr.id, title: pr.title, author: nameOf(room, pr.author), version: pr.v, gist: pr.gist,
        conceded: !!pr.conceded, positions: positionsOf(pr), approach: pr.approach || null,
      })),
    objections: room.artifacts.objections.map(o => ({ id: o.id, by: nameOf(room, o.by), severity: o.severity, text: o.text, addressed: !!o.addressed })),
    checks: room.artifacts.checks.length,
    log: entries,
    result: room.status === 'closed' ? room.result : undefined,
  };
}

// ---------------------------------------------------------------- vista humana
// ---------------------------------------------------------------- estado en vivo
// Radiografía de «qué está pasando ahora»: quién tiene turno, quién ya entregó y
// qué falta para que la fase cierre. Se calcula con las MISMAS reglas que cierran
// la fase, así que lo que se ve en la interfaz es el estado real del motor.

const LIVE_ACTION = {
  lobby: 'entrar al debate',
  frame: 'encuadre',
  contrast: 'revisión de los ejes',
  audit: 'hallazgos del repo',
  proposal: 'propuesta',
  critique: 'crítica asignada',
  revise: 'respuesta a la crítica',
  vote: 'voto secreto',
  tiebreak: 'alegato final',
  objection: 'veto',
  repair: 'reparación',
  synthesis: 'síntesis',
  verify: 'verificación',
  work: 'trabajo en el repo',
};

// A qué fase se pasa cuando los pendientes entreguen (solo tramos lineales).
const LIVE_NEXT = {
  frame: 'contraste de los ejes',
  contrast: 'planes de los agentes',
  audit: 'propuestas de cambio',
  proposal: 'crítica cruzada',
  critique: 'revisión de los autores',
  revise: 'votación secreta',
  repair: 'síntesis',
  synthesis: 'verificación independiente',
  verify: 'trabajo sobre el repo',
  work: 'resultado congelado y diff final',
};

// Una tarea reclamada y sin cerrar es trabajo en curso: la sala cuenta con ese agente hasta que
// su tarea vuelve al montón (`sweepClaims`, tras claimIdleMs sin señales) o se integra. Sin esta
// señal, quien estaba montando un parche de tres archivos aparecía «sin señal» en el panel
// mientras seguía trabajando en él.
function holdsLiveClaim(room, id) {
  const work = room.work;
  if (!work || work.finishedAt) return false;
  return (work.order || []).some(k => {
    const item = work.items?.[k];
    return item && item.claimant === id && !['integrated', 'failed', 'skipped'].includes(item.status);
  });
}

export function liveState(room) {
  const status = room.status;
  const phase = status === 'closed' ? 'closed' : room.phase.name;
  const d = room.phase?.data || {};
  const proposals = liveProposals(room);
  const authors = phase === 'revise' ? new Set(reviseAuthors(room)) : new Set();

  // Tarea pendiente de un agente en esta fase, o null si no le toca.
  const owing = (id) => {
    switch (phase) {
      case 'lobby':
        return canStart(room) ? 'arrancar o esperar' : null;
      case 'frame':
        return d.responses?.[id] ? null : LIVE_ACTION.frame;
      case 'contrast':
        return d.responses?.[id] ? null : LIVE_ACTION.contrast;
      case 'audit':
        return d.responses?.[id] ? null : LIVE_ACTION.audit;
      case 'proposal':
        return proposals.some(p => p.author === id) ? null : LIVE_ACTION.proposal;
      case 'critique': {
        const left = (d.assignments?.[id] || [])
          .filter(pid => proposals.some(p => p.id === pid))
          .filter(pid => !critiqueOf(room, id, pid));
        return left.length ? `${LIVE_ACTION.critique} (${left.length})` : null;
      }
      case 'revise':
        return authors.has(id) && !d.responses?.[id] ? LIVE_ACTION.revise : null;
      case 'vote':
      case 'tiebreak':
        return d.ballots?.[id] ? null : LIVE_ACTION[phase];
      case 'objection':
        return d.responses?.[id] ? null : LIVE_ACTION.objection;
      case 'repair':
        return d.winnerId && room.artifacts.proposals[d.winnerId]?.author === id && !d.responses?.[id]
          ? LIVE_ACTION.repair : null;
      case 'synthesis':
        return d.authorId === id && !d.responses?.[id] ? LIVE_ACTION.synthesis : null;
      case 'verify':
        return d.verifierId === id && !d.responses?.[id] ? LIVE_ACTION.verify : null;
      case 'review': {
        const agent = room.agents[id];
        if (!agent || agent.status === 'absent') return null;
        const pend = reviewAssignments(room, id).pendientes;
        return pend.length ? `revisar ${plural(pend.length, 'mejora')} integradas` : null;
      }
      case 'work': {
        const agent = room.agents[id];
        if (!agent || agent.status === 'absent' || agent.overBudget || agent.workOptOut) return null;
        const work = room.work;
        if (!work) return null;
        const mine = work.order.map(x => work.items[x]).find(i => i && i.claimant === id && !['integrated', 'failed', 'skipped'].includes(i.status));
        if (mine) return mine.status === 'claimed' ? `parche para ${mine.id}` : `esperando verificación de ${mine.id}`;
        const pending = work.pending ? work.patches[work.pending] : null;
        if (pending && !pending.review && pending.author !== id) return `revisión del parche ${pending.id}`;
        const free = work.order.map(x => work.items[x]).filter(i => i && i.status === 'open');
        return free.length ? `reclamar tarea (${free.length})` : null;
      }
      default:
        return null;
    }
  };

  // ¿Ya entregó? Misma señal que cierra la fase: propuesta presentada, voto emitido
  // o respuesta registrada. Si no, la interfaz diría que alguien no ha hecho nada
  // cuando el motor ya lo dio por entregado (o al revés).
  const forPhaseKind = (id) => {
    switch (phase) {
      case 'proposal': return proposals.some(p => p.author === id);
      case 'vote':
      case 'tiebreak': return !!d.ballots?.[id];
      // En el trabajo no hay «entrega de fase»: se muestra quién está trabajando
      // ahora y quién observa, sin fingir que todos deben entregar algo.
      case 'work': return false;
      case 'review': return Object.keys(d.review?.revisados?.[id] || {}).length > 0;
      default: return !!d.responses?.[id];
    }
  };

  const members = room.order.map(id => {
    const a = room.agents[id];
    const action = status === 'closed' ? null : owing(id);
    const done = phase !== 'lobby' && phase !== 'closed' && forPhaseKind(id) && !action;
    const voted = (phase === 'vote' || phase === 'tiebreak') && !!d.ballots?.[id];
    return {
      id,
      name: a.name,
      harness: a.harness || null,
      status: a.status,
      online: status !== 'closed' && a.status !== 'absent'
        && (now() - (a.lastSeenAt || 0) < offlineGraceMs(room, a)),
      lastSeenAt: a.lastSeenAt || 0,
      // 'pending' = le toca ahora · 'delivered' = ya entregó · 'free' = sin turno en esta fase
      state: action ? 'pending' : (done || voted) ? 'delivered' : 'free',
      action,
    };
  });

  const waiting = members.filter(m => m.state === 'pending' && m.status !== 'absent');
  const delivered = members.filter(m => m.state === 'delivered');
  const lastEvent = [...(room.log || [])].reverse().find(e => e.kind !== 'phase' && e.kind !== 'room') || null;

  return {
    status,
    phase,
    phaseLabel: PHASE_LABEL[phase] || phase,
    mechanism: PHASE_MECHANISM[phase] || null,
    next: LIVE_NEXT[phase] || null,
    deadlineInSec: status === 'closed' ? 0 : Math.max(0, Math.round(phaseMsLeft(room) / 1000)),
    // Cuántas veces se ha ampliado el plazo de esta fase porque alguien tenía el turno
    // entregado: el panel lo dice en vez de mostrar un reloj que se reinicia sin explicación.
    phaseExtensions: d.extensions || 0,
    // Cuántos tienen turno pendiente y cuántos ya entregaron en esta fase.
    pending: waiting.length,
    delivered: delivered.length,
    expected: waiting.length + delivered.length,
    who: waiting.map(m => ({ id: m.id, name: m.name, harness: m.harness, action: m.action, online: m.online })),
    members,
    lastEvent: lastEvent ? { id: lastEvent.id, kind: lastEvent.kind, text: lastEvent.text, by: lastEvent.agentId ? nameOf(room, lastEvent.agentId) : null, at: lastEvent.ts } : null,
    // Disenso protegido: qué puntos siguen disputados, quién los sostiene, cuánto se movió
    // la gente sin decir por qué y si las propuestas llegaron casi idénticas a la votación.
    dissent: protectedDissentView(room),
    // Atajo para el estado de lobby: cuántos faltan para arrancar.
    waitingFor: status === 'lobby' ? Math.max(0, room.settings.minAgents - activeAgents(room).length) : null,
  };
}

// Una frase por fase que explica el mecanismo (no lo que falta, sino POR QUÉ).
const PHASE_MECHANISM = {
  lobby: 'Los agentes entran y el debate arranca solo al reunir los mínimos.',
  frame: 'Encuadre: los agentes añaden puntos de decisión y negocian las reglas antes de proponer planes.',
  contrast: 'Contraste de ejes: con la agenda entera a la vista, se añade el eje que falta y se impugna el que sobra. El encuadre a ciegas ya no es definitivo.',
  proposal: 'Propuestas a ciegas: nadie ve las demás hasta que están todas, para que no se copien entre sí.',
  critique: 'Crítica asignada: cada propuesta recibe ataques de agentes que no la escribieron.',
  revise: 'Revisión: cada autor responde a las objeciones o retira su propuesta y respalda otra.',
  vote: 'Voto secreto por orden de preferencia; el recuento usa medianas, así que un voto raro no manda.',
  tiebreak: 'Empate: los finalistas argumentan y se vota otra vez.',
  objection: 'Ventana de veto: un fallo fatal (severity blocker) obliga a reparar el plan ganador.',
  audit: 'Auditoría del repo: cada agente lee el código y deja hallazgos anclados a archivos; las mejores mejoras se votan como cualquier otro punto.',
  repair: 'Reparación: el autor del plan ganador corrige los vetos o los rebate por escrito.',
  synthesis: 'Síntesis: el autor de la ganadora fusiona su plan con las objeciones válidas.',
  verify: 'Verificación adversarial: verifica quien menos apoyó al ganador y ataca primero los puntos que la síntesis cerró por autoridad.',
  work: 'Trabajo conjunto: cada mejora aprobada se convierte en una tarea que un agente reclama, otro revisa y el servidor verifica antes de commitear.',
  closed: 'Resultado congelado con checksum: es la versión exacta que vieron los agentes.',
};

// Impugnaciones del contraste tal como están AHORA: dentro de la fase viven en su almacén
// (`contrast.challenges`) y solo al cerrarla pasan al punto (`point.challenged`). Si el panel
// solo mirara el punto, el eje aparecería limpio justo mientras se está discutiendo.
function contrastChallenged(room, liveChallenges) {
  const fromStore = Object.entries(liveChallenges || {});
  if (fromStore.length) {
    return fromStore.map(([pointId, entries]) => ({
      id: pointId,
      label: room.agenda.find(p => p.id === pointId)?.label || pointId,
      by: entries.map(c => nameOf(room, c.by)),
      because: entries.map(c => c.because).filter(Boolean),
      mergeInto: [...new Set(entries.map(c => c.mergeInto).filter(Boolean))],
    }));
  }
  return room.agenda.filter(p => p.challenged?.length).map(p => ({
    id: p.id, label: p.label,
    by: p.challenged.map(c => c.byName || nameOf(room, c.by)),
    because: p.challenged.map(c => c.because).filter(Boolean),
    mergeInto: [...new Set(p.challenged.map(c => c.mergeInto).filter(Boolean))],
  }));
}

// Qué se lleva el humano de esta sala: código (repo ajeno o proyecto nuevo) o un plan, y por qué.
// Lo dice el panel desde el primer turno, no solo el informe final.
export function deliveryOf(room) {
  const planOnly = !!room.settings?.planOnly;
  return {
    kind: planOnly || !room.repo ? 'plan' : 'code',
    reason: planOnly ? 'solo-planificacion' : room.repo?.greenfield ? 'proyecto-nuevo' : room.repo ? 'repo' : 'sin-proyecto',
    planOnly: !!room.settings?.planOnly,
    branch: room.repo?.branch || null,
    warning: room.artifacts?.deliveryWarning || null,
  };
}

export function publicRoom(room) {
  const closed = room.status === 'closed';
  const report = consensusReport(room);
  const phase = closed ? 'closed' : room.phase.name;
  const liveChallenges = room.artifacts.contrast?.challenges || {};
  // Fase ciega mientras la sala está en propuestas: es el único momento del protocolo en el que
  // ver el plan ajeno es hacer trampa (la crítica ya se reparte como advocatus diaboli).
  const blind = room.status === 'debate' && phase === 'proposal';
  return {
    storage: room.__storageFailure ? { saved: false, failedAt: room.__storageFailure.at } : { saved: !room.__changed, failedAt: null },
    health: workflowHealth(room),
    code: room.code,
    title: room.title,
    createdAt: room.createdAt,
    closedAt: room.result?.closedAt || null,
    task: room.task,
    context: room.context,
    criteria: room.criteria,
    template: room.template,
    tournament: room.tournament,
    status: room.status,
    phase,
    phaseLabel: PHASE_LABEL[phase] || phase,
    macro: macroOf(phase),
    deadlineInSec: closed ? 0 : Math.max(0, Math.round(phaseMsLeft(room) / 1000)),
    live: liveState(room),
    phaseAgreement: agreementState(room),
    rules: {
      phaseAdvanceMode: room.settings.phaseAdvanceMode || 'timed',
      language: room.settings.language,
      tone: room.settings.tone,
      minAgents: room.settings.minAgents,
      expectedAgents: room.settings.expectedAgents,
      consensusThreshold: room.settings.consensusThreshold,
      requireDiversity: room.settings.requireDiversity,
      tokenBudgetPerAgent: room.settings.tokenBudgetPerAgent,
      phaseMs: room.settings.phaseMs,
      maxDurationMs: room.settings.maxDurationMs,
      extraordinary: !!room.settings.extraordinary,
    },
    roster: rosterSummary(room),
    vacancies: vacanciesForUI(room),
    agenda: report.points.map(p => ({
      id: p.id, label: p.label, status: p.status, share: p.share, weight: p.weight,
      source: p.source, voters: p.voters, abstain: p.abstain,
      // Un eje impugnado en el contraste sigue contando, pero quien lo mira tiene derecho a
      // saber que se discute su existencia y de dónde salió si nació de una fusión. Durante el
      // contraste la impugnación vive en su almacén (aún no está resuelta), así que se mira ahí
      // también: si no, el eje aparecería limpio justo mientras se está discutiendo.
      contested: !!p.contested || !!liveChallenges[p.id],
      challenged: p.challenged?.length
        ? p.challenged
        : (liveChallenges[p.id] || []).map(c => ({ by: nameOf(room, c.by), because: c.because || '', mergeInto: c.mergeInto || null })),
      mergedFrom: p.mergedFrom || [],
      modal: p.modal ? { id: p.modal.id, label: p.modal.label, count: p.modal.count, agents: p.modal.agents.map(a => nameOf(room, a)) } : null,
      choices: p.choices.map(c => ({ id: c.id, label: c.label, count: c.count, share: c.share, agents: c.agents.map(a => nameOf(room, a)) })),
      options: p.options,
    })),
    // Contraste de ejes, en vivo: qué se impugnó, qué se fusionó y quién lo pidió. Es la
    // vuelta que existe porque el encuadre a ciegas no puede cubrirlo todo.
    contrast: {
      open: phase === 'contrast',
      challenged: contrastChallenged(room, liveChallenges),
      merged: (room.artifacts.contrast?.applied || []).map(m => ({
        from: m.fromLabel, into: m.intoLabel,
        by: m.byName || (m.by || []).map(id => nameOf(room, id)),
      })),
    },
    dissent: protectedDissentView(room, report),
    consensus: {
      global: report.global, method: report.method, threshold: report.threshold,
      agreed: report.agreed, discussing: report.discussing, open: report.open, pending: report.pending, total: report.total,
      stanceSource: report.stanceSource,
      // Consenso por etapa (lo cerrado, congelado; la etapa en curso, en vivo) junto al
      // global: un único número no dice si la sala se acercó o se atrincheró.
      stages: stageConsensus(room, macroOf(phase)),
    },
    // Fase ciega: hasta que se revelan, los planes ajenos no salen por la vista pública.
    // El turno del agente ya los filtraba; `publicRoom` no, y es lo que sirve /public y el SSE
    // SIN token: cualquiera podía leer los planes de todos durante la única fase donde el
    // protocolo exige que nadie los vea. El autor sigue viendo el suyo en su turno.
    blind,
    proposals: Object.values(room.artifacts.proposals).map(p => ({
      id: p.id, title: p.title, authorName: nameOf(room, p.author), authorId: p.author,
      version: p.v, gist: p.gist,
      // Ronda en la que se presentó: con mejora recursiva hay propuestas de varias rondas y el
      // panel distingue la viva de las ya decididas.
      round: p.round || 1,
      plan: blind ? '' : p.plan, risks: blind ? '' : p.risks, assumptions: blind ? '' : p.assumptions,
      premortem: blind ? '' : p.premortem, approach: blind ? '' : p.approach,
      revisionNote: blind ? null : (p.revisionNote || null),
      positions: blind ? [] : positionsOf(p), positionNotes: blind ? {} : notesOf(p),
      conceded: !!p.conceded, concedeReason: p.concedeReason || null,
      history: (p.history || []).length,
      endorsements: (room.artifacts.endorsements?.[p.id] || []).map(id => nameOf(room, id)),
      createdAt: p.createdAt,
    })),
    critiques: Object.values(room.artifacts.critiques).map(c => ({
      id: c.id, authorName: nameOf(room, c.author), authorId: c.author,
      target: c.target, targetTitle: room.artifacts.proposals[c.target]?.title || c.target,
      steelman: c.steelman, objections: c.objections, improvements: c.improvements || [],
    })),
    objections: room.artifacts.objections.map(o => ({
      id: o.id, byName: nameOf(room, o.by), severity: o.severity, text: o.text, addressed: !!o.addressed,
    })),
    checks: room.artifacts.checks.map(c => ({
      id: c.id, byName: nameOf(room, c.by), claim: c.claim, method: c.method,
      expectation: c.expectation, pointId: c.pointId, verdict: c.verdict,
    })),
    verification: room.artifacts.verification
      ? { byName: nameOf(room, room.artifacts.verification.by), ...room.artifacts.verification }
      : null,
    ruleProposals: (room.artifacts.ruleProposals || []).map(r => ({
      id: r.id, byName: nameOf(room, r.by), text: r.text, op: r.op,
      ratifications: (r.ratifications || []).map(id => nameOf(room, id)),
      rejectedBy: (r.rejectedBy || []).map(id => nameOf(room, id)),
      applied: !!r.applied,
    })),
    tiebreakArgs: (room.phase?.data?.args || []).map(x => ({
      byName: nameOf(room, x.by), target: x.target,
      targetTitle: room.artifacts.proposals[x.target]?.title, text: x.text,
    })),
    ballots: closed && room.lastBallots
      ? Object.fromEntries(Object.entries(room.lastBallots).map(([aid, r]) => [
        nameOf(room, aid), r.map(id => room.artifacts.proposals[id]?.title || id)]))
      : undefined,
    repo: repoSummary(room),
    // Qué entrega esta sala: código (repo ajeno o proyecto nuevo) o solo un plan. El panel lo
    // dice en vez de dejar que el humano adivine por qué no hay archivos.
    delivery: deliveryOf(room),
    // Mejora recursiva, en vivo: en qué ronda va la sala y por qué paró (si paró).
    rounds: room.rounds || 1,
    recursion: {
      rounds: room.rounds || 1,
      cap: recursionRounds(room),
      history: room.roundHistory || [],
      stop: room.artifacts.recursionStop || null,
    },
    findings: room.artifacts.findings.slice(-40).map(f => ({
      id: f.id, byName: nameOf(room, f.by), severity: f.severity, file: f.file, line: f.line,
      symbol: f.symbol, claim: f.claim, evidence: gist(f.evidence, 300), action: f.action,
      pointId: f.pointId || null,
    })),
    work: workSummary(room),
    cost: closed || room.artifacts.ledger.length > 20 ? costSnapshot(room) : undefined,
    // La cola del log va acotada en cada evento SSE (el coste no crece con la actividad) y la
    // cabeza se publica aparte: quien sigue la sala puede pedir deltas desde `logSeq` (`/state`
    // y el turno ya lo aceptan con `since`) en vez de volver a bajarse el historial.
    logSeq: room.logSeq,
    log: room.log.slice(-250).map(l => ({
      id: l.id, ts: l.ts, by: l.agentId ? nameOf(room, l.agentId) : 'sistema',
      agentId: l.agentId, kind: l.kind, text: l.text,
    })),
    result: closed ? room.result : undefined,
  };
}

function costSnapshot(room) {
  const perAgent = room.order.map(id => {
    const a = room.agents[id] || {};
    const est = Math.round(((a.servedChars || 0) + (a.sentChars || 0)) / 3.5);
    // El harness y el modelo viajan hasta aquí: sin ellos el panel enseñaba «harness sin declarar»
    // justo debajo de la lista de agentes que sí lo declara, y el coste quedaba huérfano de quien
    // lo paga.
    return {
      id, name: a.name, harness: a.harness || null, model: a.model || null,
      role: a.role || null, estTokens: est, servedChars: a.servedChars || 0, sentChars: a.sentChars || 0,
    };
  });
  const total = perAgent.reduce((s, a) => s + a.estTokens, 0);
  return { perAgent, total, avgPerAgent: perAgent.length ? Math.round(total / perAgent.length) : 0 };
}
