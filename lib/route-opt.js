/* Stop-sequence optimisation by simulated annealing. Mirrors python/route_opt.py with enhanced moves. */
import { PyRandom } from './py-random.js';

const cost = (order, dm) => {
  if (!order.length) return 0;
  const k = (a, b) => dm[`${a}|${b}`] ?? 99999; // directed leg a -> b
  let d = k('WH', order[0]);
  for (let i = 0; i < order.length - 1; i++) d += k(order[i], order[i + 1]);
  return d;
};

export function routeCost(order, dm) { return cost(order, dm); }

function twoOptMove(arr, rng, n) {
  if (n < 4) return null;
  const i = rng.randrange(0, n - 2);
  const j = rng.randrange(i + 2, n);
  const next = arr.slice();
  // reverse between i+1 and j
  const rev = next.slice(i + 1, j + 1).reverse();
  return next.slice(0, i + 1).concat(rev, next.slice(j + 1));
}

function orOptMove(arr, rng, n) {
  if (n < 4) return null;
  // move 1 or 2 consecutive stops
  const len = rng.random() < 0.5 ? 1 : 2;
  if (n - len < 2) return null;
  const i = rng.randrange(0, n - len);
  const removed = arr.slice(i, i + len);
  const rest = arr.slice(0, i).concat(arr.slice(i + len));
  if (rest.length < 2) return null;
  let j = rng.randrange(0, rest.length);
  if (j >= i && len === 1) j = rng.randrange(0, rest.length); // try again simply
  // better: pick different position
  j = rng.randrange(0, rest.length + 1);
  if (j > rest.length) j = rest.length;
  if (j === i && rest.length > 0) j = (i + 1) % (rest.length + 1);
  const next = rest.slice(0, j).concat(removed, rest.slice(j));
  return next;
}

export function optimizeOrder(order, dm, iterations = 5000, seed = 42) {
  const rng = new PyRandom(seed);
  if (order.length < 3) return order.slice();

  let best = order.slice();
  let bestCost = cost(best, dm);
  let cur = best.slice();
  let curCost = bestCost;
  const n = cur.length;
  let temp = Math.max(1.0, bestCost * 0.08);

  for (let it = 0; it < iterations; it++) {
    const r = rng.random();
    let next = null;

    if (r < 0.35 && n >= 4) {
      // reverse segment
      const i = rng.randrange(0, n - 1);
      if (i + 2 <= n) {
        const j = rng.randrange(i + 2, n + 1);
        next = cur.slice(0, i).concat(cur.slice(i, j).reverse(), cur.slice(j));
      }
    } else if (r < 0.55 && n >= 4) {
      next = twoOptMove(cur, rng, n);
    } else if (r < 0.75 && n >= 4) {
      next = orOptMove(cur, rng, n);
    } else if (r < 0.9) {
      const [i, j] = rng.sample([...Array(n).keys()], 2);
      if (i !== undefined && j !== undefined) {
        next = cur.slice();
        const t = next[i]; next[i] = next[j]; next[j] = t;
      }
    } else {
      const i = rng.randrange(n);
      const j = rng.randrange(n);
      if (i !== j) {
        next = cur.slice();
        const x = next.splice(i, 1)[0];
        next.splice(j, 0, x);
      }
    }

    if (!next) continue;

    const nextCost = cost(next, dm);
    const delta = nextCost - curCost;
    if (delta <= 0 || rng.random() < Math.exp(-delta / Math.max(temp, 1e-9))) {
      cur = next;
      curCost = nextCost;
      if (curCost < bestCost - 1e-9) { best = cur.slice(); bestCost = curCost; }
    }
    temp *= 0.9993;
  }
  // local 2-opt polish
  let improved = true;
  let curBest = best.slice();
  let curBestCost = cost(curBest, dm);
  for (let pass = 0; pass < 50 && improved; pass++) {
    improved = false;
    for (let i = 0; i < curBest.length - 2; i++) {
      for (let j = i + 2; j < curBest.length; j++) {
        const cand = curBest.slice(0, i + 1).concat(curBest.slice(i + 1, j + 1).reverse(), curBest.slice(j + 1));
        const c2 = cost(cand, dm);
        if (c2 < curBestCost - 1e-9) {
          curBest = cand; curBestCost = c2; improved = true; break;
        }
      }
      if (improved) break;
    }
  }
  return curBest;
}
