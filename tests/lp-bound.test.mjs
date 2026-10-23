import { test } from 'node:test';
import assert from 'node:assert';
import { buildLpRelaxed, lpLowerBound } from '../lib/solver.js';

const mk = (route, distance, volume, value) => ({ route, distance, volume, value, isUnassigned: false });

const candidates = [
  mk(['A', 'B', 'C'], 21, 12, 12_000_000),
  mk(['A', 'B'], 9, 8, 8_000_000),
  mk(['C'], 8, 4, 4_000_000),
];

const highsRecording = (result) => {
  const calls = [];
  return {
    calls,
    solve() { calls.push(1); return result; },
  };
};

test('buildLpRelaxed: Continuous section, no Binaries, same rows', () => {
  const lp = buildLpRelaxed(candidates, { mode: 'min-km' });
  assert.match(lp, /Continuous/);
  assert.doesNotMatch(lp, /Binaries/);
  assert.match(lp, / obj: 21\.000 x0 \+ 9\.000 x1 \+ 8\.000 x2/);
  assert.match(lp, / c0: x0 \+ x1 = 1/);
});

test('buildLpRelaxed: countK pins truck count row', () => {
  const lp = buildLpRelaxed(candidates, { mode: 'min-trucks', countK: 2 });
  assert.match(lp, / ccount: x0 \+ x1 \+ x2 = 2/);
  assert.match(lp, /Continuous/);
});

test('lpLowerBound: Optimal returns the bound', async () => {
  const highs = highsRecording({ Status: 'Optimal', ObjectiveValue: 17, Columns: { x1: { Primal: 1 } } });
  const r = await lpLowerBound(candidates, { mode: 'min-km', highs });
  assert.deepStrictEqual(r, { lb: 17, status: 'Optimal' });
});

test('lpLowerBound: non-Optimal status → null (no dishonest bound)', async () => {
  for (const status of ['Unknown', 'Infeasible', 'Error']) {
    const highs = highsRecording({ Status: status, ObjectiveValue: 17, Columns: {} });
    assert.strictEqual(await lpLowerBound(candidates, { mode: 'min-km', highs }), null, status);
  }
});
