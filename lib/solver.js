/* Set-covering ILP solved with HiGHS (WASM). Mirrors python/solver.py. */

export const PENALTY = 10_000;

export function qualify(volume, value, vMin = 12, pMin = 10_000_000) {
  const byVol = volume >= vMin - 1e-9;
  const byVal = value >= pMin - 1e-9;
  if (byVol && byVal) return 'Both';
  if (byVol) return 'Volume';
  if (byVal) return 'Value';
  return 'Below';
}

export function buildLp(candidates, { mode = 'min-km', countK = null } = {}) {
  const lines = ['Minimize'];
  const terms = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    // min-trucks stage 1: one penalty unit per real truck, huge cost for
    // fail-to-assign singletons; min-trucks stage 2 (countK set) is km-based.
    const cost = mode === 'min-trucks' && countK === null
      ? (c.isUnassigned ? 1000 : 1)
      : c.distance + (c.isUnassigned ? PENALTY : 0);
    terms[i] = `${cost.toFixed(3)} x${i}`;
  }
  lines.push(' obj: ' + terms.join(' + '));

  lines.push('Subject To');
  const covering = new Map();
  for (let i = 0; i < candidates.length; i++) {
    for (const cid of candidates[i].route) {
      let arr = covering.get(cid);
      if (!arr) { arr = []; covering.set(cid, arr); }
      arr.push(i);
    }
  }
  let row = 0;
  for (const [, idxs] of covering) {
    lines.push(` c${row++}: ` + idxs.map((i) => `x${i}`).join(' + ') + ' = 1');
  }

  // min-trucks stage 2: pin the truck count found by stage 1
  if (countK !== null) {
    const realIdx = candidates.map((c, i) => (c.isUnassigned ? null : i)).filter((v) => v !== null);
    lines.push(` ccount: ` + realIdx.map((i) => `x${i}`).join(' + ') + ` = ${countK}`);
  }

  lines.push('Binaries');
  lines.push(' ' + candidates.map((_, i) => `x${i}`).join(' '));
  lines.push('End');
  return lines.join('\n');
}

/**
 * @param {object} data       buildData output (needs warehouse + customers)
 * @param {object[]} candidates  generateCandidates output
 * @param {object} opts       { capMax, vMin, pMin, timeLimit, highs }
 */
export async function solve(data, candidates, {
  capMax = 12, vMin = 12, pMin = 10_000_000, timeLimit = 60, highs, mode = 'min-km',
} = {}) {
  const keep = data.orderedIds ? new Set(data.orderedIds) : null;
  const customers = data.customers.filter((c) => !c.excluded && (!keep || keep.has(c.id)));
  const custLookup = new Map(customers.map((c) => [c.id, c]));

  const lps = [];
  let lp = buildLp(candidates, { mode });
  let relaxK = null;
  if (mode === 'min-trucks') {
    // stage 1: fewest trucks
    const r1 = highs.solve(lp, { time_limit: timeLimit });
    const k1 = Object.entries(r1.Columns || {})
      .filter(([, col]) => col.Primal > 0.5)
      .map(([name]) => Number(name.replace(/^x/, '')))
      .filter((idx) => candidates[idx] && !candidates[idx].isUnassigned)
      .length;
    relaxK = k1;
    lp = buildLp(candidates, { mode, countK: k1 });
  } else {
    lps.push(lp);
  }
  const t0 = performance.now();
  let res = highs.solve(lp, { time_limit: timeLimit });
  // stage-2 at the pinned count can be infeasible in edge cases; relax once
  if (mode === 'min-trucks' && res.Status !== 'Optimal' && res.Status !== 'Time limit reached') {
    relaxK += 1;
    lp = buildLp(candidates, { mode, countK: relaxK });
    const res2 = highs.solve(lp, { time_limit: timeLimit });
    if (res2.Status === 'Optimal' || res2.Status === 'Time limit reached') res = res2;
  }
  const solveTime = Math.round(performance.now() - t0) / 1000;

  const status = res.Status || 'Unknown';
  const selectedRoutes = [];
  const unassigned = [];

  if (status === 'Optimal' || status === 'Time limit reached' || res.Columns) {
    for (const [name, col] of Object.entries(res.Columns || {})) {
      if (!(col.Primal > 0.5)) continue;
      const idx = Number(name.replace(/^x/, ''));
      const cand = candidates[idx];
      if (!cand) continue;
      if (cand.isUnassigned) {
        const cid = cand.route[0];
        const c = custLookup.get(cid) || {};
        const reason = (c.orderVolume || 0) > capMax
          ? `Single order ${(c.orderVolume || 0).toFixed(1)} MT exceeds truck capacity ${capMax} MT`
          : 'No feasible qualifying route found';
        unassigned.push({ customerId: cid, reason });
      } else {
        selectedRoutes.push(cand);
      }
    }
  }

  for (const route of selectedRoutes) {
    route.customers = route.route.map((cid) => {
      const c = custLookup.get(cid) || {};
      return {
        id: cid,
        name: c.name || '',
        bpId: c.bpId || '',
        orderVolume: c.orderVolume || 0,
        orderValue: c.orderValue || 0,
      };
    });
    route.qualifiesBy = qualify(route.volume, route.value, vMin, pMin);
    route.utilisation = capMax ? Math.round((route.volume / capMax) * 1000) / 1000 : 0;
    delete route.isUnassigned;
  }

  return {
    status,
    mode,
    objectiveValue: status === 'Optimal' ? Math.round((res.ObjectiveValue ?? 0) * 100) / 100 : null,
    solveTime,
    routeCount: selectedRoutes.length,
    unassignedCount: unassigned.length,
    totalDistance: Math.round(selectedRoutes.reduce((a, r) => a + r.distance, 0) * 100) / 100,
    routes: selectedRoutes,
    unassigned,
    solverInfo: { solver: 'HiGHS (WASM)', candidateCount: candidates.length, penalty: PENALTY },
  };
}
