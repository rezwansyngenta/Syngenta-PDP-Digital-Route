/* PDP Digital Route — browser UI. All compute happens locally. */

const $ = (id) => document.getElementById(id);
const COLORS = ['#4FAE2E', '#10AFA4', '#3687D6', '#626BC7', '#9966C2', '#F0A32D', '#E84D8D', '#718278'];

let SETTINGS = {};
let DATA = null;
let RESULT = null;
let worker = null;
let busy = false;

const PDP = { pmin: 10, vmin: 12, cap: 12 };
const mapState = { map: null, lines: {}, markers: {}, un: [], districts: null, whMarker: null };
let selectedRoute = null;
let layerAll = false, layerGps = false, layerExc = true;
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
    buildSearchList();
    renderSummary();
    renderMap();
    renderRoutes();
    renderExceptions();
    renderFoot();
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

const qualifyFor = (vol, val) => {
  const byVol = vol >= PDP.vmin;
  const byVal = val >= PDP.pmin * 1e7;
  if (byVol && byVal) return 'Both';
  if (byVol) return 'Volume';
  if (byVal) return 'Value';
  return 'Below';
};

const badge = (q) => (q === 'Below'
  ? '<span class="tag below">Below PDP</span>'
  : '<span class="tag">PDP met</span>');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- routes ---------------- */
