import { test } from 'node:test';
import assert from 'node:assert';
import { createPlan, applyOp, undo } from '../js/state.js';

test('removeCustomer moves to pool with full BP record', () => {
  const result = { routes: [{ id: 'R01', customers: [{ id: 'C1', bpId: 'BP01', name: 'Shop', orderVolume: 2, orderValue: 20000000 }], volume: 2, value: 20000000 }] };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  const res = applyOp(plan, { type: 'removeCustomer', routeId: 'R01', customerId: 'C1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(plan.routes[0].customers.length, 0);
  assert.strictEqual(plan.unassignedPool.length, 1);
  assert.strictEqual(plan.unassignedPool[0].bp.bpId, 'BP01');
});

test('addCustomer beyond cap blocked unless approved', () => {
  const result = { routes: [{ id: 'R01', customers: [], volume: 11, value: 150000000 }] };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  const res = applyOp(plan, { type: 'addCustomer', routeId: 'R01', customer: { id: 'C1', orderVolume: 2, orderValue: 10000000 } });
  assert.strictEqual(res.ok, false);
});

test('undo restores after remove', () => {
  const result = { routes: [{ id: 'R01', customers: [{ id: 'C1', bpId: 'BP01', name: 'Shop', orderVolume: 2, orderValue: 20000000 }], volume: 2, value: 20000000 }] };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  applyOp(plan, { type: 'removeCustomer', routeId: 'R01', customerId: 'C1' });
  const u = undo(plan);
  assert.strictEqual(u.ok, true);
  assert.strictEqual(plan.routes[0].customers.length, 1);
});
