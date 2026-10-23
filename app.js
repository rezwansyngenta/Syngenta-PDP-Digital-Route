/* PDP Digital Route — browser UI. All compute happens locally. */

const $ = (id) => document.getElementById(id);
const COLORS = ['#4FAE2E', '#10AFA4', '#3687D6', '#626BC7', '#9966C2', '#F0A32D', '#E84D8D', '#718278'];

let SETTINGS = {};
let DATA = null;
let RESULT = null;
let worker = null;
let busy = false;

const PDP = { pmin: 10, vmin: 12, cap: 12 };
const mapState = { map: null, lines: {}, markers: {}, un: [], districts: null, legLabels: {} };
let selectedRoute = null;
const flt = { routes: new Set(), qual: 'All', status: 'All', showAll: false };
let corridorOn = false, corridorW = 2;

/* ---------------- settings ---------------- */
async function loadSettings() {
  try {
    SETTINGS = await (await fetch('./settings.json', { cache: 'no-cache' })).json();
  } catch {
    SETTINGS = {};
  }
  const title = SETTINGS.title || 'PDP Digital Route';
  $('appTitle').textContent = title;
  document.title = title;
  if (SETTINGS.warehouse_name) $('appSub').textContent = SETTINGS.warehouse_name;
  if (SETTINGS.pdp_value_cr != null) $('pmin').value = SETTINGS.pdp_value_cr;
  if (SETTINGS.pdp_volume_mt != null) $('vmin').value = SETTINGS.pdp_volume_mt;
  if (SETTINGS.truck_capacity_mt != null) $('cap').value = SETTINGS.truck_capacity_mt;
}

/* ---------------- status ---------------- */
function setStatus(msg, isError = false, pct = null) {
  const el = $('net');
  el.hidden = !msg;
  el.classList.toggle('err', !!isError);
  $('netMsg').textContent = msg || '';
  const bar = $('netBar');
  const fill = bar.firstElementChild;
  bar.hidden = pct == null;
  bar.classList.toggle('indeterminate', pct == null);
  fill.style.width = pct == null ? '' : `${Math.max(0, Math.min(100, pct))}%`;
}

/* ---------------- file pickers ---------------- */
function bindFile(inputId, nameId) {
  $(inputId).addEventListener('change', (e) => {
    const f = e.target.files[0];
    $(nameId).textContent = f ? f.name : 'Choose Excel file …';
  });
}
bindFile('gpsFile', 'gpsName');
bindFile('orderFile', 'orderName');

function sheetRows(arrayBuffer) {
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  if (!wb.SheetNames.length) throw new Error('Workbook has no sheets');
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
}

function parseWarehouseOverride() {
  const raw = ($('whOverride').value || '').trim();
  if (!raw) return null;
  const parts = raw.split(/[,;\s]+/).map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    throw new Error('Warehouse override must be "latitude, longitude"');
  }
  const [lat, lon] = parts;
  if (lat < 20 || lat > 27 || lon < 88 || lon > 93) {
    throw new Error(`Warehouse override (${lat}, ${lon}) is outside Bangladesh`);
  }
  return { lat, lon };
}

/* ---------------- worker ---------------- */
function getWorker() {
  if (!worker) {
    worker = new Worker('./worker.js', { type: 'module' });
    worker.onmessage = (ev) => handleWorkerMessage(ev.data || {});
    worker.onerror = (e) => {
      setStatus(`Solver error: ${e.message || 'worker failed'}`, true);
      setBusy(false);
    };
  }
  return worker;
}

function handleWorkerMessage(msg) {
  if (msg.type === 'progress') {
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : null;
    setStatus(msg.message, false, msg.stage === 'distance' && msg.total > 1 ? pct : null);
    return;
  }
  if (msg.type === 'warn') { setStatus(msg.message, false, null); return; }
  if (msg.type === 'error') { setStatus(msg.message, true); setBusy(false); return; }
  if (msg.type === 'aborted') { setStatus('Solve cancelled.', true); setBusy(false); return; }
  if (msg.type === 'done') {
    DATA = msg.data;
    RESULT = msg.result;
    setBusy(false);
    setStatus('');
    $('result').hidden = false;
    $('drawer').hidden = true;
    selectedRoute = null;
    flt.routes.clear(); flt.qual = 'All'; flt.status = 'All'; flt.showAll = false;
    $('fltQual').value = 'All'; $('fltStatus').value = 'All'; $('fltShowAll').checked = false;
    buildSearchList();
    buildRouteFilter();
    renderSummary();
    renderMap();
    renderRoutes();
    renderCustomerLayers();
    renderExceptions();
    renderFoot();
  }
}

