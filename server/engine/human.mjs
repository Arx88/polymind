// AGORA v2 — el juicio humano: SOLO sobre lo entregado, y solo al final.
//
// El reparto de ojos es deliberado y no se solapa:
//
//   · DURANTE el trabajo juzgan los MODELOS QUE VEN. La capacidad «vision» se declara al entrar y
//     desde ahí es una obligación: el servidor les entrega las capturas del commit actual y exige
//     su firma en cada afirmación de aspecto (server/engine/visual.mjs). Si un modelo que ve no
//     firma, la obligación queda abierta y el veredicto NO sube.
//   · AL FINAL, con la entrega congelada, juzga el HUMANO. No antes: mientras la sala trabaja no
//     hay nada que aceptar, y un humano mirando a mitad de camino solo agrega un turno de espera.
//     Su veredicto es «aprobado» o «cambios» — y los cambios no son una opinión decorativa: se
//     convierten en tareas y la sala vuelve a trabajar sobre ellas, con las capturas de antes y
//     las de después al lado.
//
// Lo que este módulo NO hace: juzgar el aspecto por nadie. No mira imágenes ni opina sobre ellas;
// toma la decisión del humano, la registra con lo que estaba mirando (checksum y capturas del
// momento) y, si pidió cambios, los convierte en trabajo ejecutable.

import { now, clampStr, gist, plural, uid, DebateError } from './util.mjs';
import { log } from './state.mjs';
import { addReviewItems } from './work.mjs';
import { visualState } from './visual.mjs';

const MAX_REVIEWS = 20;
const MAX_REQUESTS = 6;
const MIN_REQUEST = 12;

export function humanReviews(room) {
  return Array.isArray(room?.artifacts?.humanReviews) ? room.artifacts.humanReviews : [];
}

export function humanReview(room) {
  return humanReviews(room).at(-1) || null;
}

// ¿La sala ya entregó? El juicio humano es sobre lo entregado: sin entrega congelada, quien tiene
// la última palabra todavía no es el humano.
export function delivered(room) {
  return room?.status === 'closed' && !!room?.result;
}

// Cómo está una petición del humano: si la sala la convirtió en trabajo y si ese trabajo entró.
function requestStatus(request, items) {
  const ids = request.itemIds || [];
  if (!ids.length) {
    return { status: 'sin-tarea', because: 'quedó registrada; la sala no escribió código, así que no hay ronda que la ejecute' };
  }
  const estados = ids.map(id => items[id]?.status || 'desconocida');
  if (estados.every(s => s === 'integrated')) return { status: 'atendido', because: `integrado en ${ids.join(', ')}` };
  if (estados.some(s => ['reverted', 'failed'].includes(s))) {
    return { status: 'revertido', because: `la tarea ${ids.filter(id => ['reverted', 'failed'].includes(items[id]?.status)).join(', ')} no quedó en pie` };
  }
  if (estados.some(s => s === 'integrated')) return { status: 'en-curso', because: `parte integrada (${ids.join(', ')}), parte pendiente` };
  return { status: 'en-curso', because: `en la cola de trabajo (${ids.join(', ')})` };
}

// El informe del humano para el resultado: su veredicto, su motivo, qué pidió y en qué quedó cada
// petición. Se recalcula al leer, no se congela: una petición «en curso» pasa a «atendida» cuando
// la tarea entra de verdad.
export function humanReviewReport(room) {
  const reviews = humanReviews(room);
  if (!reviews.length) return null;
  const items = room.work?.items || {};
  const requests = reviews.flatMap(r => (r.requests || []).map(q => {
    const st = requestStatus(q, items);
    return {
      id: q.id,
      text: q.text,
      askedAt: q.at,
      round: q.round || null,
      itemIds: q.itemIds || [],
      status: st.status,
      because: st.because,
    };
  }));
  const last = reviews.at(-1);
  const abiertas = requests.filter(r => r.status !== 'atendido');
  return {
    verdict: last.verdict,
    by: last.by,
    at: last.at,
    reason: last.reason || null,
    deliveredChecksum: last.deliveredChecksum || null,
    deliveredHead: last.deliveredHead ? String(last.deliveredHead).slice(0, 8) : null,
    rounds: room.artifacts.humanRounds || 0,
    reviewed: reviews.length,
    // Lo que el humano tenía delante cuando firmó: la huella de la entrega y las capturas.
    shots: (last.shots || []).map(s => ({ id: s.id, hash: s.hash })),
    requests,
    open: abiertas.map(r => r.text),
    history: reviews.map(r => ({
      id: r.id,
      verdict: r.verdict,
      by: r.by,
      at: r.at,
      round: r.round || null,
      reason: r.reason || null,
      reopened: !!r.reopened,
      requests: (r.requests || []).map(q => q.text),
    })),
    note: last.verdict === 'aprobado'
      ? `El humano aprobó la entrega${abiertas.length ? ` (con ${plural(abiertas.length, 'petición')} de cambios todavía sin cerrar)` : ''}${last.deliveredHead ? ` tal como estaba en ${last.deliveredHead}` : ''}.`
      : abiertas.length
        ? `${plural(abiertas.length, 'cambio pedido', 'cambios pedidos')} por el humano, aún sin cerrar${room.artifacts.humanRounds ? ` (${plural(room.artifacts.humanRounds, 'ronda')} de trabajo posterior)` : ''}: ${abiertas.map(r => gist(r.text, 60)).join(' · ')}`
        : `${plural(requests.length, 'cambio pedido por el humano, ya atendido', 'cambios pedidos por el humano, ya atendidos')}${room.artifacts.humanRounds ? ` con ${plural(room.artifacts.humanRounds, 'ronda')} de trabajo posterior` : ''}.`,
  };
}

