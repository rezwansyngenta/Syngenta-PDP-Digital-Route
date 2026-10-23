/* Solve pipeline worker: Excel rows -> dataset -> road matrix -> candidates -> ILP -> stop order. */
import { buildData } from './lib/build-data.js';
import { buildMatrix } from './lib/road-distance.js';
import { generateCandidates } from './lib/candidates.js';
import { solve } from './lib/solver.js';
import { convergeResult } from './lib/converge.js';

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

    // authoritative local road matrix (validated km, no cross-border paths)
    let coordMatrix = null;
    if (settings.prefer_local_matrix !== false) {
      const localPath = settings.local_matrix_path || 'data/road_matrix_coord.json';
      try {
        const res = await fetch(localPath);
        if (res.ok) {
          const j = await res.json();
          coordMatrix = j.distances || {};
          progress('distance', `Loaded local road matrix: ${Object.keys(coordMatrix).length.toLocaleString()} coordinate pairs.`);
        }
      } catch { /* fall back to OSRM below */ }
    }

    progress('distance', 'Building road-distance matrix…', { done: 0, total: 1 });
    const matrix = await buildMatrix(
      [{ id: 'WH', lat: data.warehouse.lat, lon: data.warehouse.lon },
        ...data.customers.map((c) => ({ id: c.id, lat: c.lat, lon: c.lon }))],
      {
        endpoint,
        chunk,
        signal,
        coordMatrix,
        onProgress: (p) => progress('distance',
          `Road distances: ${p.pairsDone.toLocaleString()} pairs from OSRM…`, p),
      },
    );
    if (signal.aborted) throw new Error('Cancelled');
    if (coordMatrix && data.customers.length && matrix.stats.localPairs / matrix.stats.pairs < 0.75) {
      progress('warn', 'Coordinate match rate low — matrix may be stale or coordinates edited; uncovered pairs fall back to OSRM.');
    }
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

    const mode = params.mode === 'min-trucks' ? 'min-trucks' : 'min-km';
    const result = await solve(data, candidates, { capMax: cap, vMin, pMin, timeLimit: 60, highs: highsInstance, mode });

    if ((result.status === 'Optimal' || result.status === 'Time limit reached') && result.routes.length) {
      progress('optimise', 'Converging routes to fixed point…');
      const dm = data.distMatrix;
      await convergeResult(result, { dm, cap, vMin, pMin, mode });
      progress('optimise', `Converged: ${result.proof.rounds} improvement round(s)` +
        (result.proof.movedKm > 0 ? `, −${result.proof.movedKm} km` : ''));
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
