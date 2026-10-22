/* Drawer: compact route list sorted by spec order + unassigned pool tab with 5 actions. */
import { sortForDrawer } from './state.js';
import { STATUS_COLORS, STATUS_GLYPHS, bpPopup } from './ui-map.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openDrawer(selectedRouteId) {
  document.getElementById('drawer')?.classList.add('open');
  document.getElementById('drawerScrim')?.classList.add('open');
  // remember which tab was active
  if (selectedRouteId === 'pool') setActiveTab('pool'); 
}

export function closeDrawer() {
  document.getElementById('drawer')?.classList.remove('open');
  document.getElementById('drawerScrim')?.classList.remove('open');
}

function setActiveTab(tab) {
  const d = document.getElementById('drawer');
  if (!d) return;
  d.dataset.tab = tab;
  d.querySelector('[data-tab="routes"]')?.classList.toggle('on', tab === 'routes');
  d.querySelector('[data-tab="pool"]')?.classList.toggle('on', tab === 'pool');
  d.querySelector('#drawerRoutes')?.toggleAttribute('hidden', tab !== 'routes');
  d.querySelector('#drawerPool')?.toggleAttribute('hidden', tab !== 'pool');
}

export function renderDrawer(plan, { selectedIndex, labelsById, callbacks }) {
  const d = document.getElementById('drawer');
  if (!d) return;
  const routes = sortForDrawer(plan.routes || []);
  const rows = routes.map((r) => {
    const i = plan.routes.indexOf(r);
    const col = STATUS_COLORS[r.status] || '#8E8E93';
    const sel = i === selectedIndex ? 'thisrow' : '';
    const excluded = r.status === 'Excluded / deferred' && !(r.customers || []).length;
    return `<div class="drow ${sel}" data-i="${i}" data-act="${excluded ? 'noop' : 'select'}">
      <span class="pg">${STATUS_GLYPHS[r.status] || ''}</span>
      <span class="did" style="color:${col}">${esc(r.id)}</span>
      <span class="dd">${(r.customers || []).length} stops · ${Number(r.volume || 0).toFixed(1)} MT · ${Number(r.distance || 0).toFixed(0)} km</span>
      <span class="dst">${esc(r.status)}</span>
    </div>`;
  }).join('');

  const pool = plan.unassignedPool || [];
  const poolRows = pool.map((u, k) => {
    const bp = u.bp || {};
    const decided = u.decision || null;
    const inRoute = (plan.routes || []).some((r) => (r.customers || []).some((c) => c.id === bp.id));
    const c = labelsById.get(bp.id);
    return `<div class="drow pool">
      <span class="did">${esc(bp.bpId || '')}</span>
      <span class="dd">${esc(bp.name || '')} · ${Number(bp.vol || 0).toFixed(2)} MT · BDT ${((bp.val || 0) / 1e5).toFixed(1)} lakh${decided ? ` · ${esc(decided)}` : ''}</span>
      <span class="dacts">
        <button type="button" class="btn ghost sm" data-pool="${k}" data-pact="add" ${inRoute ? 'disabled' : ''} title="Add to the currently selected route">Add to route</button>
        <button type="button" class="btn ghost sm" data-pool="${k}" data-pact="accept" ${decided ? 'disabled' : ''} title="Accept as unassigned for this plan">Accept</button>
        <button type="button" class="btn ghost sm" data-pool="${k}" data-pact="defer" ${decided ? 'disabled' : ''} title="Defer to a future plan">Defer</button>
        <button type="button" class="btn ghost sm" data-pool="${k}" data-pact="restore" title="Return to its original route">Restore</button>
        <button type="button" class="btn ghost sm" data-pool="${k}" data-pact="locate" data-bp="${esc(bp.id || '')}" title="Show on map">Locate</button>
      </span>
    </div>`;
  }).join('');

  d.innerHTML = `
    <div class="dhead">
      <b>Plan review</b>
      <span class="note">${plan.routes.length} routes · pool: ${pool.length}</span>
      <div class="spacer"></div>
      <button type="button" class="btn ghost sm" id="drawerClose">Close ✕</button>
    </div>
    <div class="dtabs">
      <button type="button" class="dta" data-tab="routes">Routes</button>
      <button type="button" class="dta" data-tab="pool">Unassigned pool${pool.some(u => !u.decision) ? ` (${pool.filter(u => !u.decision).length})` : ''}</button>
    </div>
    <div class="dbody" id="drawerRoutes">${rows || '<div class="note" style="padding:12px">No routes.</div>'}</div>
    <div class="dbody" id="drawerPool" hidden>${poolRows || '<div class="note" style="padding:12px">Pool is empty.</div>'}</div>`;

  d.querySelector('#drawerClose').addEventListener('click', closeDrawer);
  d.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setActiveTab(b.dataset.tab)));
  d.querySelector('#drawerRoutes').addEventListener('click', (e) => {
    const row = e.target.closest('[data-act="select"]');
    if (row) callbacks.onSelect(Number(row.dataset.i));
  });
  d.querySelector('#drawerPool').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pact]');
    if (!btn) return;
    const k = Number(btn.dataset.pool);
    const act = btn.dataset.pact;
    if (act === 'locate') callbacks.onLocate?.(btn.dataset.bp);
    else callbacks.onPoolAction?.(k, act);
  });
  const active = d.dataset.tab || 'routes';
  setActiveTab(active);
  if (active === 'pool' || selectedRouteId === 'pool') setActiveTab('pool');
}
