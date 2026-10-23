/* Fixed-point converger: post-ILP improvement over the chosen routes.
 * Moves: relocate (best insertion), swap (index-wise), 2-opt* (tail exchange).
 * Steepest descent, deterministic; exact stop sequencing (Held-Karp) after
 * every applied round, SA fallback only for routes > 13 stops.
 * Guards: strict capacity, OR-qualify predicate (vol >= vMin || val >= pMin)
 * on donor AND receiver. Never empties a route (a qualifying donor
 * can never be left empty, and 2-opt* requires non-empty heads+tails). */
import { routeDistance } from './candidates.js';
import { exactOrder, optimizeOrder } from './route-opt.js';
import { qualify } from './solver.js';

const EPS = 0.5; // minimum km gain required to apply a move (matches old worker)

const qualifiesMove = (vol, val, vMin, pMin) =>
  vol >= vMin - 1e-9 || val >= pMin - 1e-9;

/* Exact-resquence one route in place; sets sequencing flag when SA fallback is used. */
function reseqRoute(route, dm, proofSeq) {
  const ids = route.customers.map((c) => c.id);
  if (!ids.length) { route.distance = 0; return; }
  if (!route.orig_order) { route.orig_order = ids.slice(); route.orig_distance = routeDistance(ids, dm); }
  const byId = new Map(route.customers.map((c) => [c.id, c]));
  let order = exactOrder('WH', ids, dm);
  if (!order) {
    proofSeq.sequencing = 'annealed';
    order = ids.slice();
    let bestD = routeDistance(order, dm);
    for (let s = 0; s < 6; s++) {
      const cand = optimizeOrder(order, dm, 10000, 42 + s * 131542391);
      const cd = routeDistance(cand, dm);
      if (cd < bestD) { bestD = cd; order = cand; }
    }
  }
  route.customers = order.map((id) => byId.get(id));
  route.distance = routeDistance(order, dm);
}

