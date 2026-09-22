// AGORA v2 — máquina de estados del debate. Todo el «orden» vive aquí:
// entrada y salida de fase, atajos por dominancia o consenso, plazos y ausencias.
//
// Nada de esto necesita un LLM moderador: son reglas deterministas.

import { now, plural, uid } from './util.mjs';
import { usesAgreement, agreementOpen, allReady } from './agreement.mjs';
import { recoverWorkParticipants, workflowHealth } from './recovery.mjs';
import { log, activeAgents, nameOf, proposalOf, critiqueOf } from './state.mjs';
import { assignCritiques, assignVerifier, synthesisAuthor, markAbsent, applyBudget } from './roster.mjs';
import {
  ratifyRuleProposals, consensusReport, unresolvedPoints, recordStageConsensus,
  dissentReport, proposalSimilarity, resolveContrast,
} from './agenda.mjs';
import { macroOf, turnHoldMs, recursionRounds } from './settings.mjs';
import { rankOptions, decideTop } from './tally.mjs';
import { finishRoom, closeRoom } from './result.mjs';
import {
  closeAudit, startWork, maybeFinishWork, closeWork, approvedImprovements, sweepClaims,
  reviewIsCovered, reviewState, improvementsFromReview, addReviewItems, workBusyReason,
  ensureWorkItems, workFrom, reconcileWork,
} from './work.mjs';

// 0 is the legacy wire-format sentinel; phaseAdvanceMode tells clients there is no clock.
export function phaseMsLeft(room) { return agreementOpen(room) ? 0 : room.phase.deadline - now(); }

// ¿Hay código que AUDITAR? Un repo con historia, sí. Un proyecto nuevo nace vacío: en la ronda 1
// no hay nada que leer —se debate y se implementa el plan— y a partir de la ronda 2 el código ya
// existe (lo acaban de escribir los agentes) y la auditoría vuelve a tener sentido. Sin repo y sin
// proyecto no hay dónde trabajar: es una sala de solo planificación (así lo pidió el humano).
export function auditOrProposal(room) {
  // Solo planificación manda sobre todo lo demás: la sala no toca ningún código, ni el suyo ni
  // el de nadie. Es la única configuración en la que una sala no entrega archivos.
  if (room.settings?.planOnly) return 'proposal';
  if (!room.repo) return 'proposal';
  if (room.repo.greenfield && (room.rounds || 1) === 1) return 'proposal';
  return 'audit';
}

// Propuestas VIVAS: las de la ronda abierta. Las de rondas anteriores ya se decidieron (y su
// trabajo está integrado o aplazado), así que no vuelven a la votación: la mejora recursiva
// empieza cada ronda con propuestas nuevas sobre el código que la ronda anterior dejó.
export function liveProposals(room) {
  const ronda = room.rounds || 1;
  return Object.values(room.artifacts.proposals)
    .filter(p => !p.conceded && (p.round || 1) === ronda);
}

export function canStart(room) {
  return room.status === 'lobby' && activeAgents(room).length >= room.settings.minAgents;
}

export function startRoom(room, byAgentId = null) {
  if (room.status !== 'lobby') return false;
  if (!canStart(room)) throw Object.assign(
    new Error(`Se requieren al menos ${room.settings.minAgents} agentes`), { code: 'too_few' });
  room.status = 'debate';
  log(room, byAgentId, 'phase',
    `¡Comienza el debate! ${activeAgents(room).length} participantes` +
    `${room.agenda.length ? `, agenda de ${plural(room.agenda.length, 'punto')}` : ''}.`);
  enterPhase(room, 'frame');
  return true;
}

export function maybeAutoStart(room) {
  if (room.status !== 'lobby' || !canStart(room)) return false;
  const s = room.settings;
  const n = activeAgents(room).length;
  if (s.startAsSoonAsReady) return startRoom(room, null);
  if (s.expectedAgents > 0 && n >= s.expectedAgents) return startRoom(room, null);
  const joins = room.order.map(id => room.agents[id]?.joinedAt || 0);
  const lastJoin = joins.length ? Math.max(...joins) : 0;
  if (now() - lastJoin >= s.joinQuietMs) return startRoom(room, null);
  return false;
}

