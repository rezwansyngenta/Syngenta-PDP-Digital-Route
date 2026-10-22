/* Impact computation for simulate/apply cards and route quality indicators. Pure functions. */

export function computeImpact(before, after, params = {}) {
  const rows = [];
  const pmin = Number(params.pmin ?? 10);
  const vmin = Number(params.vmin ?? 12);
  const cap = Number(params.cap ?? 12);
  const loadBefore = Number(before?.volume ?? 0);
  const loadAfter = Number(after?.volume ?? 0);
  const valBefore = Number(before?.value ?? 0);
  const valAfter = Number(after?.value ?? 0);
  const kmBefore = Number(before?.distance ?? 0);
  const kmAfter = Number(after?.distance ?? 0);

  const pdpWord = (v, val) => (v >= vmin - 1e-9 || val >= pmin * 1e7 - 1e-9) ? 'Meets PDP' : 'Below PDP';
  const capWord = (v) => v > cap + 1e-9 ? `Over ${cap} MT` : 'Normal';

  rows.push({ metric: 'Load', before: `${loadBefore.toFixed(1)} MT`, after: `${loadAfter.toFixed(1)} MT`, delta: `${loadAfter - loadBefore >= 0 ? '+' : ''}${(loadAfter - loadBefore).toFixed(1)} MT` });
  rows.push({ metric: 'Value BDT', before: `BDT ${(valBefore / 1e5).toFixed(1)} lakh`, after: `BDT ${(valAfter / 1e5).toFixed(1)} lakh`, delta: `${valAfter - valBefore >= 0 ? '+' : ''}BDT ${((valAfter - valBefore) / 1e5).toFixed(1)} lakh` });
  rows.push({ metric: 'Outbound km', before: `${kmBefore.toFixed(1)}`, after: `${kmAfter.toFixed(1)}`, delta: `${kmAfter - kmBefore >= 0 ? '+' : ''}${(kmAfter - kmBefore).toFixed(1)}` });
  rows.push({ metric: 'PDP', before: pdpWord(loadBefore, valBefore), after: pdpWord(loadAfter, valAfter) });
  rows.push({ metric: 'Capacity', before: capWord(loadBefore), after: capWord(loadAfter) });
  return rows;
}

/** Backtracking indicator: returns { label, km } — 15 km threshold. */
export function backtrackIndicator(ids, directionDist, thresholdKm = 15) {
  if (!ids || !ids.length) return { label: 'No backtracking', km: 0 };
  let bk = 0;
  let prev = directionDist('WH', ids[0]);
  for (let i = 1; i < ids.length; i++) {
    const w = directionDist('WH', ids[i]);
    if (w != null && prev != null && w < prev - 1) bk += prev - w;
    prev = w == null ? prev : w;
  }
  if (bk < thresholdKm) return { label: 'No backtracking', km: bk };
  return { label: `~${Math.round(bk)} km of re-tracing`, km: bk };
}
