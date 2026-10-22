import { test } from 'node:test';
import assert from 'node:assert';
import { computeImpact, backtrackIndicator } from '../js/impact.js';

test('computeImpact rows', () => {
  const before = { volume: 11, value: 100000000, distance: 40 };
  const after = { volume: 12, value: 120000000, distance: 42 };
  const rows = computeImpact(before, after, { pmin: 10, vmin: 12, cap: 12 });
  const map = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.strictEqual(map.Load.after, '12.0 MT');
  assert.strictEqual(map['Value BDT'].after, 'BDT 1200.0 lakh');
  assert.strictEqual(map['Outbound km'].delta, '+2.0');
  assert.strictEqual(map.PDP.after, 'Meets PDP');
  assert.strictEqual(map.Capacity.after, 'Normal');
});

test('value-qualifies wording when volume below but value high', () => {
  const rows = computeImpact({ volume: 9, value: 200000000, distance: 0 }, { volume: 9, value: 200000000, distance: 0 }, { pmin: 10, vmin: 12, cap: 12 });
  const map = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.strictEqual(map.PDP.after, 'Meets PDP'); // value qualifies even though 9 MT < 12 MT
});

test('backtrack boundaries 14.9 none / 15.1 retracing', () => {
  // WH at 0; route goes out to 20 then back toward WH: re-trace 5.1
  const d = (a, b) => (a === 'WH' ? ['C1','C2','C3'].indexOf(b) === 0 ? 20 : ['C1','C2','C3'].indexOf(b) === 1 ? 14.9 : 10 : 10);
  const res = backtrackIndicator(['C1', 'C2', 'C3'], d);
  assert.strictEqual(res.label, 'No backtracking');
  const d2 = (a, b) => (a === 'WH' ? (b === 'C1' ? 20.1 : 4) : 10);
  const res2 = backtrackIndicator(['C1', 'C2'], d2);
  assert.ok(res2.label.startsWith('~'));
  assert.ok(res2.km > 15);
});
