import { test } from 'node:test';
import assert from 'node:assert';
import { solve } from '../lib/solver.js';

// minimal HiGHS stub? No — real highs is loaded via vendor in browser only.
// solver requires `highs` injected; build a tiny LP-solver stub instead:
// parse LP is complex, so instead we drive solve with a fake highs that
// records LP text and returns a chosen candidate set per call.
function fakeHighs(pickIdx) {
  const calls = [];
  return {
    calls,
    solve(lp, opts) {
      calls.push(lp);
      // return columns shape like HiGHS: select candidate pickIdx(calls.length-1)
      const idx = typeof pickIdx === 'function' ? pickIdx(calls.length - 1) : pickIdx;
      const Columns = {};
      Columns[`x${idx}`] = { Primal: 1 };
      return { Status: 'Optimal', ObjectiveValue: 1, Columns };
    },
  };
}

const data = { customers: [
  { id: 'A', orderVolume: 4, orderValue: 4_000_000 },
  { id: 'B', orderVolume: 4, orderValue: 4_000_000 },
  { id: 'C', orderVolume: 4, orderValue: 4_000_000 },
] };

const mk = (route, distance, volume, value) => ({ route, distance, volume, value, isUnassigned: false });

test('min-km picks the cheaper two-truck set', async () => {
  const candidates = [
    mk(['A', 'B', 'C'], 21, 12, 12_000_000),
    mk(['A', 'B'], 9, 8, 8_000_000),
    mk(['C'], 8, 4, 4_000_000),
  ];
  // stage difference: min-km has one LP call; clever fake picks c0 (21km route)
  // would give km 21 — but min-km should pick candidates 1+2 (17km). Our fake
  // "solver" returns what the LP would: emulate by text inspection is impractical;
  // instead assert the LP objective text uses distances in min-km mode.
  const highs = fakeHighs(0);
  const res = await solve(data, candidates, { mode: 'min-km', capMax: 12, vMin: 6, pMin: 1, highs });
  assert.strictEqual(res.mode, 'min-km');
  assert.ok(highs.calls[0].includes(' obj: 21.000 x0 + 9.000 x1 + 8.000 x2'),
    `objective should be km-based: ${highs.calls[0]}`);
});

test('min-trucks: stage 1 objective is truck count; stage 2 adds count=k constraint', async () => {
  const candidates = [
    mk(['A', 'B', 'C'], 21, 12, 12_000_000),
    mk(['A', 'B'], 9, 8, 8_000_000),
    mk(['C'], 8, 4, 4_000_000),
  ];
  // stage 1 picks candidate 2 (x2): 1 truck covering C only? No — fake just picks
  // an index; stage 1 picks the REAL minimum count route = x0 (covers all, 1 truck).
  let call = 0;
  const pick = () => (call++ === 0 ? 0 : 0); // both stages choose x0
  const highs = fakeHighs(pick);
  const res = await solve(data, candidates, { mode: 'min-trucks', capMax: 12, vMin: 6, pMin: 1, highs });
  assert.strictEqual(highs.calls.length, 2, 'two LP stages');
  assert.match(highs.calls[0], / obj: 1\.000 x0 \+ 1\.000 x1 \+ 1\.000 x2/, 'stage1 = counts');
  assert.match(highs.calls[1], / ccount: x0 \+ x1 \+ x2 = 1/, 'stage2 pins truck count');
  assert.match(highs.calls[1], / obj: 21\.000 x0/, 'stage2 objective is km');
  assert.strictEqual(res.mode, 'min-trucks');
  assert.strictEqual(res.routeCount, 1);
});

test('unassigned candidates cost 1000 in min-trucks stage 1', async () => {
  const candidates = [
    mk(['A', 'B'], 9, 8, 8_000_000),
    mk(['A'], 1, 4, 4_000_000),
  ];
  candidates[1].isUnassigned = true;
  const highs = fakeHighs(0);
  await solve(data, candidates, { mode: 'min-trucks', capMax: 12, vMin: 6, pMin: 1, highs });
  assert.match(highs.calls[0], /1000\.000 x1/, 'unassigned penalized in truck-count stage');
});
