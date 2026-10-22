/* Candidate route generation. Mirrors python/candidates.py. */
import { PyRandom } from './py-random.js';

export const dist = (a, b, dm) => {
  const v = dm[`${a}|${b}`]; // directed: a -> b, no reverse substitution
  return v == null ? 99999 : v;
};

export function routeDistance(route, dm) {
  if (!route.length) return 0;
  let d = dist('WH', route[0], dm);
  for (let i = 0; i < route.length - 1; i++) d += dist(route[i], route[i + 1], dm);
  return Math.round(d * 100) / 100;
}

export function twoOpt(route, dm) {
  if (route.length < 3) return route;
  let best = route.slice();
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        const cand = best.slice(0, i + 1).concat(best.slice(i + 1, j + 1).reverse(), best.slice(j + 1));
        if (routeDistance(cand, dm) < routeDistance(best, dm)) { best = cand; improved = true; }
      }
    }
  }
  return best;
}

export function isFeasible(vol, val, capMax, vMin, pMin, vTol, pTol) {
  if (vol > capMax) return false;
  return vol >= vMin - vTol || val >= pMin - pTol;
}

function radialOrder(custs, dm) {
  // sort by bearing/angle from WH to minimize backtracking
  const withAngle = custs.map((c) => {
    const dx = c.lon - (c.whLon || 0);
    const dy = c.lat - (c.whLat || 0);
    const ang = Math.atan2(dy, dx);
    return { c, ang };
  });
  withAngle.sort((a, b) => a.ang - b.ang);
  return withAngle.map((x) => x.c.id);
}

function nnRandomStarts(customers, dm, nCandidates, capMax, vMin, pMin, vTol, pTol, seed = 42) {
  const rng = new PyRandom(seed);
  const out = [];
  // also add some radial-started routes
  for (let n = 0; n < Math.max(nCandidates, 200); n++) {
    const remaining = customers.slice();
    if (n < 50) {
      // radial-ish start
      remaining.sort((a, b) => {
        const da = dist('WH', a.id, dm) + dist(a.id, b.id, dm) * 0.001;
        const db = dist('WH', b.id, dm);
        return da - db;
      });
    } else {
      rng.shuffle(remaining);
    }
    const route = [];
    let vol = 0, val = 0;

    const seedC = remaining.shift();
    route.push(seedC.id);
    vol += seedC.orderVolume;
    val += seedC.orderValue;

    while (remaining.length) {
      const last = route[route.length - 1];
      let bestC = null, bestD = Infinity, bestIdx = -1;
      // blend distance to last and distance from WH to encourage radial routes
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i];
        if (vol + c.orderVolume > capMax) continue;
        const dLast = dist(last, c.id, dm);
        const dWh = dist('WH', c.id, dm);
        const d = dLast * 0.7 + dWh * 0.0001; // prefer continuing in similar direction
        if (d < bestD) { bestD = d; bestC = c; bestIdx = i; }
      }
      if (!bestC) break;
      route.push(bestC.id);
      vol += bestC.orderVolume;
      val += bestC.orderValue;
      remaining.splice(bestIdx, 1);
    }

    if (route.length >= 2 && isFeasible(vol, val, capMax, vMin, pMin, vTol, pTol)) {
      out.push(twoOpt(route, dm));
    }
  }
  return out;
}

function farthestSeedClustering(customers, dm, k, capMax, vMin, pMin, vTol, pTol) {
  const list = customers.slice();
  if (list.length < k) k = list.length;
  const byId = new Map(list.map((c) => [c.id, c]));

  const seeded = list.slice().sort((a, b) => dist('WH', b.id, dm) - dist('WH', a.id, dm)).slice(0, k);
  const seeds = seeded.map((c) => c.id);

  const routes = new Map(seeds.map((s) => [s, []]));
  const routeVol = new Map(seeds.map((s) => [s, 0]));
  const routeVal = new Map(seeds.map((s) => [s, 0]));
  const assigned = new Set(seeds);

  for (const c of list) {
    if (assigned.has(c.id)) continue;
    let bestSeed = null, bestD = Infinity;
    for (const s of seeds) {
      const d = dist(c.id, s, dm);
      if (d < bestD) { bestD = d; bestSeed = s; }
    }
    routes.get(bestSeed).push(c.id);
    routeVol.set(bestSeed, routeVol.get(bestSeed) + c.orderVolume);
    routeVal.set(bestSeed, routeVal.get(bestSeed) + c.orderValue);
    assigned.add(c.id);
  }

  const out = [];
  for (const s of seeds) {
    const members = [s, ...routes.get(s)];
    const vol = routeVol.get(s) + byId.get(s).orderVolume;
    const val = routeVal.get(s) + byId.get(s).orderValue;

    if (vol <= capMax && isFeasible(vol, val, capMax, vMin, pMin, vTol, pTol)) {
      out.push(twoOpt(members, dm));
    } else if (members.length > 1) {
      for (let start = 0; start < members.length; start += 3) {
        const chunk = members.slice(start, start + 3);
        if (!chunk.length) continue;
        let cv = 0, cval = 0;
        for (const cid of chunk) { cv += byId.get(cid).orderVolume; cval += byId.get(cid).orderValue; }
        if (isFeasible(cv, cval, capMax, vMin, pMin, vTol, pTol)) out.push(twoOpt(chunk, dm));
      }
    }
  }
  return out;
}

