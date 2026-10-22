import { test } from 'node:test';
import assert from 'node:assert';
import { createPlan, applyMerge, undo } from '../js/state.js';

test('applyMerge sets statuses and reason', () => {
  const result = { 
    routes: [
      { id: 'BOG-02', customers: [{ id: 'C1', orderVolume: 2, orderValue: 30000000 }], volume: 2, value: 30000000 },
      { id: 'BOG-05', customers: [{ id: 'C2', orderVolume: 3, orderValue: 40000000 }], volume: 3, value: 40000000 }
    ] 
  };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  const res = applyMerge(plan, 'BOG-05', 'BOG-02');
  assert.strictEqual(res.ok, true);
  const t = plan.routes.find(r => r.id === 'BOG-02');
  const s = plan.routes.find(r => r.id === 'BOG-05');
  assert.strictEqual(t.status, 'Needs revision');
  assert.strictEqual(s.status, 'Excluded / deferred');
  assert.strictEqual(s.reason, 'Merged into BOG-02');
});

test('undo after merge restores both exactly', () => {
  const result = { 
    routes: [
      { id: 'BOG-02', customers: [{ id: 'C1', orderVolume: 2, orderValue: 30000000 }], volume: 2, value: 30000000, status: 'Pending review' },
      { id: 'BOG-05', customers: [{ id: 'C2', orderVolume: 3, orderValue: 40000000 }], volume: 3, value: 40000000, status: 'Pending review' }
    ] 
  };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  applyMerge(plan, 'BOG-05', 'BOG-02');
  const u = undo(plan);
  assert.strictEqual(u.ok, true);
  assert.strictEqual(plan.routes[0].customers.length, 1);
  assert.strictEqual(plan.routes[1].customers.length, 1);
  assert.strictEqual(plan.routes[0].status, 'Pending review');
  assert.strictEqual(plan.routes[1].status, 'Pending review');
});