function renderRoutes() {
  const tb = $('routeBody');
  tb.innerHTML = '';
  $('routeCount').textContent = `${RESULT.routes.length} routes · ${RESULT.unassignedCount} unassigned`;
  // populate route selector
  const sel = $('routeSelect');
  if (sel) {
    sel.innerHTML = RESULT.routes.map((r, i) => `<option value="${i}">R${String(i + 1).padStart(2, '0')} (${r.customers.length} stops, ${r.distance.toFixed(0)} km)</option>`).join('');
    sel.onchange = () => selectRoute(Number(sel.value));
  }
  RESULT.routes.forEach((r, i) => {
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
  $('detail').innerHTML = '<div class="muted" style="font-size:12.5px">Select a route above to see its stops, value and distance.</div>';
}

function renderExceptions() {
  const byId = new Map(DATA.customers.map((c) => [c.id, c]));
  const below = RESULT.routes.map((r, i) => ({ r, i })).filter((x) => x.r.qualifiesBy === 'Below');
  $('excCount').textContent = `${below.length} below PDP · ${RESULT.unassignedCount} unassigned`;
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
  $('exceptions').innerHTML = html
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

function backtrackKm(ids) {
  let bk = 0, prev = distAB('WH', ids[0]);
  for (let k = 1; k < ids.length; k++) {
    const w = distAB('WH', ids[k]);
    if (w < prev - 1) bk += prev - w;
    prev = w;
  }
  return bk;
}

const nearestOnRoute = (ids, c) => ids.reduce((m, id) => Math.min(m, distAB(id, c.id)), Infinity);

function routeOfId(id) {
  return RESULT.routes.findIndex((r) => r.customers.some((c) => c.id === id));
}

function selectRoute(i) {
  if (!RESULT || !RESULT.routes || i < 0 || i >= RESULT.routes.length) return;
  selectedRoute = i;
  const sel = $('routeSelect');
  if (sel) sel.value = String(i);
  document.querySelectorAll('#routeBody tr').forEach((tr) => tr.classList.toggle('thisrow', +tr.dataset.i === i));
  const r = RESULT.routes[i];
  const byId = byIdMap();
  const ids = r.customers.map((c) => c.id);

  const stops = r.customers.map((c, j) => {
    const cc = byId.get(c.id) || {};
    return `<div class="stop" data-act="focus" data-i="${i}" data-j="${j}">` +
      `<span class="n">${j + 1}</span><span class="nm">${esc(cc.name)}</span>` +
      `<span class="muted">${(cc.orderVolume || 0).toFixed(2)} MT · ৳${((cc.orderValue || 0) / 1e7).toFixed(2)} Cr</span></div>`;
  }).join('');

  let gap = '';
  if (r.qualifiesBy === 'Below') {
    const needV = Math.max(0, PDP.vmin - r.volume);
    const needP = Math.max(0, PDP.pmin * 1e7 - r.value);
    gap = `<div class="pdpgap"><span>Does not meet PDP</span>` +
      `<span>Shortfall: ${needV.toFixed(1)} MT · ৳${(needP / 1e5).toFixed(1)} lakh</span></div>`;
  }

  const bk = backtrackKm(ids);
  let warn = '';
  if (bk > 15) {
    warn = `<div class="warnbar"><span>Route quality check: ~${bk.toFixed(0)} km of backtracking toward the previous corridor.</span>` +
      `<button class="btn ghost" data-act="reopt" data-i="${i}">Optimise sequence</button></div>`;
  } else if (r.orig_distance && r.orig_distance - r.distance > 5) {
    warn = `<div class="warnbar" style="background:var(--lime-soft);color:var(--brand-ink)">` +
      `<span>Sequence optimised: saved ${(r.orig_distance - r.distance).toFixed(1)} km (was ${r.orig_distance.toFixed(0)} km).</span>` +
      `<button class="btn ghost" data-act="restore" data-i="${i}">Restore original</button></div>`;
  }

  const corridor = `<div class="corridorbar">` +
    '<span class="note">Route corridor</span>' +
    `<span class="seg"><button type="button" class="${corridorW === 2 ? 'on' : ''}" data-act="corridor" data-w="2">2 km</button>` +
    `<button type="button" class="${corridorW === 5 ? 'on' : ''}" data-act="corridor" data-w="5">5 km</button></span>` +
    `<button class="btn ghost" data-act="toggle-corridor">${corridorOn ? 'Hide nearby BPs' : 'Find nearby BPs'}</button>` +
    '<div class="nearby" id="nearby"></div></div>';

  $('detail').innerHTML =
    '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
      `<div><div class="k">Route</div><div class="v" style="color:${COLORS[i % COLORS.length]}">R${String(i + 1).padStart(2, '0')}</div></div>` +
      `<div><div class="k">PDP</div><div class="v">${r.qualifiesBy}</div></div>` +
      `<div><div class="k">Load</div><div class="v">${r.volume.toFixed(1)} MT</div></div>` +
      `<div><div class="k">Value</div><div class="v">৳${(r.value / 1e7).toFixed(2)} Cr</div></div>` +
      `<div><div class="k">Road km</div><div class="v">${r.distance.toFixed(1)}</div></div>` +
      '<div class="spacer" style="flex:1"></div>' +
      `<a class="btn primary" href="${esc(r.gmaps_url)}" target="_blank" rel="noopener">View in Google Maps</a>` +
    '</div>' +
    gap + warn +
    `<div class="stops">${stops}</div>` +
    corridor + '<div id="sim"></div>';

  if (mapState.map) { isolateRoute(i); fitRoute(i); }
  if (corridorOn) renderNearby(i);
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
      `<div class="nb" data-act="sim" data-i="${i}" data-id="${esc(x.c.id)}">` +
      `<span class="dotc" style="background:var(--cy)"></span>` +
      `<span>${esc(x.c.name)} <span class="muted">(${esc(x.c.bpId)})</span></span>` +
      `<span class="imp">+${x.detour.toFixed(1)} km · +${x.c.orderVolume.toFixed(2)} MT</span></div>`).join('')
    : `<span class="note">No nearby BPs within ${corridorW} km of this route.</span>`;
}

function simulateBp(i, bpId) {
  const r = RESULT.routes[i];
  const ids = r.customers.map((c) => c.id);
  const c = byIdMap().get(bpId);
  if (!c) return;
  const best = insertBest(ids, bpId);
  const nv = r.volume + c.orderVolume;
  const nval = r.value + c.orderValue;
  const pdpOk = nv >= PDP.vmin || nval >= PDP.pmin * 1e7;
  const capOk = nv <= PDP.cap;
  $('sim').innerHTML =
    '<div class="simcard"><table>' +
    `<tr><th>Metric</th><th>Current route</th><th>With ${esc(c.name)}</th><th>Change</th></tr>` +
    `<tr><td>Volume</td><td>${r.volume.toFixed(1)} MT</td><td>${nv.toFixed(1)} MT</td><td class="chg">+${c.orderVolume.toFixed(1)} MT</td></tr>` +
    `<tr><td>Value</td><td>৳${(r.value / 1e7).toFixed(2)} Cr</td><td>৳${(nval / 1e7).toFixed(2)} Cr</td><td class="chg">+৳${(c.orderValue / 1e5).toFixed(1)} lakh</td></tr>` +
    `<tr><td>Road distance</td><td>${r.distance.toFixed(1)} km</td><td>${best.d.toFixed(1)} km</td><td class="chg">+${(best.d - r.distance).toFixed(1)} km</td></tr>` +
    `<tr><td>PDP result</td><td>${r.qualifiesBy}</td><td>${pdpOk ? 'PDP met' : 'Below PDP'}</td><td>${pdpOk ? 'Met' : 'Short'}</td></tr>` +
    `<tr><td>Capacity</td><td>Normal</td><td>${capOk ? 'Normal' : 'Above selected capacity'}</td><td>${capOk ? '—' : 'Approval required'}</td></tr>` +
    '</table><div style="padding:10px;display:flex;gap:8px;flex-wrap:wrap">' +
    `<button class="btn primary" data-act="apply" data-i="${i}" data-id="${esc(bpId)}">Apply to route</button>` +
    '<button class="btn ghost" data-act="sim-clear">Keep current route</button></div></div>';
}

function applyBp(i, bpId) {
  const r = RESULT.routes[i];
  const byId = byIdMap();
  const c = byId.get(bpId);
  if (!c) return;
  const best = insertBest(r.customers.map((x) => x.id), bpId);
  r.customers = best.order.map((id) => {
    const cc = byId.get(id) || {};
    return { id, name: cc.name || '', bpId: cc.bpId || '', orderVolume: cc.orderVolume || 0, orderValue: cc.orderValue || 0 };
  });
  r.volume += c.orderVolume;
  r.value += c.orderValue;
  r.distance = best.d;
  r.qualifiesBy = qualifyFor(r.volume, r.value);
  clearMap();
  renderMap();
  renderSummary();
  renderRoutes();
  renderExceptions();
  selectRoute(i);
}

function reoptimise(i) {
  const r = RESULT.routes[i];
  let ids = r.customers.map((c) => c.id);
  let d = routeDist(ids);
  let improved = true;
  while (improved) {
    improved = false;
    for (let a = 0; a < ids.length - 1; a++) {
      for (let b = a + 2; b < ids.length; b++) {
        const o = ids.slice(0, a + 1).concat(ids.slice(a + 1, b + 1).reverse(), ids.slice(b + 1));
        const nd = routeDist(o);
        if (nd < d - 0.01) { ids = o; d = nd; improved = true; }
      }
    }
  }
  const byId = byIdMap();
  r.customers = ids.map((id) => {
    const cc = byId.get(id) || {};
    return { id, name: cc.name || '', bpId: cc.bpId || '', orderVolume: cc.orderVolume || 0, orderValue: cc.orderValue || 0 };
  });
  r.distance = d;
  clearMap();
  renderMap();
  renderRoutes();
  selectRoute(i);
}

function restoreOriginal(i) {
  const r = RESULT.routes[i];
  if (!r.orig_order) return;
  const byId = byIdMap();
  r.customers = r.orig_order.map((id) => {
    const cc = byId.get(id) || {};
    return { id, name: cc.name || '', bpId: cc.bpId || '', orderVolume: cc.orderVolume || 0, orderValue: cc.orderValue || 0 };
  });
  r.distance = r.orig_distance;
  clearMap();
  renderMap();
  renderRoutes();
  selectRoute(i);
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
  else if (act === 'reopt') reoptimise(i);
  else if (act === 'restore') restoreOriginal(i);
  else if (act === 'corridor') { corridorW = Number(el.dataset.w); selectRoute(i); }
  else if (act === 'toggle-corridor') { corridorOn = !corridorOn; if (selectedRoute != null) selectRoute(selectedRoute); }
  else if (act === 'sim') simulateBp(i, el.dataset.id);
  else if (act === 'apply') applyBp(i, el.dataset.id);
  else if (act === 'sim-clear') { const s = $('sim'); if (s) s.innerHTML = ''; }
});

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
  Object.values(mapState.lines).forEach((l) => { try { if (map.hasLayer(l)) map.removeLayer(l); } catch {} });
  Object.values(mapState.markers).forEach((arr) => (arr || []).forEach((m) => { try { if (map.hasLayer(m)) map.removeLayer(m); } catch {} }));
  (mapState.un || []).forEach((m) => { try { if (map.hasLayer(m)) map.removeLayer(m); } catch {} });
  mapState.un = [];
  mapState.lines = {};
  mapState.markers = {};
}

