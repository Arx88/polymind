import type { Room } from './types';

/** A passed vote never implies passed tests. Count only recorded execution evidence. */
export function deliveryEvidence(room: Room) {
  const result = room.result;
  const work = room.work || result?.work;
  const integrated = work?.items.filter(item => item.status === 'integrated') || [];
  return {
    hasWork: !!work,
    integrated: integrated.length,
    reviewed: integrated.filter(item => !!item.reviewerName && !item.unreviewed).length,
    verified: integrated.filter(item => item.verify?.ran === true && item.verify.ok === true && !item.verify.preExisting).length,
    unresolved: result?.consensus.points.filter(point => point.status !== 'agreed').length || 0,
  };
}
