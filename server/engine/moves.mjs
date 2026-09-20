// AGORA v2 — aplicación de movimientos.
//
// Regla de oro: un payload bienintencionado nunca se rechaza por forma. Se coacciona,
// se completan los huecos y se devuelven avisos que enseñan la forma correcta. Solo se
// rechaza cuando el artefacto quedaría semánticamente vacío o cuando la fase no admite
// ese movimiento.
//
// Y una regla que estuvo mal durante un tiempo: NO se trunca el contenido de un agente
// para «ahorrarlo». Un harness decide cuánto necesita decir; la plataforma solo protege su
// propia memoria, y cuando ese techo muerde lo dice (`fit`/`fitList`) con la cifra exacta
// y qué se descartó. Perder texto en silencio era un fallo, no una política de eficiencia.

import { now, uid, clampStr, clampText, gist, bytesOf, arr, obj, oneOf, plural, fit, fitList, DebateError } from './util.mjs';
import { CAPS, MOVE_KINDS } from './settings.mjs';
import { agreementOpen, acknowledgePhase, invalidateReadiness } from './agreement.mjs';
import { improvementResponses } from './collaboration.mjs';
import { log, nameOf, proposalOf, critiqueOf, recordCost } from './state.mjs';
import {
  addPoint, applyPositions, positionsOf, diversityReport, diffPositions, resolveRuleProposal,
  dissentReport, challengePoint,
} from './agenda.mjs';
import { applyBudget } from './roster.mjs';
import { startRoom, maybeAdvance, proceedToVerify, proceedToWork, enterPhase } from './phases.mjs';
import { finishRoom } from './result.mjs';
import { recordFinding, claimItem, submitPatch, reviewPatch, passWork, holdClaim, applyRecheck } from './work.mjs';

const OBJECTION_TYPES = ['risk', 'cost', 'feasibility', 'ethics', 'missing-info', 'scope'];
const SEVERITIES = ['high', 'med', 'low'];

export function applyMove(room, agentId, move = {}) {
  try {
    const out = applyMoveInner(room, agentId, move);
    const agent = room.agents[agentId];
    if (agent?.lastReject) { agent.lastReject = null; room.__changed = true; }
    // Ya no está «a mitad de un movimiento»: la fase no tiene por qué seguir esperándole.
    if (agent?.awaiting) { agent.awaiting = null; room.__changed = true; }
    return out;
  } catch (err) {
    rememberRejection(room, agentId, move, err);
    throw err;
  }
}

// Un rechazo se recuerda y viaja en el siguiente turno del agente. Sin esto, un
// payload inválido se repite en bucle hasta agotar los tokens y el plazo de fase.
function rememberRejection(room, agentId, move, err) {
  if (!(err instanceof DebateError)) return;
  if (['closed', 'unknown_agent', 'unauthorized'].includes(err.code)) return;
  const agent = room.agents[agentId];
  if (!agent) return;
  agent.lastReject = {
    kind: clampStr(move?.kind, 40),
    code: err.code,
    message: clampText(err.message, 400),
    at: now(),
  };
  room.__changed = true;
}