function renderMap() {
  const { map } = mapState;
  if (!map) {
    mapState.map = L.map('map', { zoomControl: false }).setView([DATA.warehouse.lat, DATA.warehouse.lon], 10);
    L.control.scale().addTo(mapState.map);
    fetch('./assets/districts.geojson')
      .then((r) => r.json())
      .then((g) => {
        if (!mapState.map) return;
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

  // Clear existing route layers/markers before re-render
  clearMap();

  if (mapState.whMarker && m.hasLayer(mapState.whMarker)) m.removeLayer(mapState.whMarker);
  mapState.whMarker = L.marker([DATA.warehouse.lat, DATA.warehouse.lon], { icon: whIcon(), zIndexOffset: 1000 })
    .addTo(m)
    .bindPopup(`<b>${esc(DATA.warehouse.name)}</b><br>Origin of every route`);

  RESULT.routes.forEach((r, i) => {
    const col = COLORS[i % COLORS.length];
    const pts = [[DATA.warehouse.lat, DATA.warehouse.lon]]
      .concat(r.customers.map((c) => [byId.get(c.id).lat, byId.get(c.id).lon]));
    const line = L.polyline(pts, { color: col, weight: 4, opacity: 0.9, className: `route-line route-${i}` }).addTo(m);
    line.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectRoute(i);
    });
    mapState.lines[i] = line;
    mapState.markers[i] = r.customers.map((c, j) => {
      const cc = byId.get(c.id);
      const mk = L.marker([cc.lat, cc.lon], { icon: stopIcon(j + 1, col), zIndexOffset: 500 }).addTo(m);
      mk.bindPopup(bpPopup(cc, i, j));
      mk.bindTooltip(bpPopup(cc, i, j), { sticky: true, direction: 'top', opacity: 0.95, className: 'cust-tooltip', interactive: true });
      mk.on('mouseover', function() { this.openTooltip(); });
      mk.on('mouseout', function() { this.closeTooltip(); });
      mk.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectRoute(i);
        focusStop(i, j);
        mk.openPopup();
      });
      return mk;
    });
  });

  RESULT.unassigned.forEach((u) => {
    const c = byId.get(u.customerId);
    if (!c) return;
    const mk = L.circleMarker([c.lat, c.lon], { radius: 7, color: '#F70566', fillColor: '#F70566', fillOpacity: 0.6, zIndexOffset: 300 }).addTo(m);
    mk.bindPopup(`${bpPopup(c)}<br>Reason: ${esc(u.reason)}`);
    mapState.un.push(mk);
  });

  renderLayers();

  const lb = $('legendbar');
  if (lb) lb.innerHTML = '';

  fitAll();
  if (selectedRoute != null && RESULT.routes[selectedRoute]) {
    selectRoute(selectedRoute);
  }
}

