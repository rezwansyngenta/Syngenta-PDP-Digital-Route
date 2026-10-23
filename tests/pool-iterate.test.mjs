import { test } from 'node:test';
import assert from 'node:assert';
import { runPoolLoop, clonePool } from '../lib/pool-iterate.js';
import { setKeyExport } from '../lib/enrich.js';

const base = [
  { route: ['A'], distance: 9, volume: 8, value: 8e7, isUnassigned: false },
  { route: ['B', 'C'], distance: 8, volume: 4, value: 4e7, isUnassigned: false },
];

const mkResult = (km, { routeCount = 2, status = 'Optimal' } = {}) => ({
  status,
  mode: 'min-km',
  routeCount,
  totalDistance: km,
  routes: [{ customers: [{ id: 'A', name: 'A', bpId: 'A', orderVolume: 8, orderValue: 8e7 }] },
           { customers: [{ id: 'B', name: 'B', bpId: 'B', orderVolume: 2, orderValue: 2e7 },
                         { id: 'C', name: 'C', bpId: 'C', orderVolume: 2, orderValue: 2e7 }] }],
  unassigned: [],
});

const data = { customers: [
  { id: 'A', orderVolume: 8, orderValue: 8e7 },
  { id: 'B', orderVolume: 2, orderValue: 2e7 },
  { id: 'C', orderVolume: 2, orderValue: 2e7 },
] };
const dm = { 'WH|A': 9, 'A|WH': 9, 'WH|B': 4, 'B|WH': 4, 'WH|C': 4, 'C|WH': 4, 'B|C': 4, 'C|B': 4, 'A|B': 5, 'B|A': 5, 'A|C': 5, 'C|A': 5, 'WH|WH': 0 };
const enrichOpts = { capMax: 12, vMin: 6, pMin: 1e8 };

test('clonePool: copy preserves records; original not mutated', () => {
  const pool = [{ route: ['A'], distance: 1, volume: 2, value: 2, isUnassigned: true }];
  const c = clonePool(pool);
  assert.strictEqual(c[0].isUnassigned, true);
  c[0].route.push('X');
  assert.deepStrictEqual(pool[0].route, ['A']);
});

test('pool loop: accepts an improving re-solve, counts it, stops at fixed point', async () => {
  let call = 0;
  const solveFn = async (pool) => {
    call++;
    return mkResult(17);
  };
  const convergeFn = async (res) => {
    // one-time improvement: converge 17 → 14, then nothing further improves
    res.totalDistance = call === 1 ? 14 : 17;
    return res;
  };
  const first = mkResult(15);
  const r = await runPoolLoop({
    data, dm, candidates: base, base, first,
    mode: 'min-km', enrichOpts, solveFn, convergeFn,
  });
  assert.strictEqual(r.ilpRounds, 1);
  assert.strictEqual(r.result.totalDistance, 14);
  assert.strictEqual(call, 1, 'second round enriches nothing new → stops without re-solve');
});

test('pool loop: rejects a worse re-solve and keeps the best', async () => {
  let call = 0;
  const solveFn = async () => mkResult(17);
  const convergeFn = async (res) => {
    call++;
    res.totalDistance = call === 1 ? 16 : 17; // worse than best 15
    return res;
  };
  const r = await runPoolLoop({
    data, dm, candidates: base, base, first: mkResult(15),
    mode: 'min-km', enrichOpts, solveFn, convergeFn,
  });
  assert.strictEqual(r.ilpRounds, 0);
  assert.strictEqual(r.result.totalDistance, 15);
  assert.strictEqual(call, 1, 'stop after first non-improving re-solve');
});

test('pool loop: rejects gains below minGain', async () => {
  let call = 0;
  const solveFn = async () => mkResult(17);
  const convergeFn = async (res) => {
    call++;
    res.totalDistance = call === 1 ? 14.6 : 15; // 15 − 14.6 = 0.4 < minGain 0.5
    return res;
  };
  const r = await runPoolLoop({
    data, dm, candidates: base, base, first: mkResult(15),
    mode: 'min-km', enrichOpts: { ...enrichOpts }, solveFn, convergeFn,
  });
  assert.strictEqual(r.ilpRounds, 0);
  assert.strictEqual(r.result.totalDistance, 15);
});

test('pool loop: min-trucks rejects higher truck count, accepts lower', async () => {
  let call = 0;
  let r = await runPoolLoop({
    data, dm, candidates: base, base, first: mkResult(15, { routeCount: 1 }),
    mode: 'min-trucks', enrichOpts,
    solveFn: async () => mkResult(5, { routeCount: ++call === 1 ? 2 : 2 }),
    convergeFn: async (res) => { res.totalDistance = call === 1 ? 5 : 15; res.routeCount = call === 1 ? 2 : 1; return res; },
  });
  assert.strictEqual(r.ilpRounds, 0, '2 trucks > 1: rejected even with km 5');

  call = 0;
  r = await runPoolLoop({
    data, dm, candidates: base, base, first: mkResult(15, { routeCount: 2 }),
    mode: 'min-trucks', enrichOpts,
    solveFn: async () => mkResult(18),
    convergeFn: async (res) => { call++; res.totalDistance = 18; res.routeCount = 1; return res; },
  });
  assert.strictEqual(r.ilpRounds, 1, 'fewer trucks = lexicographically better');
  assert.strictEqual(r.result.routeCount, 1);
});

test('pool loop: stops without re-solving when enrichment adds nothing', async () => {
  let calls = 0;
  const solveFn = async () => { calls++; return mkResult(17); };
  const single = { status: 'Optimal', routes: [{ customers: [{ id: 'A', orderVolume: 8, orderValue: 8e7 }] }], unassigned: [] };
  const first = { ...single, totalDistance: 15, routeCount: 1 };
  const r = await runPoolLoop({
    data, dm, candidates: [{ route: ['A'], distance: 9, volume: 8, value: 8e7, isUnassigned: false }],
    base: [{ route: ['A'], distance: 9, volume: 8, value: 8e7, isUnassigned: false }],
    first, mode: 'min-km', enrichOpts, solveFn, convergeFn: async (x) => x,
  });
  assert.strictEqual(calls, 0, 'solution ⊆ base pool → no enrichment, no re-solve');
  assert.strictEqual(r.ilpRounds, 0);
  assert.strictEqual(r.result.totalDistance, 15);
});
