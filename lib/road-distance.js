/* Road-distance matrix: OSRM table service + IndexedDB cache keyed by coordinates. */

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad, p2 = lat2 * toRad;
  const dp = (lat2 - lat1) * toRad, dl = (lon2 - lon1) * toRad;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const COORD_DECIMALS = 6;
const c6 = (v) => Number(v).toFixed(COORD_DECIMALS);

/** Cache key from rounded coordinates, order-independent (safe across warehouses). */
export function coordKey(a, b, coord) {
  let pa = `${c6(coord[a][0])},${c6(coord[a][1])}`;
  let pb = `${c6(coord[b][0])},${c6(coord[b][1])}`;
  if (pb < pa) { const t = pa; pa = pb; pb = t; }
  return `${pa}|${pb}`;
}

/* ---------------- IndexedDB cache ---------------- */
const DB_NAME = 'pdp-distances';
const STORE = 'pairs';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbPromise;
}

async function cacheGet(keys) {
  const db = await openDb();
  const out = new Map();
  if (!db || keys.length === 0) return out;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    let pending = keys.length;
    for (const k of keys) {
      const req = store.get(k);
      req.onsuccess = () => {
        if (typeof req.result === 'number') out.set(k, req.result);
        if (--pending === 0) resolve(out);
      };
      req.onerror = () => { if (--pending === 0) resolve(out); };
    }
    tx.onabort = () => resolve(out);
  });
}

async function cachePut(entries) {
  const db = await openDb();
  if (!db || entries.length === 0) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [k, v] of entries) store.put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export async function cacheSize() {
  const db = await openDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => resolve(0);
  });
}

export async function clearCache() {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/* ---------------- OSRM ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function osrmTable(endpoint, coords, signal) {
  const path = coords.map(([lat, lon]) => `${c6(lon)},${c6(lat)}`).join(';');
  const url = `${endpoint.replace(/\/+$/, '')}/table/v1/driving/${path}?annotations=distance`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctl.abort(), 30000);
      const resp = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
      const json = await resp.json();
      if (json.code !== 'Ok' || !json.distances) throw new Error(`OSRM ${json.code || 'bad response'}`);
      return json.distances;
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (attempt === 2) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
  return null;
}

/**
 * Build a full road-distance matrix.
 * @param {{id:string,lat:number,lon:number}[]} locations
 * @returns {Promise<{distMatrix:Record<string,number>, source:string, stats:object}>}
 */
export async function buildMatrix(locations, {
  endpoint = 'https://router.project-osrm.org',
  chunk = 50,
  concurrency = 3,
  onProgress = null,
  signal = null,
} = {}) {
  const ids = locations.map((l) => l.id);
  const coord = Object.create(null);
  for (const l of locations) coord[l.id] = [l.lat, l.lon];
  const distMatrix = {};
  const total = (ids.length * (ids.length - 1)) / 2;

  // every unordered pair, with its coordinate cache key
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push({ a: ids[i], b: ids[j], k: pairKey(ids[i], ids[j]), ck: coordKey(ids[i], ids[j], coord) });
    }
  }

  const cached = await cacheGet(pairs.map((p) => p.ck));
  let cacheHits = 0;
  const missing = [];
  for (const p of pairs) {
    const v = cached.get(p.ck);
    if (typeof v === 'number') { distMatrix[p.k] = v; cacheHits++; } else missing.push(p);
  }

  // group missing pairs into (chunk_i, chunk_j) blocks
  const chunkOf = new Map();
  const chunks = [];
  for (let s = 0; s < ids.length; s += chunk) {
    const group = ids.slice(s, s + chunk);
    group.forEach((id) => chunkOf.set(id, chunks.length));
    chunks.push(group);
  }
  const blocks = new Map();
  for (const p of missing) {
    const ci = chunkOf.get(p.a);
    const cj = chunkOf.get(p.b);
    const bk = ci < cj ? `${ci}:${cj}` : `${cj}:${ci}`;
    if (!blocks.has(bk)) blocks.set(bk, { ci: Math.min(ci, cj), cj: Math.max(ci, cj), pairs: [] });
    blocks.get(bk).pairs.push(p);
  }

  const blockList = [...blocks.values()];
  let done = 0, osrmPairs = 0, failedBlocks = 0;
  const fetched = [];
  const report = () => { if (onProgress) onProgress({ done, total: blockList.length, pairsDone: osrmPairs }); };

  const runBlock = async (block) => {
    const union = [...chunks[block.ci], ...chunks[block.cj].filter((id) => !chunks[block.ci].includes(id))];
    if (union.length > 100) { failedBlocks++; done++; report(); return; }
    try {
      const mat = await osrmTable(endpoint, union.map((id) => coord[id]), signal);
      const idx = new Map(union.map((id, i) => [id, i]));
      for (const p of block.pairs) {
        const d = mat[idx.get(p.a)][idx.get(p.b)];
        if (typeof d === 'number') {
          const km = Math.round(d / 10) / 100;
          distMatrix[p.k] = km;
          fetched.push([p.ck, km]);
          osrmPairs++;
        }
      }
    } catch (err) {
      failedBlocks++;
    }
    done++;
    report();
  };

  let cursor = 0;
  const lane = async () => {
    while (cursor < blockList.length) {
      if (signal && signal.aborted) return;
      const block = blockList[cursor++];
      await runBlock(block);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, blockList.length || 1) }, lane));
  if (fetched.length) await cachePut(fetched);

  // straight-line fallback for whatever is left
  let fallbackPairs = 0;
  for (const p of pairs) {
    if (typeof distMatrix[p.k] === 'number') continue;
    const ca = coord[p.a], cb = coord[p.b];
    distMatrix[p.k] = Math.round(haversineKm(ca[0], ca[1], cb[0], cb[1]) * 100) / 100;
    fallbackPairs++;
  }

  const source = osrmPairs === 0
    ? 'straight-line (haversine km)'
    : fallbackPairs === 0
      ? 'OSRM road network (driving km)'
      : 'OSRM road network + straight-line fallback';

  return {
    distMatrix,
    source,
    stats: { pairs: pairs.length, cacheHits, osrmPairs, fallbackPairs, failedBlocks, requests: blockList.length },
  };
}
