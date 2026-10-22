/* OSRM route-service leg client. Injected into js/geometry.js fetchRouteLegs. */

const c6 = (v) => Number(v).toFixed(6);

/**
 * @param {string} endpoint OSRM base URL
 * @param {typeof fetch} fetchImpl injectable for tests
 * @returns {{ route: (coords: [number,number][]) => Promise<{ok:boolean,km:number,durationS:number,points:number[][]}> }}
 *          coords are [lat,lon] pairs; points come back as [lat,lon] polyline vertices.
 */
export function osrmRouteClient(endpoint, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
  return {
    async route(coords) {
      if (!fetchImpl) throw new Error('no fetch');
      const path = coords.map(([lat, lon]) => `${c6(lon)},${c6(lat)}`).join(';');
      const url = `${String(endpoint).replace(/\/+$/, '')}/route/v1/driving/${path}?overview=full&geometries=geojson&annotations=false`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        const resp = await fetchImpl(url, { signal: ctl.signal });
        if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
        const json = await resp.json();
        if (json.code !== 'Ok' || !json.routes?.length) throw new Error(`OSRM ${json.code || 'bad response'}`);
        const r = json.routes[0];
        const km = Math.round((r.distance / 1000) * 100) / 100;
        const durationS = Math.round(r.duration || 0);
        const points = (r.geometry?.coordinates || []).map(([lon, lat]) => [lat, lon]);
        return { ok: true, km, durationS, points: points.length >= 2 ? points : coords.slice() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
