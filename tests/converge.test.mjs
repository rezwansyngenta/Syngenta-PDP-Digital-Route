import { test } from 'node:test';
import assert from 'node:assert';
import { convergeResult } from '../lib/converge.js';

const mk = (rid, ids, volume, value, distance) => ({
  customers: ids.map((id) => ({ id, name: id, bpId: id, orderVolume: volume[id] || 1, orderValue: (value[id] || 1) * 1e7 })),
  volume: ids.reduce((a, id) => a + (volume[id] || 1), 0),
  value: ids.reduce((a, id) => a + ((value[id] || 1) * 1e7), 0),
  distance,
  qualifiesBy: 'Volume',
  orig_order: ids,
  orig_distance: distance,
});

// WH at origin; stops on a line. Directed symmetric key dm['A|B'].
const makeDm = (coords) => {
  const dm = {};
  const ids = Object.keys(coords);
  for (const a of ids) {
    dm[`WH|${a}`] = dm[`${a}|WH`] = Math.hypot(...coords[a]);
    for (const b of ids) dm[`${a}|${b}`] = dm[`${b}|${a}`] = Math.hypot(coords[a][0] - coords[b][0], coords[a][1] - coords[b][1]);
  }
  return dm;
};

const OPTS = { cap: 12, vMin: 6, pMin: 10 * 1e7 };

test('converge: relocate the far pair into the near-cluster route reduces km and converges', async () => {
  // Two opposite clusters, each polluted with one outlier from the other side.
  // Relocating the outliers back reduces total km; a second pass finds nothing.
  const coords = {
    WH: [0, 0],
    A: [1, 0.2], B: [1.4, 0.1],
    F: [9, 9],   // outlier on R1 that belongs near D,E
    D: [9, 9.4], E: [9.6, 9.2],
    G: [0.9, 0.4], // outlier on R2 that belongs near A,B
  };
  const dm = makeDm(coords);
  const result = {
    status: 'Optimal',
    routes: [
      mk('R1', ['A', 'B', 'F'], { A: 2, B: 2, F: 2 }, { A: 5, B: 5, F: 10 }, 0),
      mk('R2', ['D', 'E', 'G'], { D: 2, E: 2, G: 2 }, { D: 5, E: 5, G: 10 }, 0),
    ],
    unassigned: [],
  };
  const res = await convergeResult(result, { dm, ...OPTS, mode: 'min-km' });
  assert.ok(res.proof, 'proof object present');
  assert.ok(['exact', 'annealed'].includes(res.proof.sequencing));
  assert.ok(res.proof.movedKm > 5, `outlier relocation should save km, got ${res.proof && res.proof.movedKm}`);
  // after convergence, second pass changes nothing
  const before = res.totalDistance;
  const res2 = await convergeResult(res, { dm, ...OPTS, mode: 'min-km' });
  assert.strictEqual(res2.totalDistance, before, 'already at fixed point');
});

test('converge: capacity guard — over-cap relocation never applied', async () => {
  const coords = { WH: [0, 0], A: [1, 1], B: [5, 5] };
  const dm = makeDm(coords);
  const result = {
    status: 'Optimal',
    routes: [
      mk('R1', ['A'], { A: 10 }, { A: 10 }, 0),
      mk('R2', ['B'], { B: 2 }, { B: 2 }, 0),
    ],
    unassigned: [],
  };
  const res = await convergeResult(result, { dm, cap: 11, vMin: OPTS.vMin, pMin: OPTS.pMin, mode: 'min-km' });
  const r1 = res.routes.find((r) => r.customers.some((c) => c.id === 'A'));
  const r2 = res.routes.find((r) => r.customers.some((c) => c.id === 'B'));
  assert.strictEqual(r1.customers.length, 1, '10+2=12 > cap 11');
  assert.strictEqual(r2.customers.length, 1);
  assert.ok(res.routes.every((r) => r.volume <= 11 + 1e-9));
});

test('converge: qualify guard — donor below OR-predicate never empties/breaks', async () => {
  // donor route at exactly vMin loses its only qualifying status if it ships one away.
  const coords = { WH: [0, 0], A: [1, 0], B: [2, 0], X: [5, 5] };
  const dm = makeDm(coords);
  const result = {
    status: 'Optimal',
    routes: [
      mk('R1', ['A', 'B'], { A: 3, B: 3 }, { A: 3, B: 3 }, 0), // vol 6 == vMin: qualifying
      mk('R2', ['X'], { X: 1 }, { X: 1 }, 0),
    ],
    unassigned: [],
  };
  const res = await convergeResult(result, { dm, ...OPTS, mode: 'min-km' });
  const r1 = res.routes.find((r) => r.customers.length === 2 || r.customers.some((c) => c.id === 'A'));
  assert.ok(
    r1.qualifiesBy !== 'Below',
    'donor must not be pushed below the OR-predicate',
  );
});

test('converge: min-trucks never empties a route', async () => {
  const coords = { WH: [0, 0], A: [1, 0], B: [2, 0], C: [9, 0] };
  const dm = makeDm(coords);
  const result = {
    status: 'Optimal',
    routes: [
      mk('R1', ['A', 'B'], { A: 3, B: 3 }, { A: 3, B: 3 }, 0),
      mk('R2', ['C'], { C: 2 }, { C: 2 }, 0),
    ],
    unassigned: [],
  };
  const res = await convergeResult(result, { dm, ...OPTS, mode: 'min-trucks' });
  // each route keeps >= 1 customer: construction would merge C into R1 (vol 8 <= cap)
  // but that empties R2 — forbidden in min-trucks (count pinned by stage-1)
  assert.strictEqual(
    res.routes.filter((r) => r.customers.length > 0).length,
    2,
    'truck count preserved',
  );
});

test('converge: proof carries rounds, km moved and neighborhood tag', async () => {
  const coords = { WH: [0, 0], A: [1, 1], B: [2, 2] };
  const dm = makeDm(coords);
  const result = { status: 'Optimal', routes: [mk('R1', ['A', 'B'], { A: 2, B: 2 }, { A: 2, B: 2 }, 0)], unassigned: [] };
  const res = await convergeResult(result, { dm, ...OPTS, mode: 'min-km' });
  assert.strictEqual(typeof res.proof.rounds, 'number');
  assert.strictEqual(res.proof.poolStatus, 'Optimal');
  assert.strictEqual(res.proof.neighborhood, 'relocate+swap+2opt*');
});