// ---------------------------------------------------------------- entrada de fase
export function enterPhase(room, name, extraData = {}) {
  const t = now();
  // Cerrar una macro-etapa deja una foto del consenso (antes de mover la fase, para
  // saber en cuál se cerró): el panel puede contar cómo evolucionó, no solo dónde está.
  const macroBefore = macroOf(room.phase?.name || 'lobby');
  if (macroBefore !== macroOf(name)) recordStageConsensus(room, macroBefore, room.phase?.name || null);
  room.phase = {
    name,
    instanceId: uid('phase'),
    startedAt: t,
    deadline: t + (room.settings.phaseMs[name] || 5 * 60_000),
    data: { ...extraData },
  };
  const d = room.phase.data;
  const active = activeAgents(room);

  switch (name) {
    case 'frame':
      d.responses = {};
      log(room, null, 'phase',
        'Fase de encuadre: podéis proponer puntos de decisión, sugerir cambios de reglas y ratificar los ajenos. Lo ratificado por mayoría se aplica.');
      // El contrato de entrega se dice desde el primer turno: qué se lleva la sala al final. Un
      // proyecto nuevo no tiene código previo, así que nadie espere (ni deje de) escribir archivos.
      if (room.settings.planOnly) {
        log(room, null, 'phase',
          'Solo planificación (así está configurada la sala): el resultado es un plan y no se escribe código.');
      } else if (room.repo?.greenfield) {
        log(room, null, 'phase',
          'Esta sala entrega CÓDIGO: no había repo, así que tiene un proyecto nuevo vacío con git. ' +
          'El plan que ganen se convierte en tareas y los agentes escriben los archivos (rama ' +
          `${room.repo.branch}). El encuadre decide QUÉ hay que construir; el trabajo lo construye.`);
      } else if (!room.repo) {
        log(room, null, 'phase',
          `Sin proyecto donde escribir: ${room.artifacts.deliveryWarning || 'no se pudo preparar el proyecto'}. El resultado será un plan.`);
      }
      break;
    case 'contrast':
      d.responses = {};
      // Cuándo empezó el contraste: es lo que después permite decir en el informe qué ejes no
      // entraron en el encuadre (a ciegas) y tuvieron que entrar aquí, con la agenda a la vista.
      room.artifacts.contrast = { ...(room.artifacts.contrast || {}), startedAt: t };
      log(room, null, 'phase',
        'Contraste de ejes: la agenda ya está a la vista, así que aquí nadie ancla a nadie. Añade con point-proposal el eje que falte, impugna con point-challenge el que sobre (di por qué y, si es el mismo tema que otro, propón mergeInto), o pasa. Nada se borra por mayoría: lo impugnado queda abierto y visible.');
      break;
    case 'audit':
      d.responses = {};
      log(room, null, 'phase',
        `Auditoría del repo ${room.repo?.source || ''}: cada agente lee el código y presenta hallazgos anclados a archivos (qué está mal, con qué evidencia y qué mejora concreta). Las mejores se convierten en puntos de agenda y las decide el debate.`);
      // Ronda de mejora recursiva: el repo ya trae los parches de las rondas anteriores. Se dice
      // para que la auditoría busque lo siguiente y no vuelva a reportar lo ya mejorado.
      if ((room.rounds || 1) > 1) {
        const integradas = room.work ? room.work.order.filter(id => room.work.items[id]?.status === 'integrated').length : 0;
        log(room, null, 'phase',
          `Ronda ${room.rounds} de mejora recursiva: el código que vas a leer ya incluye ${plural(integradas, 'mejora')} de rondas anteriores (head ${String(room.repo?.head || '').slice(0, 8)}). ` +
          `Busca lo que AÚN se puede mejorar; lo ya integrado no se vuelve a proponer. Una auditoría sin hallazgos cierra la sala: eso es «no hay más» dicho por vosotros.`);
      }
      break;
    case 'proposal':
      d.responses = {};
      log(room, null, 'phase', 'Propuestas a ciegas: cada agente presenta su plan sin ver los demás.' +
        (room.agenda.length ? ' Incluye tu elección en cada punto de la agenda.' : ''));
      break;
    case 'critique':
      d.assignments = assignCritiques(room);
      d.responses = {};
      log(room, null, 'phase', `Crítica asignada: ${plural(Object.keys(d.assignments).length, 'atacante')} repartidos (advocatus diaboli).`);
      break;
    case 'revise':
      d.responses = {};
      log(room, null, 'phase', 'Revisión: los autores responden a las objeciones, o retiran su propuesta.');
      break;
    case 'vote': {
      d.options = liveProposals(room).map(p => p.id);
      d.ballots = {};
      log(room, null, 'phase', `Votación secreta: ordena las ${plural(d.options.length, 'propuesta')} de mejor a peor.`);
      // Aviso de diversidad: si las propuestas que llegan a la votación son casi la misma
      // idea con otras palabras, hay que decirlo AHORA (no en el acta): la votación decide
      // matices, no direcciones. Se fotografía el momento para que el informe no lo maquille
      // con posiciones posteriores.
      const sim = proposalSimilarity(room);
      room.artifacts.similaritySnapshot = { at: t, ...sim };
      if (sim.collapsed) {
        log(room, null, 'vote',
          `Aviso de diversidad: «${sim.closest.aTitle}» y «${sim.closest.bTitle}» coinciden en el ` +
          `${Math.round(sim.closest.similarity * 100)}% de las decisiones de agenda. ` +
          `La votación decidirá matices, no direcciones.`);
      }
      break;
    }
    case 'tiebreak':
      d.args = [];
      d.ballots = {};
      log(room, null, 'phase', `Empate entre ${(d.finalists || []).length} finalistas: alegatos y segunda votación.`);
      break;
    case 'objection': {
      d.responses = {};
      d.after = 'synthesis';
      log(room, null, 'phase', 'Ventana de veto: ¿la ganadora tiene un fallo fatal? severity:"blocker" fuerza reparación.');
      // Quien quedó en minoría tiene aquí su momento: se le dice qué puntos siguen
      // disputados y contra qué mayoría, para que el desacuerdo no se disuelva solo.
      const dis = dissentReport(room, null, id => nameOf(room, id));
      if (dis.measured && dis.count) {
        const peor = [...dis.contested].sort((a, b) => a.share - b.share)[0];
        const alt = peor.minority[0];
        log(room, null, 'phase',
          `${dis.count === 1 ? '1 punto de agenda sigue' : `${dis.count} puntos de agenda siguen`} con minoría real ` +
          `(${Math.round((dis.contestedShare || 0) * 100)}% de los puntos votados). ` +
          `El más disputado: «${peor.label}», donde ${alt.by.join(', ')} sostiene «${alt.label}» frente a «${peor.majority?.label || '—'}». ` +
          `Si la ganadora resuelve ese punto en contra, dilo aquí: el disenso queda en el resultado.`);
      }
      break;
    }
    case 'repair':
      d.responses = {};
      log(room, null, 'phase', d.after === 'close'
        ? 'Reparación tras la verificación: el autor aborda los hallazgos; después la sala pasa a trabajar lo aprobado (o cierra si no hay nada que ejecutar).'
        : 'Reparación: el autor responde a los vetos (revisión o defensa por escrito).');
      break;
    case 'synthesis': {
      d.responses = {};
      log(room, null, 'phase', 'Síntesis: el autor de la ganadora fusiona su plan con las objeciones válidas y resuelve cada punto abierto.');
      const dis = dissentReport(room, null, id => nameOf(room, id));
      if (dis.measured && dis.count) {
        log(room, null, 'phase',
          `${dis.count === 1 ? '1 punto llega' : `${dis.count} puntos llegan`} a la síntesis con minoría real. Cada resolución declara su base: ` +
          `"evidence" (con evidence), "adopted-dissent" si adoptas la alternativa minoritaria, o "authority". ` +
          `Lo resuelto por autoridad sin evidencia nueva se publica como tal, con los nombres de quien sostenía la otra opción.`);
      }
      break;
    }
    case 'work': {
      d.responses = {};
      // Volver de la revisión NO es empezar de cero: el plan de trabajo ya existe y tiene
      // tareas integradas e historial. Reconstruirlo duplicaba las tareas ya hechas y dejaba
      // a las nuevas (las que trajo la revisión) sin ejecutar nunca.
      if (room.work) {
        // En una ronda de mejora recursiva esta vuelta al trabajo trae mejoras aprobadas por la
        // auditoría nueva: se AÑADEN a la cola existente, con el mismo formato de tarea. Con la
        // cola ya construida, sólo queda lo que aún no tiene tarea (por eso la ronda 1 usa
        // startWork y las siguientes esto).
        const anadidas = ensureWorkItems(room);
        const nuevas = room.work.order.filter(id => {
          const it = room.work.items[id];
          return it && !['integrated', 'reverted', 'failed', 'skipped'].includes(it.status);
        });
        log(room, null, 'phase',
          anadidas.length
            ? `Vuelta al trabajo con ${plural(nuevas.length, 'mejora')} pendientes: ${anadidas.length} nacidas de la ronda ${room.rounds || 1} de auditoría. El resto de la rama ${room.work.branch} sigue como estaba.`
            : `Vuelta al trabajo con ${plural(nuevas.length, 'mejora')} nuevas de la revisión; el resto de la rama ${room.work.branch} sigue como estaba.`);
        break;
      }
      const work = startWork(room, d.winnerId);
      if (work.order.length) {
        log(room, null, 'phase',
          (room.repo?.greenfield
            ? `Trabajo conjunto en el proyecto nuevo (rama ${work.branch}): ${plural(work.order.length, 'parte')} del plan ganador convertidas en tareas. `
            : `Trabajo conjunto sobre la rama ${work.branch}: ${plural(work.order.length, 'mejora')} aprobadas por el debate. `) +
          `Cada tarea la reclama un agente, la revisa otro y el servidor verifica «${room.repo?.verify?.command || 'sin comando declarado'}» antes de commitear.`);
      } else if (room.repo?.greenfield) {
        log(room, null, 'phase',
          'El debate no dejó ninguna decisión implementable: no se puede escribir código de un plan vacío. ' +
          'La sala cierra con el plan tal como salió (ni un archivo más que decir que no se pudo construir).');
      }
      break;
    }
    case 'review': {
      // Revisión posterior al trabajo: cada mejora integrada recibe un veredicto de otro
      // agente. Con «trabajo extraordinario» lo que aún se pueda mejorar vuelve a la cola.
      d.review = { revisados: {}, round: (d.round || 0) + 1, startedAt: now() };
      const integradas = room.work ? room.work.order.filter(id => room.work.items[id]?.status === 'integrated').length : 0;
      const autores = new Set(room.work ? room.work.order.map(id => room.work.items[id]?.claimant).filter(Boolean) : []);
      d.review.soloAutor = autores.size >= activeAgents(room).length;
      log(room, null, 'phase',
        `Revisión posterior del trabajo (ronda ${d.review.round}): ${plural(integradas, 'mejora')} integradas por revisar. ` +
        (room.settings.extraordinary
          ? 'La sala exige trabajo extraordinario: lo que aún se pueda mejorar vuelve a la cola.'
          : 'Se revisa el conjunto; lo que quede pendiente se registra en el resultado.'));
      break;
    }
    case 'verify': {
      d.responses = {};
      const winner = room.artifacts.proposals[d.winnerId];
      const { verifierId, selfVerified } = assignVerifier(room, winner);
      d.verifierId = verifierId;
      d.selfVerified = selfVerified;
      log(room, null, 'phase', verifierId
        ? `Verificación a cargo de ${nameOf(room, verifierId)}${selfVerified ? ' (mismo harness o autor: no hay otro harness independiente disponible)' : ' (harness independiente cuando se conoce su identidad)'}.`
        : 'Verificación omitida: no hay agentes disponibles.');
      break;
    }
    default:
      break;
  }
  room.__changed = true;
  return room.phase;
}

