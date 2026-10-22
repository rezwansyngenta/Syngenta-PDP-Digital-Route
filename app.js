/* PDP Digital Route — controller. Phase 1 (setup + scatter) → Phase 2 (map-dominant review). */

import {
  createPlan, applyOp, applyMerge, planMerge, trySetStatus, computeFinaliseGate,
  bestInsertDelta, directedRouteKm, sortForDrawer, createRevision, undo,
} from './js/state.js';
import { fetchRouteLegs } from './js/geometry.js';
import { osrmRouteClient } from './js/osrm.js';
import { savePlan, getPlan, listPlans, getActivePlanId, setActivePlanId } from './js/persistence.js';
import { initMap, drawScatter, showRoute, showOverview, setBanners, bpPopup, STATUS_COLORS } from './js/ui-map.js';
import { renderTopStrip, planProgress } from './js/ui-strip.js';
import { renderDrawer, openDrawer, closeDrawer } from './js/ui-drawer.js';
import { renderPanel, bindPanel } from './js/ui-panel.js';
import { computeImpact, backtrackIndicator } from './js/impact.js';
import { buildWorkbook } from './js/export.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const COLORS = ['#c40056', '#10AFA4', '#3687D6', '#626BC7', '#9966C2', '#F0A32D', '#E84D8D', '#718278'];

let SETTINGS = {};
let DATA = null;
let RESULT = null;
let ROUTING_META = null;
let worker = null;
let busy = false;

let plan = null;
let selectedRoute = 0;
let selectedCustomer = null;
let corridor = { on: false, w: 2, list: [] };
let overviewOn = false;
let simState = null; // { kind, ... }

const legOsrm = () => osrmRouteClient(SETTINGS.osrm_endpoint || 'https://router.project-osrm.org');

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

function bindFile(inputId, nameId, onChange) {
  $(inputId).addEventListener('change', (e) => {
    const f = e.target.files[0];
    $(nameId).textContent = f ? f.name : 'Choose Excel file …';
    onChange?.();
  });
}

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

/* ---------------- Screen 1: pre-solve scatter ---------------- */
let scatterMap = null;

function colFinder(hdr, keywords) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i < hdr.length; i++) {
    const hl = norm(hdr[i]);
    if (keywords.every((k) => hl.includes(k))) return i;
  }
  return -1;
}

