/* Solve pipeline worker: Excel rows -> dataset -> road matrix -> candidates -> ILP -> stop order. */
import { buildData } from './lib/build-data.js';
import { buildMatrix } from './lib/road-distance.js';
import { generateCandidates, routeDistance } from './lib/candidates.js';
import { solve } from './lib/solver.js';
import { optimizeOrder } from './lib/route-opt.js';

let highsFactory = null;
let highsInstance = null;
let currentAbort = null;

const post = (msg) => self.postMessage(msg);
const progress = (stage, message, extra = {}) => post({ type: 'progress', stage, message, ...extra });

self.onmessage = async (ev) => {
  const msg = ev.data || {};

  if (msg.type === 'abort') {
    if (currentAbort) currentAbort.abort();
    return;
  }
  if (msg.type !== 'solve') return;

  currentAbort = new AbortController();
  const signal = currentAbort.signal;

  try {
    const { gpsRows, ordersRows, settings = {}, params = {} } = msg;
    const cap = Number(params.cap ?? settings.truck_capacity_mt ?? 12);
    const vMin = Number(params.vmin ?? settings.pdp_volume_mt ?? 12);
    const pMin = Number(params.pmin ?? settings.pdp_value_cr ?? 10) * 10_000_000;
    const endpoint = params.osrmEndpoint || settings.osrm_endpoint || 'https://router.project-osrm.org';
    const chunk = Number(params.osrmChunk || settings.osrm_table_chunk || 50);
    const maxCandidates = Number(params.maxCandidates || settings.max_candidates || 15000);

    progress('data', 'Reading customer master and orders…');
    const data = buildData(gpsRows, ordersRows, settings);

    progress('distance', 'Building road-distance matrix…', { done: 0, total: 1 });
    const matrix = await buildMatrix(
      [{ id: 'WH', lat: data.warehouse.lat, lon: data.warehouse.lon },
        ...data.customers.map((c) => ({ id: c.id, lat: c.lat, lon: c.lon }))],
      {
        endpoint,
        chunk,
        signal,
        onProgress: (p) => progress('distance',
          `Road distances: ${p.pairsDone.toLocaleString()} pairs from OSRM…`, p),
      },
    );
    if (signal.aborted) throw new Error('Cancelled');
    data.distMatrix = matrix.distMatrix;

    const whKm = data.customers
      .map((c) => matrix.distMatrix[c.id < 'WH' ? `${c.id}|WH` : `WH|${c.id}`] ?? 99999)
      .sort((a, b) => a - b);
    data.geo = whKm.length
      ? {
        minKm: Math.round(whKm[0] * 10) / 10,
        medianKm: Math.round(whKm[Math.floor(whKm.length / 2)] * 10) / 10,
        maxKm: Math.round(whKm[whKm.length - 1] * 10) / 10,
      }
      : { minKm: 0, medianKm: 0, maxKm: 0 };

    data.meta.distanceSource = matrix.source;
    data.meta.distanceStats = matrix.stats;

    progress('candidates', 'Generating candidate routes…');
    const candidates = generateCandidates(data, { capMax: cap, vMin, pMin, maxCandidates });
    if (signal.aborted) throw new Error('Cancelled');
    if (candidates.length >= maxCandidates) {
      progress('warn', `Candidate cap reached (${maxCandidates.toLocaleString()}). Raise it in settings.json if needed.`);
    }

    progress('solve', `Solving integer program over ${candidates.length.toLocaleString()} candidates…`);
    if (!highsInstance) {
      progress('solve', 'Loading HiGHS solver…');
      if (!highsFactory) highsFactory = (await import('./vendor/highs.mjs')).default;
      highsInstance = await highsFactory();
    }
    if (signal.aborted) throw new Error('Cancelled');

    const result = await solve(data, candidates, { capMax: cap, vMin, pMin, timeLimit: 60, highs: highsInstance });

    if ((result.status === 'Optimal' || result.status === 'Time limit reached') && result.routes.length) {
      progress('optimise', 'Optimising stop sequence…');
      const dm = data.distMatrix;
      for (let i = 0; i < result.routes.length; i++) {
        const route = result.routes[i];
        const order = route.customers.map((c) => c.id);
        const origDistance = routeDistance(order, dm);
        let bestOrder = order.slice();
        let bestDist = origDistance;
        for (let s = 0; s < 6; s++) {
          const candOrder = optimizeOrder(order, dm, 10000, 42 + s * 131542391);
          const cd = routeDistance(candOrder, dm);
          if (cd < bestDist) { bestDist = cd; bestOrder = candOrder; }
        }
        const better = optimizeOrder(bestOrder, dm, 15000, 99991);
        const bd = routeDistance(better, dm);
        if (bd < bestDist) { bestDist = bd; bestOrder = better; }
        const byId = new Map(route.customers.map((c) => [c.id, c]));
        route.orig_order = order;
        route.orig_distance = origDistance;
        route.customers = bestOrder.map((id) => byId.get(id));
        route.distance = routeDistance(bestOrder, dm);
        if (i % 10 === 0) progress('optimise', `Optimising stop sequence… ${i + 1}/${result.routes.length}`);
      }
      // Global regrouping/local improvement: try moving single customers between routes to reduce total km
      let improved = true;
      let passes = 0;
      while (improved && passes < 30) {
        improved = false;
        passes++;
        const custById = new Map(data.customers.map((c) => [c.id, c]));
        for (let i = 0; i < result.routes.length && !improved; i++) {
          for (let j = 0; j < result.routes.length && !improved; j++) {
            if (i === j) continue;
            const ri = result.routes[i], rj = result.routes[j];
            for (let k = 0; k < ri.customers.length; k++) {
              const c = ri.customers[k];
              const cc = custById.get(c.id);
              if (!cc) continue;
              // try move c from ri to rj
              const niVol = rj.volume + cc.orderVolume;
              const niVal = rj.value + cc.orderValue;
              const nrVol = ri.volume - cc.orderVolume;
              const nrVal = ri.value - cc.orderValue;
              if (niVol > cap + 1e-9) continue;
              // check PDP for both after move
              const qualifies = (vol, val) => (vol >= vMin - 1e-9 || val >= pMin - 1e-9);
              if (!qualifies(niVol, niVal)) continue;
              if (!qualifies(nrVol, nrVal)) continue;
              // compute distance delta
              const idsI = ri.customers.map(x => x.id);
              const idsJ = rj.customers.map(x => x.id);
              const dIold = routeDistance(idsI, dm);
              const dJold = routeDistance(idsJ, dm);
              // try inserting c into best position of rj
              let bestDeltaj = Infinity;
              for (let p = 0; p <= idsJ.length; p++) {
                const ord = idsJ.slice(0,p).concat([c.id], idsJ.slice(p));
                const nd = routeDistance(ord, dm);
                if (nd - dJold < bestDeltaj) bestDeltaj = nd - dJold;
              }
              const idsI2 = idsI.slice(); idsI2.splice(k,1);
              const dInew = idsI2.length ? routeDistance(idsI2, dm) : 0;
              if (dInew + (dJold + bestDeltaj) < dIold + dJold - 0.5) {
                // apply move
                // rebuild ri without c
                ri.customers = idsI2.map(id => {
                  const cx = custById.get(id) || {};
                  return { id, name: cx.name || '', bpId: cx.bpId || '', orderVolume: cx.orderVolume || 0, orderValue: cx.orderValue || 0 };
                });
                ri.volume = nrVol; ri.value = nrVal; ri.distance = dInew; ri.qualifiesBy = (nrVol>=vMin||nrVal>=pMin)?(nrVol>=vMin&&nrVal>=pMin?'Both':(nrVol>=vMin?'Volume':'Value')):'Below';
                // insert c into rj
                let bestOrd = null, bestDj = Infinity;
                for (let p = 0; p <= idsJ.length; p++) {
                  const ord = idsJ.slice(0,p).concat([c.id], idsJ.slice(p));
                  const nd = routeDistance(ord, dm);
                  if (nd < bestDj) { bestDj = nd; bestOrd = ord; }
                }
                rj.customers = bestOrd.map(id => {
                  const cx = custById.get(id) || {};
                  return { id, name: cx.name || '', bpId: cx.bpId || '', orderVolume: cx.orderVolume || 0, orderValue: cx.orderValue || 0 };
                });
                rj.volume = niVol; rj.value = niVal; rj.distance = bestDj; rj.qualifiesBy = (niVol>=vMin&&niVal>=pMin)?'Both':(niVol>=vMin?'Volume':(niVal>=pMin?'Value':'Below'));
                improved = true;
                break;
              }
            }
          }
        }
      }
      // re-optimize sequences after regrouping
      for (let i = 0; i < result.routes.length; i++) {
        const route = result.routes[i];
        const order = route.customers.map((c) => c.id);
        if (order.length < 2) continue;
        let bestOrder = order.slice();
        let bestDist = routeDistance(bestOrder, dm);
        for (let s = 0; s < 4; s++) {
          const candOrder = optimizeOrder(order, dm, 8000, 12345 + s * 7919);
          const cd = routeDistance(candOrder, dm);
          if (cd < bestDist) { bestDist = cd; bestOrder = candOrder; }
        }
        const byId = new Map(route.customers.map((c) => [c.id, c]));
        route.customers = bestOrder.map((id) => byId.get(id));
        route.distance = routeDistance(bestOrder, dm);
      }
      result.totalDistance = Math.round(result.routes.reduce((a, r) => a + r.distance, 0) * 100) / 100;
    }

    const wh = data.warehouse;
    const byId = new Map(data.customers.map((c) => [c.id, c]));
    for (const r of result.routes) {
      const parts = [`${wh.lat},${wh.lon}`];
      for (const c of r.customers) {
        const cc = byId.get(c.id);
        if (cc) parts.push(`${cc.lat},${cc.lon}`);
      }
      r.gmaps_url = 'https://www.google.com/maps/dir/' + parts.join('/');
    }

    post({ type: 'done', data, result,
      settings: { cap, vMin, pMinCr: pMin / 10_000_000 },
      routingMeta: {
        engineVersion: settings.routing_engine_version || (endpoint.includes('project-osrm.org') ? 'public-osrm-dev' : 'local-osrm'),
        profile: settings.routing_profile || 'car',
        restrictionVersion: settings.restriction_version || 'v0',
        osrmEndpoint: endpoint,
      } });
  } catch (err) {
    if (signal.aborted) post({ type: 'aborted' });
    else post({ type: 'error', message: String((err && err.message) || err) });
  } finally {
    currentAbort = null;
  }
};