function setBusy(b) {
  busy = b;
  const btn = $('solveBtn');
  btn.disabled = b;
  btn.innerHTML = b
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>Solving…'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>Solve Routes';
}

$('solveBtn').addEventListener('click', async () => {
  if (busy) return;
  const gpsFile = $('gpsFile').files[0];
  const orderFile = $('orderFile').files[0];
  if (!gpsFile || !orderFile) { setStatus('Please choose both Excel files first.', true); return; }

  try {
    setBusy(true);
    setStatus('Reading the Excel files…');
    const [gpsRows, ordersRows] = await Promise.all([
      gpsFile.arrayBuffer().then(sheetRows),
      orderFile.arrayBuffer().then(sheetRows),
    ]);

    PDP.pmin = Number($('pmin').value) || 10;
    PDP.vmin = Number($('vmin').value) || 12;
    PDP.cap = Number($('cap').value) || 12;

    const settings = { ...SETTINGS };
    const override = parseWarehouseOverride();
    if (override) {
      settings.warehouse_override = true;
      settings.warehouse_lat = override.lat;
      settings.warehouse_lon = override.lon;
    }

    getWorker().postMessage({
      type: 'solve',
      gpsRows,
      ordersRows,
      settings,
      params: {
        cap: PDP.cap,
        vmin: PDP.vmin,
        pmin: PDP.pmin,
        mode: $('mode').value === 'min-trucks' ? 'min-trucks' : 'min-km',
        osrmEndpoint: SETTINGS.osrm_endpoint,
        osrmChunk: SETTINGS.osrm_table_chunk,
        maxCandidates: SETTINGS.max_candidates,
      },
    });
  } catch (err) {
    setStatus(err.message || String(err), true);
    setBusy(false);
  }
});

/* ---------------- summary ---------------- */
function renderSummary() {
  const r = RESULT;
  const vol = r.routes.reduce((a, x) => a + x.volume, 0);
  const val = r.routes.reduce((a, x) => a + x.value, 0);
  const km = r.totalDistance;
  const cards = [
    { lab: 'Proposed routes', dot: 'var(--brand)', val: r.routeCount, dl: `${r.unassignedCount} unassigned` },
    { lab: 'Road distance', dot: 'var(--g1)', val: Math.round(km).toLocaleString(), dl: 'total km' },
    { lab: 'Volume planned', dot: 'var(--cy)', val: `${vol.toFixed(1)} MT`, dl: `${PDP.cap} MT truck capacity` },
    { lab: 'Value planned', dot: 'var(--pink)', val: `${(val / 1e7).toFixed(2)} Cr`, dl: 'BDT' },
  ];
  $('kpis').innerHTML = cards.map((k) =>
    `<div class="kpi"><div class="lab"><i class="dotc" style="background:${k.dot}"></i>${k.lab}</div>` +
    `<div class="val">${k.val}</div><div class="dl">${k.dl}</div></div>`).join('');
}

const badge = (q) => (q === 'Below'
  ? '<span class="tag below">Below PDP</span>'
  : '<span class="tag">PDP met</span>');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- routes + filters ---------------- */
function buildRouteFilter() {
  $('fltRoutes').innerHTML = RESULT.routes.map((r, i) =>
    `<option value="${i}">R${String(i + 1).padStart(2, '0')} — ${r.customers.length} stops — ${r.distance.toFixed(0)} km</option>`).join('');
}

const routeVisible = (i) => {
  if (flt.routes.size && !flt.routes.has(String(i))) return false;
  if (flt.qual !== 'All' && RESULT.routes[i].qualifiesBy !== flt.qual) return false;
  return true;
};

function filterChanged() {
  if (selectedRoute != null && !routeVisible(selectedRoute)) {
    selectedRoute = null;
    $('drawer').hidden = true;
  }
  renderRoutes();
  if (mapState.map) styleRoutes();
}

