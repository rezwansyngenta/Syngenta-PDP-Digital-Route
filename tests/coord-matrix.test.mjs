import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { round6, coordPairKey } from '../lib/road-distance.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('round6 pins coordinates to 6 decimals in lat,lon string form', () => {
  assert.strictEqual(round6(24.8155701506389, 89.35851746567042), '24.815570,89.358517');
  assert.strictEqual(round6(1.0000004, 2.9999996), '1.000000,3.000000');
});

test('coordPairKey is order-agnostic sorted lat,lon pair', () => {
  assert.strictEqual(coordPairKey([24.8, 89.3], [24.9, 89.4]), '24.800000,89.300000|24.900000,89.400000');
  assert.strictEqual(coordPairKey([24.9, 89.4], [24.8, 89.3]), coordPairKey([24.8, 89.3], [24.9, 89.4]));
});

test('committed coord asset: version 3, big, no identifying keys', () => {
  const p = join(root, 'data', 'road_matrix_coord.json');
  assert.ok(existsSync(p), 'asset committed');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  assert.strictEqual(j._version, 3);
  const keys = Object.keys(j.distances);
  assert.ok(keys.length >= 9000, `expected >=9000 pairs, got ${keys.length}`);
  // privacy: no customer ids anywhere
  assert.strictEqual(keys.filter((k) => /(^|\|)\s*WH(\||$)/.test(k)).length, 0, 'no WH ids');
  assert.strictEqual(keys.filter((k) => /^C0/.test(k)).length, 0, 'no C0xx ids');
  for (const v of Object.values(j.distances)) assert.strictEqual(typeof v, 'number');
});
