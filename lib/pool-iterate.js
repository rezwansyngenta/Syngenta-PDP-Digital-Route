/* ILP pool-enrichment fixed-point loop: solve → converge → enrich the
 * candidate pool with the converged solution's sets → re-solve to fixed point.
 * Deterministic; strictly monotonic acceptance (never replaces the best with
 * anything worse). solve() mutates candidate records, so every re-solve gets
 * a fresh clone taken from the pristine pool. */

export function clonePool(pool) {
  return pool.map((c) => ({
    ...c,
    route: c.route.slice(),
  }));
}

export async function runPoolLoop({
  data, dm, candidates, base, first, mode = 'min-km',
  enrichOpts, solveFn, convergeFn,
  maxPoolRounds = 3, minGain = 0.5, candidateCap = 15000, onProgress,
} = {}) {
  const { enrichCandidates, mergePools } = await import('./enrich.js');
  let best = first;
  let pool = candidates;
  let ilpRounds = 0;
  const progress = (msg) => { if (onProgress) onProgress(msg); };

  for (let round = 0; round < maxPoolRounds; round++) {
    const extra = enrichCandidates(data, best, { dm, ...enrichOpts });
    const merged = mergePools(pool, extra, candidateCap);
    if (merged.length === pool.length) break; // nothing new → fixed point
    pool = merged;

    const res = await solveFn(clonePool(pool));
    if (!res || (res.status !== 'Optimal' && res.status !== 'Time limit reached')) break;
    await convergeFn(res);

    const better = mode === 'min-trucks'
      ? res.routeCount < best.routeCount ||
        (res.routeCount === best.routeCount && res.totalDistance < best.totalDistance - minGain)
      : res.totalDistance < best.totalDistance - minGain;
    if (!better) break;
    best = res;
    ilpRounds++;
    progress(`Enriched pool re-solve ${ilpRounds}: ${best.totalDistance} km`);
  }

  return { result: best, ilpRounds };
}