function renderRoutes() {
  const tb = $('routeBody');
  tb.innerHTML = '';
  const n = RESULT.routes.filter((_, i) => routeVisible(i)).length;
  $('routeCount').textContent = `${n}/${RESULT.routes.length} routes · ${RESULT.unassignedCount} unassigned`;
  RESULT.routes.forEach((r, i) => {
    if (!routeVisible(i)) return;
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.dataset.i = i;
    tr.innerHTML =
      `<td><span class="mono" style="color:${COLORS[i % COLORS.length]}">R${String(i + 1).padStart(2, '0')}</span></td>` +
      `<td>${r.customers.length}</td><td>${r.volume.toFixed(1)} MT</td>` +
      `<td>${(r.value / 1e7).toFixed(2)} Cr</td><td>${r.distance.toFixed(1)}</td>` +
      `<td>${badge(r.qualifiesBy)}</td>`;
    tr.addEventListener('click', () => selectRoute(i));
    tb.appendChild(tr);
  });
  if (!selectedRoute) {
    $('detail').innerHTML = '<div class="muted" style="font-size:12.5px">Click a route in the list, on the map or a legend pill to see stops, leg distances and Google Maps navigation.</div>';
  }
}

function renderExceptions() {
  const byId = new Map(DATA.customers.map((c) => [c.id, c]));
  const below = RESULT.routes.map((r, i) => ({ r, i })).filter((x) => x.r.qualifiesBy === 'Below');
  $('excCount').textContent = `Exceptions (${below.length} below PDP · ${RESULT.unassignedCount} unassigned)`;
  let html = '';
  for (const x of below) {
    html += `<div class="exc" style="background:var(--pink-soft);color:var(--pink-ink)">` +
      `<span class="dotc" style="background:var(--pink-deep)"></span>` +
      `<span><b>R${String(x.i + 1).padStart(2, '0')}</b> · ${x.r.volume.toFixed(1)} MT · ৳${(x.r.value / 1e7).toFixed(2)} Cr</span>` +
      `<button class="btn ghost" style="margin-left:auto" data-act="review" data-i="${x.i}">Review</button></div>`;
  }
  for (const u of RESULT.unassigned) {
    const c = byId.get(u.customerId) || {};
    html += `<div class="exc"><span class="dotc" style="background:#8E8E93"></span>` +
      `<span>${esc(c.name)} <span class="muted">(${esc(c.bpId)})</span> · ${(c.orderVolume || 0).toFixed(2)} MT · ৳${((c.orderValue || 0) / 1e5).toFixed(1)} lakh</span>` +
      `<span class="muted" style="margin-left:auto">${esc(u.reason)}</span></div>`;
  }
  $('excList').innerHTML = html
    || '<div class="muted" style="font-size:12.5px">No exceptions. All routes meet PDP and all customers are assigned.</div>';
}

function renderFoot() {
  const s = DATA.meta.distanceStats || {};
  const bits = [
    DATA.meta.distanceSource,
    `${s.cacheHits?.toLocaleString?.() ?? 0} pairs from cache`,
    `${s.osrmPairs?.toLocaleString?.() ?? 0} from OSRM`,
    `${s.fallbackPairs?.toLocaleString?.() ?? 0} straight-line`,
    `${DATA.meta.totalCustomers} customers · ${DATA.meta.orderedCount} with orders`,
    `solved in ${RESULT.solveTime}s`,
  ];
  $('foot').textContent = bits.join(' · ');
}

/* ---------------- route detail ---------------- */
const byIdMap = () => new Map(DATA.customers.map((c) => [c.id, c]));
const distAB = (a, b) => {
  const v = DATA.distMatrix[a < b ? `${a}|${b}` : `${b}|${a}`];
  return v == null ? 99999 : v;
};
const routeDist = (ids) => {
  if (!ids.length) return 0;
  let d = distAB('WH', ids[0]);
  for (let k = 1; k < ids.length; k++) d += distAB(ids[k - 1], ids[k]);
  return d;
};

function insertBest(ids, id) {
  let best = null;
  for (let p = 0; p <= ids.length; p++) {
    const order = ids.slice(0, p).concat([id], ids.slice(p));
    const d = routeDist(order);
    if (best === null || d < best.d) best = { order, d };
  }
  return best;
}

