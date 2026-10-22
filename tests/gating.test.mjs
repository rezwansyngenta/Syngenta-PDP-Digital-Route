import { test } from 'node:test';
import assert from 'node:assert';
import { createPlan, trySetStatus, computeFinaliseGate, isPdpOk } from '../js/state.js';

test('PDP from params only - cap different from vMin', () => {
  // cap 7 MT truck, vMin 12 MT PDP volume - route can qualify via value only
  const route = { id: 'R01', volume: 9, value: 150000000, customers: [] }; // 9 MT, 15 Cr
  const params = { pmin: 10, vmin: 12, cap: 7 };
  assert.strictEqual(isPdpOk(route, params), true); // qualifies by value
});

test('Ready requires PDP ok, not over, no fallback', () => {
  const result = { routes: [{ id: 'R01', customers: [{ id: 'C1', orderVolume: 5, orderValue: 150000000 }], volume: 5, value: 150000000, distance: 10, qualifiesBy: 'Value' }] };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  const res = trySetStatus(plan, 'R01', 'Ready');
  assert.strictEqual(res.ok, true);
});

test('Ready blocked if over capacity', () => {
  const result = { routes: [{ id: 'R01', customers: [], volume: 15, value: 200000000 }] };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  const res = trySetStatus(plan, 'R01', 'Ready');
  assert.strictEqual(res.ok, false);
});

test('Approved exception needs category and comment', () => {
  const result = { routes: [{ id: 'R01', customers: [], volume: 5, value: 50000000 }] };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  const res = trySetStatus(plan, 'R01', 'Approved exception', { reasonCategory: 'Below-PDP accepted' });
  assert.strictEqual(res.ok, false);
  const res2 = trySetStatus(plan, 'R01', 'Approved exception', { reasonCategory: 'Below-PDP accepted', reason: 'ok' });
  assert.strictEqual(res2.ok, true);
});

test('Excluded deferred needs reason but no exception category', () => {
  const result = { routes: [{ id: 'R01', customers: [], volume: 5, value: 50000000 }] };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  const res = trySetStatus(plan, 'R01', 'Excluded / deferred', { reason: 'Deferred to future plan' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(plan.routes[0].reasonCategory, null);
});

test('finalise gate blocks pending', () => {
  const result = { routes: [{ id: 'R01', customers: [], volume: 5, value: 150000000 }] };
  const plan = createPlan(result, { pmin: 10, vmin: 12, cap: 12 });
  const gate = computeFinaliseGate(plan);
  assert.strictEqual(gate.canFinalise, false);
});