// ---------------------------------------------------------------- avance
// Read-only readiness gate. Ask for confirmation once the required contributions exist,
// not after every small contribution (which would multiply unnecessary harness turns).
export function phaseInputsComplete(room) {
  const p = room.phase;
  const active = activeAgents(room);
  if (!active.length) return false;
  if (p.data.pendingTransition) return true;
  const responded = ids => ids.every(id => p.data.responses?.[id]);
  switch (p.name) {
    case 'frame': case 'contrast': case 'audit': case 'objection': return responded(active);
    case 'proposal': return active.every(id => liveProposals(room).some(pr => pr.author === id));
    case 'critique': return active.every(id => (p.data.assignments?.[id] || [])
      .filter(pid => liveProposals(room).some(pr => pr.id === pid)).every(pid => critiqueOf(room, id, pid)));
    case 'revise': return responded(reviseAuthors(room));
    case 'vote': case 'tiebreak': return active.every(id => p.data.ballots?.[id]);
    case 'repair': { const author = room.artifacts.proposals[p.data.winnerId]?.author; return !author || responded([author]); }
    case 'verify': return !p.data.verifierId || responded([p.data.verifierId]);
    case 'work': return maybeFinishWork(room);
    case 'review': return reviewIsCovered(room);
    default: return false;
  }
}
// Ejecuta como mucho una transición y devuelve true si la hizo. El bucle de
// maybeAdvance encadena las fases que se cierran solas (p. ej. sin asignaciones).
function advanceOnce(room) {
  if (room.status === 'closed') return false;
  if (!allReady(room)) return false;
  const p = room.phase;
  const active = activeAgents(room);

  if (p.data.pendingTransition) {
    const next = p.data.pendingTransition;
    delete p.data.pendingTransition;
    if (next.name === 'verify') proceedToVerify(room, next.winnerId);
    else if (next.name === 'work') proceedToWork(room, next.winnerId);
    else enterPhase(room, next.name, next.data);
    return true;
  }

  switch (p.name) {
    case 'frame': {
      const done = active.length > 0 && active.every(id => p.data.responses?.[id]);
      if (!done) return false;
      const applied = ratifyRuleProposals(room, active.map(id => id));
      const pointsCreated = (p.data.pointsCreated || 0);
      const logLine = `Encuadre cerrado (a ciegas: cada agente propuso sin ver los puntos de los demás): ${plural(pointsCreated, 'punto')} añadidos por los agentes, ` +
        `${plural(applied.length, 'cambio')} de reglas ratificados${applied.length ? ` (${applied.map(a => a.text).join('; ')})` : ''}.`;
      for (const a of applied) a.appliedOp = a.op;
      log(room, null, 'phase', logLine);
      afterFrame(room);
      return true;
    }
    case 'contrast': {
      const done = active.length > 0 && active.every(id => p.data.responses?.[id]);
      if (!done) return false;
      const res = closeContrast(room);
      log(room, null, 'phase', contrastSummary(res));
      enterPhase(room, auditOrProposal(room));
      return true;
    }
    case 'audit': {
      const done = active.length > 0 && active.every(id => p.data.responses?.[id]);
      if (!done) return false;
      const res = closeAudit(room);
      // Mejora recursiva: una auditoría de ronda ≥2 que no encuentra NADA es la declaración
      // conjunta de fin — los agentes miraron el código con sus propios parches dentro y ninguno
      // vio nada más que mejorar. Eso es «no hay más», dicho por la sala y no por un tope. No se
      // sigue a propuestas: no hay nada que proponer sobre una auditoría vacía.
      if (!res.findings && (room.rounds || 1) > 1) {
        const ronda = room.rounds;
        room.artifacts.recursionStop = {
          round: ronda, cap: recursionRounds(room), integrated: 0,
          reason: 'auditoria-sin-hallazgos', agents: active.length, head: room.repo?.head || null,
        };
        room.roundHistory.push({ round: ronda, integrated: 0, findings: 0, head: room.repo?.head || null, at: now(), next: false });
        log(room, null, 'phase',
          `Ronda ${ronda} sin hallazgos: ${plural(active.length, 'agente')} volvió a leer el código ya mejorado y ninguno encontró nada más que mejorar. ` +
          `La sala da por alcanzada esta versión y cierra.`);
        finishRoom(room, room.lastWinnerId || null);
        return true;
      }
      log(room, null, 'phase',
        res.findings
          ? `Auditoría cerrada: ${plural(res.findings, 'hallazgo')} de ${plural(active.length, 'agente')} → ${plural(res.groups, 'mejora')} distintas, ` +
            `${res.accepted} pasan a la agenda${res.deferred ? ` y ${res.deferred} quedan fuera por espacio (registradas en el resultado)` : ''}.`
          : 'Auditoría cerrada sin hallazgos: no hay mejoras que debatir.');
      enterPhase(room, 'proposal');
      return true;
    }
    case 'proposal': {
      const submitted = active.filter(id => liveProposals(room).some(pr => pr.author === id));
      if (active.length && submitted.length >= active.length) {
        log(room, null, 'phase', `Propuestas reveladas: ${liveProposals(room).length}. Pasan a revisión cruzada.`);
        enterPhase(room, 'critique');
        return true;
      }
      return false;
    }
    case 'critique': {
      const live = liveProposals(room);
      const assigns = p.data.assignments || {};
      const pending = active.filter(id => (assigns[id] || [])
        .filter(pid => live.some(pr => pr.id === pid))
        .some(pid => !critiqueOf(room, id, pid)));
      if (!pending.length) {
        if (!live.length) { closeRoom(room, 'failed', 'Todas las propuestas fueron retiradas.'); return true; }
        enterPhase(room, 'revise');
        return true;
      }
      return false;
    }
    case 'revise': {
      const authors = reviseAuthors(room);
      if (!authors.length) { proceedToVote(room); return true; }
      if (authors.every(id => p.data.responses?.[id])) { proceedToVote(room); return true; }
      return false;
    }
    case 'vote': {
      if (active.length && active.every(id => p.data.ballots?.[id])) { tallyAndAdvance(room, false); return true; }
      return false;
    }
    case 'tiebreak': {
      if (active.length && active.every(id => p.data.ballots?.[id])) { tallyAndAdvance(room, true); return true; }
      return false;
    }
    case 'objection': {
      if (active.length && active.every(id => p.data.responses?.[id])) { afterObjections(room); return true; }
      return false;
    }
    case 'repair': {
      const winner = room.artifacts.proposals[p.data.winnerId];
      const author = winner?.author;
      if (!author) { afterRepair(room); return true; }
      if (p.data.responses?.[author]) { afterRepair(room); return true; }
      return false;
    }
    case 'synthesis': {
      // La síntesis la provoca el propio movimiento (submit-synthesis).
      return false;
    }
    case 'verify': {
      const verifier = p.data.verifierId;
      if (!verifier || p.data.responses?.[verifier]) { proceedToWork(room, p.data.winnerId); return true; }
      return false;
    }
    case 'work': {
      if (maybeFinishWork(room)) {
        closeWork(room, 'todas las tareas cerradas');
        proceedToReview(room, p.data.winnerId);
        return true;
      }
      return false;
    }
    case 'review': {
      if (reviewIsCovered(room)) { closeReviewPhase(room); return true; }
      return false;
    }
    default:
      return false;
  }
}