// Registrar el veredicto humano. Valida lo que es mecánico (que la entrega exista, que un pedido
// de cambios diga QUÉ cambiar) y no opina sobre lo que es suyo (si lo aprobado le sirve).
export function recordHumanReview(room, payload = {}) {
  const verdict = ['aprobado', 'cambios'].includes(payload.verdict) ? payload.verdict : null;
  if (!verdict) {
    throw new DebateError('bad_payload',
      'payload:{verdict:"aprobado"|"cambios", reason:"por qué", requests:["qué cambiar", …]}. El humano aprueba la entrega o pide cambios concretos.');
  }
  if (!delivered(room)) {
    throw new DebateError('not_delivered',
      `El juicio humano es sobre lo ENTREGADO y la sala todavía no cerró (estado ${room.status}, fase ${room.phase?.name}). ` +
      'Durante el trabajo juzgan los modelos que ven, con las capturas delante; el humano entra al final.');
  }
  const reason = clampStr(payload.reason ?? payload.note ?? '', 800);
  const raw = Array.isArray(payload.requests)
    ? payload.requests
    : (payload.request ? [payload.request] : []);
  let requests = raw.map(r => clampStr(typeof r === 'object' && r ? (r.text || r.request || '') : r, 400)).filter(Boolean);
  if (verdict === 'cambios') {
    if (!requests.length && reason.length >= MIN_REQUEST) requests = [reason];
    if (!requests.length) {
      throw new DebateError('bad_payload',
        'Para pedir cambios hace falta al menos una petición concreta: requests:["qué cambiar"] (o un reason de 12+ caracteres). «No me gusta» no es accionable y no se puede convertir en trabajo.');
    }
    const cortas = requests.filter(t => t.length < MIN_REQUEST);
    if (cortas.length) {
      throw new DebateError('bad_payload',
        `Cada cambio pedido tiene que decir qué cambiar (${MIN_REQUEST}+ caracteres): ${cortas.map(t => `«${gist(t, 40)}»`).join(', ')}`);
    }
  }
  requests = requests.slice(0, MAX_REQUESTS);

  const warnings = [];
  const vis = room.result?.obligations?.visual?.vision || null;
  if (vis && (vis.seers || []).some(s => (s.pending || []).length)) {
    const deudores = vis.seers.filter(s => (s.pending || []).length).map(s => `${s.name} (${s.pending.join(', ')})`);
    warnings.push(`hay firmas de modelos con visión declarada sin poner — ${deudores.join('; ')}: mirar el artefacto era su parte de la obligación y la entrega se cerró sin ella`);
  }
  if (vis && !(vis.seers || []).length) {
    warnings.push('ningún participante declaró la capacidad «vision»: las afirmaciones de aspecto quedaron sin un ojo obligado a mirarlas');
  }
  const sinCerrar = (room.result?.obligations?.blockers || []).length;
  if (sinCerrar) {
    warnings.push(`la entrega tiene ${plural(sinCerrar, 'obligación')} sin cerrar según el acta generada: ${(room.result.obligations.blockers || []).slice(0, 3).map(b => b.kind).join(', ')}${sinCerrar > 3 ? ', …' : ''}`);
  }
  const antes = humanReviews(room);
  const abiertasAntes = antes.at(-1)?.verdict === 'cambios'
    ? humanReviewReport(room)?.open || []
    : [];
  if (verdict === 'aprobado' && abiertasAntes.length) {
    warnings.push(`aprobás con ${plural(abiertasAntes.length, 'cambio')} pedido(s) que la sala todavía no cerró: ${abiertasAntes.map(t => gist(t, 50)).join(' · ')}`);
  }

  const round = (room.artifacts.humanRounds || 0) + 1;
  const review = {
    id: uid('h'),
    verdict,
    by: clampStr(payload.by || 'el humano', 60),
    reason,
    at: now(),
    round: verdict === 'cambios' ? round : (room.artifacts.humanRounds || 0) || null,
    // Qué estaba mirando: la huella de lo entregado y las capturas del momento.
    deliveredChecksum: room.result?.checksum || null,
    deliveredHead: room.repo?.head || null,
    shots: visualState(room).shots.map(s => ({ id: s.id, hash: s.hash })),
    requests: requests.map(t => ({ id: uid('rep'), text: t, itemIds: [], at: now(), round })),
    warnings: [],
    reopened: false,
    because: null,
  };
  room.artifacts.humanReviews = [...antes, review].slice(-MAX_REVIEWS);
  review.warnings = warnings;
  // El informe congelado se actualiza aquí mismo: quien acaba de firmar tiene que verlo reflejado
  // sin esperar a un recálculo. (El veredicto de obligaciones lo refresca quien llama, que es el
  // único que puede importar `result` sin ciclo: este módulo no puede depender de él.)
  if (room.result) room.result.humanReview = humanReviewReport(room);
  log(room, null, 'human',
    `Revisión humana (sobre la entrega ${String(room.result?.checksum || '').slice(0, 18)}): ${verdict === 'aprobado' ? 'APROBADO' : `CAMBIOS PEDIDOS — ${review.requests.map(r => gist(r.text, 70)).join(' · ')}`}` +
    `${reason ? `: ${gist(reason, 120)}` : ''}` +
    `${warnings.length ? ` (${warnings.length} aviso(s) del acta)` : ''}.`);
  return { review, warnings, canReopen: verdict === 'cambios' && !!room.work && !!room.repo };
}

