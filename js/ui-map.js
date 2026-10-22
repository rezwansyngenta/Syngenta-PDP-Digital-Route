/* Map module. Isolates Leaflet so the renderer can swap (MapLibre + PMTiles) without touching callers. */
export const STATUS_COLORS = {
  'Pending review': '#8E8E93',
  'Ready': '#019934',
  'Approved exception': '#F5A623',
  'Needs revision': '#C40056',
  'Excluded / deferred': '#6C6C70',
};
export const STATUS_GLYPHS = {
  'Pending review': '●',
  'Ready': '✓',
  'Approved exception': '⚠',
  'Needs revision': '✎',
  'Excluded / deferred': '✕',
};
const COLORS = ['#4FAE2E', '#10AFA4', '#3687D6', '#626BC7', '#9966C2', '#F0A32D', '#E84D8D', '#718278'];
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BANNERS = {
  fallback: 'Road path unavailable — straight-line preview only. Do not use for dispatch decision.',
  profile: 'Road route uses the current local routing profile. Confirm truck suitability where local restrictions are not yet mapped.',
};

export function bannerCopy(kind) { return BANNERS[kind] || ''; }

let districtsLayer = null;

export function tileLayer(map) {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 }).addTo(map);
}

export function initMap(containerId, warehouse) {
  const map = L.map(containerId, { zoomControl: false }).setView([warehouse.lat, warehouse.lon], 10);
  L.control.scale().addTo(map);
  tileLayer(map);
  if (!districtsLayer) {
    fetch('./assets/districts.geojson')
      .then((r) => r.json())
      .then((g) => {
        districtsLayer = L.geoJSON(g, {
          style: { color: '#99E36D', weight: 0.5, opacity: 0.45, fillColor: '#7FDE44', fillOpacity: 0.02 },
          onEachFeature: (f, layer) => {
            const nm = f.properties && (f.properties.ADM2_EN || f.properties.name);
            if (nm) layer.bindTooltip(nm, { sticky: true });
          },
        }).addTo(map);
      })
      .catch(() => {});
  }
  return map;
}

export function clearAnimated(map, group) {
  if (group && map.hasLayer(group)) map.removeLayer(group);
}

/* ---------- Phase 1 scatter (Screen 1) ---------- */
export function drawScatter(map, warehouse, customers) {
  if (map._scatter) map.removeLayer(map._scatter);
  if (map._wh) map.removeLayer(map._wh);
  const whIcon = L.divIcon({ className: '', html: '<div class="whbadge">WH</div>', iconSize: [28, 28], iconAnchor: [14, 14] });
  map._wh = L.marker([warehouse.lat, warehouse.lon], { icon: whIcon, zIndexOffset: 1000 }).addTo(map)
    .bindPopup(`<b>${escapeHtml(warehouse.name)}</b><br>Origin of every route`);
  const pts = customers.map((c) => {
    const r = Math.max(4, 3 + Math.min(6, (c.orderVolume || 0) * 1.5));
    const has = (c.orderValue || 0) > 0 || (c.orderVolume || 0) > 0;
    const col = has ? '#10CCBE' : '#B0B0B0';
    const mk = L.circleMarker([c.lat, c.lon], { radius: r, color: col, fillColor: col, fillOpacity: has ? 0.65 : 0.4, weight: 1 });
    mk.bindPopup(bpPopup(c, null));
    mk.on('mouseover', () => mk.openTooltip());
    mk.on('mouseout', () => mk.closeTooltip());
    mk.bindTooltip(bpPopup(c, null), { sticky: true, direction: 'top', opacity: 0.95, className: 'cust-tooltip' });
    return mk;
  });
  map._scatter = L.layerGroup(pts).addTo(map);
  const b = L.latLngBounds(pts.map((m) => m.getLatLng()).concat([[warehouse.lat, warehouse.lon]]));
  if (b.isValid()) map.fitBounds(b.pad(0.1));
}

export function bpPopup(c, routeLabel = null) {
  return `<b>${escapeHtml(c.name)}</b><br>BP ID: ${escapeHtml(c.bpId)}` +
    `<br>Location: ${escapeHtml(c.address || '—')}` +
    `<br>GPS: ${Number(c.lat).toFixed(5)}, ${Number(c.lon).toFixed(5)}` +
    `<br>Order value: BDT ${(Number(c.orderValue || 0) / 1e5).toFixed(1)} lakh` +
    `<br>Order volume: ${Number(c.orderVolume || 0).toFixed(2)} MT` +
    (routeLabel ? `<br>Route: ${escapeHtml(routeLabel)}` : '<br>Not on a route');
}

/* ---------- Review drawing ---------- */
const stopIcon = (txt, color) => L.divIcon({
  className: '',
  html: `<div class="stopbadge" style="background:${color}">${txt}</div>`,
  iconSize: [22, 22], iconAnchor: [11, 11],
});
const whIcon = () => L.divIcon({ className: '', html: '<div class="whbadge">WH</div>', iconSize: [28, 28], iconAnchor: [14, 14] });

