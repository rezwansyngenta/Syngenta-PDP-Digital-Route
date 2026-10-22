import { test } from 'node:test';
import assert from 'node:assert';
import { buildSummaryRows, buildDecisionRows, buildStopRows, buildPlanArchive, decisionCodeFor } from '../js/export.js';
import { createPlan } from '../js/state.js';

const mkPlan = () => {
  const result = {
    routes: [
      { id: 'BOG-01', customers: [{ id: 'C1', bpId: 'BP-1', name: 'Shop 1', orderVolume: 12, orderValue: 200000000 }], volume: 12, value: 200000000, distance: 42.5, qualifiesBy: 'Both' },
      { id: 'BOG-05', customers: [{ id: 'C2', bpId: 'BP-2', name: 'Shop 2', orderVolume: 3, orderValue: 40000000 }], volume: 3, value: 40000000, distance: 9, qualifiesBy: 'Below' }
    ],
    unassigned: []
  };
  return createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
};

test('summary rows carry status, reason, version, source', () => {
  const plan = mkPlan();
  plan.routes[0].status = 'Ready';
  plan.routes[0].geometrySource = 'local-road';
  plan.routes[1].status = 'Excluded / deferred';
  plan.routes[1].reason = 'Merged into BOG-01';
  const rows = buildSummaryRows(plan);
  assert.strictEqual(rows[0].length, 12);
  assert.strictEqual(rows[1][1], 'Ready');
  assert.strictEqual(rows[2][1], 'Excluded / deferred');
  assert.strictEqual(rows[2][9], 'Merged into BOG-01');
  assert.ok(rows[0].includes('Distance source'));
});

test('decision codes exact for pool and merged routes', () => {
  const plan = mkPlan();
  plan.unassignedPool = [
    { bp: { id: 'C9', bpId: 'BP-9', name: 'Shop 9', vol: 2, val: 30000000 }, from: 'BOG-01', decision: 'ACCEPTED_UNASSIGNED', reason: null },
    { bp: { id: 'C8', bpId: 'BP-8', name: 'Shop 8', vol: 2, val: 30000000 }, from: 'BOG-01', decision: 'DEFERRED_FUTURE_PLAN', reason: 'no truck' }
  ];
  plan.routes[1].status = 'Excluded / deferred';
  plan.routes[1].reason = 'Merged into BOG-01';
  const rows = buildDecisionRows(plan);
  assert.strictEqual(rows[0][4], 'Decision code');
  assert.ok(rows.some(r => r[0] === 'BP-9' && r[4] === 'ACCEPTED_UNASSIGNED'));
  assert.ok(rows.some(r => r[0] === 'BP-8' && r[4] === 'DEFERRED_FUTURE_PLAN'));
  assert.ok(rows.some(r => r[0] === 'BP-2' && r[4] === 'MERGED_INTO_ROUTE:BOG-01'));
});

test('decisionCodeFor empty when undecided', () => {
  assert.strictEqual(decisionCodeFor({ decision: null }), '');
  assert.strictEqual(decisionCodeFor({ decision: 'ACCEPTED_UNASSIGNED' }), 'ACCEPTED_UNASSIGNED');
});

test('stop rows and archive', () => {
  const plan = mkPlan();
  const stops = buildStopRows(plan);
  assert.strictEqual(stops.length, 3);
  const archive = buildPlanArchive(plan, { legs: 4 });
  assert.strictEqual(archive.planId, plan.planId);
  assert.deepStrictEqual(archive.geometryRefs, { legs: 4 });
  assert.strictEqual(archive.routes.length, 2);
});