export function maybeAdvance(room) {
  if (room.status === 'closed') return false;
  let guard = 0;
  while (guard++ < 25 && room.status !== 'closed') {
    if (!advanceOnce(room)) break;
  }
  return true;
}

// El encuadre no cierra la agenda para siempre: si dejó ejes, pasa por el contraste, que es la
// vuelta corta donde se añade el eje que falta y se impugna el que sobra con la agenda entera a
// la vista. Si no hay ningún eje, no hay nada que contrastar y se sigue como siempre.
function afterFrame(room) {
  if (room.agenda.length) { enterPhase(room, 'contrast'); return; }
  enterPhase(room, auditOrProposal(room));
}

// Cierra el contraste: aplica las fusiones acordadas por mayoría y deja constancia de los ejes
// que quedan impugnados. Nada se borra por mayoría: lo impugnado sigue en la agenda, a la vista.
function closeContrast(room) {
  return resolveContrast(room, {
    activeCount: activeAgents(room).length,
    nameOf: id => nameOf(room, id),
  });
}

function contrastSummary({ applied = [], kept = [] } = {}) {
  const partes = [];
  if (applied.length) {
    partes.push(`${plural(applied.length, 'fusión', 'fusiones')} de ejes acordadas: ` +
      applied.map(m => `«${m.fromLabel}» → «${m.intoLabel}»`).join(', '));
  }
  if (kept.length) {
    partes.push(`${plural(kept.length, 'eje')} queda${kept.length === 1 ? '' : 'n'} impugnado${kept.length === 1 ? '' : 's'} ` +
      `sin apoyo suficiente para fusionar${kept.length === 1 ? 'lo' : 'los'}: ${kept.map(k => `«${k.label}» (${k.byName.join(', ')})`).join(', ')}`);
  }
  return `Contraste de ejes cerrado: ${partes.length ? partes.join('. ') + '.' : 'nadie añadió ni impugnó ningún eje.'}`;
}

// Quiénes tienen que responder a una crítica seria (lo usa la vista en vivo).
export function reviseAuthors(room) {
  const serious = Object.values(room.artifacts.critiques)
    .filter(c => (c.improvements || []).length > 0 || (c.objections || []).some(o => o.severity !== 'low'));
  const authors = new Set(
    serious.map(c => room.artifacts.proposals[c.target]?.author).filter(Boolean)
  );
  for (const id of authors) {
    const pr = proposalOf(room, id);
    if (!pr || pr.conceded) authors.delete(id);
  }
  return [...authors];
}

export function proceedToVote(room) {
  const live = liveProposals(room);
  if (!live.length) { closeRoom(room, 'failed', 'No queda ninguna propuesta viva.'); return; }
  if (live.length === 1) {
    log(room, null, 'phase', `Solo queda «${live[0].title}»: se salta la votación.`);
    proceedToObjection(room, live[0].id);
    return;
  }
  enterPhase(room, 'vote');
}

export function tallyAndAdvance(room, isTiebreak) {
  const p = room.phase;
  const ballots = { ...(p.data.ballots || {}) };
  const voters = Object.keys(ballots);
  room.lastBallots = ballots;
  if (!voters.length) { closeRoom(room, 'failed', 'Nadie votó; sin quórum.'); return; }
  const options = (p.data.options || p.data.finalists || liveProposals(room).map(x => x.id))
    .filter(id => room.artifacts.proposals[id]);
  const createdAtOf = id => room.artifacts.proposals[id]?.createdAt || 0;
  const { medians, ranked } = rankOptions(room, options, ballots, createdAtOf);
  room.lastMedians = medians;
  const decision = decideTop(ranked);

  if (isTiebreak) {
    if (decision.clear) { announceWinner(room, decision.top.id, ballots, medians); proceedToObjection(room, decision.top.id); return; }
    log(room, null, 'vote', 'Empate persistente tras el desempate: decide la mediana de la primera ronda.');
    const first = Object.entries(room.lastMedians || {})
      .sort((a, b) => a[1].median - b[1].median || b[1].firsts - a[1].firsts || a[1].sum - b[1].sum);
    if (!first.length) { closeRoom(room, 'failed', 'Desempate sin datos.'); return; }
    proceedToObjection(room, first[0][0]);
    return;
  }

  if (decision.clear) {
    if (decision.dominant) log(room, null, 'vote', `Dominancia clara: ${Math.round((decision.top.firsts / Math.max(1, decision.top.voters)) * 100)}% de primeros puestos.`);
    announceWinner(room, decision.top.id, ballots, medians);
    proceedToObjection(room, decision.top.id);
    return;
  }
  enterPhase(room, 'tiebreak', { finalists: ranked.slice(0, 2).map(r => r.id) });
}

