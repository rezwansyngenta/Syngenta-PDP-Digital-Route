/* Stop-sequence optimisation by simulated annealing. Mirrors python/route_opt.py. */
import { PyRandom } from './py-random.js';

const cost = (order, dm) => {
  if (!order.length) return 0;
  const k = (a, b) => dm[a < b ? `${a}|${b}` : `${b}|${a}`] ?? 99999;
  let d = k('WH', order[0]);
  for (let i = 0; i < order.length - 1; i++) d += k(order[i], order[i + 1]);
  return d;
};

export function routeCost(order, dm) { return cost(order, dm); }

export function optimizeOrder(order, dm, iterations = 3000, seed = 42) {
  const rng = new PyRandom(seed);
  if (order.length < 3) return order.slice();

  let best = order.slice();
  let bestCost = cost(best, dm);
  let cur = best.slice();
  let curCost = bestCost;
  const n = cur.length;
  let temp = Math.max(1.0, bestCost * 0.05);

  for (let it = 0; it < iterations; it++) {
    const r = rng.random();
    let next = null;

    if (r < 0.4 && n >= 4) {
      const i = rng.randrange(0, n - 1);
      if (i + 2 > n) continue;
      const j = rng.randrange(i + 2, n + 1);
      next = cur.slice(0, i).concat(cur.slice(i, j).reverse(), cur.slice(j));
    } else if (r < 0.7) {
      const [i, j] = rng.sample([...Array(n).keys()], 2);
      next = cur.slice();
      const t = next[i]; next[i] = next[j]; next[j] = t;
    } else {
      const i = rng.randrange(n);
      const j = rng.randrange(n);
      if (i === j) continue;
      next = cur.slice();
      const x = next.splice(i, 1)[0];
      next.splice(j, 0, x);
    }

    const nextCost = cost(next, dm);
    const delta = nextCost - curCost;
    if (delta <= 0 || rng.random() < Math.exp(-delta / Math.max(temp, 1e-9))) {
      cur = next;
      curCost = nextCost;
      if (curCost < bestCost) { best = cur.slice(); bestCost = curCost; }
    }
    temp *= 0.999;
  }
  return best;
}
