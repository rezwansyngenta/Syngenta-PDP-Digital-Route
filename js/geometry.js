/* Versioned leg cache - directed legs */
const DB_NAME = 'pdp-legs';
const STORE = 'legs';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

export function cacheKey(fromId, toId, fromCoords, toCoords, meta = {}) {
  const ev = meta.engineVersion || '';
  const prof = meta.profile || '';
  const rv = meta.restrictionVersion || '';
  // use coords for cache identity as well as ids
  const f = `${fromCoords?.[0]?.toFixed(6)},${fromCoords?.[1]?.toFixed(6)}`;
  const t = `${toCoords?.[0]?.toFixed(6)},${toCoords?.[1]?.toFixed(6)}`;
  return `${fromId}|${toId}|${f}|${t}|${ev}|${prof}|${rv}`;
}

async function cacheGet(keys) {
  const db = await openDb();
  const out = new Map();
  if (!db || !keys || keys.length === 0) return out;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      let pending = keys.length;
      for (const k of keys) {
        const req = store.get(k);
        req.onsuccess = () => {
          if (req.result) out.set(k, req.result);
          if (--pending === 0) resolve(out);
        };
        req.onerror = () => { if (--pending === 0) resolve(out); };
      }
      tx.onabort = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

async function cachePut(entries) {
  const db = await openDb();
  if (!db || !entries || entries.length === 0) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [k, v] of entries) store.put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad, p2 = lat2 * toRad;
  const dp = (lat2 - lat1) * toRad, dl = (lon2 - lon1) * toRad;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export async function fetchRouteLegs(warehouse, route, customerCoords, { osrm, cache, meta = {} } = {}) {
  const legs = [];
  let hasFallbackLegs = false;
  let source = 'local-road';
  if (!route || !Array.isArray(route.customers) || route.customers.length === 0) {
    return { legs: [], hasFallbackLegs: false, source };
  }
  const ids = route.customers.map(c => typeof c === 'string' ? c : c.id);
  const points = [];
  // build sequence WH -> ... 
  const seq = ['WH', ...ids];
  const coords = { WH: Array.isArray(warehouse) ? warehouse : [warehouse.lat, warehouse.lon] };
  for (let i = 0; i < ids.length; i++) {
    if (customerCoords && customerCoords[ids[i]]) coords[ids[i]] = customerCoords[ids[i]];
    else if (route.customers[i] && route.customers[i].lat) coords[ids[i]] = [route.customers[i].lat, route.customers[i].lon];
  }
  
  // use injected cache
  const cacheImpl = cache || { get: cacheGet, set: cachePut };
  for (let i = 0; i < seq.length - 1; i++) {
    const fromId = seq[i], toId = seq[i + 1];
    const fromC = coords[fromId], toC = coords[toId];
    const key = cacheKey(fromId, toId, fromC, toC, meta);
    let cached = null;
    if (cacheImpl.get) {
      const got = await cacheImpl.get([key]);
      if (got && got.get(key)) cached = got.get(key);
    }
    if (cached) {
      legs.push({ points: cached.points || [[fromC[0], fromC[1]], [toC[0], toC[1]]], km: cached.km, durationS: cached.durationS, ok: true, from: fromId, to: toId });
      continue;
    }
    // try osrm
    if (osrm && typeof osrm.route === 'function') {
      try {
        const res = await osrm.route([fromC, toC]);
        if (res && res.ok && res.km) {
          const leg = { points: res.points || [[fromC[0], fromC[1]], [toC[0], toC[1]]], km: res.km, durationS: res.durationS || 0, ok: true, from: fromId, to: toId };
          legs.push(leg);
          if (cacheImpl.set) await cacheImpl.set([[key, leg]]);
          continue;
        }
      } catch {}
    }
    // fallback
    const km = haversineKm(fromC[0], fromC[1], toC[0], toC[1]);
    legs.push({ points: [[fromC[0], fromC[1]], [toC[0], toC[1]]], km: Math.round(km * 100) / 100, durationS: km * 60, ok: false, from: fromId, to: toId });
    hasFallbackLegs = true;
    source = hasFallbackLegs && legs.some(l => l.ok) ? 'mixed' : 'straight-line-fallback';
  }
  if (legs.length === route.customers.length && legs.every(l => l.ok)) source = 'local-road';
  return { legs, hasFallbackLegs, source };
}