function announceWinner(room, winnerId, ballots, medians) {
  const wp = room.artifacts.proposals[winnerId];
  const firsts = Object.values(ballots).filter(b => b[0] === winnerId).length;
  log(room, null, 'vote',
    `Ganadora por votación secreta: «${wp?.title}» de ${nameOf(room, wp?.author)} ` +
    `(${firsts}/${Object.keys(ballots).length} primeros puestos, mediana ${medians[winnerId]?.median}).`);
}

export function proceedToObjection(room, winnerId) {
  enterPhase(room, 'objection', { winnerId });
}

export function afterObjections(room) {
  const winnerId = room.phase.data.winnerId;
  const blockers = room.artifacts.objections.filter(o => o.severity === 'blocker' && !o.addressed);
  if (blockers.length) {
    enterPhase(room, 'repair', { winnerId, blockers: blockers.map(b => b.id), after: 'synthesis' });
    return;
  }
  proceedToSynthesis(room, winnerId);
}

export function proceedToSynthesis(room, winnerId) {
  const winner = room.artifacts.proposals[winnerId];
  if (!winner) { closeRoom(room, 'failed', 'La propuesta ganadora desapareció.'); return; }
  const authorId = synthesisAuthor(room, winner);
  if (!authorId) { finishRoom(room, winnerId); return; }
  enterPhase(room, 'synthesis', { winnerId, authorId });
}

// Tras la reparación: continuar a síntesis o, si la reparación venía de la verificación,
// pasar al trabajo. Esta rama cerraba la sala directamente y se comía la fase de trabajo
// entera: con repo y mejoras aprobadas, cualquier verificación con un hallazgo grave
// terminaba la sala con cero trabajo hecho. Ahora decide el mismo camino que una
// verificación limpia: trabajar lo aprobado si hay repo y mejoras, o cerrar si no hay nada
// que ejecutar. La reparación sigue siendo el último paso del debate; deja de ser el último
// paso de la sala.
export function afterRepair(room) {
  const { winnerId, after } = room.phase.data;
  if (after === 'close') { proceedToWork(room, winnerId); return; }
  proceedToSynthesis(room, winnerId);
}

// La síntesis terminó: falta la verificación independiente antes de cerrar.
export function proceedToVerify(room, winnerId) {
  // El ganador de la ronda se recuerda fuera de la fase: la mejora recursiva cierra rondas
  // posteriores (p. ej. una auditoría sin hallazgos) cuando ya no hay fase que lo lleve encima.
  if (winnerId) room.lastWinnerId = winnerId;
  enterPhase(room, 'verify', { winnerId });
}

// Mejora recursiva — cuántas mejoras nacidas en una ronda concreta terminaron integradas.
// Es la prueba de que la ronda sirvió de algo: una que no integra nada no deja código nuevo que
// auditar, así que encadenar otra auditoría solo gastaría tiempo de los agentes.
function integratedInRound(room, ronda) {
  const work = room.work;
  if (!work) return 0;
  return work.order
    .map(id => work.items[id])
    .filter(it => it && (it.round || 1) === ronda && it.status === 'integrated').length;
}

// ¿Abre la sala otra ronda sobre su propio código ya mejorado? Solo si la pidió
// (`repo.recursionRounds`), si la ronda que termina mejoró algo de verdad y si no se agotó el
// tope. El tope es un seguro contra la sala eterna; quien decide que ya no hay más es la
// auditoría de la ronda siguiente (o su ausencia de hallazgos).
function maybeStartRecursionRound(room, ronda) {
  const cap = recursionRounds(room);
  const integradas = integratedInRound(room, ronda);
  const rondaActual = room.rounds || 1;
  const seguir = !!room.repo && cap > 0 && integradas > 0 && rondaActual < 1 + cap;

  if (!seguir) {
    room.artifacts.recursionStop = {
      round: rondaActual,
      cap,
      integrated: integradas,
      head: room.repo?.head || null,
      reason: !room.repo || cap <= 0 ? 'sin-recursion'
        : integradas === 0 ? 'ronda-sin-mejoras'
          : 'tope-de-rondas',
    };
    return false;
  }

  room.rounds = rondaActual + 1;
  const head = String(room.repo?.head || '').slice(0, 8);
  log(room, null, 'phase',
    `Ronda ${room.rounds} de mejora recursiva: la ronda ${rondaActual} integró ${plural(integradas, 'mejora')} (head ${head}). ` +
    `La sala vuelve a auditar el código que acaba de mejorar — con sus parches dentro — y seguirá así hasta que una auditoría no encuentre nada nuevo` +
    `${1 + cap > room.rounds ? ` (tope: ronda ${1 + cap})` : ' (última ronda permitida)'}.`);
  enterPhase(room, 'audit', { round: room.rounds });
  return true;
}

// El trabajo terminó: si se integró algo, se revisa como conjunto antes de congelar el
// resultado. Una sala sin nada integrado se cierra igual que siempre.
export function proceedToReview(room, winnerId) {
  if (room.status === 'closed') return;
  const work = room.work;
  const integradas = work ? work.order.filter(id => work.items[id].status === 'integrated') : [];
  if (!integradas.length) { finishRoom(room, winnerId); return; }
  enterPhase(room, 'review', { winnerId, round: work.reviewRounds || 0 });
}

