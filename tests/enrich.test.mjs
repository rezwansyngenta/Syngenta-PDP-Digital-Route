import { test } from 'node:test';
import assert from 'node:assert';
import { enrichCandidates, mergePools, setKeyExport } from '../lib/enrich.js';

const mk = (rid, ids, volume, value, distance) => ({
  customers: ids.map((id) => ({ id, name: id, bpId: id, orderVolume: volume[id] || 1, orderValue: (value[id] || 1) * 1e7 })),
  volume: ids.reduce((a, id) => a + (volume[id] || 1), 0),
  value: ids.reduce((a, id) => a + ((value[id] || 1) * 1e7), 0),
  distance,
  qualifiesBy: 'Volume',
  orig_order: ids,
  orig_distance: distance,
});

const makeDm = (coords) => {
  const dm = {};
  const ids = Object.keys(coords);
  for (const a of ids)
    for (const b of ids)
      dm[`${a}|${b}`] = Math.hypot(coords[a][0] - coords[b][0], coords[a][1] - coords[b][1]);
  return dm;
};
const coords = { WH: [0, 0], A: [1, 0.2], B: [1.4, 0.1], F: [9, 9], D: [9, 9.4], E: [9.6, 9.2], G: [0.9, 0.4], H: [5, 5] };
const dm = makeDm(coords);

const data = { customers: [
  { id: 'A', orderVolume: 2, orderValue: 5e7 }, { id: 'B', orderVolume: 2, orderValue: 5e7 },
  { id: 'F', orderVolume: 2, orderValue: 1e8 }, { id: 'D', orderVolume: 2, orderValue: 5e7 },
  { id: 'E', orderVolume: 2, orderValue: 5e7 }, { id: 'G', orderVolume: 2, orderValue: 1e8 },
  { id: 'H', orderVolume: 10, orderValue: 9e7 },
] };

const result = {
  status: 'Optimal',
  routes: [
    mk('R1', ['A', 'B', 'F'], { A: 2, B: 2, F: 2 }, { A: 5, B: 5, F: 10 }, 0),
    mk('R2', ['D', 'E', 'G'], { D: 2, E: 2, G: 2 }, { D: 5, E: 5, G: 10 }, 0),
  ],
  unassigned: [],
};

const OPTS = { capMax: 11, vMin: 6, pMin: 1e8 };

test('enrich: solution routes appear as first-class candidates', () => {
  const extras = enrichCandidates(data, result, { dm, ...OPTS });
  const keys = extras.map((c) => setKeyExport(c.route));
  assert.ok(keys.includes('A,B,F'), 'R1 set present');
  assert.ok(keys.includes('D,E,G'), 'R2 set present');
  // F relocated into R2: receiver [D,E,G,F] and donor residual [A,B]
  assert.ok(keys.includes('D,E,F,G'), 'receiver+outlier set present');
  assert.ok(keys.includes('A,B'), 'donor residual set present');
});

test('enrich: candidate records carry correct volume/value and feasibility', () => {
  const extras = enrichCandidates(data, result, { dm, ...OPTS });
  const def = extras.find((c) => setKeyExport(c.route) === 'D,E,F,G');
  assert.strictEqual(def.volume, 8);
  assert.strictEqual(def.value, 3e8);
  assert.strictEqual(def.isUnassigned, false);
  assert.ok(extras.every((c) => c.volume <= OPTS.capMax + 1e-9));
});

test('enrich: over-cap receiver insertion excluded', () => {
  // H (10 MT) cannot join a full 2-MT-capacity... vol 10+2=12 > cap 11
  const res2 = { status: 'Optimal', routes: [
    mk('R1', ['A', 'B', 'F'], { A: 2, B: 2, F: 2 }, { A: 5, B: 5, F: 10 }, 0),
    mk('R3', ['H'], { H: 10 }, { H: 9 }, 0),
  ], unassigned: [] };
  const extras = enrichCandidates(data, res2, { dm, ...OPTS });
  const keys = extras.map((c) => setKeyExport(c.route));
  const mergedUCKeys = keys.filter((k) => /H/.test(k) && k !== 'H');
  const over = mergedUCKeys.find((k) => k === 'A,F,H' || k === 'B,F,H' || k === 'A,B,F,H');
  assert.strictEqual(over, undefined, 'any set with H + R1 content would exceed cap or lack H');
  // residual drops (donor [H] residual after removal → empty) — no sets containing H added
  assert.ok(!keys.some((k) => k.includes('H') && k !== 'H'), 'H sets excluded');
});

test('enrich: donor residual below OR-predicate excluded', () => {
  // single-customer donor loses its only qualifying status: [A,B,F] plus a
  // hypothetical donor [F] alone (val 1e8 qualifies) — use residual failing case:
  // route R4 = [F] alone: removing F empties it → no residual, skip silently.
  const res3 = { status: 'Optimal', routes: [
    mk('R1', ['A', 'B'], { A: 2, B: 2 }, { A: 5, B: 5 }, 0), // residual vol 2 < 6, val 5e7 < 1e8 → Below
    mk('R2', ['D', 'E', 'G'], { D: 2, E: 2, G: 2 }, { D: 5, E: 5, G: 10 }, 0),
  ], unassigned: [] };
  // moving any of A,B into R2 gives residual [B] or [A]: vol 2, val 5e7 → Below → excluded
  const extras = enrichCandidates(data, res3, { dm, ...OPTS });
  const keys = extras.map((c) => setKeyExport(c.route));
  assert.ok(!keys.includes('A'), 'singletons A/B are below OR → excluded');
  assert.ok(!keys.includes('B'), 'singletons A/B are below OR → excluded');
  // and the receiver-side sets from those excluded donors must not appear either
  assert.ok(!keys.includes('A,D,E,G'), 'move depends on infeasible residual');
});

test('mergePools: dedupe keeps base-first, caps total', () => {
  const base = [
    { route: ['A', 'B'], distance: 1, volume: 2, value: 2, isUnassigned: false },
  ];
  const extras = [
    { route: ['A', 'B'], distance: 5, volume: 2, value: 2, isUnassigned: false }, // dup
    { route: ['C'], distance: 2, volume: 1, value: 1, isUnassigned: false },
    { route: ['D'], distance: 3, volume: 1, value: 1, isUnassigned: false },
  ];
  const merged = mergePools(base, extras, 2);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(setKeyExport(merged[0].route), 'A,B'); // base kept its own record
  assert.ok(merged.every((c) => setKeyExport(merged[0].route) === 'A,B' ? true : c.distance !== 5), 'dup not re-added');
});