async function refreshScatter() {
  const gpsFile = $('gpsFile').files[0];
  if (!gpsFile) { $('scatterCard').hidden = true; return; }
  try {
    const rows = sheetRows(await gpsFile.arrayBuffer());
    const hdr = rows[0] || [];
    const bpCol = colFinder(hdr, ['bp']);
    const latCol = colFinder(hdr, ['lat']);
    const lonCol = colFinder(hdr, ['lon']);
    if (bpCol < 0 || latCol < 0 || lonCol < 0) { $('scatterCard').hidden = true; return; }
    let nameCol = colFinder(hdr, ['customer', 'name']);
    if (nameCol < 0) nameCol = colFinder(hdr, ['name']);
    let addrCol = colFinder(hdr, ['address']);
    if (addrCol < 0) addrCol = colFinder(hdr, ['location']);

    // orders (optional): BP + Value + Volume
    let ordersByBp = null;
    const orderFile = $('orderFile').files[0];
    if (orderFile) {
      try {
        const orows = sheetRows(await orderFile.arrayBuffer());
        const ohdr = orows[0] || [];
        const obp = colFinder(ohdr, ['bp']) >= 0 ? colFinder(ohdr, ['bp']) : colFinder(ohdr, ['id']);
        const oval = colFinder(ohdr, ['value']);
        const ovol = colFinder(ohdr, ['volume']);
        if (obp >= 0 && oval >= 0 && ovol >= 0) {
          for (const r of orows.slice(1)) {
            const bp = String(r[obp] ?? '').trim();
            if (!bp) continue;
            ordersByBp = ordersByBp || new Map();
            const prev = ordersByBp.get(bp) || { value: 0, volume: 0 };
            prev.value += Number(r[oval]) || 0;
            prev.volume += Number(r[ovol]) || 0;
            ordersByBp.set(bp, prev);
          }
        }
      } catch { /* orders not parseable yet */ }
    }

    const pts = [];
    for (const r of rows.slice(1)) {
      if (!r || r.every((v) => v == null || String(v).trim() === '')) continue;
      const name = nameCol >= 0 ? String(r[nameCol] ?? '').trim() : '';
      const lidHint = addrCol >= 0 ? String(r[addrCol] ?? '').trim() : '';
      if (name.toLowerCase().includes('warehouse') || lidHint.toLowerCase() === 'wh') continue;
      const bp = String(r[bpCol] ?? '').trim();
      if (!bp) continue;
      const lat = Number(r[latCol]); const lon = Number(r[lonCol]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < 20 || lat > 27 || lon < 88 || lon > 93) continue;
      const o = ordersByBp?.get(bp);
      pts.push({ bpId: bp, name: name || bp, address: String(r[addrCol] ?? ''), lat, lon, orderValue: o?.value || 0, orderVolume: o?.volume || 0 });
    }

    if (!pts.length) { $('scatterCard').hidden = true; return; }
    $('scatterCard').hidden = false;
    const withOrders = pts.filter((p) => p.orderValue > 0 || p.orderVolume > 0).length;
    $('scatterNote').textContent = `— ${pts.length} BPs · ${withOrders} with orders`;
    if (!scatterMap) {
      scatterMap = initMap('scatterMap', { lat: pts[0].lat, lon: pts[0].lon, name: SETTINGS.warehouse_name || 'Warehouse' });
    }
    drawScatter(scatterMap, { lat: pts[0].lat, lon: pts[0].lon, name: 'Warehouse (check GPS master row)' }, pts);
  } catch (err) {
    $('scatterCard').hidden = true;
  }
}

let scatterTimer = null;
function queueScatter() {
  clearTimeout(scatterTimer);
  scatterTimer = setTimeout(refreshScatter, 120);
}

bindFile('gpsFile', 'gpsName', () => queueScatter());
bindFile('orderFile', 'orderName', () => queueScatter());

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
    ROUTING_META = msg.routingMeta || null;
    setBusy(false);
    setStatus('');
    enterReview();
  }
}

function setBusy(b) {
  busy = b;
  const btn = $('solveBtn');
  btn.disabled = b;
  btn.textContent = b ? 'Solving…' : 'Solve Routes';
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

    const pdpParams = {
      pmin: Number($('pmin').value) || 10,
      vmin: Number($('vmin').value) || 12,
      cap: Number($('cap').value) || 12,
    };

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
        ...pdpParams,
        osrmEndpoint: SETTINGS.osrm_endpoint,
        osrmChunk: SETTINGS.osrm_table_chunk,
        maxCandidates: SETTINGS.max_candidates,
      },
      __pdpParams: pdpParams,
    });
    window.__lastParams = pdpParams;
  } catch (err) {
    setStatus(err.message || String(err), true);
    setBusy(false);
  }
});

