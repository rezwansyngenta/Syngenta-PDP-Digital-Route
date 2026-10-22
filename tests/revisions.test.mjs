import { test } from 'node:test';
import assert from 'node:assert';
import { createPlan, newSolverVersion, replaceCurrentDraft, createRevision, computeFinaliseGate } from '../js/state.js';

const mkResult = (n = 1) => ({
  routes: Array.from({ length: n }, (_, i) => ({
    id: `R${i + 1}`, customers: [{ id: `C${i + 1}`, orderVolume: 5, orderValue: 150000000 }],
    volume: 5, value: 150000000, distance: 10, qualifiesBy: 'Value'
  })),
  unassigned: []
});

test('newSolverVersion appends to chain and preserves old plan', () => {
  const p1 = createPlan(mkResult(2), { pmin: 10, vmin: 12, cap: 12 });
  p1.planId = 'solveA';
  const p2 = newSolverVersion(p1, mkResult(3), { pmin: 10, vmin: 12, cap: 12 });
  assert.deepStrictEqual(p2.reSolveChain, ['solveA']);
  assert.strictEqual(p2.routes.length, 3);
});

test('replaceCurrentDraft blocked when a route is Ready', () => {
  const p1 = createPlan(mkResult(1), { pmin: 10, vmin: 12, cap: 12 });
  p1.routes[0].status = 'Ready';
  assert.throws(() => replaceCurrentDraft(p1, mkResult(2), { pmin: 10, vmin: 12, cap: 12 }), /revision/i);
});

test('replaceCurrentDraft allowed when all pending', () => {
  const p1 = createPlan(mkResult(1), { pmin: 10, vmin: 12, cap: 12 });
  const p2 = replaceCurrentDraft(p1, mkResult(2), { pmin: 10, vmin: 12, cap: 12 });
  assert.strictEqual(p2.routes.length, 2);
  assert.strictEqual(p2.planId, p1.planId);
});

test('createRevision copies with revisionOf set and unlocks', () => {
  const p1 = createPlan(mkResult(1), { pmin: 10, vmin: 12, cap: 12 });
  p1.planId = 'solveA';
  p1.finalised = true;
  const rev = createRevision(p1);
  assert.strictEqual(rev.planId, 'solveA_rev1');
  assert.strictEqual(rev.revisionOf, 'solveA');
  assert.strictEqual(rev.finalised, false);
  assert.strictEqual(rev.routes.length, 1);
});