// Cierre de la revisión: se decide si vuelve al trabajo (trabajo extraordinario con mejoras
// concretas y rondas disponibles) o si la sala congela el resultado. Lo pendiente sin
// ejecutar no se esconde: queda escrito en el artefacto y en el acta.
export function closeReviewPhase(room) {
  const d = room.phase.data;
  const ronda = d.review?.round || 1;
  const sugerencias = improvementsFromReview(room, { round: ronda });
  const maxRondas = room.settings.repo?.reviewRounds || 2;
  const puedeSeguir = room.settings.extraordinary && sugerencias.length && ronda < maxRondas;

  // Los veredictos se guardan ANTES de dejar la fase: el informe congelado se arma después,
  // cuando `room.phase` ya es otra cosa, y sin este registro diría que nadie revisó nada.
  const estado = reviewState(room);
  room.artifacts.reviewSnapshot = {
    round: ronda,
    maxRounds: maxRondas,
    extraordinary: !!room.settings.extraordinary,
    total: estado.total,
    reviewed: estado.reviewed,
    reviewedItems: estado.reviewedItems,
    pending: estado.pending,
    unknown: false,
  };

  if (puedeSeguir) {
    const nuevas = addReviewItems(room, sugerencias);
    room.work.reviewRounds = ronda;
    log(room, null, 'phase',
      `La revisión encontró ${plural(nuevas.length, 'mejora')} más: vuelven a la cola de trabajo (ronda ${ronda + 1} de revisión por delante).`);
    enterPhase(room, 'work', { winnerId: d.winnerId });
    return;
  }

  // Sin trabajo extraordinario (o sin rondas): lo que se propuso queda registrado.
  room.artifacts.reviewPending = sugerencias.map(s => ({
    title: s.title, files: s.files, severity: s.severity, action: s.action, by: s.by || null,
    evidence: s.evidence, executed: false,
  }));
  room.work.reviewRounds = ronda;
  if (sugerencias.length) {
    log(room, null, 'work',
      `La revisión dejó ${plural(sugerencias.length, 'mejora')} pendientes. ` +
      (room.settings.extraordinary ? 'No quedaban rondas de revisión.' : 'La sala no exige trabajo extraordinario: quedan en el resultado, sin ejecutar.'));
  } else {
    log(room, null, 'work', 'La revisión no encontró nada más que mejorar en lo integrado.');
  }

  // Mejora recursiva: con el trabajo de esta ronda cerrado y revisado, la sala puede volver a
  // auditar el código —que ya trae sus propios parches— buscando lo siguiente. Sin esto, la
  // «mejora recursiva» terminaba aquí: un solo ciclo y a congelar el acta.
  if (maybeStartRecursionRound(room, ronda)) return;

  room.roundHistory.push({
    round: room.rounds || 1,
    integrated: integratedInRound(room, room.rounds || 1),
    findings: room.artifacts.findings.filter(f => (f.round || 1) === (room.rounds || 1)).length,
    head: room.repo?.head || null,
    at: now(),
    next: false,
  });
  finishRoom(room, d.winnerId || room.lastWinnerId || null);
}

// El debate decidió: si la sala trae repo y el debate aprobó mejoras concretas,
// se trabaja sobre ellas antes de congelar el resultado. Si no, se cierra igual que
// siempre (una sala sin repo no cambia en nada su comportamiento).
export function proceedToWork(room, winnerId) {
  if (room.status === 'closed') return;
  // Solo planificación: el debate cierra con su plan, sin tocar ningún repositorio.
  if (room.settings?.planOnly) { finishRoom(room, winnerId); return; }
  const pendientes = workFrom(room);
  if (room.repo && pendientes.length) { enterPhase(room, 'work', { winnerId }); return; }
  if (room.repo) {
    log(room, null, 'phase', room.repo.greenfield
      ? 'El debate no llegó a decidir ninguna parte del plan: no hay nada que construir.'
      : 'El debate no aprobó ninguna mejora concreta: no hay trabajo que ejecutar sobre el repo.');
  }
  finishRoom(room, winnerId);
}

// ---------------------------------------------------------------- plazos

// Quién tiene un turno entregado y sin devolver en la fase abierta. Es la prueba de que está
// trabajando: no es un agente mudo, es un agente a mitad de su movimiento.
function agentsAwaiting(room) {
  const phase = room.phase.name;
  const t = now();
  const hold = turnHoldMs(room);
  return activeAgents(room)
    .map(id => room.agents[id])
    .filter(a => a?.awaiting && a.awaiting.phase === phase)
    // Con el turno en la mano demasiado tiempo, se deja de esperar: un agente puede tardar, no
    // puede retener la sala sin límite. El reloj del silencio se mide desde que se le entregó
    // el turno, así que un turno largo legítimo nunca se corta por llevar rato escribiendo.
    .filter(a => t - (a.awaiting.since || t) < hold)
    .map(a => ({ name: a.name, action: a.awaiting.action, since: a.awaiting.since }));
}

// Nombre legible de cada fase para los mensajes al humano (el id técnico no se lee).
const ES_PHASE = {
  frame: 'encuadre', contrast: 'contraste de ejes', audit: 'auditoría', proposal: 'propuestas', critique: 'crítica',
  revise: 'revisión de propuestas', vote: 'votación', tiebreak: 'desempate',
  objection: 'vetos', repair: 'reparación', synthesis: 'síntesis', verify: 'verificación',
  work: 'trabajo', review: 'revisión del trabajo', lobby: 'sala de espera',
};

// El techo de duración protege contra una sala abandonada, no contra terminar el trabajo.
// El debate consume su presupuesto (lobby→verificación) y el trabajo sobre el repo trae el
// suyo (phaseMs.work + phaseMs.review): con el techo aplicado a pelo, una sala que usaba sus
// plazos se congelaba justo después de aprobar las mejoras y el acta salía con 0 integradas,
// sin que ningún harness hubiera abandonado nada. La ampliación está acotada por esos dos
// presupuestos de fase, así que sigue habiendo tope: no hay sala eterna, hay sala que termina.
function durationCeilingMs(room) {
  const base = room.settings.maxDurationMs;
  // Solo las salas con repo trabajan: en ellas el techo del debate se amplía con el
  // presupuesto de las dos fases de trabajo, que ya tienen su propio tope. Depende de que
  // haya repo y no de que ya haya aprobaciones a propósito: si dependiera de aprobaciones
  // habría una ventana (debate lento, agenda aún sin votar) en la que el techo volvía a
  // cortar antes de poder ejecutar nada.
  if (!room.repo) return base;
  const pm = room.settings.phaseMs || {};
  const trabajo = (pm.work || 0) + (pm.review || 0);
  // Rondas de mejora recursiva: cada una repite el ciclo entero (auditoría → debate → trabajo
  // → revisión), así que el techo crece con el presupuesto completo de cada ronda extra. Sin
  // recursión (0) el techo es exactamente el de siempre: esto es una prórroga por rondas
  // pedidas, no una barra libre — una sala varada sigue cerrando.
  const cap = recursionRounds(room);
  const extra = cap * Object.values(pm).reduce((n, v) => n + (Number(v) || 0), 0);
  return base + trabajo + extra;
}