/* ---------------- enter review ---------------- */
function enterReview() {
  // stable route ids
  RESULT.routes.forEach((r, i) => { r.id = r.id || `R${String(i + 1).padStart(2, '0')}`; });
  const params = window.__lastParams || { pmin: 10, vmin: 12, cap: 12 };
  plan = createPlan(RESULT, params, DATA);
  if (ROUTING_META) {
    plan.meta.engineVersion = ROUTING_META.engineVersion;
    plan.meta.profile = ROUTING_META.profile;
    plan.meta.restrictionVersion = ROUTING_META.restrictionVersion;
  }
  plan.solvedAt = new Date().toISOString();
  plan.label = `Solved ${new Date().toLocaleString()}`;
  savePlan(plan);
  setActivePlanId(plan.planId);

  selectedRoute = 0;
  selectedCustomer = null;
  corridor = { on: false, w: 2, list: [] };
  overviewOn = false;

  $('setupPhase').style.display = 'none';
  document.body.classList.remove('setup-open');
  $('reviewShell').classList.add('open');
  $('backToSetup').hidden = false;
  $('undoBtn').hidden = false;
  $('planName').hidden = false;
  $('planName').textContent = `Plan ${plan.planId} · ${plan.routes.length} routes · ${Math.round(plan.params.cap)} MT truck · PDP ${plan.params.pmin} Cr / ${plan.params.vmin} MT`;

  // profile warning: show whenever the routing profile is not a validated truck profile
  setBanners({ fallback: false, profile: true });

  if (!$('map')._leaflet_id || !window.__reviewMap) {
    window.__reviewMap = initMap('map', DATA.warehouse);
  }
  selectRoute(0);
}

$('backToSetup').addEventListener('click', () => {
  $('setupPhase').style.display = '';
  document.body.classList.add('setup-open');
  $('reviewShell').classList.remove('open');
  $('backToSetup').hidden = true;
  $('undoBtn').hidden = true;
  $('planName').hidden = true;
  setStatus('');
});