// Pedir cambios REABRE la sala: las peticiones se convierten en tareas y el ciclo de trabajo vuelve
// a abrirse. Sin esto, «pedir modificaciones» sería un comentario al pie de un resultado congelado.
// La importación de `phases` es diferida a propósito: `phases` importa `result`, y `result` importa
// este módulo para publicar el veredicto humano.
export async function reopenForChanges(room, review) {
  if (!review || review.verdict !== 'cambios') return { reopened: false, because: 'la revisión no pide cambios' };
  if (!room.work || !room.repo) {
    review.reopened = false;
    review.because = 'la sala no escribió código: los cambios pedidos quedan registrados en el resultado, sin ronda de trabajo que los ejecute';
    return { reopened: false, because: review.because, items: [] };
  }
  if (review.reopened) return { reopened: true, items: review.itemIds || [], because: 'ya reabierta' };
  const sugerencias = review.requests.map(r => ({
    title: clampStr(r.text, 110),
    files: [],
    severity: 'med',
    claim: clampStr(`El humano revisó la entrega y pidió: ${r.text}`, 200),
    evidence: clampStr('Revisión humana posterior a la entrega congelada.', 200),
    action: r.text,
    by: 'humano',
    de: null,
  }));
  const creadas = addReviewItems(room, sugerencias, { from: 'humano' });
  review.requests.forEach((r, i) => { r.itemIds = creadas[i] ? [creadas[i].id] : []; });
  review.itemIds = creadas.map(i => i.id);
  review.reopened = true;
  review.reopenedAt = now();
  review.because = `la sala vuelve al trabajo con ${creadas.map(i => i.id).join(', ')}`;
  room.artifacts.humanRounds = (room.artifacts.humanRounds || 0) + 1;
  if (room.result) room.result.humanReview = humanReviewReport(room);
  const wid = room.result?.winner?.id || room.lastWinnerId || null;
  log(room, null, 'human',
    `La sala VUELVE AL TRABAJO: ${plural(creadas.length, 'cambio pedido convertido', 'cambios pedidos convertidos')} en ${plural(creadas.length, 'tarea')} (${creadas.map(i => i.id).join(', ')}). Al integrarlas, la sala cierra de nuevo y el resultado se recalcula con las capturas nuevas.`);
  const { enterPhase } = await import('./phases.mjs');
  room.status = 'debate';
  enterPhase(room, 'work', { winnerId: wid, by: 'humano', humanRound: room.artifacts.humanRounds });
  return { reopened: true, items: creadas.map(i => i.id), because: review.because };
}

// Lo que el humano ve en su propio turno de cierre: no es un turno de agente (los agentes ya
// cerraron), es la pregunta que el resultado le hace. Va en el resultado y en el panel.
export function humanBrief(room) {
  if (!delivered(room)) return null;
  const report = humanReviewReport(room);
  const vis = room.result?.obligations?.visual?.vision || null;
  return {
    available: true,
    already: report ? { verdict: report.verdict, at: report.at, rounds: report.rounds } : null,
    open: report?.open || [],
    asks: [
      'Mirá las capturas del artefacto (están en el resultado, con su huella y su commit).',
      'Aprobá la entrega tal como está, o pedí cambios concretos: cada uno se convierte en una tarea y la sala vuelve a trabajar.',
    ],
    missingSignatures: vis?.missing || 0,
    note: 'Los modelos que declararon visión ya juzgaron durante el trabajo. Acá decidís vos, sobre lo ENTREGADO.',
    move: {
      kind: 'admin:human-review',
      payload: '{op:"human-review", verdict:"aprobado"|"cambios", reason:"por qué", requests:["qué cambiar", …]}',
    },
  };
}