// `force` lo usa el humano desde el panel («Forzar avance de fase»): su orden manda sobre las
// prórrogas automáticas, que existen para no cortar a un agente que trabaja, no para
// contradecir a quien decide cerrar la fase ya.
export function sweep(room, { force = false } = {}) {
  if (room.status === 'closed') return false;
  const t = now();
  const recovered = recoverWorkParticipants(room);
  // Los invariantes del trabajo se reparan antes de decidir nada: un estado imposible (un parche
  // en vuelo cuya tarea volvió al montón) bloqueaba el árbol y nadie podía deshacerlo.
  reconcileWork(room);
  const health = workflowHealth(room);
  // El aviso de salud es un AVISO, no un freno: la sala sigue mirando sus plazos. Antes, con el
  // aviso puesto, `sweep` volvía antes de procesar el vencimiento, así que una sala con la
  // revisión trabada se quedaba varada para siempre: ni cerraba, ni prorrogaba, ni gastaba su
  // techo de duración. El aviso sigue quedando escrito (una vez por motivo).
  const healthKey = health ? `${health.state}:${health.reason}` : null;
  if (healthKey && room.recoveryNotice !== healthKey) {
    room.recoveryNotice = healthKey;
    log(room, null, 'recovery', `${health.reason} ${health.action}`);
    room.__changed = true;
  } else if (!healthKey && room.recoveryNotice) {
    delete room.recoveryNotice;
    room.__changed = true;
  }
  if (recovered) return true;
  // In agreement mode there is intentionally no thinking clock. A room with no
  // remaining harnesses cannot obtain consent, so end it explicitly with the
  // unfinished work recorded instead of keeping an eternal live room.
  if (agreementOpen(room) && !activeAgents(room).length) {
    closeRoom(room, 'expired', 'Todos los harnesses se desconectaron antes de concluir. El trabajo y las objeciones pendientes quedan registrados.');
    return true;
  }
  if (room.phase.name === 'review' && room.finalReviewDeadline > t && !force) {
    maybeAdvance(room);
    return room.status === 'closed';
  }
  if (!usesAgreement(room) && t - room.createdAt > durationCeilingMs(room)) { forceFinish(room); return true; }

  if (room.status === 'lobby') {
    if (maybeAutoStart(room)) return true;
    if (t >= room.phase.deadline) {
      if (activeAgents(room).length >= room.settings.minAgents) { startRoom(room, null); return true; }
      closeRoom(room, 'expired', 'Plazo de lobby agotado sin suficientes agentes.');
      return true;
    }
    return false;
  }

  // No silent timeouts, expulsion or claim reassignment while a harness is thinking.
  // The human can still explicitly force an advance or remove an unavailable member.
  if (agreementOpen(room) && !force) {
    const before = room.phase;
    maybeAdvance(room);
    return before !== room.phase || room.status === 'closed';
  }

  // Antes de mirar plazos: si alguien desapareció con una tarea reclamada, esa tarea
  // vuelve al montón para que la sala no dependa de que vuelva.
  if (room.phase.name === 'work' && sweepClaims(room)) return true;

  if (t < room.phase.deadline) return false;

  // Prórroga por actividad: si a alguien se le entregó una acción de ESTA fase y aún no la ha
  // devuelto, está trabajando en ella. Cerrar el plazo encima tira su movimiento entero y deja
  // al debate con una voz menos. Antes solo se prorrogaban trabajo y revisión; el resto de
  // fases cortaba en seco a quien estaba a mitad de escribir (y una tarea larga no es abandono).
  // Con tope de prórrogas y sin poder pasar del plazo total de la sala, que es el techo que el
  // humano declaró al crearla.
  if (!force && !['work', 'review'].includes(room.phase.name)) {
    const esperando = agentsAwaiting(room);
    const extras = room.phase.data.extensions || 0;
    if (esperando.length && extras < 3) {
      const extra = Math.max(60_000, Math.round((room.settings.phaseMs[room.phase.name] || 5 * 60_000) / 2));
      room.phase.deadline = t + extra;
      room.phase.data.extensions = extras + 1;
      log(room, null, 'phase',
        `El plazo de «${ES_PHASE[room.phase.name] || room.phase.name}» se amplía ${Math.round(extra / 60_000)} min: ` +
        `${esperando.map(e => e.name).join(', ')} ${esperando.length === 1 ? 'tiene' : 'tienen'} el turno entregado y sin responder ` +
        `(${esperando[0].action}). No se cierra la fase encima de quien está trabajando.`);
      return true;
    }
  }

  const p = room.phase.name;

  if (p === 'frame') {
    const active = activeAgents(room);
    const applied = ratifyRuleProposals(room, active.map(id => id));
    for (const a of applied) {
      const rp = room.artifacts.ruleProposals.find(x => x.id === a.proposalId);
      if (rp) rp.appliedOp = a.op;
    }
    log(room, null, 'phase', `Encuadre cerrado por plazo${applied.length ? ` con ${plural(applied.length, 'cambio')} ratificados` : ''}.`);
    afterFrame(room);
    maybeAdvance(room);
    return true;
  }

  if (p === 'contrast') {
    const res = closeContrast(room);
    log(room, null, 'phase', contrastSummary(res) + ' Se cierra por plazo; lo impugnado sigue a la vista.');
    enterPhase(room, auditOrProposal(room));
    maybeAdvance(room);
    return true;
  }

  if (p === 'audit') {
    const missing = activeAgents(room).filter(id => !room.phase.data.responses?.[id]);
    if (missing.length) log(room, null, 'phase', `${plural(missing.length, 'agente')} no ${missing.length === 1 ? 'presentó' : 'presentaron'} hallazgos; se cierra la auditoría con lo que hay.`);
    const res = closeAudit(room);
    log(room, null, 'phase', `Auditoría cerrada por plazo: ${plural(res.accepted, 'mejora')} a debate${res.deferred ? `, ${res.deferred} sin espacio en la agenda` : ''}.`);
    enterPhase(room, 'proposal');
    maybeAdvance(room);
    return true;
  }

  if (p === 'proposal') {
    const missing = activeAgents(room).filter(id => !proposalOf(room, id));
    for (const id of missing) {
      log(room, id, 'timeout', `${nameOf(room, id)} no presentó propuesta a tiempo; continúa como evaluador.`);
      if (!room.agents[id].movesCount) markAbsent(room, id, 'no presentó propuesta ni participó en el encuadre');
    }
    if (!liveProposals(room).length) { closeRoom(room, 'failed', 'Ninguna propuesta a tiempo.'); return true; }
    log(room, null, 'phase', `Propuestas reveladas por plazo: ${liveProposals(room).length}.`);
    enterPhase(room, 'critique');
    maybeAdvance(room);
    return true;
  }

  if (p === 'critique') {
    const done = Object.keys(room.artifacts.critiques).length;
    if (!done) log(room, null, 'phase', 'Plazo agotado sin críticas: se pasa directamente a votación.');
    else log(room, null, 'phase', `Crítica cerrada por plazo con ${plural(done, 'crítica')}.`);
    enterPhase(room, 'revise');
    maybeAdvance(room);
    return true;
  }

  if (p === 'revise') {
    const authors = reviseAuthors(room);
    for (const id of authors) if (!room.phase.data.responses?.[id]) {
      log(room, id, 'timeout', `${nameOf(room, id)} no respondió a las objeciones: se vota su versión vigente.`);
    }
    log(room, null, 'phase', 'Revisión cerrada por plazo.');
    proceedToVote(room);
    maybeAdvance(room);
    return true;
  }

  if (p === 'vote') {
    const ballots = Object.keys(room.phase.data.ballots || {});
    if (!ballots.length) { closeRoom(room, 'failed', 'Plazo de votación agotado sin votos.'); return true; }
    log(room, null, 'vote', `Votación cerrada por plazo con ${plural(ballots.length, 'voto')}.`);
    tallyAndAdvance(room, false);
    maybeAdvance(room);
    return true;
  }

  if (p === 'tiebreak') {
    if (!Object.keys(room.phase.data.ballots || {}).length) {
      const first = Object.entries(room.lastMedians || {})
        .sort((a, b) => a[1].median - b[1].median || b[1].firsts - a[1].firsts || a[1].sum - b[1].sum);
      if (!first.length) { closeRoom(room, 'failed', 'Desempate sin votos ni ronda previa.'); return true; }
      log(room, null, 'vote', 'Plazo del desempate sin votos: decide la primera votación.');
      proceedToObjection(room, first[0][0]);
      maybeAdvance(room);
      return true;
    }
    tallyAndAdvance(room, true);
    maybeAdvance(room);
    return true;
  }

  if (p === 'objection') {
    const d = room.phase.data;
    d.responses ||= {};
    for (const id of activeAgents(room)) if (!d.responses[id]) d.responses[id] = { kind: 'pass' };
    afterObjections(room);
    maybeAdvance(room);
    return true;
  }

  if (p === 'repair') {
    log(room, null, 'phase', room.phase.data.after === 'close'
      ? 'Reparación no presentada a tiempo: los hallazgos de la verificación quedan sin respuesta.'
      : 'Reparación no presentada a tiempo: los vetos quedan como disenso sin responder.');
    afterRepair(room);
    maybeAdvance(room);
    return true;
  }

  if (p === 'synthesis') {
    log(room, null, 'timeout', 'Síntesis no presentada a tiempo: se conserva el plan ganador tal cual.');
    proceedToVerify(room, room.phase.data.winnerId);
    maybeAdvance(room);
    return true;
  }

  if (p === 'verify') {
    log(room, null, 'timeout', 'Verificación no presentada a tiempo: el resultado se cierra sin comprobaciones.');
    proceedToWork(room, room.phase.data.winnerId);
    maybeAdvance(room);
    return true;
  }

  if (p === 'work') {
    // Cerrar el trabajo con un parche a medio verificar, o con alguien trabajando, tira
    // trabajo real: en vez de cortar se amplía el plazo y se dice por qué.
    const ocupado = workBusyReason(room);
    if (ocupado) {
      const extra = Math.max(60_000, Math.round((room.settings.phaseMs.work || 30 * 60_000) / 2));
      room.phase.deadline = t + extra;
      room.phase.data.extensions = (room.phase.data.extensions || 0) + 1;
      log(room, null, 'phase',
        `El plazo del trabajo se amplía ${Math.round(extra / 60_000)} min: ${ocupado}. No se cierra con trabajo a medias.`);
      return true;
    }
    closeWork(room, 'plazo del trabajo agotado');
    proceedToReview(room, room.phase.data.winnerId);
    return true;
  }

  if (p === 'review') {
    if (reviewIsCovered(room)) { closeReviewPhase(room); return true; }
    // Cerrar la revisión sin veredicto deja lo integrado sin juicio: mientras haya agentes
    // activos y mejoras sin revisar, el plazo se amplía en vez de cortar (con tope, para que
    // una sala abandonada no se quede colgada).
    const sinRevisar = reviewState(room).pending.length;
    const extras = room.phase.data.extensions || 0;
    if (sinRevisar && activeAgents(room).length && extras < 3) {
      const extra = Math.max(60_000, Math.round((room.settings.phaseMs.review || 8 * 60_000) / 2));
      room.phase.deadline = t + extra;
      room.phase.data.extensions = extras + 1;
      log(room, null, 'phase',
        `El plazo de la revisión se amplía ${Math.round(extra / 60_000)} min: ${plural(sinRevisar, 'mejora')} integradas siguen sin veredicto.`);
      return true;
    }
    log(room, null, 'phase', 'La revisión se cierra por plazo con lo que hay; lo que no se revisó queda dicho así.');
    closeReviewPhase(room);
    return true;
  }

  return false;
}