const nearestOnRoute = (ids, c) => ids.reduce((m, id) => Math.min(m, distAB(id, c.id)), Infinity);

function routeOfId(id) {
  return RESULT.routes.findIndex((r) => r.customers.some((c) => c.id === id));
}

const legKm = (ids) => {
  const seq = ['WH'].concat(ids);
  const legs = { WHfirst: null, mid: [], ret: null };
  let d = null;
  for (let k = 0; k < seq.length - 1; k++) {
    const v = distAB(seq[k], seq[k + 1]);
    legs.mid.push(v);
    if (k === 0) legs.WHfirst = v;
    d = (d ?? 0) + v;
  }
  if (ids.length) legs.ret = distAB(seq[seq.length - 1], 'WH');
  return legs;
};

function showRouteDetail(i) {
  const r = RESULT.routes[i];
  const byId = byIdMap();
  const ids = r.customers.map((c) => c.id);
  const lg = legKm(ids);

  const stops = r.customers.map((c, j) => {
    const cc = byId.get(c.id) || {};
    return `<tr data-act="focus" data-i="${i}" data-j="${j}">` +
      `<td>${j + 1}</td><td><b>${esc(cc.name)}</b> <span class="muted">${esc(cc.bpId)}</span></td>` +
      `<td>${(cc.orderVolume || 0).toFixed(2)}</td><td>${((cc.orderValue || 0) / 1e5).toFixed(1)} lk</td>` +
      `<td class="kmcell">${lg.mid[j].toFixed(1)} km</td></tr>`;
  }).join('');

  let gap = '';
  if (r.qualifiesBy === 'Below') {
    const needV = Math.max(0, PDP.vmin - r.volume);
    const needP = Math.max(0, PDP.pmin * 1e7 - r.value);
    gap = `<div class="pdpgap"><span>Does not meet PDP</span>` +
      `<span>Shortfall: ${needV.toFixed(1)} MT · ৳${(needP / 1e5).toFixed(1)} lakh</span></div>`;
  }

  let warn = '';
  if (r.orig_distance && r.orig_distance - r.distance > 5) {
    warn = `<div class="warnbar" style="background:var(--lime-soft);color:var(--brand-ink)">` +
      `<span>Sequence optimised: saved ${(r.orig_distance - r.distance).toFixed(1)} km (was ${r.orig_distance.toFixed(0)} km).</span></div>`;
  }

  const corridor = `<div class="corridorbar">` +
    '<span class="note">Route corridor</span>' +
    `<span class="seg"><button type="button" class="${corridorW === 2 ? 'on' : ''}" data-act="corridor" data-w="2">2 km</button>` +
    `<button type="button" class="${corridorW === 5 ? 'on' : ''}" data-act="corridor" data-w="5">5 km</button></span>` +
    `<button class="btn ghost" data-act="toggle-corridor">${corridorOn ? 'Hide nearby BPs' : 'Find nearby BPs'}</button>` +
    '<div class="nearby" id="nearby"></div></div>';

  $('drawerTitle').textContent = `R${String(i + 1).padStart(2, '0')} · ${r.customers.length} stops · ${r.distance.toFixed(1)} km`;

  $('detail').innerHTML =
    '<div class="row">' +
      `<div><div class="k">PDP</div><div class="v">${r.qualifiesBy}</div></div>` +
      `<div><div class="k">Load</div><div class="v">${r.volume.toFixed(1)} MT</div></div>` +
      `<div><div class="k">Value</div><div class="v">৳${(r.value / 1e7).toFixed(2)} Cr</div></div>` +
      `<div><div class="k">Load %</div><div class="v">${Math.round((r.volume / PDP.cap) * 100)}%</div></div>` +
    '</div>' +
    gap + warn +
    `<table class="stops"><thead><tr><th>#</th><th>Customer</th><th>MT</th><th>Value</th><th>Leg km</th></tr></thead>` +
    `<tbody>${stops}` +
    `<tr class="retrow" title="Display only - planned km totals remain outbound"><td>↩</td><td>Return to warehouse</td><td></td><td></td>` +
    `<td class="kmcell">${(lg.ret ?? 0).toFixed(1)} km</td></tr></tbody></table>` +
    `<a class="btn primary gmaps" href="${esc(r.gmaps_url)}" target="_blank" rel="noopener">View in Google Maps</a>` +
    corridor + '<div id="sim"></div>';

  if (corridorOn) renderNearby(i);
}

