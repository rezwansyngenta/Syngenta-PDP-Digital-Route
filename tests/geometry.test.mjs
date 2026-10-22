import { test } from 'node:test';
import assert from 'node:assert';
import { fetchRouteLegs, cacheKey } from '../js/geometry.js';

test('cache miss -> fetch -> set', async () => {
  const mem = new Map();
  const cache = {
    get: async (keys) => { const out = new Map(); for (const k of keys) if (mem.has(k)) out.set(k, mem.get(k)); return out; },
    set: async (entries) => { for (const [k,v] of entries) mem.set(k,v); }
  };
  let called = 0;
  const osrm = { route: async () => { called++; return { ok: true, km: 5, points: [[0,0],[1,1]] }; } };
  const route = { customers: [{ id: 'C1' }] };
  const res = await fetchRouteLegs([0,0], route, { C1: [1,1] }, { osrm, cache, meta: { engineVersion: '1' } });
  assert.strictEqual(called, 1);
  assert.strictEqual(res.legs.length, 1);
  assert.strictEqual(res.legs[0].ok, true);
});

test('cache hit no fetch', async () => {
  const mem = new Map();
  const key = cacheKey('WH', 'C1', [0,0], [1,1], { engineVersion: '1' });
  mem.set(key, { points: [[0,0],[1,1]], km: 5 });
  const cache = {
    get: async (keys) => { const out = new Map(); for (const k of keys) if (mem.has(k)) out.set(k, mem.get(k)); return out; },
    set: async () => {}
  };
  let called = 0;
  const osrm = { route: async () => { called++; return { ok: true, km: 5 }; } };
  const route = { customers: [{ id: 'C1' }] };
  const res = await fetchRouteLegs([0,0], route, { C1: [1,1] }, { osrm, cache, meta: { engineVersion: '1' } });
  assert.strictEqual(called, 0);
  assert.strictEqual(res.legs[0].ok, true);
});

test('version bump causes miss', async () => {
  const mem = new Map();
  const key1 = cacheKey('WH', 'C1', [0,0], [1,1], { engineVersion: '1' });
  mem.set(key1, { points: [[0,0],[1,1]], km: 5 });
  const cache = {
    get: async (keys) => { const out = new Map(); for (const k of keys) if (mem.has(k)) out.set(k, mem.get(k)); return out; },
    set: async (entries) => { for (const [k,v] of entries) mem.set(k,v); }
  };
  let called = 0;
  const osrm = { route: async () => { called++; return { ok: true, km: 6 }; } };
  const route = { customers: [{ id: 'C1' }] };
  const res = await fetchRouteLegs([0,0], route, { C1: [1,1] }, { osrm, cache, meta: { engineVersion: '2' } });
  assert.strictEqual(called, 1);
});

test('leg failure gives fallback', async () => {
  const cache = { get: async () => new Map(), set: async () => {} };
  const osrm = { route: async () => { throw new Error('fail'); } };
  const route = { customers: [{ id: 'C1' }] };
  const res = await fetchRouteLegs([0,0], route, { C1: [1,0] }, { osrm, cache });
  assert.strictEqual(res.hasFallbackLegs, true);
  assert.strictEqual(res.legs[0].ok, false);
});

test('first leg is WH to stop 1', async () => {
  const cache = { get: async () => new Map(), set: async () => {} };
  const osrm = { route: async (pts) => { return { ok: true, km: 3 }; } };
  const route = { customers: [{ id: 'C1' }, { id: 'C2' }] };
  const res = await fetchRouteLegs([0,0], route, { C1: [1,0], C2: [2,0] }, { osrm, cache });
  assert.strictEqual(res.legs[0].from, 'WH');
  assert.strictEqual(res.legs[0].to, 'C1');
});