/**
 * Show exactly one route: legs drawn in order WH -> s1 -> ... -> sn.
 * legs: [{points, km, ok, from, to}] from fetchRouteLegs; fallback legs dashed grey.
 */
export function showRoute(map, warehouse, route, legs, { labelsById = new Map(), overviewRoutes = null } = {}) {
  clearReviewLayers(map);
  const group = L.layerGroup().addTo(map);
  map._reviewGroup = group;
  map._whMarker = L.marker([warehouse.lat, warehouse.lon], { icon: whIcon(), zIndexOffset: 1000 }).addTo(group)
    .bindPopup(`<b>${escapeHtml(warehouse.name)}</b><br>Origin of every route`);

  const color = route.__color || COLORS[(route.__index || 0) % COLORS.length];
  let nearPt = [warehouse.lat, warehouse.lon];

  (legs || []).forEach((leg) => {
    const line = L.polyline(leg.points, {
      color: leg.ok ? '#C40056' : '#8E8E93',
      weight: leg.ok ? 5 : 3,
      opacity: leg.ok ? 0.9 : 0.8,
      dashArray: leg.ok ? null : '6 8',
      className: 'route-leg',
    }).addTo(group).bindTooltip(`${leg.from} → ${leg.to} · ${Number(leg.km).toFixed(1)} km${leg.ok ? '' : ' (straight-line)'} `, { sticky: true });
    if (leg.ok) line.setStyle({ opacity: 0.95 });
    nearPt = leg.points[leg.points.length - 1] || nearPt;
  });

  (route.customers || []).forEach((c, j) => {
    const cc = labelsById.get(c.id) || c;
    const mk = L.marker([cc.lat, cc.lon], { icon: stopIcon(j + 1, '#C40056'), zIndexOffset: 500 }).addTo(group);
    mk.bindPopup(bpPopup(cc, `${route.id || 'Route'} · Stop ${j + 1}`));
    mk.bindTooltip(bpPopup(cc, `${route.id || 'Route'} · Stop ${j + 1}`), { sticky: true, direction: 'top', opacity: 0.95, className: 'cust-tooltip' });
    mk.on('mouseover', function () { this.openTooltip(); });
    mk.on('mouseout', function () { this.closeTooltip(); });
  });

  // fit to route extent
  const b = L.latLngBounds([[warehouse.lat, warehouse.lon]]);
  (route.customers || []).forEach((c) => { const cc = labelsById.get(c.id) || c; b.extend([cc.lat, cc.lon]); });
  if (b.isValid()) map.fitBounds(b.pad(0.15));
  return group;
}

/** Plan overview: thin lines of all routes with one-route focus retained underneath. */
export function showOverview(map, warehouse, routes, labelsById, colorsIndexMap = {}) {
  clearReviewLayers(map);
  const group = L.layerGroup().addTo(map);
  map._reviewGroup = group;
  map._whMarker = L.marker([warehouse.lat, warehouse.lon], { icon: whIcon(), zIndexOffset: 1000 }).addTo(group);
  const b = L.latLngBounds([[warehouse.lat, warehouse.lon]]);
  routes.forEach((r) => {
    const ids = (r.customers || []).map((c) => c.id);
    const pts = [[warehouse.lat, warehouse.lon], ...ids.map((id) => { const cc = labelsById.get(id) || r; b.extend([cc.lat, cc.lon]); return [cc.lat, cc.lon]; })];
    const col = STATUS_COLORS[r.status] || COLORS[0];
    L.polyline(pts, { color: col, weight: 3, opacity: 0.65 }).addTo(group).bindTooltip(`${r.id || ''} · ${r.status}`, { sticky: true });
    (r.customers || []).forEach((c, j) => {
      const cc = labelsById.get(c.id) || c;
      const mk = L.marker([cc.lat, cc.lon], { icon: stopIcon(j + 1, col) }).addTo(group);
      mk.bindPopup(bpPopup(cc, `${r.id || ''} · Stop ${j + 1}`));
    });
  });
  if (b.isValid()) map.fitBounds(b.pad(0.1));
  return group;
}

export function clearReviewLayers(map) {
  if (map._reviewGroup) { map.removeLayer(map._reviewGroup); map._reviewGroup = null; }
}

export function setBanners({ fallback = false, profile = false } = {}) {
  const el = document.getElementById('mapBanners');
  if (!el) return;
  let html = '';
  if (fallback) html += `<div class="banner banner-fallback">${bannerCopy('fallback')}</div>`;
  if (profile) html += `<div class="banner banner-profile">${bannerCopy('profile')}<button type="button" class="bnr-x" data-bnr-close>✕</button></div>`;
  el.innerHTML = html;
  el.hidden = html === '';
  el.querySelectorAll('[data-bnr-close]').forEach((b) => b.addEventListener('click', () => {
    b.closest('.banner')?.remove();
    el.hidden = !el.querySelector('.banner');
  }));
}
