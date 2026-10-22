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

export function buildLp(candidates) {
  const lines = ['Minimize'];
  const terms = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const cost = c.distance + (c.isUnassigned ? PENALTY : 0);
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
  capMax = 12, vMin = 12, pMin = 10_000_000, timeLimit = 60, highs,
} = {}) {
  const keep = data.orderedIds ? new Set(data.orderedIds) : null;
  const customers = data.customers.filter((c) => !c.excluded && (!keep || keep.has(c.id)));
  const custLookup = new Map(customers.map((c) => [c.id, c]));

  const lp = buildLp(candidates);
  const t0 = performance.now();
  const res = highs.solve(lp, { time_limit: timeLimit });
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