function volumePacking(customers, dm, capMax, vMin, pMin, vTol, pTol) {
  const list = customers.slice().sort((a, b) => b.orderVolume - a.orderVolume);
  const out = [];
  const used = new Set();

  for (const seed of list) {
    if (used.has(seed.id)) continue;
    const route = [seed.id];
    let vol = seed.orderVolume, val = seed.orderValue;
    used.add(seed.id);

    for (const c of list) {
      if (used.has(c.id)) continue;
      if (vol + c.orderVolume > capMax) continue;
      route.push(c.id);
      vol += c.orderVolume;
      val += c.orderValue;
      used.add(c.id);
      if (vol >= vMin - vTol || val >= pMin - pTol) break;
    }

    if (isFeasible(vol, val, capMax, vMin, pMin, vTol, pTol)) out.push(twoOpt(route, dm));
  }
  return out;
}

function pairingHeuristic(customers, dm, capMax, vMin, pMin, vTol, pTol, allowTriples = true) {
  const out = [];
  const list = customers;
  const n = list.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = list[i], b = list[j];
      const vol = a.orderVolume + b.orderVolume;
      const val = a.orderValue + b.orderValue;
      if (vol > capMax) continue;
      if (vol >= vMin - vTol || val >= pMin - pTol) out.push(twoOpt([a.id, b.id], dm));
    }
  }

  if (allowTriples && n <= 300) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let k = j + 1; k < n; k++) {
          const a = list[i], b = list[j], c = list[k];
          const vol = a.orderVolume + b.orderVolume + c.orderVolume;
          const val = a.orderValue + b.orderValue + c.orderValue;
          if (vol > capMax) continue;
          if (vol >= vMin - vTol || val >= pMin - pTol) out.push(twoOpt([a.id, b.id, c.id], dm));
        }
      }
    }
  }
  return out;
}

const setKey = (route) => [...new Set(route)].sort().join(',');

export function generateCandidates(data, {
  nNn = 500,
  capMax = 12,
  vMin = 12,
  pMin = 10_000_000,
  vTol = 0,
  pTol = 0,
  seed = 42,
  maxTripleN = 60,
  maxCandidates = 15000,
} = {}) {
  const keep = data.orderedIds ? new Set(data.orderedIds) : null;
  const customers = data.customers.filter((c) => !c.excluded && (!keep || keep.has(c.id)));
  const dm = data.distMatrix;

  const raw = [];
  raw.push(...nnRandomStarts(customers, dm, nNn, capMax, vMin, pMin, vTol, pTol, seed));

  const nCust = customers.length;
  const step = Math.max(1, Math.floor(nCust / 20));
  for (let k = Math.max(3, Math.floor(nCust / 20)); k <= Math.max(4, Math.floor(nCust / 5)); k += step) {
    raw.push(...farthestSeedClustering(customers, dm, k, capMax, vMin, pMin, vTol, pTol));
  }

  raw.push(...volumePacking(customers, dm, capMax, vMin, pMin, vTol, pTol));
  raw.push(...pairingHeuristic(customers, dm, capMax, vMin, pMin, vTol, pTol, customers.length <= maxTripleN));
  raw.push(...customers.map((c) => [c.id]));

  const seen = new Set();
  const unique = [];
  for (const r of raw) {
    const key = setKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
    if (unique.length >= maxCandidates) break;
  }

  const byId = new Map(customers.map((c) => [c.id, c]));
  return unique.map((route) => {
    let vol = 0, val = 0;
    for (const cid of route) {
      const c = byId.get(cid);
      if (c) { vol += c.orderVolume; val += c.orderValue; }
    }
    const singleOk = route.length === 1 && isFeasible(vol, val, capMax, vMin, pMin, vTol, pTol);
    return {
      route,
      distance: routeDistance(route, dm),
      volume: Math.round(vol * 100) / 100,
      value: Math.round(val * 100) / 100,
      isUnassigned: route.length === 1 && !singleOk,
    };
  });
}