export async function convergeResult(result, { dm, cap, vMin, pMin, mode, maxRounds = 12 }) {
  const proofSeq = { sequencing: 'exact' };
  const routes = result.routes;
  for (const route of routes) reseqRoute(route, dm, proofSeq);

  const vol = (route) => route.customers.reduce((a, c) => a + (c.orderVolume || 0), 0);
  const val = (route) => route.customers.reduce((a, c) => a + (c.orderValue || 0), 0);
  const km = (route) => routeDistance(route.customers.map((c) => c.id), dm);

  let initialKm = routes.reduce((a, r) => a + r.distance, 0);
  let rounds = 0;

  for (; rounds < maxRounds; rounds++) {
    let best = null; // { gain, apply() }
    const base = routes.reduce((a, r) => a + km(r), 0);

    const push = (gain, apply) => {
      if (gain > EPS && (!best || gain > best.gain)) best = { gain, apply };
    };
    const feasible = (niVol, niVal, nrVol, nrVal) =>
      niVol <= cap + 1e-9 &&
      qualifiesMove(niVol, niVal, vMin, pMin) &&
      qualifiesMove(nrVol, nrVal, vMin, pMin);

    for (let i = 0; i < routes.length; i++) {
      for (let j = 0; j < routes.length; j++) {
        if (i === j) continue;
        const ri = routes[i], rj = routes[j];
        const custOf = (id) => ri.customers.find((c) => c.id === id) || rj.customers.find((c) => c.id === id) || {};
        const idsI = ri.customers.map((c) => c.id);
        const idsJ = rj.customers.map((c) => c.id);
        const dI = km(ri), dJ = km(rj);
        const vI = vol(ri), vJ = vol(rj), vlI = val(ri), vlJ = val(rj);

        for (let k = 0; k < idsI.length; k++) {
          const c = ri.customers[k];
          const cvol = c.orderVolume || 0, cval = c.orderValue || 0;

          // relocate c: ri -> rj at best insertion
          {
            const nrVol = vI - cvol, nrVal = vlI - cval;
            const niVol = vJ + cvol, niVal = vlJ + cval;
            if (feasible(niVol, niVal, nrVol, nrVal)) {
              const without = idsI.slice(0, k).concat(idsI.slice(k + 1));
              const dIw = without.length ? routeDistance(without, dm) : 0;
              let bp = -1, bd = Infinity;
              for (let p = 0; p <= idsJ.length; p++) {
                const nd = routeDistance(idsJ.slice(0, p).concat([c.id], idsJ.slice(p)), dm);
                if (nd < bd) { bd = nd; bp = p; }
              }
              const delta = dIw + bd - dI - dJ;
              push(-delta, () =>
                applyMove(routes[i], routes[j], without, idsJ.slice(0, bp).concat([c.id], idsJ.slice(bp))));
            }
          }

          // swap c in ri with d in rj (same index position)
          if (j > i) {
            for (let l = 0; l < idsJ.length; l++) {
              const d = rj.customers[l];
              if (d.id === c.id) continue;
              const dvol = d.orderVolume || 0, dval = d.orderValue || 0;
              const nrVol = vI - cvol + dvol, nrVal = vlI - cval + dval;
              const niVol = vJ - dvol + cvol, niVal = vlJ - dval + cval;
              if (!feasible(niVol, niVal, nrVol, nrVal)) continue;
              const orderI = idsI.slice(); orderI[k] = d.id;
              const orderJ = idsJ.slice(); orderJ[l] = c.id;
              const delta = routeDistance(orderI, dm) + routeDistance(orderJ, dm) - dI - dJ;
              push(-delta, () => applyMove(routes[i], routes[j], orderI, orderJ));
            }
          }

          // 2-opt*: exchange tails between ri and rj
          if (j > i && idsI.length >= 2 && idsJ.length >= 2) {
            for (let a = 1; a < idsI.length; a++) {
              for (let b = 1; b < idsJ.length; b++) {
                const orderI = idsI.slice(0, a).concat(idsJ.slice(b));
                const orderJ = idsJ.slice(0, b).concat(idsI.slice(a));
                if (!orderI.length || !orderJ.length) continue;
                const oIvol = orderI.reduce((x, id) => x + (custOf(id).orderVolume || 0), 0);
                const oJvol = vI + vJ - oIvol;
                const oIval = orderI.reduce((x, id) => x + (custOf(id).orderValue || 0), 0);
                const oJval = vlI + vlJ - oIval;
                if (!feasible(oIvol, oIval, oJvol, oJval)) continue;
                const delta = routeDistance(orderI, dm) + routeDistance(orderJ, dm) - dI - dJ;
                push(-delta, () => applyMove(routes[i], routes[j], orderI, orderJ));
              }
            }
          }
        }
      }
    }

    if (!best) break;
    best.apply(); // applyMove resequences both touched routes exactly
  }

  for (const route of routes) {
    route.volume = vol(route);
    route.value = val(route);
    route.qualifiesBy = qualify(route.volume, route.value, vMin, pMin);
    route.utilisation = cap ? Math.round((route.volume / cap) * 1000) / 1000 : 0;
    route.distance = km(route);
  }

  const finalKm = routes.reduce((a, r) => a + r.distance, 0);
  result.totalDistance = Math.round(finalKm * 100) / 100;
  result.proof = {
    poolStatus: result.status,
    sequencing: proofSeq.sequencing,
    rounds,
    movedKm: Math.round((initialKm - finalKm) * 100) / 100,
    neighborhood: 'relocate+swap+2opt*',
  };

  function applyMove(ri, rj, orderI, orderJ) {
    const byId = new Map([...ri.customers, ...rj.customers].map((c) => [c.id, c]));
    ri.customers = orderI.map((id) => byId.get(id));
    rj.customers = orderJ.map((id) => byId.get(id));
    ri.volume = vol(ri); ri.value = val(ri);
    rj.volume = vol(rj); rj.value = val(rj);
    reseqRoute(ri, dm, proofSeq);
    reseqRoute(rj, dm, proofSeq);
  }

  return result;
}
