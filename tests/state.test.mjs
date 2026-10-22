import { test } from 'node:test';
import assert from 'node:assert';
import { createPlan, bumpVersion, pushAudit, recomputeDerived, STATUSES, REASON_CATEGORIES } from '../js/state.js';

test('createPlan defaults', () => {
  const result = {
    routes: [{ id: 'R01', customers: [{ id: 'C1', orderVolume: 1, orderValue: 10000000 }], volume: 1, value: 10000000, distance: 10, qualifiesBy: 'Value' }],
    unassigned: []
  };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  assert.strictEqual(plan.routes[0].status, 'Pending review');
  assert.strictEqual(plan.routes[0].version, 0);
  assert.ok(Array.isArray(plan.routes[0].history));
  assert.deepStrictEqual(plan.params, { pmin: 10, vmin: 12, cap: 12 });
});

test('bumpVersion increments', () => {
  const route = { version: 0 };
  bumpVersion(route);
  assert.strictEqual(route.version, 1);
  bumpVersion(route);
  assert.strictEqual(route.version, 2);
});

test('pushAudit records before/after with paramsSnapshot', () => {
  const route = { history: [], version: 1 };
  pushAudit(route, {
    type: 'edit',
    version: 2,
    before: { km: 10, MT: 5, cr: 1, status: 'Pending review' },
    after: { km: 12, MT: 5, cr: 1, status: 'Pending review' },
    paramsSnapshot: { pmin: 10, vmin: 12, cap: 12 }
  });
  assert.strictEqual(route.history.length, 1);
  assert.strictEqual(route.history[0].type, 'edit');
  assert.deepStrictEqual(route.history[0].paramsSnapshot, { pmin: 10, vmin: 12, cap: 12 });
});

test('recomputeDerived uses directed keys, no reverse substitution', () => {
  const route = { customers: [{ id: 'C1', orderVolume: 5, orderValue: 50000000 }] };
  const dm = {
    'WH|C1': 10,
    'C1|WH': 15 // different direction - must not be used
  };
  const res = recomputeDerived(route, dm, { pmin: 10, vmin: 12, cap: 12 });
  assert.strictEqual(res.distance, 10);
});

test('recomputeDerived throws if missing directed leg', () => {
  const route = { customers: [{ id: 'C1', orderVolume: 5, orderValue: 50000000 }] };
  const dm = { 'C1|WH': 15 }; // missing WH|C1
  assert.throws(() => recomputeDerived(route, dm, { pmin: 10, vmin: 12, cap: 12 }), /Missing directed distance/);
});

test('STATUSES and REASON_CATEGORIES exact', () => {
  assert.deepStrictEqual(STATUSES, ['Pending review', 'Ready', 'Approved exception', 'Needs revision', 'Excluded / deferred']);
  assert.strictEqual(REASON_CATEGORIES.length, 6);
});
