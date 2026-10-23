/* Pool enrichment: turn a converged solution back into ILP-candidate records
 * so a re-solve can chain multi-move combinations the neighborhood scan can't.
 * Deterministic; strict capacity + OR-qualify guard on BOTH the enriched
 * receiver set and the donor residual a candidate-split implies. */
import { routeDistance } from './candidates.js';

export const setKeyExport = (route) => [...new Set(route)].sort().join(',');

const qualifyOr = (vol, val, vMin, pMin) =>
  vol >= vMin - 1e-9 || val >= pMin - 1e-9;

/* Build candidates from result.routes: the solution sets themselves plus
 * every feasible (receiver∪{c}, donor∖{c}) split. Feasibility is checked for
 * both parts: only if receiver∪{c} fits cap+qualify AND donor residual keeps
 * qualifying (or is empty → nothing to add) do we emit the pair. */
export function enrichCandidates(data, result, { dm, capMax, vMin, pMin, maxExtras = 3000 }) {
  const keep = data.orderedIds ? new Set(data.orderedIds) : null;
  const customers = data.customers.filter((c) => !c.excluded && (!keep || keep.has(c.id)));
  const byId = new Map(customers.map((c) => [c.id, c]));

  const routes = result.routes.map((r) => r.customers.map((c) => c.id));
  const routeStats = routes.map((ids) => {
    let vol = 0, val = 0;
    for (const id of ids) { const c = byId.get(id) || {}; vol += c.orderVolume || 0; val += c.orderValue || 0; }
    return { vol, val };
  });

  const out = [];
  const push = (ids) => {
    if (maxExtras !== undefined && out.length >= maxExtras) return;
    let vol = 0, val = 0;
    for (const id of ids) { const c = byId.get(id) || {}; vol += c.orderVolume || 0; val += c.orderValue || 0; }
    if (vol > capMax + 1e-9) return;
    if (!qualifyOr(vol, val, vMin, pMin)) return;
    out.push({
      route: ids.slice(),
      distance: routeDistance(ids, dm),
      volume: Math.round(vol * 100) / 100,
      value: Math.round(val * 100) / 100,
      isUnassigned: false,
    });
  };

  // solution route sets themselves
  for (const ids of routes) if (ids.length) push(ids);

  // relocate splits: receiver gains c, donor loses c
  for (let i = 0; i < routes.length; i++) {
    const donorIds = routes[i];
    const donor = routeStats[i];
    for (let k = 0; k < donorIds.length; k++) {
      const cid = donorIds[k];
      const c = byId.get(cid) || {};
      const dvol = c.orderVolume || 0, dval = c.orderValue || 0;
      const rVol = donor.vol - dvol, rVal = donor.val - dval;
      // donor residual must still qualify (or be gone)
      if (donorIds.length > 1 && !(qualifyOr(rVol, rVal, vMin, pMin))) continue;
      const residual = donorIds.slice(0, k).concat(donorIds.slice(k + 1));
      for (let j = 0; j < routes.length; j++) {
        if (j === i) continue;
        const receiverIds = routes[j];
        const receiver = routeStats[j];
        const nVol = receiver.vol + dvol, nVal = receiver.val + dval;
        if (nVol > capMax + 1e-9) continue;
        if (!qualifyOr(nVol, nVal, vMin, pMin)) continue;
        push([...new Set([...receiverIds, cid])]);
        if (residual.length) push(residual);
        if (maxExtras !== undefined && out.length >= maxExtras) return out;
      }
    }
  }
  return out;
}

/* Deterministic merge: base pool first (stable indexes), then extras not
 * already present, until cap. */
export function mergePools(base, extras, max_candidates = 15000) {
  const seen = new Set(base.map((c) => setKeyExport(c.route)));
  const merged = base.slice();
  for (const c of extras) {
    if (merged.length >= max_candidates) break;
    const k = setKeyExport(c.route);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(c);
  }
  return merged;
}