function selectRoute(i) {
  selectedRoute = i;
  document.querySelectorAll('#routeBody tr').forEach((tr) => tr.classList.toggle('thisrow', +tr.dataset.i === i));
  $('drawer').hidden = false;
  showRouteDetail(i);
  if (mapState.map) { styleRoutes(); fitRoute(i); }
}

function renderNearby(i) {
  const r = RESULT.routes[i];
  const ids = r.customers.map((c) => c.id);
  const inRoute = new Set(ids);
  const list = DATA.customers
    .filter((c) => !inRoute.has(c.id) && !c.excluded)
    .map((c) => ({ c, nd: nearestOnRoute(ids, c), detour: insertBest(ids, c.id).d - r.distance }))
    .filter((x) => x.nd <= corridorW)
    .sort((a, b) => a.detour - b.detour);

  const nb = $('nearby');
  if (!nb) return;
  nb.innerHTML = list.length
    ? list.slice(0, 8).map((x) =>
      `<div class="nb">` +
      `<span class="dotc" style="background:var(--cy)"></span>` +
      `<span>${esc(x.c.name)} <span class="muted">(${esc(x.c.bpId)})</span></span>` +
      `<span class="imp">+${x.detour.toFixed(1)} km · +${x.c.orderVolume.toFixed(2)} MT</span></div>`).join('')
    : `<span class="note">No nearby BPs within ${corridorW} km of this route.</span>`;
}

function focusStop(i, j) {
  const r = RESULT.routes[i];
  const c = byIdMap().get(r.customers[j].id);
  if (!c || !mapState.map) return;
  mapState.map.panTo([c.lat, c.lon], { animate: true });
  const m = mapState.markers[i] && mapState.markers[i][j];
  if (m) m.openPopup();
}

/* detail panel event delegation */
$('detail').addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const i = Number(el.dataset.i);
  if (act === 'focus') focusStop(i, Number(el.dataset.j));
  else if (act === 'review') selectRoute(i);
  else if (act === 'corridor') { corridorW = Number(el.dataset.w); showRouteDetail(i); }
  else if (act === 'toggle-corridor') { corridorOn = !corridorOn; if (selectedRoute != null) showRouteDetail(selectedRoute); }
});

$('drawerClose').addEventListener('click', () => {
  $('drawer').hidden = true;
  selectedRoute = null;
  document.querySelectorAll('#routeBody tr').forEach((tr) => tr.classList.remove('thisrow'));
  if (mapState.map) styleRoutes();
});

$('backBtn').addEventListener('click', () => { $('result').hidden = true; });

