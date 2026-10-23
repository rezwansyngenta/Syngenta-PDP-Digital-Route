import { test } from 'node:test';
import assert from 'node:assert';
import { exactOrder, routeCost } from '../lib/route-opt.js';

// deterministic symmetric directed matrix helper: dm['A|B'] == dm['B|A']
function makeDm(coords) {
  const dm = {};
  const ids = Object.keys(coords);
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const dx = coords[a][0] - coords[b][0];
      const dy = coords[a][1] - coords[b][1];
      dm[`${a}|${b}`] = Math.hypot(dx, dy);
    }
  }
  return dm;
}

const permCost = (start, perm, dm) => routeCost([start, ...perm], dm);

test('exactOrder equals brute-force optimum on small exhaustive cases', () => {
  const fixtures = [
    { WH: [0, 0], A: [1, 0], B: [2, 3], C: [4, 1] },
    { WH: [0, 0], A: [3, 1], B: [4, 4], C: [1, 5], D: [2, 2] },
    { WH: [0, 0], A: [5, 0], B: [5, 5], C: [0, 5], D: [3, 3], E: [1, 2] },
  ];
  for (const coords of fixtures) {
    const dm = makeDm(coords);
    const ids = Object.keys(coords).filter((k) => k !== 'WH');
    const best = exactOrder('WH', ids, dm);
    const bestCost = permCost('WH', best, dm);
    // exhaustive permutations
    const perms = (arr) => arr.length <= 1 ? [arr]
      : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
    for (const p of perms(ids)) {
      assert.ok(permCost('WH', p, dm) >= bestCost - 1e-9, `exact ${best} beats ${p}`);
    }
  }
});

test('exactOrder is deterministic and returns a valid permutation', () => {
  const dm = makeDm({ WH: [0, 0], A: [1, 2], B: [3, 1], C: [2, 4], D: [4, 3] });
  const ids = ['A', 'B', 'C', 'D'];
  const a = exactOrder('WH', ids, dm);
  const b = exactOrder('WH', ids, dm);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual([...a].sort(), [...ids].sort());
});

test('exactOrder edges: empty, single stop', () => {
  const dm = makeDm({ WH: [0, 0], A: [1, 1] });
  assert.deepStrictEqual(exactOrder('WH', [], dm), []);
  assert.deepStrictEqual(exactOrder('WH', ['A'], dm), ['A']);
});

test('exactOrder refuses too-large routes (caller must fall back to SA)', () => {
  const coords = { WH: [0, 0] };
  for (let i = 0; i < 14; i++) coords[`X${i}`] = [i * 1.1 % 7, i * 0.9 % 5];
  const dm = makeDm(coords);
  assert.strictEqual(exactOrder('WH', Object.keys(coords).filter((k) => k !== 'WH'), dm), null);
});
