import { now } from './util.mjs';
import { claimIdleThresholdMs, offlineGraceMs } from './settings.mjs';
import { activeAgents, log, nameOf } from './state.mjs';
import { markAbsent } from './roster.mjs';

export function hasRecentSignal(room, id) {
  const a = room.agents[id];
  return !!a && a.status !== 'absent' && now() - (a.lastSeenAt || a.joinedAt || 0) < offlineGraceMs(room, a);
}

// Connection leases are independent of thinking/phase deadlines. Never discard a patch.
export function recoverWorkParticipants(room) {
  if (room.status !== 'debate' || !['work', 'review'].includes(room.phase.name)) return false;
  let changed = false;
  for (const id of activeAgents(room)) {
    const a = room.agents[id];
    if (now() - (a.lastSeenAt || a.joinedAt || now()) > claimIdleThresholdMs(room)) {
      const removed = markAbsent(room, id, 'sin contacto del harness; se conserva su trabajo y se abre reemplazo');
      if (removed) a.recoveryVacancy = true;
      changed = removed || changed;
    }
  }
  const work = room.work;
  const patch = work?.patches?.[work.pending];
  if (patch && !patch.review && patch.verify?.status !== 'running' && !hasRecentSignal(room, patch.reviewer)) {
    const next = activeAgents(room).find(id => id !== patch.author && hasRecentSignal(room, id));
    if (next && next !== patch.reviewer) {
      const previous = patch.reviewer;
      patch.reviewer = next;
      patch.reviewAssignedAt = now();
      work.items[patch.itemId].reviewer = next;
      log(room, null, 'recovery', `Revisión de ${patch.id} reasignada de ${nameOf(room, previous)} a ${nameOf(room, next)}. El parche se conserva íntegro.`);
      changed = true;
    }
  }
  return changed;
}

export function workflowHealth(room) {
  if (room.status !== 'debate') return null;
  const patch = room.work?.patches?.[room.work.pending];
  if (patch && !patch.review && patch.verify?.status !== 'running') {
    const available = activeAgents(room).filter(id => id !== patch.author && hasRecentSignal(room, id));
    if (!available.length) return { state: 'blocked', reason: `El parche ${patch.id} está conservado, pero no hay un revisor independiente con señal reciente.`, action: 'Reconecta un revisor o conecta un reemplazo en una vacante. El autor no puede aprobar su propio parche.' };
    if (now() - (patch.reviewAssignedAt || patch.at || now()) > claimIdleThresholdMs(room)) {
      return { state: 'stalled', reason: `La revisión de ${patch.id} no ha producido un veredicto dentro del plazo de actividad.`, action: 'Comprueba el harness revisor. Recibir latidos no demuestra avance; el parche sigue protegido.' };
    }
  }
  if (['work', 'review'].includes(room.phase.name) && !activeAgents(room).some(id => hasRecentSignal(room, id))) {
    return { state: 'blocked', reason: 'No hay participantes con señal reciente.', action: 'Reconecta un harness o cubre una vacante para continuar.' };
  }
  if (room.phase.name === 'work' && room.work && !patch && !room.work.finishedAt) {
    const work = room.work;
    const events = [work.startedAt || now(), ...Object.values(work.patches || {}).map(p => p.at || 0), ...Object.values(work.items || {}).flatMap(i => [i.finishedAt || 0, i.claimedAt || 0])];
    if (now() - Math.max(...events) > 2 * claimIdleThresholdMs(room)) {
      return { state: 'stalled', reason: 'Hay contacto, pero no hay nuevas entregas ni cambios de tareas recientes.', action: 'Comprueba los harnesses y el alcance del trabajo. Los latidos no cuentan como progreso.' };
    }
  }
  return null;
}