/* ---------------- map ---------------- */
const stopIcon = (txt, color) => L.divIcon({
  className: '',
  html: `<div class="stopbadge" style="background:${color}">${txt}</div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});
const whIcon = () => L.divIcon({ className: '', html: '<div class="whbadge">WH</div>', iconSize: [28, 28], iconAnchor: [14, 14] });

const bpPopup = (c, i, j) => {
  const routeLabel = i != null ? `R${String(i + 1).padStart(2, '0')} · Stop ${j + 1}` : 'Not on a route';
  return `<b>${esc(c.name)}</b><br>BP ID: ${esc(c.bpId)}<br>Location: ${esc(c.address || '—')}` +
    `<br>GPS: ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}` +
    `<br>Order value: ৳${(c.orderValue / 1e5).toFixed(1)} lakh` +
    `<br>Order volume: ${c.orderVolume.toFixed(2)} MT<br>Route: ${routeLabel}`;
};

function clearMap() {
  const { map } = mapState;
  if (!map) return;
  Object.values(mapState.lines).forEach((l) => { if (map.hasLayer(l)) map.removeLayer(l); });
  Object.values(mapState.legLabels).forEach((arr) => arr.forEach((m) => { if (map.hasLayer(m)) map.removeLayer(m); }));
  Object.values(mapState.markers).forEach((arr) => arr.forEach((m) => { if (map.hasLayer(m)) map.removeLayer(m); }));
  mapState.un.forEach((m) => { if (map.hasLayer(m)) map.removeLayer(m); });
  mapState.un = [];
  mapState.lines = {};
  mapState.markers = {};
  mapState.legLabels = {};
}

function renderMap() {
  const { map } = mapState;
  if (!map) {
    mapState.map = L.map('map', { zoomControl: false }).setView([DATA.warehouse.lat, DATA.warehouse.lon], 10);
    fetch('./assets/districts.geojson')
      .then((r) => r.json())
      .then((g) => {
        mapState.districts = L.geoJSON(g, {
          style: { color: '#99E36D', weight: 0.5, opacity: 0.45, fillColor: '#7FDE44', fillOpacity: 0.02 },
          onEachFeature: (f, layer) => {
            const nm = f.properties && (f.properties.ADM2_EN || f.properties.name);
            if (nm) layer.bindTooltip(nm, { sticky: true });
          },
        }).addTo(mapState.map);
      })
      .catch(() => {});
  }

  const byId = byIdMap();
  const m = mapState.map;

  L.marker([DATA.warehouse.lat, DATA.warehouse.lon], { icon: whIcon() })
    .addTo(m)
    .bindPopup(`<b>${esc(DATA.warehouse.name)}</b><br>Origin of every route`);

  RESULT.routes.forEach((r, i) => {
    const col = COLORS[i % COLORS.length];
    const ids = r.customers.map((c) => c.id);
    const seq = ['WH'].concat(ids);
    const pts = seq.map((id) => {
      const cc = id === 'WH' ? DATA.warehouse : byId.get(id);
      return [cc.lat, cc.lon];
    });
    const line = L.polyline(pts, { color: col, weight: 3, opacity: 0.85 }).addTo(m);
    line.on('click', () => selectRoute(i));
    line.bindTooltip(`R${String(i + 1).padStart(2, '0')} · ${r.customers.length} stops · ${r.distance.toFixed(1)} km`, { sticky: true });
    mapState.lines[i] = line;
    // per-leg km pills (hidden until the route is selected)
    mapState.legLabels[i] = seq.slice(0, -1).map((a, s) => {
      const b = seq[s + 1];
      const A = a === 'WH' ? DATA.warehouse : byId.get(a);
      const B = b === 'WH' ? DATA.warehouse : byId.get(b);
      const mid = [(A.lat + B.lat) / 2, (A.lon + B.lon) / 2];
      return L.marker(mid, {
        interactive: false,
        icon: L.divIcon({
          className: 'legbox',
          html: `<span class="legpill${a !== 'WH' && b !== 'WH' ? '' : ' ret'}">${distAB(a, b).toFixed(1)}</span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
      });
    });
    mapState.markers[i] = r.customers.map((c, j) => {
      const cc = byId.get(c.id);
      const mk = L.marker([cc.lat, cc.lon], { icon: stopIcon(j + 1, col) }).addTo(m);
      mk.bindPopup(bpPopup(cc, i, j));
      mk.on('click', () => selectRoute(i));
      return mk;
    });
  });

  RESULT.unassigned.forEach((u) => {
    const c = byId.get(u.customerId);
    if (!c) return;
    const mk = L.circleMarker([c.lat, c.lon], { radius: 7, color: '#F70566', fillColor: '#F70566', fillOpacity: 0.6 }).addTo(m);
    mk.bindPopup(`${bpPopup(c)}<br>Reason: ${esc(u.reason)}`);
    mapState.un.push(mk);
  });

  renderCustomerLayers();

  $('legendbar').innerHTML = RESULT.routes.slice(0, 12).map((r, i) =>
    `<span class="lgpill" data-i="${i}" style="cursor:pointer"><i class="swatch" style="background:${COLORS[i % COLORS.length]}"></i>R${String(i + 1).padStart(2, '0')} · ${r.distance.toFixed(0)} km</span>`).join('');
  $('legendbar').querySelectorAll('.lgpill').forEach((el) => {
    el.addEventListener('click', () => selectRoute(Number(el.dataset.i)));
  });

  fitAll();
}

/* layers */
let layerAllGroup = null;

