import { nameOf } from './state.mjs';
import { fit, fitList, obj } from './util.mjs';
import { CAPS } from './settings.mjs';

export function sharedImprovements(room, target = null) {
  return Object.values(room.artifacts.critiques || {}).filter(critique => {
    const proposal = room.artifacts.proposals[critique.target];
    return proposal && (proposal.round || 1) === (room.rounds || 1) && (!target || critique.target === target);
  }).flatMap(critique => (critique.improvements || []).map(idea => ({
    ...idea, by: nameOf(room, critique.author), target: critique.target,
    targetTitle: room.artifacts.proposals[critique.target]?.title || critique.target,
  })));
}

// These are attributed declarations, not proof that the final implementation improved.
export function improvementResponses(room, payload, warnings, target = null) {
  const valid = new Set(sharedImprovements(room, target).map(idea => idea.id));
  const responses = new Map();
  for (const raw of fitList(payload, 500, 'contributionResponses', warnings)) {
    const item = obj(raw);
    if (!valid.has(item.contributionId) || !['adopted', 'adapted', 'declined'].includes(item.disposition)) {
      warnings.push('Respuesta de colaboración ignorada: aporte inexistente, ajeno a esta propuesta o decisión inválida.');
      continue;
    }
    const reason = fit(item.reason, CAPS.revisionNote, 'contributionResponses[].reason', warnings);
    if (!reason.trim()) { warnings.push('Una decisión sobre un aporte requiere explicar el motivo.'); continue; }
    responses.set(item.contributionId, { contributionId: item.contributionId, disposition: item.disposition, reason });
  }
  return [...responses.values()];
}

export function collaborationReport(room) {
  return sharedImprovements(room).map(idea => ({ ...idea,
    proposalResponse: room.artifacts.proposals[idea.target]?.contributionResponses?.find(response => response.contributionId === idea.id) || null,
    finalResponse: room.artifacts.synthesis?.contributionResponses?.find(response => response.contributionId === idea.id) || null,
  }));
}