// Se agotó el tiempo máximo del debate: se congela lo mejor disponible y se
// dicen las cosas claras (no se hace pasar por resultado lo que es una emergencia).
export function forceFinish(room) {
  if (room.status === 'closed') return;
  const phase = room.phase.name;
  if (phase === 'review') {
    closeReviewPhase(room);
    return;
  }
  if (phase === 'work') {
    closeWork(room, 'tiempo máximo de la sala agotado');
    const winnerId = room.phase.data.winnerId;
    enterPhase(room, 'review', { winnerId });
    room.finalReviewDeadline = room.phase.deadline;
    return;
  }
  if (phase === 'vote' && Object.keys(room.phase.data.ballots || {}).length) {
    tallyAndAdvance(room, false);
    if (room.status === 'closed') return;
    if (room.phase.name !== 'vote') { sweep(room); return; }
  }
  if (phase === 'synthesis' || phase === 'verify' || phase === 'repair') {
    const winnerId = room.phase.data.winnerId
      || (room.lastMedians ? Object.entries(room.lastMedians).sort((a, b) => a[1].median - b[1].median)[0]?.[0] : null);
    if (winnerId && room.artifacts.proposals[winnerId]) {
      log(room, null, 'timeout', 'Tiempo máximo agotado en la recta final: se cierra con la mejor propuesta disponible.');
      finishRoom(room, winnerId);
      return;
    }
  }
  const live = liveProposals(room);
  if (!live.length) { closeRoom(room, 'expired', 'Tiempo máximo agotado sin propuestas vivas.'); return; }
  const best = bestAvailable(room, live.map(p => p.id));
  log(room, null, 'timeout', 'Tiempo máximo del debate agotado: se congela la mejor propuesta disponible como resultado de emergencia.');
  finishRoom(room, best);
}

// Elige la mejor disponible: si hubo votación, la mejor clasificada; si no, la que
// menos objeciones de severidad alta acumuló (nunca «la más antigua»).
function bestAvailable(room, ids) {
  if (room.lastMedians) {
    const ranked = ids.filter(id => room.lastMedians[id])
      .sort((a, b) => room.lastMedians[a].median - room.lastMedians[b].median || room.lastMedians[a].sum - room.lastMedians[b].sum);
    if (ranked.length) return ranked[0];
  }
  const penalty = id => Object.values(room.artifacts.critiques)
    .filter(c => c.target === id)
    .reduce((s, c) => s + (c.objections || []).reduce((x, o) => x + (o.severity === 'high' ? 3 : o.severity === 'med' ? 1 : 0), 0), 0);
  return [...ids].sort((a, b) => penalty(a) - penalty(b)
    || (room.artifacts.proposals[a].createdAt - room.artifacts.proposals[b].createdAt))[0];
}

export function phaseSummary(room) {
  const active = activeAgents(room);
  const report = consensusReport(room);
  return {
    phase: room.status === 'closed' ? 'closed' : room.phase.name,
    status: room.status,
    deadlineInSec: room.status === 'closed' ? 0 : Math.max(0, Math.round(phaseMsLeft(room) / 1000)),
    activeAgents: active.length,
    totalAgents: room.order.length,
    proposals: liveProposals(room).length,
    conceded: Object.values(room.artifacts.proposals).filter(p => p.conceded).length,
    consensus: report.global,
    agreed: report.agreed,
    discussing: report.discussing,
    open: report.open,
    pending: report.pending,
    points: report.points.length,
    unresolved: unresolvedPoints(report).length,
    vacancies: room.vacancies.length,
  };
}

export { applyBudget };