function renderCustomerLayers() {
  const { map } = mapState;
  if (!map) return;
  if (layerAllGroup) { map.removeLayer(layerAllGroup); layerAllGroup = null; }

  const showUn = flt.status === 'All' || flt.status === 'Unassigned';
  mapState.un.forEach((mk) => {
    if (showUn && !map.hasLayer(mk)) mk.addTo(map);
    if (!showUn && map.hasLayer(mk)) map.removeLayer(mk);
  });

  if (!flt.showAll && flt.status !== 'Routed' && flt.status !== 'Unassigned' && flt.status !== 'No-order') return;

  layerAllGroup = L.layerGroup(DATA.customers.filter((c) => {
    if (c.excluded) return flt.status === 'All' || flt.status === 'No-order';
    const ri = routeOfId(c.id);
    if (ri >= 0) return flt.status === 'All' || flt.status === 'Routed';
    return flt.status === 'All' || flt.status === 'Unassigned';
  }).map((c) => {
    const ri = routeOfId(c.id);
    const col = ri >= 0 ? COLORS[ri % COLORS.length] : '#8E8E93';
    const radius = 3 + Math.min(6, c.orderVolume * 1.5);
    const mk = L.circleMarker([c.lat, c.lon], { radius, color: col, fillColor: col, fillOpacity: 0.55, weight: 1 });
    const j = ri >= 0 ? RESULT.routes[ri].customers.findIndex((x) => x.id === c.id) : null;
    mk.bindPopup(bpPopup(c, ri >= 0 ? ri : null, j));
    mk.on('click', () => { if (ri >= 0) selectRoute(ri); });
    return mk;
  })).addTo(map);
}

function buildSearchList() {
  $('bpList').innerHTML = DATA.customers
    .map((c) => `<option value="${esc(c.bpId)}">${esc(c.name)}</option>`).join('');
}

$('searchBox').addEventListener('change', function onSearch() {
  if (!DATA) return;
  const v = (this.value || '').trim();
  if (!v) return;
  const lower = v.toLowerCase();
  const c = DATA.customers.find((x) => String(x.bpId) === v)
    || DATA.customers.find((x) => x.name.toLowerCase().includes(lower));
  if (!c || !mapState.map) return;
  mapState.map.panTo([c.lat, c.lon], { animate: true });
  const ri = routeOfId(c.id);
  if (ri >= 0) {
    selectRoute(ri);
    focusStop(ri, RESULT.routes[ri].customers.findIndex((x) => x.id === c.id));
  }
});

$('fltRoutes').addEventListener('change', () => {
  flt.routes = new Set(Array.from($('fltRoutes').selectedOptions).map((o) => o.value));
  filterChanged();
});
$('fltQual').addEventListener('change', (e) => { flt.qual = e.target.value; filterChanged(); });
$('fltShowAll').addEventListener('change', (e) => { flt.showAll = e.target.checked; renderCustomerLayers(); });
$('fltStatus').addEventListener('change', (e) => { flt.status = e.target.value; renderCustomerLayers(); });

function fitAll() {
  if (!mapState.map || !RESULT) return;
  const b = new L.LatLngBounds([[DATA.warehouse.lat, DATA.warehouse.lon]]);
  const byId = byIdMap();
  RESULT.routes.forEach((r) => r.customers.forEach((c) => {
    const cc = byId.get(c.id);
    if (cc) b.extend([cc.lat, cc.lon]);
  }));
  RESULT.unassigned.forEach((u) => {
    const cc = byId.get(u.customerId);
    if (cc) b.extend([cc.lat, cc.lon]);
  });
  if (b.isValid()) mapState.map.fitBounds(b.pad(0.1));
}

function fitRoute(i) {
  const r = RESULT.routes[i];
  const byId = byIdMap();
  const b = new L.LatLngBounds([[DATA.warehouse.lat, DATA.warehouse.lon]]);
  r.customers.forEach((c) => {
    const cc = byId.get(c.id);
    if (cc) b.extend([cc.lat, cc.lon]);
  });
  if (b.isValid()) mapState.map.fitBounds(b.pad(0.15));
}

