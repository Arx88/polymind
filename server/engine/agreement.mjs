import { activeAgents } from './state.mjs';
import { DebateError } from './util.mjs';

export const usesAgreement = room => room.settings?.phaseAdvanceMode === 'agreement';
export const agreementOpen = room => usesAgreement(room) && room.status === 'debate';

// Acknowledgements apply to an exact phase revision AND participant set.
// New contributions revoke consent; a readiness vote is never a vote for the plan.
export function phaseRevision(room) {
  return `${room.phase.name}:${room.phase.instanceId || room.phase.startedAt}:${room.phase.data.agreementRevision || 0}:${activeAgents(room).join(',')}`;
}
export function agreementState(room) {
  if (!agreementOpen(room)) return null;
  const revision = phaseRevision(room);
  const members = activeAgents(room);
  const ready = members.filter(id => room.phase.data.ready?.[id] === revision);
  return { revision, ready, pending: members.filter(id => !ready.includes(id)), total: members.length };
}
export function allReady(room) {
  const state = agreementState(room);
  return !state || (state.total > 0 && state.pending.length === 0);
}
export function invalidateReadiness(room) {
  if (!agreementOpen(room)) return;
  room.phase.data.agreementRevision = (room.phase.data.agreementRevision || 0) + 1;
  room.phase.data.ready = {};
  room.__changed = true;
}
export function acknowledgePhase(room, agentId, payload) {
  if (!agreementOpen(room) || !activeAgents(room).includes(agentId)) {
    throw new DebateError('wrong_phase', 'La confirmación requiere una fase abierta por acuerdo y un agente activo.');
  }
  if (payload.revision !== phaseRevision(room)) {
    throw new DebateError('stale_phase', 'Hay aportes nuevos o cambió el equipo. Consulta /turn y revisa antes de confirmar.');
  }
  room.phase.data.ready ||= {};
  if (payload.ready === false) delete room.phase.data.ready[agentId];
  else room.phase.data.ready[agentId] = payload.revision;
  room.__changed = true;
}
