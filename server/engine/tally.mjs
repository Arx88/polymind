// AGORA v2 — recuento de votos. Funciones puras: no cambian de fase ni escriben.
// Medianas de rangos (resistentes a valores atípicos), dominancia y acuerdo.

import { medianOf } from './util.mjs';

export function computeMedians(options, ballots) {
  const out = {};
  const voters = Object.values(ballots || {}).filter(b => Array.isArray(b) && b.length);
  for (const oid of options) {
    const positions = voters.map(b => {
      const i = b.indexOf(oid);
      return i === -1 ? options.length : i;
    }).sort((a, b) => a - b);
    out[oid] = {
      median: medianOf(positions),
      sum: positions.reduce((a, b) => a + b, 0),
      firsts: positions.filter(p => p === 0).length,
      voters: positions.length,
    };
  }
  return out;
}

export function rankOptions(room, options, ballots, createdAtOf) {
  const medians = computeMedians(options, ballots);
  const rank = id => createdAtOf ? createdAtOf(id) : 0;
  const ranked = Object.entries(medians).sort((a, b) =>
    a[1].median - b[1].median ||
    b[1].firsts - a[1].firsts ||
    a[1].sum - b[1].sum ||
    rank(a[0]) - rank(b[0]));
  return { medians, ranked: ranked.map(([id, stats]) => ({ id, ...stats })) };
}

// ¿Hay ganador claro? Margen sobre el segundo en mediana, primer puesto o suma.
export function decideTop(ranked) {
  if (!ranked.length) return { winnerId: null, tie: false, clear: false, dominant: false };
  const top = ranked[0];
  const second = ranked[1] || null;
  if (!second) return { winnerId: top.id, tie: false, clear: true, dominant: true, top };
  const clear = top.median < second.median ||
    (top.median === second.median && top.firsts > second.firsts) ||
    (top.median === second.median && top.firsts === second.firsts && top.sum < second.sum);
  const voters = Math.max(1, top.voters);
  const dominant = top.firsts / voters >= 0.75 && top.firsts - second.firsts >= Math.ceil(voters / 2);
  return { winnerId: clear ? top.id : null, tie: !clear, clear, dominant, top, second };
}

export function topChoice(ballot) {
  return Array.isArray(ballot) && ballot.length ? ballot[0] : null;
}
