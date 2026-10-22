import { test } from 'node:test';
import assert from 'node:assert';
import { savePlan, getPlan, listPlans, getActivePlanId, setActivePlanId } from '../js/persistence.js';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k,v) => m.set(k,String(v)), removeItem: (k) => m.delete(k) };
}

test('multi-plan index upsert', () => {
  const s = memStorage();
  const plan1 = { planId: 'p1', routes: [] };
  const plan2 = { planId: 'p2', routes: [] };
  savePlan(plan1, s);
  savePlan(plan2, s);
  const idx = listPlans(s);
  assert.strictEqual(idx.length, 2);
});

test('active pointer switches', () => {
  const s = memStorage();
  setActivePlanId('p1', s);
  assert.strictEqual(getActivePlanId(s), 'p1');
  setActivePlanId('p2', s);
  assert.strictEqual(getActivePlanId(s), 'p2');
});

test('stale schema returns null', () => {
  const s = memStorage();
  s.setItem('pdp.plan.p1', JSON.stringify({ schemaVersion: 0.9, plan: { planId: 'p1' } }));
  const p = getPlan('p1', s);
  assert.strictEqual(p, null);
});