function styleRoutes() {
  const { map } = mapState;
  if (!map || !RESULT) return;
  RESULT.routes.forEach((r, k) => {
    const line = mapState.lines[k];
    const markers = mapState.markers[k] || [];
    const labels = mapState.legLabels[k] || [];
    if (!routeVisible(k)) {
      if (line && map.hasLayer(line)) map.removeLayer(line);
      markers.forEach((mk) => { if (map.hasLayer(mk)) map.removeLayer(mk); });
      labels.forEach((mk) => { if (map.hasLayer(mk)) map.removeLayer(mk); });
      return;
    }
    const others = selectedRoute != null && selectedRoute !== k;
    if (line && !map.hasLayer(line)) line.addTo(map);
    line.setStyle({ opacity: others ? 0.15 : selectedRoute === k ? 1 : 0.85, weight: others ? 2 : selectedRoute === k ? 6 : 3 });
    if (others) markers.forEach((mk) => { if (map.hasLayer(mk)) map.removeLayer(mk); });
    else markers.forEach((mk) => { if (!map.hasLayer(mk)) mk.addTo(map); mk.setOpacity(1); });
    labels.forEach((mk) => {
      const has = map.hasLayer(mk);
      if (selectedRoute === k && !has) mk.addTo(map);
      if (selectedRoute !== k && has) map.removeLayer(mk);
    });
  });
}

function showAllRoutes() {
  selectedRoute = null;
  $('drawer').hidden = true;
  document.querySelectorAll('#routeBody tr').forEach((tr) => tr.classList.remove('thisrow'));
  styleRoutes();
}

function toggleRoutes() {
  const btn = $('ctl-routes');
  if (btn.classList.toggle('on')) styleRoutes();
  else {
    RESULT.routes.forEach((r, i) => {
      const line = mapState.lines[i];
      if (line && mapState.map.hasLayer(line)) mapState.map.removeLayer(line);
      (mapState.markers[i] || []).forEach((m) => { if (mapState.map.hasLayer(m)) mapState.map.removeLayer(m); });
      (mapState.legLabels[i] || []).forEach((m) => { if (mapState.map.hasLayer(m)) mapState.map.removeLayer(m); });
    });
  }
}

$('ctl-in').addEventListener('click', () => mapState.map && mapState.map.zoomIn());
$('ctl-out').addEventListener('click', () => mapState.map && mapState.map.zoomOut());
$('ctl-fit').addEventListener('click', fitAll);
$('ctl-routes').addEventListener('click', toggleRoutes);

/* ---------------- export ---------------- */
function buildWorkbook() {
  const byId = byIdMap();
  const summary = [['Route ID', 'Customer Count', 'Total Volume (MT)', 'Total Value (BDT)',
    'Road Distance (km)', 'PDP Status', 'Capacity Utilisation']];
  RESULT.routes.forEach((r, i) => {
    summary.push([`R${String(i + 1).padStart(2, '0')}`, r.customers.length, r.volume, r.value,
      r.distance, r.qualifiesBy, r.utilisation]);
  });

  const stops = [['Route ID', 'Stop', 'BP ID', 'Customer Name', 'Volume (MT)', 'Value (BDT)']];
  RESULT.routes.forEach((r, i) => {
    r.customers.forEach((c, j) => {
      const cc = byId.get(c.id) || {};
      stops.push([`R${String(i + 1).padStart(2, '0')}`, j + 1, cc.bpId || '', cc.name || '',
        cc.orderVolume || 0, cc.orderValue || 0]);
    });
  });

  const links = [['Route ID', 'Google Maps URL']];
  RESULT.routes.forEach((r, i) => links.push([`R${String(i + 1).padStart(2, '0')}`, r.gmaps_url || '']));

  const unassigned = [['Customer', 'BP ID', 'Volume (MT)', 'Value (BDT)', 'Reason']];
  RESULT.unassigned.forEach((u) => {
    const c = byId.get(u.customerId) || {};
    unassigned.push([c.name || u.customerId, c.bpId || '', c.orderVolume || 0, c.orderValue || 0, u.reason]);
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Route Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stops), 'Route Stops');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(links), 'Google Maps Links');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(unassigned), 'Unassigned');
  return wb;
}

/* test hook: sheet list without triggering a download */
window.__exportWorkbook = () => {
  const wb = buildWorkbook();
  return { name: `route-plan-${new Date().toISOString().slice(0, 10)}.xlsx`, sheets: wb.SheetNames };
};

$('exportBtn').addEventListener('click', () => {
  if (!DATA || !RESULT) return;
  XLSX.writeFile(buildWorkbook(), `route-plan-${new Date().toISOString().slice(0, 10)}.xlsx`);
});

/* ---------------- theme ---------------- */
$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'light';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  try { localStorage.setItem('pdp-theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
});

loadSettings();