/* ---------------- map rail ---------------- */
$('ctl-in').addEventListener('click', () => window.__reviewMap?.zoomIn());
$('ctl-out').addEventListener('click', () => window.__reviewMap?.zoomOut());
$('ctl-fitroute').addEventListener('click', () => selectRoute(selectedRoute));
$('ctl-prev').addEventListener('click', () => nav(-1));
$('ctl-next').addEventListener('click', () => nav(1));
document.addEventListener('keydown', (e) => {
  if (!plan || !$('reviewShell').classList.contains('open')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowLeft') nav(-1);
  if (e.key === 'ArrowRight') nav(1);
  if (e.key === 'Escape') closeDrawer();
});

function nav(d) {
  if (!plan) return;
  overviewOn = false;
  const n = plan.routes.length;
  selectRoute((selectedRoute + d + n) % n);
}

/* ---------------- labels & data helpers ---------------- */
const labelsById = () => new Map(DATA.customers.map((c) => [c.id, c]));
const coordsById = () => Object.fromEntries(DATA.customers.map((c) => [c.id, [c.lat, c.lon]]));

/* ---------------- route selection + drawing ---------------- */
async function selectRoute(i, { keepOverview = false } = {}) {
  if (!plan || !plan.routes[i]) return;
  overviewOn = overviewOn && keepOverview;
  selectedRoute = i;
  selectedCustomer = null;
  simState = null;
  const route = plan.routes[i];
  route.__index = i;
  route.__color = COLORS[i % COLORS.length];

  renderStrip();
  $('routeCounter').textContent = `R${String(i + 1).padStart(2, '0')} of ${plan.routes.length}`;
  updateUndoButtons();

  if (overviewOn) {
    showOverview(window.__reviewMap, DATA.warehouse, plan.routes, labelsById());
    renderPanelFor(route);
    updateBanners(route);
    return;
  }

  // fetch legs (local road geometry or fallback)
  showRoute(window.__reviewMap, DATA.warehouse, route, [], { labelsById: labelsById() }); // stops immediately
  renderPanelFor(route);
  updateBanners(route);
  try {
    const res = await fetchRouteLegs(DATA.warehouse, route, coordsById(), {
      osrm: legOsrm(),
      mode: SETTINGS.prefer_local_matrix === false ? null : 'local-matrix',
      distMatrix: DATA.distMatrix,
      meta: {
        engineVersion: ROUTING_META?.engineVersion || plan.meta?.engineVersion || 'v0',
        profile: ROUTING_META?.profile || plan.meta?.profile || 'car',
        restrictionVersion: ROUTING_META?.restrictionVersion || plan.meta?.restrictionVersion || 'v0',
      },
    });
    route.legs = res.legs;
    route.hasFallbackLegs = res.hasFallbackLegs;
    route.geometrySource = res.source;
    if (res.legs.length) {
      const legKm = Math.round(res.legs.reduce((a, l) => a + l.km, 0) * 100) / 100;
      route.distance = legKm;
    }
  } catch {
    route.legs = route.legs || [];
  }
  if (selectedRoute === i && !overviewOn) {
    showRoute(window.__reviewMap, DATA.warehouse, route, route.legs || [], { labelsById: labelsById() });
    renderPanelFor(route);
    updateBanners(route);
    if (corridor.on) computeCorridor();
    renderPanelFor(route);
  }
}

function updateBanners(route) {
  const showProfile = SETTINGS.routing_profile !== 'truck'; // car profile = warn always
  setBanners({ fallback: !!route?.hasFallbackLegs, profile: showProfile });
}

/* ---------------- top strip ---------------- */
function renderStrip() {
  renderTopStrip(plan, {
    selected: selectedRoute,
    callbacks: {
      onSelect: (i) => { closeDrawer(); selectRoute(i); },
      onOverview: toggleOverview,
      onDrawer: () => { renderDrawer(plan, drawerCallbacks()); openDrawer(); },
      onPoolTab: () => { renderDrawer(plan, drawerCallbacks()); openDrawer('pool'); },
    },
  });
}

function toggleOverview() {
  overviewOn = !overviewOn;
  if (overviewOn) {
    showOverview(window.__reviewMap, DATA.warehouse, plan.routes, labelsById());
  } else {
    selectRoute(selectedRoute);
  }
}

/* ---------------- drawer ---------------- */
function drawerCallbacks() {
  return {
    selectedIndex: selectedRoute,
    labelsById: labelsById(),
    onSelect: (i) => { closeDrawer(); selectRoute(i); },
    onLocate: (bpId) => {
      const c = DATA.customers.find((x) => x.id === bpId);
      if (c && window.__reviewMap) {
        closeDrawer();
        window.__reviewMap.panTo([c.lat, c.lon]);
      }
    },
    onPoolAction: (k, act) => poolAction(k, act),
  };
}

async function poolAction(k, act) {
  const u = plan.unassignedPool[k];
  if (!u) return;
  const bpId = u.bp.id;
  if (act === 'accept') {
    applyOp(plan, { type: 'acceptUnassigned', customerId: bpId });
  } else if (act === 'defer') {
    const reason = window.prompt('Reason for deferral (records in the plan and export):', 'Deferred to a future plan');
    if (reason == null) return;
    applyOp(plan, { type: 'deferUnassigned', customerId: bpId, reason: reason || 'Deferred to a future plan' });
  } else if (act === 'restore') {
    const origin = plan.routes.find((r) => r.id === u.from);
    if (!origin) { alert('The original route no longer exists. Add this BP to a route instead.'); return; }
    applyOp(plan, { type: 'restoreCustomer', routeId: origin.id, customerId: bpId }, DATA.distMatrix);
    if ((origin.customers || []).length && origin.status === 'Excluded / deferred') {
      origin.status = 'Needs revision';
      origin.reason = null;
    }
  } else if (act === 'add') {
    const route = plan.routes[selectedRoute];
    const c = DATA.customers.find((x) => x.id === bpId);
    if (!route || !c) { alert('Select a route first, then use “Add to route”.'); return; }
    const ins = bestInsertDelta(route.customers.map((x) => x.id), bpId, DATA.distMatrix);
    const nv = Number(route.volume || 0) + Number(c.orderVolume || 0);
    const over = nv > Number(plan.params.cap) + 1e-9;
    if (over) {
      const okApprove = window.confirm(
        `${c.name} is +${c.orderVolume.toFixed(2)} MT pushing this route to ${nv.toFixed(1)} MT — over the ${plan.params.cap} MT capacity.` +
        `\nApprove overload for this route?`);
      if (!okApprove) return;
    }
    applyOp(plan, { type: 'addCustomer', routeId: route.id, customer: { id: c.id, bpId: c.bpId, name: c.name, orderVolume: c.orderVolume, orderValue: c.orderValue }, approveOverload: over }, DATA.distMatrix);
  }
  planSaved();
  renderDrawer(plan, drawerCallbacks());
  selectRoute(selectedRoute);
}

async function addCustomerToRoute(bpId, routeIndex) {
  const route = plan.routes[routeIndex];
  const c = DATA.customers.find((x) => x.id === bpId);
  if (!c || !route) return null;
  const ids = route.customers.map((x) => x.id);
  const ins = bestInsertDelta(ids, bpId, DATA.distMatrix);
  const before = { volume: route.volume, value: route.value, distance: route.distance, customers: route.customers.length };
  const after = {
    volume: Number(route.volume || 0) + Number(c.orderVolume || 0),
    value: Number(route.value || 0) + Number(c.orderValue || 0),
    distance: ins?.d ?? route.distance,
  };
  const impact = computeImpact(before, after, plan.params);
  const over = after.volume > Number(plan.params.cap) + 1e-9;
  simState = { kind: 'add', customerId: bpId, routeIndex, ins, impact, over, customer: c };
  return { before, after, impact, over };
}

/* ---------------- panel ---------------- */
let reviewMapRef = null;

function renderPanelFor(route) {
  const i = selectedRoute;
  const gate = computeFinaliseGate(plan);
  const ids = route.customers.map((x) => x.id);
  const dirDist = (a, b) => { const v = DATA.distMatrix[`${a}|${b}`]; return v == null ? null : v; };
  const bt = backtrackIndicator(ids, dirDist);
  let simulateHtml = '';
  if (simState?.kind === 'add') {
    const rows = simState.impact.map((r) =>
      `<tr><td>${esc(r.metric)}</td><td>${esc(r.before)}</td><td>${esc(r.after)}</td><td class="chg">${esc(r.delta || '')}</td></tr>`).join('');
    const c = simState.customer;
    simulateHtml = `<div class="simcard"><table>
      <tr><th>Metric</th><th>Current</th><th>With ${esc(c.name)}</th><th>Change</th></tr>${rows}</table>
      ${simState.over ? '<div style="padding:8px 10px;font-size:11.5px;color:var(--org-ink)">Over selected truck capacity — applying requires overload approval.</div><label style="display:flex;gap:6px;padding:0 10px 6px;font-size:11.5px"><input type="checkbox" id="overloadOk"> Approve overload for this route</label>' : ''}
      <div class="simbtns">
        <button class="btn primary" data-act="sim-apply">Apply to route</button>
        <button class="btn ghost" data-act="sim-keep">Keep as is</button>
      </div></div>`;
  } else if (simState?.kind === 'optimise') {
    simulateHtml = `<div class="simcard"><table>
      <tr><th>Optimise sequence</th><th>km</th></tr>
      <tr><td>Current</td><td>${simState.beforeKm.toFixed(1)}</td></tr>
      <tr><td>Optimised</td><td>${simState.afterKm.toFixed(1)}</td></tr>
      <tr><td>Saving</td><td class="chg">${(simState.beforeKm - simState.afterKm).toFixed(1)} km</td></tr>
      </table><div class="simbtns">
      <button class="btn primary" data-act="opt-apply">Apply optimised sequence</button>
      <button class="btn ghost" data-act="opt-keep">Keep as is</button></div></div>`;
  } else if (simState?.kind === 'stop') {
    const c = route.customers[simState.j];
    const cc = labelsById().get(c.id) || c;
    const others = plan.routes.map((r, ri) => ({ r, ri })).filter(({ ri }) => ri !== i);
    simulateHtml = `<div class="simcard"><div style="padding:10px 12px;font-size:12.5px"><b>${esc(cc.name)}</b> — remove or move this customer.</div>
      <div class="simbtns" style="flex-wrap:wrap">
        <button class="btn ghost" data-act="stop-remove">Remove → Unassigned pool</button>
        <select id="moveTarget" style="max-width:170px">${others.map(({ r }) => `<option value="${esc(r.id)}">${esc(r.id)}</option>`).join('')}</select>
        <button class="btn ghost" data-act="stop-move">Move to route</button>
        <button class="btn ghost" data-act="stop-cancel">Cancel</button>
      </div></div>`;
  } else if (simState?.kind === 'mergeSuggest') {
    simulateHtml = `<div class="simcard"><div style="padding:10px 12px;font-size:12.5px">${esc(simState.message)}</div>
      <div class="simbtns">${simState.candidates?.length ? `
        <button class="btn primary" data-act="merge-apply" data-target="${esc(simState.candidates[0].targetId)}">Merge into ${esc(simState.candidates[0].targetId)} (+${simState.candidates[0].delta ?? '?'} km est.)</button>
        ${simState.candidates.slice(1, 4).map((c) => `<button class="btn ghost" data-act="merge-apply" data-target="${esc(c.targetId)}">${esc(c.targetId)} (+${c.delta ?? '?'} km)</button>`).join('')}` : ''}
        <button class="btn ghost" data-act="stop-cancel">Keep as is</button>
      </div></div>`;
  }
  const nearby = corridor.on ? { on: true, w: corridor.w, list: corridor.list } : { on: false };
  const el = $('routePanel');
  renderPanel({
    plan, index: i, route, legsInfo: { source: route.geometrySource, hasFallbackLegs: route.hasFallbackLegs },
    labelsById: labelsById(), nearby, selectedCustomerIndex: selectedCustomer,
    gateInfo: gate, backtrackLabel: bt.label, simulateHtml, corridorWidth: corridor.w,
  });
  bindPanel(el, onPanelEvent);
}

function onPanelEvent(ev) {
  const route = plan.routes[selectedRoute];
  switch (ev.type) {
    case 'focusStop': {
      selectedCustomer = ev.j;
      const c = route.customers[ev.j];
      const cc = DATA.customers.find((x) => x.id === (typeof c === 'string' ? c : c.id));
      if (cc && window.__reviewMap) window.__reviewMap.panTo([cc.lat, cc.lon]);
      renderPanelFor(route);
      break;
    }
    case 'stopMenu':
      selectedCustomer = ev.j;
      simState = { kind: 'stop', j: ev.j };
      renderPanelFor(route);
      break;
    case 'ready': {
      const res = trySetStatus(plan, route.id, 'Ready');
      if (!res.ok) alert(`Cannot mark ready:\n${res.blockers.join('\n')}`);
      afterMutation(route); break;
    }
    case 'revision':
      trySetStatus(plan, route.id, 'Needs revision');
      afterMutation(route); break;
    case 'exception':
      route.__exFormOpen = true;
      renderPanelFor(route); break;
    case 'ex-cancel':
      route.__exFormOpen = false;
      renderPanelFor(route); break;
    case 'applyException': {
      const res = trySetStatus(plan, route.id, 'Approved exception', { reasonCategory: ev.category, reason: (ev.reason || '').trim() });
      route.__exFormOpen = false;
      if (!res.ok) alert(`Cannot approve exception:\n${res.blockers.join('\n')}`);
      afterMutation(route); break;
    }
    case 'reopen':
      trySetStatus(plan, route.id, 'Pending review');
      afterMutation(route); break;
    case 'optimise':
      simulateOptimise(route); break;
    case 'undo':
      doUndo(); break;
    case 'corr':
      corridor.on = true; corridor.w = ev.w ?? corridor.w;
      computeCorridor(); renderPanelFor(route); break;
    case 'corrtoggle':
      corridor.on = !corridor.on;
      if (corridor.on) computeCorridor();
      renderPanelFor(route); break;
    case 'simulate':
      simulateAdd(ev.customerId); break;
    case 'sim-apply': {
      const s = simState;
      if (!s) break;
      const approve = s.over ? !!$('routePanel').querySelector('#overloadOk')?.checked : false;
      if (s.over && !approve) { alert('Tick “Approve overload” to apply, or keep the route as is.'); break; }
      const custObj = customerObj(s.customerId);
      applyOp(plan, { type: 'addCustomer', routeId: route.id, customer: custObj, approveOverload: approve }, DATA.distMatrix);
      simState = null;
      afterMutation(route);
      // refresh legs for the new geometry later; selectree redraw
      break;
    }
    case 'sim-keep':
    case 'opt-keep':
    case 'stop-cancel':
      simState = null;
      renderPanelFor(route); break;
    case 'opt-apply': {
      applyOp(plan, { type: 'reoptimiseSequence', routeId: route.id }, DATA.distMatrix);
      simState = null;
      afterMutation(route); break;
    }
    case 'stop-remove': {
      const c = route.customers[simState.j];
      applyOp(plan, { type: 'removeCustomer', routeId: route.id, customerId: c.id }, DATA.distMatrix);
      simState = null;
      afterMutation(route); break;
    }
    case 'stop-move': {
      const c = route.customers[simState.j];
      const target = $('routePanel').querySelector('#moveTarget')?.value;
      applyOp(plan, { type: 'moveCustomer', fromRouteId: route.id, toRouteId: target, customerId: c.id }, DATA.distMatrix);
      simState = null;
      afterMutation(plan.routes.find((r) => r.id === target));
      break;
    }
    case 'suggestMerge':
      suggestMerge(route); break;
    case 'merge-apply': {
      applyMerge(plan, route.id, ev.target, { distMatrix: DATA.distMatrix });
      simState = null;
      afterMutation(plan.routes.find((r) => r.id === ev.target));
      break;
    }
    case 'finalise':
      finalisePlan(); break;
    case 'export':
      exportPlan(); break;
    case 'createRevision':
      createRevisionAction(); break;
  }
}

function customerObj(id) {
  const c = DATA.customers.find((x) => x.id === id);
  return c ? { id: c.id, bpId: c.bpId, name: c.name, lat: c.lat, lon: c.lon, orderVolume: c.orderVolume, orderValue: c.orderValue } : { id };
}

function afterMutation(route) {
  planSaved();
  renderStrip();
  if (route) {
    selectedRoute = plan.routes.indexOf(route) >= 0 ? plan.routes.indexOf(route) : selectedRoute;
    selectRoute(selectedRoute);
  }
}

function planSaved() {
  plan.label = plan.finalised ? 'Finalised' : 'Draft';
  savePlan(plan);
}

function updateUndoButtons() {
  const can = (plan?.undoStack || []).length > 0;
  $('undoBtn').disabled = !can;
}

function doUndo() {
  const route0 = plan.routes[selectedRoute];
  const res = undo(plan);
  if (!res.ok) { alert('Nothing to undo.'); return; }
  if (route0) route0.__exFormOpen = false;
  simState = null;
  planSaved();
  renderStrip();
  selectRoute(selectedRoute);
}

/* corridor candidates */
function computeCorridor() {
  const route = plan.routes[selectedRoute];
  const ids = route.customers.map((x) => x.id);
  const inRoute = new Set(ids);
  const dm = DATA.distMatrix;
  const d = (a, b) => dm[`${a}|${b}`] ?? dm[`${b}|${a}`] ?? 99999;
  corridor.list = DATA.customers
    .filter((c) => !inRoute.has(c.id) && !c.excluded)
    .map((c) => ({ c, nd: Math.min(...ids.map((r) => d(r, c.id))), detour: insertDetour(ids, c.id, dm, route.distance ?? 0) }))
    .filter((x) => x.nd <= corridor.w && Number.isFinite(x.detour))
    .sort((a, b) => a.detour - b.detour);
  corridor.list = corridor.list.slice(0, 8);
}

function insertDetour(ids, id, dm, baseKm) {
  const ins = bestInsertDelta(ids, id, dm);
  return ins ? ins.delta : Infinity;
}

/* simulate add */
async function simulateAdd(customerId) {
  const res = await addCustomerToRoute(customerId, selectedRoute);
  if (res) renderPanelFor(plan.routes[selectedRoute]);
}

/* optimise: pure preview; Apply goes through applyOp so undo/audit stay intact */
function simulateOptimise(route) {
  const ids = route.customers.map((c) => c.id);
  const dm = DATA.distMatrix;
  const beforeKm = directedRouteKm(ids, dm);
  let newOrder;
  try {
    newOrder = window.__optimizeOrder(ids, dm, 5000, 42);
  } catch { newOrder = ids; }
  const afterKm = directedRouteKm(newOrder, dm);
  if (afterKm == null || beforeKm == null || afterKm >= beforeKm - 0.05) {
    simState = { kind: 'mergeSuggest', message: `Sequence is already near-optimal (directed ${beforeKm != null ? beforeKm.toFixed(1) : '?'} km). Try “Suggest merge” or approve as ready.`, candidates: null };
    renderPanelFor(route);
    return;
  }
  simState = { kind: 'optimise', newOrder, beforeKm, afterKm };
  renderPanelFor(route);
}

/* merge suggestion */
function suggestMerge(route) {
  const m = planMerge(plan, route.id, DATA.distMatrix);
  if (m.none) {
    simState = { kind: 'mergeSuggest', message: m.message, candidates: null };
  } else {
    simState = { kind: 'mergeSuggest', message: `Merging all stops of ${route.id} adds road km to the target. Lowest-impact option first:`, candidates: [m.best, ...m.alternatives] };
  }
  renderPanelFor(route);
}

/* finalise + export */
function finalisePlan() {
  const gate = computeFinaliseGate(plan);
  if (!gate.canFinalise) {
    alert(`Cannot finalise yet:\n${gate.blockers.join('\n')}`);
    renderPanelFor(plan.routes[selectedRoute]);
    return;
  }
  plan.finalised = true;
  plan.finalisedAt = new Date().toISOString();
  planSaved();
  renderStrip();
  renderPanelFor(plan.routes[selectedRoute]);
  $('exportBtn').hidden = false;
  alert('Plan finalised. Export and archive are now available; the plan is locked for editing.');
}

function exportPlan() {
  const archive = { schemaVersion: plan.schemaVersion || 1, planId: plan.planId, params: plan.params, meta: plan.meta, routes: plan.routes, unassignedPool: plan.unassignedPool, finalised: !!plan.finalised };
  const wb = buildWorkbook(plan, { include_stops: true, include_audit: true });
  wb.SheetNames.push('Plan archive'); wb.Sheets['Plan archive'] = XLSX.utils.aoa_to_sheet([['archive'], [JSON.stringify(archive)]]);
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `route-plan-${plan.planId}-${stamp}.xlsx`);
}

function createRevisionAction() {
  const rev = createRevision(plan);
  rev.label = `Revision of ${plan.planId}`;
  rev.revisionCount = (plan.revisionCount || 0) + 1;
  plan.revisionCount = rev.revisionCount;
  plan = rev;
  savePlan(plan);
  setActivePlanId(plan.planId);
  renderStrip();
  selectRoute(0);
}

/* appbar */
$('undoBtn').addEventListener('click', doUndo);
$('exportBtn').addEventListener('click', exportPlan);

/* theme */
$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'light';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  try { localStorage.setItem('pdp-theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
});

/* expose for tests/debug */
window.__pdp = { get plan() { return plan; }, get data() { return DATA; }, selectRoute, planMerge, applyPlanOp: applyOp, applyPlanMerge: applyMerge, trySetStatus, computeFinaliseGate, undo: doUndo, sortForDrawer, planProgress, setCorridor: (on) => { corridor.on = on; } };

/* wire optimizeOrder for the review screen (simulated annealing from lib) */
import('./lib/route-opt.js').then((m) => {
  window.__optimizeOrder = m.optimizeOrder;
});

loadSettings();