function applyMoveInner(room, agentId, move = {}) {
  if (room.status === 'closed') throw new DebateError('closed', 'El debate ya cerró. Obtén el resultado con /result.');
  const agent = room.agents[agentId];
  if (!agent) throw new DebateError('unknown_agent', 'Agente desconocido');

  const kind = clampStr(move.kind, 40);
  const key = clampStr(move.idempotencyKey || obj(move.payload).idempotencyKey || '', 80);
  const idemKey = key ? `${agentId}:${key}` : null;
  if (idemKey) {
    room.idem ||= {};
    const hit = room.idem[idemKey];
    if (hit) return { warnings: [`movimiento repetido (idempotencia): ${hit.kind} ya se aplicó`], replayed: true, kind: hit.kind };
  }

  if (kind === 'phase-ready') {
    acknowledgePhase(room, agentId, obj(move.payload));
    agent.lastSeenAt = now();
    maybeAdvance(room);
    return { warnings: [] };
  }
  const allowed = MOVE_KINDS[room.phase.name] || [];
  if (!allowed.includes(kind)) {
    throw new DebateError('wrong_phase',
      `Movimiento «${kind}» no válido en fase «${room.phase.name}». Válidos: ${allowed.join(', ') || 'ninguno'}. Consulta /turn.`);
  }

  // Never carry consent over another substantive contribution. Heartbeats do not reset it.
  if (kind !== 'progress') invalidateReadiness(room);
  agent.lastSeenAt = now();
  agent.movesCount = (agent.movesCount || 0) + 1;
  const payload = obj(move.payload);
  const warnings = [];
  const sent = bytesOf(payload);
  agent.sentChars = (agent.sentChars || 0) + sent;
  recordCost(room, agentId, kind, sent);

  const d = room.phase.data;
  const phase = room.phase.name;
  const respond = (extra = {}) => {
    d.responses ||= {};
    d.responses[agentId] = { kind, at: now(), ...extra };
  };

  switch (kind) {
    case 'start': {
      if (room.status !== 'lobby') throw new DebateError('wrong_phase', 'El debate ya arrancó.');
      startRoom(room, agentId);
      break;
    }

    // ---------------------------------------------------------------- encuadre
    case 'point-proposal': {
      const res = addPoint(room, payload, agentId);
      if (!res.point) {
        const why = res.reason === 'too-many-points'
          ? `la agenda ya tiene ${room.agenda.length} puntos y el techo de esta sala está en ${CAPS.maxPoints}`
          : (res.reason || 'punto inválido');
        throw new DebateError('bad_payload',
          `payload: {label ≤${CAPS.pointLabel}, options?: [textos ≤${CAPS.pointOption}]}. Motivo: ${why}`);
      }
      d.pointsCreated = (d.pointsCreated || 0) + 1;
      log(room, agentId, 'point',
        `${agent.name} ${res.created ? `propone el punto «${res.point.label}»` : `amplía «${res.point.label}»`}` +
        `${res.addedOptions?.length ? ` con ${res.addedOptions.map(o => `«${o.label}»`).join(', ')}` : ''}.`);
      respond({ pointId: res.point.id });
      break;
    }
    // Contraste de ejes: la agenda entera ya está a la vista, así que aquí nadie ancla a nadie.
    // Se añade el eje que falta (point-proposal), se impugna uno que sobra con motivo
    // (point-challenge) o se pide fusionarlo con otro. Nada se borra: lo impugnado queda
    // abierto y visible, y solo se fusiona si lo pide más de la mitad de la sala y todas las
    // peticiones apuntan al mismo destino.
    case 'point-challenge': {
      const res = challengePoint(room, agentId, payload);
      if (!res.point) {
        throw new DebateError('bad_payload',
          'payload: {pointId: uno de ' + (room.agenda.map(p => p.id).join(', ') || 'ninguno') +
          ', because: "por qué sobra o por qué debería fusionarse", mergeInto?: "otro pointId"}');
      }
      const label = res.point.label;
      if (res.mergeInto) {
        log(room, agentId, 'contrast',
          `${agent.name} pide fusionar «${label}» con «${res.mergeInto.label}»${res.entry.because ? `: ${gist(res.entry.because, 130)}` : ''}.`);
      } else {
        log(room, agentId, 'contrast',
          `${agent.name} impugna el eje «${label}»${res.entry.because ? `: ${gist(res.entry.because, 130)}` : ' sin decir por qué'}.`);
      }
      respond({ pointId: res.point.id, mergeInto: res.entry.mergeInto });
      break;
    }
    case 'rule-change': {
      const op = clampStr(payload.op || payload.field || '', 40);
      const text = fit(payload.text || `${op} = ${payload.value}`, CAPS.ruleChangeText, 'text', warnings);
      const probe = resolveRuleProposal(room, { op, value: payload.value, phase: payload.phase });
      if (!probe) {
        throw new DebateError('bad_payload',
          'Cambio de reglas inválido. Forma: {op, value, phase?, text?} con ' +
          'op="consensusThreshold" value 0.5..1 (0.7 = 70%), ' +
          'op="tone" value texto libre, ' +
          'op="requireDiversity" value true|false, ' +
          'op="maxDurationMs" value 60000..21600000 (ms), ' +
          'op="tokenBudgetPerAgent" value 0..2000000 (tokens, 0 = sin tope), ' +
          'op="phaseMs" + phase (nombre exacto de la fase) value 5000..3600000 (ms). ' +
          `Recibido: ${JSON.stringify({ op: op || null, value: payload.value ?? null })}`);
      }
      const rp = {
        id: uid('r'),
        by: agentId,
        at: now(),
        op: probe.op,
        value: probe.value,
        phase: probe.phase,
        text: text || probe.text,
        ratifications: [agentId],
        applied: false,
      };
      room.artifacts.ruleProposals.push(rp);
      log(room, agentId, 'rule', `${agent.name} sugiere un cambio de reglas: ${rp.text} (pendiente de ratificación).`);
      respond({ ruleId: rp.id });
      break;
    }
    case 'ratify': {
      const proposed = room.artifacts.ruleProposals.filter(r => !r.applied);
      if (!proposed.length) { respond({ ratified: false }); warnings.push('no hay cambios de reglas pendientes'); break; }
      const target = payload.proposalId ? proposed.find(r => r.id === payload.proposalId) : proposed[0];
      if (!target) throw new DebateError('bad_payload', `proposalId desconocido. Pendientes: ${proposed.map(r => r.id).join(', ')}`);
      const approve = payload.approve !== false;
      target.ratifications = target.ratifications || [];
      if (approve) {
        if (!target.ratifications.includes(agentId)) target.ratifications.push(agentId);
        log(room, agentId, 'rule', `${agent.name} ratifica: ${target.text}.`);
      } else {
        target.ratifications = target.ratifications.filter(x => x !== agentId);
        target.rejectedBy = [...new Set([...(target.rejectedBy || []), agentId])];
        log(room, agentId, 'rule', `${agent.name} rechaza: ${target.text}.`);
      }
      respond({ ruleId: target.id, ratified: approve });
      break;
    }
    case 'pass': {
      if (!['frame', 'contrast', 'audit', 'revise', 'repair', 'objection', 'verify', 'work', 'review', 'lobby'].includes(phase)) {
        throw new DebateError('wrong_phase', 'pass no aplica en esta fase.');
      }
      if (phase === 'review') {
        // Un «pass» aquí NO es un veredicto: la mejora sigue sin revisar y la fase no cierra
        // por cortesía. Solo dice que tú ya no tienes nada más que mirar.
        log(room, agentId, 'review', `${agent.name} no tiene nada más que revisar por su parte.`);
        respond({ reviewed: Object.keys(room.phase.data?.review?.revisados?.[agentId] || {}).length });
        break;
      }
      if (phase === 'work') {
        warnings.push(...(passWork(room, agentId, payload).warnings || []));
        break;
      }
      if (phase === 'verify') {
        if (d.verifierId && d.verifierId !== agentId) throw new DebateError('not_author', 'Solo el verificador asignado puede cerrar la verificación.');
        const winnerId = d.winnerId;
        room.artifacts.verification = {
          by: agentId, verdict: 'pass', selfVerified: !!d.selfVerified, findings: [], repaired: false, at: now(),
        };
        log(room, agentId, 'verify', `${agent.name} declara que no encuentra nada bloqueante en el plan ganador.`);
        respond({ verdict: 'pass' });
        break;
      }
      respond({});
      if (phase === 'revise') log(room, agentId, 'pass', `${agent.name} mantiene su propuesta sin cambios y acepta el disenso.`);
      if (phase === 'repair') log(room, agentId, 'pass', `${agent.name} defiende su versión original frente a los vetos.`);
      if (phase === 'frame') log(room, agentId, 'pass', `${agent.name} no propone cambios en el encuadre.`);
      if (phase === 'contrast') log(room, agentId, 'contrast', `${agent.name} deja los ejes como están.`);
      if (phase === 'audit') log(room, agentId, 'pass', `${agent.name} ha revisado el repo y no presenta hallazgos.`);
      if (phase === 'objection') log(room, agentId, 'pass', `${agent.name} no presenta objeciones.`);
      break;
    }

    // ---------------------------------------------------------------- auditoría del repo
    case 'finding': {
      const res = recordFinding(room, agentId, payload);
      warnings.push(...res.warnings);
      respond({ findingId: res.finding.id, severity: res.finding.severity });
      break;
    }

    // ---------------------------------------------------------------- trabajo conjunto
    case 'claim-item': {
      const item = claimItem(room, agentId, payload);
      respond({ itemId: item.id, status: item.status });
      break;
    }
    case 'submit-patch': {
      const res = submitPatch(room, agentId, payload);
      warnings.push(...res.warnings);
      respond({ itemId: res.item.id, patchId: res.patch.id, reviewer: res.patch.reviewer, status: res.item.status });
      break;
    }
    case 'review-patch': {
      const res = reviewPatch(room, agentId, payload);
      warnings.push(...res.warnings);
      respond({ patchId: res.patch.id, verdict: res.verdict, itemId: res.item.id });
      break;
    }
    // Latido: mantiene el reclamo sin gastar en un movimiento completo.
    case 'progress': {
      const res = holdClaim(room, agentId, payload);
      respond({ itemId: res.item.id, heartbeats: res.heartbeats, status: res.item.status });
      break;
    }
    // Veredicto de la revisión posterior al trabajo.
    case 'recheck': {
      const res = applyRecheck(room, agentId, payload);
      respond({ itemId: res.item.id, verdict: res.verdict, pending: res.pending });
      break;
    }

    // ---------------------------------------------------------------- propuesta
    case 'proposal': {
      if (proposalOf(room, agentId)) throw new DebateError('duplicate', 'Ya presentaste tu propuesta.');
      const title = fit(payload.title, CAPS.proposalTitle, 'title', warnings);
      const plan = fit(payload.plan, CAPS.proposalPlan, 'plan', warnings, { keepLines: true });
      if (!title || plan.length < 30) {
        throw new DebateError('bad_payload',
          `payload: {title ≤${CAPS.proposalTitle}, plan 30+ caracteres (sin tope), approach?, premortem?, risks?, assumptions?, positions?}`);
      }
      const { positions, warnings: posWarnings, newOptions } = applyPositions(room, payload.positions);
      warnings.push(...posWarnings);
      for (const n of newOptions) {
        log(room, agentId, 'point', `${agent.name} añade la opción «${n.option.label}» a «${n.pointLabel}».`);
      }
      if (room.agenda.length && Object.keys(positions).length === 0) {
        if (room.settings.requirePositions) {
          throw new DebateError('bad_payload',
            `Falta tu posición en la agenda. payload.positions = [{pointId, choiceId}] con: ` +
            room.agenda.map(p => p.id).join(', '));
        }
        warnings.push('propuesta sin posiciones en la agenda: cuenta como abstención en cada punto');
      }
      const approach = fit(payload.approach, CAPS.proposalApproach, 'approach', warnings);
      const diversity = diversityReport(room, agentId, positions, approach);
      if (diversity.askChange) {
        const close = diversity.closest;
        throw new DebateError('not_diverse',
          `Tu propuesta se parece demasiado a «${close.title}» de ${close.authorName} ` +
          `(similitud ${Math.round(close.similarity * 100)}% en las decisiones). ` +
          `Cambia al menos dos elecciones o declara un enfoque distinto en "approach" y reenvía. ` +
          `Sus elecciones: ${Object.entries(close.positions).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
      const id = uid('p');
      room.artifacts.proposals[id] = {
        id, v: 1, author: agentId, title, plan,
        // Ronda en la que se presentó: cada ronda de mejora recursiva trae sus propias
        // propuestas y la votación no arrastra las de la ronda anterior.
        round: room.rounds || 1,
        approach,
        premortem: fit(payload.premortem, CAPS.proposalPremortem, 'premortem', warnings),
        risks: fit(payload.risks, CAPS.proposalRisks, 'risks', warnings),
        assumptions: fit(payload.assumptions, CAPS.proposalAssumptions, 'assumptions', warnings),
        positions,
        createdAt: now(), history: [], gist: gist(plan), conceded: false,
      };
      log(room, agentId, 'proposal',
        `${agent.name} presenta «${title}» (oculta hasta revelar)` +
        `${Object.keys(positions).length ? ` con ${plural(Object.keys(positions).length, 'posición', 'posiciones')} en la agenda` : ''}.`);
      break;
    }

    // ---------------------------------------------------------------- crítica
    case 'critique': {
      const targets = (d.assignments?.[agentId] || []).filter(pid => room.artifacts.proposals[pid] && !room.artifacts.proposals[pid].conceded);
      const target = clampStr(payload.target || targets[0] || '', 40);
      if (!targets.includes(target)) {
        throw new DebateError('not_assigned',
          `No tienes asignada la propuesta ${target || '(vacío)'}. Tus objetivos: ${targets.join(', ') || 'ninguno'}.`);
      }
      if (critiqueOf(room, agentId, target)) throw new DebateError('duplicate', 'Ya criticaste esta propuesta.');

      const steelman = fit(payload.steelman, CAPS.steelman, 'steelman', warnings);
      const id = uid('c');
      const improvements = fitList(payload.improvements, 500, 'improvements', warnings).map((raw, index) => {
        const idea = typeof raw === 'string' ? { change: raw } : obj(raw);
        return { id: `${id}:${index}`, change: fit(idea.change, CAPS.objectionText, 'improvements[].change', warnings),
          why: fit(idea.why, CAPS.objectionText, 'improvements[].why', warnings),
          validation: fit(idea.validation, CAPS.checkMethod, 'improvements[].validation', warnings) };
      }).filter(idea => idea.change.trim().length > 5);
      const raw = fitList(payload.objections, CAPS.objectionsPerCritique, 'objections', warnings);
      const objections = [];
      for (const item of raw) {
        const o = typeof item === 'string' ? { text: item } : obj(item);
        const text = fit(o.text ?? o.message ?? o.description ?? '', CAPS.objectionText, 'objections[].text', warnings);
        if (text.length <= 5) continue;
        objections.push({
          type: oneOf(clampStr(o.type, 20), OBJECTION_TYPES, 'risk'),
          severity: oneOf(clampStr(o.severity, 10), SEVERITIES, 'med'),
          text,
          against: o.against ? clampStr(o.against, 40) : null,
        });
      }
      if (!objections.length && !steelman && !improvements.length) {
        throw new DebateError('bad_payload',
          'payload: {target, steelman?, objections:[{type, severity, text}]}. Si no tienes objeciones, usa {kind:"pass"}... pero aquí hace falta al menos un steelman u objeción.');
      }
      if (!objections.length && !improvements.length) warnings.push('crítica sin objeciones concretas: se registra solo el steelman');
      room.artifacts.critiques[id] = { id, target, author: agentId, steelman, objections, improvements, createdAt: now() };
      if (improvements.length) log(room, agentId, 'collaboration', `${agent.name} aporta ${improvements.length} mejoras concretas a «${room.artifacts.proposals[target]?.title}».`);
      const top = objections.find(o => o.severity === 'high') || objections[0];
      log(room, agentId, 'critique',
        `${agent.name} ataca «${room.artifacts.proposals[target]?.title}»${objections.length ? `: ${plural(objections.length, 'objeción', 'objeciones')}. Principal: «${gist(top.text, 110)}»` : ' con un steelman sin objeciones'}.`);
      break;
    }

    // ---------------------------------------------------------------- revisión
    case 'revision': {
      const isRepair = phase === 'repair';
      const pid = isRepair ? d.winnerId : (clampStr(payload.proposalId, 40) || proposalOf(room, agentId)?.id);
      const pr = room.artifacts.proposals[pid];
      if (!pr || pr.author !== agentId) throw new DebateError('not_author', 'Solo el autor puede revisar esa propuesta.');
      if (pr.conceded) throw new DebateError('closed', 'Esa propuesta fue retirada.');
      const plan = fit(payload.plan, CAPS.proposalPlan, 'plan', warnings, { keepLines: true });
      if (plan.length < 30) {
        throw new DebateError('bad_payload',
          'payload: {proposalId?, plan 30+ caracteres (sin tope), note?, positions?}');
      }
      pr.history.push({ v: pr.v, plan: pr.plan, note: pr.revisionNote || '', contributionResponses: pr.contributionResponses || [], at: now() });
      pr.v += 1;
      pr.plan = plan;
      pr.gist = gist(plan);
      pr.revisionNote = fit(payload.note, CAPS.revisionNote, 'note', warnings);
      if (payload.contributionResponses) pr.contributionResponses = improvementResponses(room, payload.contributionResponses, warnings, pid);
      if (payload.positions) {
        const before = positionsOf(pr);
        const { positions, warnings: posWarnings, newOptions } = applyPositions(room, payload.positions);
        warnings.push(...posWarnings);
        pr.positions = { ...pr.positions, ...positions };
        for (const n of newOptions) log(room, agentId, 'point', `${agent.name} añade la opción «${n.option.label}» a «${n.pointLabel}».`);
        const optionLabel = (pointId, choiceId) =>
          room.agenda.find(x => x.id === pointId)?.options.find(o => o.id === choiceId)?.label || choiceId || '—';
        // Converger tiene que justificarse. Cada posición movida se registra con la razón
        // declarada en changes[{pointId, because}]. Sin razón NO se rechaza el movimiento
        // (nunca rechazamos un payload bienintencionado): se registra como cambio sin
        // evidencia, sale en el registro y el informe final lo cuenta.
        // Antes esto se cortaba en 12 cambios. Con más posiciones movidas que eso, las
        // razones de la cola se perdían y el autor aparecía como «convergencia sin
        // evidencia» por un recorte del servidor, no por su culpa.
        const changes = fitList(payload.changes, 500, 'changes', warnings);
        const reasons = new Map(changes.map(c => {
          const o = typeof c === 'string' ? { pointId: c } : obj(c);
          return [
            clampStr(o.pointId ?? o.point ?? o.id, 40),
            fit(o.because ?? o.reason ?? o.why, CAPS.driftReason, 'changes[].because', warnings),
          ];
        }).filter(([pid]) => pid));
        for (const ch of diffPositions(before, positionsOf(pr))) {
          const label = room.agenda.find(p => p.id === ch.pointId)?.label || ch.pointId;
          const reason = reasons.get(ch.pointId) || '';
          (room.artifacts.drift ||= []).push({
            at: now(), by: agentId, proposalId: pr.id, version: pr.v,
            pointId: ch.pointId, pointLabel: label,
            from: ch.from, to: ch.to, fromLabel: optionLabel(ch.pointId, ch.from), toLabel: optionLabel(ch.pointId, ch.to),
            because: reason, evidenced: !!reason,
          });
          log(room, agentId, 'drift',
            `${agent.name} mueve su posición en «${label}»: «${optionLabel(ch.pointId, ch.from)}» → «${optionLabel(ch.pointId, ch.to)}»` +
            `${reason ? ` (${gist(reason, 110)})` : ' sin citar qué evidencia lo movió'}.`);
          if (!reason) {
            warnings.push(`moviste tu posición en «${label}» sin decir qué evidencia lo provocó: ` +
              `queda registrado como convergencia sin evidencia. Si fue un argumento ajeno, cítalo en changes:[{pointId:"${ch.pointId}", because:"…"}]`);
          }
        }
      }
      if (payload.approach) pr.approach = fit(payload.approach, CAPS.proposalApproach, 'approach', warnings);
      if (isRepair && d.after === 'close') {
        room.artifacts.verification = { ...(room.artifacts.verification || {}), repaired: true, repairNote: pr.revisionNote };
      }
      respond({ version: pr.v });
      log(room, agentId, 'revision', `${agent.name} publica v${pr.v} de «${pr.title}»${pr.revisionNote ? ` — ${gist(pr.revisionNote, 110)}` : ''}.`);
      break;
    }
    case 'concede': {
      const pid = clampStr(payload.proposalId, 40) || proposalOf(room, agentId)?.id;
      const pr = room.artifacts.proposals[pid];
      if (!pr || pr.author !== agentId) throw new DebateError('not_author', 'Solo el autor puede retirar su propuesta.');
      if (pr.conceded) throw new DebateError('duplicate', 'Esa propuesta ya estaba retirada.');
      pr.conceded = true;
      pr.concededAt = now();
      pr.concedeReason = fit(payload.reason, CAPS.revisionNote, 'reason', warnings);
      for (const key of Object.keys(room.lastBallots || {})) {
        room.lastBallots[key] = room.lastBallots[key].filter(x => x !== pid);
      }
      if (phase === 'vote' || phase === 'tiebreak') {
        d.options = (d.options || []).filter(x => x !== pid);
        for (const key of Object.keys(d.ballots || {})) d.ballots[key] = d.ballots[key].filter(x => x !== pid);
      }
      const endorse = payload.endorse ? clampStr(payload.endorse, 40) : null;
      if (endorse && room.artifacts.proposals[endorse] && !room.artifacts.proposals[endorse].conceded) {
        room.artifacts.endorsements ||= {};
        (room.artifacts.endorsements[endorse] ||= []).push(agentId);
        log(room, agentId, 'concede', `${agent.name} retira «${pr.title}» y respalda «${room.artifacts.proposals[endorse].title}»${pr.concedeReason ? `: ${gist(pr.concedeReason, 110)}` : ''}.`);
      } else {
        log(room, agentId, 'concede', `${agent.name} retira «${pr.title}»${pr.concedeReason ? `: ${gist(pr.concedeReason, 110)}` : ''}.`);
      }
      respond({ conceded: true });
      if (phase === 'revise' || phase === 'critique') maybeAdvance(room);
      break;
    }

    // ---------------------------------------------------------------- votación
    case 'vote': {
      const options = (d.options || d.finalists || Object.keys(room.artifacts.proposals))
        .filter(id => room.artifacts.proposals[id] && !room.artifacts.proposals[id].conceded);
      const given = arr(payload.ranking).map(x => clampStr(String(x), 40));
      const ranking = [];
      for (const id of given) if (options.includes(id) && !ranking.includes(id)) ranking.push(id);
      const missing = options.filter(id => !ranking.includes(id));
      ranking.push(...missing);
      if (missing.length) warnings.push(`ranking incompleto: se colocaron al final ${missing.join(', ')}`);
      if (!options.length) throw new DebateError('bad_payload', 'No hay propuestas vivas para votar.');
      d.ballots ||= {};
      d.ballots[agentId] = ranking;
      log(room, agentId, 'vote', `${agent.name} emite su voto secreto (${plural(ranking.length, 'opción', 'opciones')}).`);
      break;
    }
    case 'argument': {
      const text = fit(payload.text, CAPS.tiebreakArg, 'text', warnings);
      const target = clampStr(payload.target, 40) || (d.finalists || [])[0];
      if (!text || !(d.finalists || []).includes(target)) {
        throw new DebateError('bad_payload',
          `payload: {target: uno de ${(d.finalists || []).join('|')}, text: libre}`);
      }
      d.args ||= [];
      if (d.args.some(x => x.by === agentId)) throw new DebateError('duplicate', 'Ya presentaste tu alegato.');
      d.args.push({ by: agentId, target, text });
      log(room, agentId, 'argument', `${agent.name} defiende «${room.artifacts.proposals[target]?.title}»: «${gist(text, 120)}»`);
      break;
    }

    // ---------------------------------------------------------------- veto y reparación
    case 'objection': {
      const text = fit(payload.text, CAPS.objectionMsg, 'text', warnings);
      const severity = payload.severity === 'blocker' ? 'blocker' : 'concern';
      if (text.length < 15) {
        throw new DebateError('bad_payload',
          'payload: {text 15+ caracteres (sin tope), severity: blocker|concern}');
      }
      const id = uid('o');
      room.artifacts.objections.push({ id, by: agentId, text, severity, addressed: false, at: now() });
      respond({ objectionId: id, severity });
      log(room, agentId, 'objection', `${agent.name} ${severity === 'blocker' ? 'VETA el resultado:' : 'observa:'} «${gist(text, 130)}»`);
      break;
    }

    // ---------------------------------------------------------------- cierre
    case 'synthesis': {
      // El acta final la firma el autor de la propuesta ganadora y nadie más. El turno ya se
      // ofrecía solo a él (views), pero el movimiento no lo comprobaba: cualquier agente podía
      // publicar la síntesis con texto ajeno y cerrar la sala con ella. Mismo guard que la
      // revisión y la retirada de propuestas (moves.mjs:352 y :416). El autor sale de
      // `authorId` (lo escribe la fase) o, si no está, de la propuesta ganadora.
      const synthAuthor = d.authorId || room.artifacts.proposals[d.winnerId]?.author;
      if (synthAuthor && synthAuthor !== agentId) {
        throw new DebateError('not_author', 'Solo el autor de la propuesta ganadora firma la síntesis.');
      }
      const final = fit(payload.final, CAPS.synthesisFinal, 'final', warnings, { keepLines: true });
      if (final.length < 50) {
        throw new DebateError('bad_payload',
          'payload: {final 50+ caracteres (sin tope), merges?, pointResolutions?}');
      }
      const merges = arr(payload.merges).map(m => clampStr(String(m), 40));
      for (const id of merges) {
        const o = room.artifacts.objections.find(x => x.id === id);
        if (o) o.addressed = true;
      }
      // Cada punto abierto se resuelve declarando CON QUÉ BASE se resuelve. «Porque yo
      // sintetizo» no es una base: si el punto tenía minoría real y se resuelve en su
      // contra sin evidencia nueva, el servidor lo marca como resuelto por autoridad y
      // así llega al resultado, con los nombres de quienes sostenían la otra mitad.
      const pointResolutions = arr(payload.pointResolutions).map(item => {
        const o = typeof item === 'string' ? { pointId: item } : obj(item);
        const pointId = clampStr(o.pointId ?? o.point ?? o.id, 40);
        const evidence = fit(o.evidence ?? o.because ?? '', CAPS.resolutionEvidence, 'pointResolutions[].evidence', warnings);
        let basis = oneOf(clampStr(o.basis, 20), ['evidence', 'adopted-dissent', 'authority'], null);
        if (basis === 'evidence' && !evidence) { basis = 'authority'; warnings.push(`«${pointId}»: declaraste basis:"evidence" sin evidence; se registra como resuelto por autoridad.`); }
        if (!basis) basis = evidence ? 'adopted-dissent' : 'authority';
        return {
          pointId,
          choiceId: o.choiceId ? clampStr(String(o.choiceId), 40) : null,
          note: fit(o.note, CAPS.pointNote, 'pointResolutions[].note', warnings),
          basis,
          evidence,
        };
      }).filter(x => x.pointId);
      // Un punto disputado que NO aparece en pointResolutions no se resuelve: se deja caer.
      // No resolverlo también es una decisión, y si no se registra el resultado miente por
      // omisión (parece que todo quedó cerrado porque nadie lo mencionó).
      const dis = dissentReport(room, null, id => nameOf(room, id));
      const sinResolver = (dis.measured ? dis.contested : [])
        .filter(p => !pointResolutions.some(r => r.pointId === p.id));
      room.artifacts.synthesis = {
        final, merges, pointResolutions,
        contributionResponses: improvementResponses(room, payload.contributionResponses, warnings),
        unresolved: sinResolver.map(p => ({ id: p.id, label: p.label })),
        by: agentId, at: now(),
      };
      d.synthesis = room.artifacts.synthesis;
      const porAutoridad = pointResolutions.filter(r => r.basis === 'authority');
      log(room, agentId, 'synthesis',
        `${agent.name} publica la síntesis final (${plural(merges.length, 'objeción', 'objeciones')} incorporadas, ${plural(pointResolutions.length, 'punto')} resueltos).`);
      if (porAutoridad.length) {
        const labels = porAutoridad
          .map(r => room.agenda.find(p => p.id === r.pointId)?.label || r.pointId).join(', ');
        log(room, null, 'phase',
          `${plural(porAutoridad.length, 'punto')} se ${porAutoridad.length === 1 ? 'resuelve' : 'resuelven'} por autoridad de síntesis, sin evidencia nueva (${labels}). ` +
          `Queda registrado: quien sostuviera otra opción sigue apareciendo como disenso en el resultado.`);
      }
      if (sinResolver.length) {
        const labels = sinResolver.map(p => p.label).join(', ');
        warnings.push(`dejaste sin resolver ${plural(sinResolver.length, 'punto')} con minoría real (${labels}): ` +
          `un punto abierto sin resolución queda registrado como tal en el resultado.`);
        log(room, null, 'phase',
          `${plural(sinResolver.length, 'punto')} con minoría real queda${sinResolver.length === 1 ? '' : 'n'} SIN resolver en la síntesis (${labels}): ` +
          `no mencionarlos no los cierra, y el resultado lo dirá.`);
      }
      const winnerId = d.winnerId;
      if (agreementOpen(room)) d.pendingTransition = { name: 'verify', winnerId };
      else proceedToVerify(room, winnerId);
      maybeAdvance(room);
      return { warnings };
    }
    case 'verification': {
      // Misma comprobación que la síntesis, por el mismo motivo: el veredicto de la verificación
      // independiente lo firma quien el servidor asignó (verifierId), no quien llegue antes.
      const verifier = d.verifierId;
      if (verifier && verifier !== agentId) {
        throw new DebateError('not_author', 'Solo el verificador asignado firma la verificación.');
      }
      const winnerId = d.winnerId;
      const verdict = payload.verdict === 'fail' ? 'fail' : 'pass';
      const rawChecks = fitList(payload.checks, CAPS.checksPerAgent, 'checks', warnings);
      const checks = [];
      for (const item of rawChecks) {
        const c = typeof item === 'string' ? { claim: item } : obj(item);
        const claim = fit(c.claim ?? c.what ?? c.text, CAPS.checkClaim, 'checks[].claim', warnings);
        const method = fit(c.method ?? c.how ?? '', CAPS.checkMethod, 'checks[].method', warnings);
        const expectation = fit(c.expectation ?? c.expected ?? '', CAPS.checkExpectation, 'checks[].expectation', warnings);
        if (!claim && !method) continue;
        checks.push({
          id: uid('k'),
          by: agentId,
          pointId: c.pointId ? clampStr(String(c.pointId), 40) : null,
          claim: claim || gist(method, 120),
          method,
          expectation,
          verdict: oneOf(clampStr(c.verdict, 10), ['pass', 'fail', 'unknown'], 'unknown'),
        });
      }
      const findings = [];
      for (const item of arr(payload.findings)) {
        const f = typeof item === 'string' ? { text: item } : obj(item);
        const text = fit(f.text ?? f.message ?? '', CAPS.findingText, 'findings[].text', warnings);
        if (text.length < 10) continue;
        findings.push({ severity: oneOf(clampStr(f.severity, 10), SEVERITIES, 'med'), text });
      }
      room.artifacts.checks.push(...checks);
      room.artifacts.verification = {
        by: agentId,
        verdict,
        selfVerified: !!d.selfVerified,
        findings,
        checks: checks.length,
        repaired: false,
        at: now(),
      };
      respond({ verdict, checks: checks.length, findings: findings.length });
      log(room, agentId, 'verify',
        `${agent.name} verifica el plan: ${plural(checks.length, 'comprobación', 'comprobaciones')}` +
        `${findings.length ? `, ${plural(findings.length, 'hallazgo')}` : ''} — veredicto ${verdict}.`);
      const blockers = findings.filter(f => f.severity === 'high');
      if (agreementOpen(room)) {
        d.pendingTransition = verdict === 'fail' || blockers.length
          ? { name: 'repair', data: { winnerId, after: 'close', blockers: blockers.map(f => f.text), reason: 'hallazgos de verificación' } }
          : { name: 'work', winnerId };
        break;
      }
      if (verdict === 'fail' || blockers.length) {
        const winner = room.artifacts.proposals[winnerId];
        enterPhase(room, 'repair', {
          winnerId,
          after: 'close',
          blockers: blockers.map(f => f.text),
          reason: verdict === 'fail' ? 'la verificación falló' : 'hallazgos de severidad alta',
        });
        log(room, null, 'phase', `La verificación encontró problemas: ${nameOf(room, winner?.author)} puede reparar; después la sala pasa a trabajar lo aprobado (o cierra si no hay nada que ejecutar).`);
        break;
      }
      proceedToWork(room, winnerId);
      return { warnings };
    }
    default:
      throw new DebateError('bad_move', `Movimiento desconocido: ${kind}`);
  }

  applyBudget(room, agentId);
  maybeAdvance(room);
  if (idemKey) {
    room.idem ||= {};
    room.idem[idemKey] = { at: now(), kind };
    const keys = Object.keys(room.idem);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete room.idem[k];
  }
  return { warnings };
}
