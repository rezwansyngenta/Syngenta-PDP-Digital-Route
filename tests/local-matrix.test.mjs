import { test } from 'node:test';
import assert from 'node:assert';
import { buildMatrix, pairKey } from '../lib/road-distance.js';

// Locations with no network access dependence: when localMatrix covers every
// pair, buildMatrix must not issue a single OSRM request (endpoint points at
// an unreachable host — a request would reject/hang).
const HOST = 'http://127.0.0.1:1'; // port 1: connection refused instantly

const locs = [
  { id: 'WH', lat: 24.8465, lon: 89.3711 },
  { id: 'C001', lat: 24.9, lon: 89.4 },
  { id: 'C002', lat: 24.75, lon: 89.3 },
];

const fullLocal = {
  'WH|C001': 12.34,
  'C001|C002': 20.5,   // sorted (C < C)
  'C002|WH': 8.1,      // sorted pair key as in the JSON file
};

test('full local matrix: 0 OSRM requests, symmetric directed km, stats', async () => {
  const m = await buildMatrix(locs, { endpoint: HOST, localMatrix: fullLocal });
  // both directed keys carry the same validated km
  assert.strictEqual(m.distMatrix['WH|C001'], 12.34);
  assert.strictEqual(m.distMatrix['C001|WH'], 12.34);
  assert.strictEqual(m.distMatrix['C001|C002'], 20.5);
  assert.strictEqual(m.distMatrix['C002|C001'], 20.5);
  assert.strictEqual(m.distMatrix['WH|C002'], 8.1);
  assert.strictEqual(m.distMatrix['C002|WH'], 8.1);
  assert.strictEqual(m.stats.localPairs, 3);
  assert.strictEqual(m.stats.osrmPairs, 0);
  assert.strictEqual(m.stats.fallbackPairs, 0);
  assert.strictEqual(m.stats.requests, 0);
  assert.strictEqual(m.source, 'Local road matrix (validated km, all pairs)');
});

test('partial local matrix: OSRM only for uncovered pairs', async () => {
  const local = { 'WH|C001': 12.34 };
  let progressEvents = 0;
  const m = await buildMatrix(locs, {
    endpoint: HOST,
    localMatrix: local,
    onProgress: () => { progressEvents++; },
  });
  assert.strictEqual(m.stats.localPairs, 1);
  assert.strictEqual(m.distMatrix['WH|C001'], 12.34);
  assert.strictEqual(m.distMatrix['C001|WH'], 12.34);
  // uncovered pairs fall back to haversine (OSRM on port 1 fails fast)
  assert.strictEqual(m.stats.pairs, 3);
  assert.strictEqual(m.source, 'Local road matrix + OSRM road network');
});

test('no local matrix: plain haversine fallback path unaffected', async () => {
  const m = await buildMatrix(locs, { endpoint: HOST });
  assert.strictEqual(m.stats.localPairs, 0);
  assert.strictEqual(m.source, 'straight-line (haversine km)');
});

test('pairKey sorts ids like the JSON file keys', () => {
  assert.strictEqual(pairKey('WH', 'C001'), 'C001|WH');
  assert.strictEqual(pairKey('C003', 'C001'), 'C001|C003');
});
