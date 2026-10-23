import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { round6, coordPairKey, buildMatrix } from '../lib/road-distance.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('round6 pins coordinates to 6 decimals in lat,lon string form', () => {
  assert.strictEqual(round6(24.8155701506389, 89.35851746567042), '24.815570,89.358517');
  assert.strictEqual(round6(1.0000004, 2.9999996), '1.000000,3.000000');
});

test('coordPairKey is order-agnostic sorted lat,lon pair', () => {
  assert.strictEqual(coordPairKey([24.8, 89.3], [24.9, 89.4]), '24.800000,89.300000|24.900000,89.400000');
  assert.strictEqual(coordPairKey([24.9, 89.4], [24.8, 89.3]), coordPairKey([24.8, 89.3], [24.9, 89.4]));
});

test('buildMatrix: coord overlay seeds symmetric directed km, no OSRM needed', async () => {
  // real coords from the asset so lookups hit
  const src = JSON.parse(readFileSync(join(root, 'data', 'road_matrix_coord.json'), 'utf8'));
  const keys = Object.keys(src.distances);
  const parse = (k) => k.split('|').map((s) => s.split(',').map(Number));
  const [pa] = keys.slice(0, 40).map(parse); // a chunk of known-real coords
  const a = pa[0], b = pa[1]; // two distinct coordinate points
  const km = src.distances[coordPairKey(a, b)];
  const m = await buildMatrix(
    [{ id: 'X1', lat: a[0], lon: a[1] }, { id: 'X2', lat: b[0], lon: b[1] }],
    { endpoint: 'http://127.0.0.1:1', coordMatrix: src.distances },
  );
  assert.strictEqual(m.distMatrix['X1|X2'], km);
  assert.strictEqual(m.distMatrix['X2|X1'], km);
  assert.strictEqual(m.stats.localPairs, 1);
});

test('buildMatrix: coord miss falls through to haversine, miss counted', async () => {
  const off = { lat: 10, lon: 10 }; // nowhere in the matrix
  const m = await buildMatrix(
    [{ id: 'A', lat: off.lat, lon: off.lon }, { id: 'B', lat: 60, lon: 60 }],
    { endpoint: 'http://127.0.0.1:1', coordMatrix: { '1,40|2,40': 5 } },
  );
  assert.strictEqual(m.distMatrix['A|B'], m.distMatrix['B|A']);
  assert.strictEqual(m.stats.localPairs, 0);
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