/* layers */
let layerAllGroup = null, layerGpsGroup = null;

function renderLayers() {
  const { map } = mapState;
  if (!map) return;
  if (layerAllGroup) { map.removeLayer(layerAllGroup); layerAllGroup = null; }
  if (layerGpsGroup) { map.removeLayer(layerGpsGroup); layerGpsGroup = null; }

  if (layerAll) {
    layerAllGroup = L.layerGroup(DATA.customers.filter((c) => !c.excluded).map((c) => {
      const ri = routeOfId(c.id);
      const col = ri >= 0 ? COLORS[ri % COLORS.length] : '#8E8E93';
      const radius = 3 + Math.min(6, c.orderVolume * 1.5);
      const mk = L.circleMarker([c.lat, c.lon], { radius, color: col, fillColor: col, fillOpacity: 0.65, weight: 1 });
      const j = ri >= 0 ? RESULT.routes[ri].customers.findIndex((x) => x.id === c.id) : null;
      mk.bindPopup(bpPopup(c, ri >= 0 ? ri : null, j));
      mk.bindTooltip(bpPopup(c, ri >= 0 ? ri : null, j), { sticky: true, direction: 'top', opacity: 0.95, className: 'cust-tooltip', interactive: true });
      mk.on('mouseover', function() { this.openTooltip(); });
      mk.on('mouseout', function() { this.closeTooltip(); });
      mk.on('click', () => { if (ri >= 0) { selectRoute(ri); if (j >= 0) focusStop(ri, j); mk.openPopup(); } else { mk.openPopup(); } });
      return mk;
    })).addTo(map);
  }
  if (layerGps) {
    layerGpsGroup = L.layerGroup(DATA.customers.filter((c) => c.excluded).map((c) => {
      const mk = L.circleMarker([c.lat, c.lon], { radius: 4, color: '#B0B0B0', fillColor: '#B0B0B0', fillOpacity: 0.5 });
      mk.bindPopup(`<b>${esc(c.name)}</b><br>BP ID: ${esc(c.bpId)}<br>No order in this batch`);
      return mk;
    })).addTo(map);
  }
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

$('lyr-all').addEventListener('change', (e) => { layerAll = e.target.checked; if (DATA) renderLayers(); });
$('lyr-gps').addEventListener('change', (e) => { layerGps = e.target.checked; if (DATA) renderLayers(); });
$('lyr-exc').addEventListener('change', (e) => {
  layerExc = e.target.checked;
  if (!mapState.map) return;
  mapState.un.forEach((m) => {
    if (layerExc && !mapState.map.hasLayer(m)) m.addTo(mapState.map);
    if (!layerExc && mapState.map.hasLayer(m)) mapState.map.removeLayer(m);
  });
});

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

function isolateRoute(i) {
  const { map } = mapState;
  RESULT.routes.forEach((r, k) => {
    const line = mapState.lines[k];
    const markers = mapState.markers[k] || [];
    if (k === i) {
      if (line && map.hasLayer(line)) { line.setStyle({ opacity: 1.0, weight: 6, color: COLORS[k % COLORS.length] }); line.bringToFront(); }
      markers.forEach((m) => { if (!map.hasLayer(m)) m.addTo(map); m.setOpacity(1); m.setZIndexOffset?.(800); });
    } else {
      if (line && map.hasLayer(line)) line.setStyle({ opacity: 0.08, weight: 2 });
      markers.forEach((m) => { if (map.hasLayer(m)) map.removeLayer(m); });
    }
  });
}

function showAllRoutes() {
  const { map } = mapState;
  RESULT.routes.forEach((r, k) => {
    const line = mapState.lines[k];
    if (line && map.hasLayer(line)) line.setStyle({ opacity: 0.85, weight: 3 });
    (mapState.markers[k] || []).forEach((m) => { if (!map.hasLayer(m)) m.addTo(map); m.setOpacity(1); });
  });
}

function toggleRoutes() {
  const btn = $('ctl-routes');
  const on = btn.classList.toggle('on');
  if (on) showAllRoutes();
  else {
    RESULT.routes.forEach((r, i) => {
      const line = mapState.lines[i];
      if (line && mapState.map.hasLayer(line)) mapState.map.removeLayer(line);
      (mapState.markers[i] || []).forEach((m) => { if (mapState.map.hasLayer(m)) mapState.map.removeLayer(m); });
    });
  }
}

$('ctl-in').addEventListener('click', () => mapState.map && mapState.map.zoomIn());
$('ctl-out').addEventListener('click', () => mapState.map && mapState.map.zoomOut());
$('ctl-fit').addEventListener('click', fitAll);
$('ctl-routes').addEventListener('click', toggleRoutes);

$('routePrev')?.addEventListener('click', () => {
  if (selectedRoute == null || !RESULT) return;
  selectRoute((selectedRoute - 1 + RESULT.routes.length) % RESULT.routes.length);
});
$('routeNext')?.addEventListener('click', () => {
  if (selectedRoute == null || !RESULT) return;
  selectRoute((selectedRoute + 1) % RESULT.routes.length);
});

/* ---------------- export ---------------- */
$('exportBtn').addEventListener('click', () => {
  if (!DATA || !RESULT) return;
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

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Route Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(stops), 'Route Stops');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(links), 'Google Maps Links');
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `route-plan-${stamp}.xlsx`);
});

/* ---------------- theme ---------------- */
$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'light';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  try { localStorage.setItem('pdp-theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
});

loadSettings();
