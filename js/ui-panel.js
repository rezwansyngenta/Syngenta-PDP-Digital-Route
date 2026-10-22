/* Right review panel: route identity, metrics, context-aware actions, stops, nearby, undo. */
import { REASON_CATEGORIES } from './state.js';
import { STATUS_COLORS, STATUS_GLYPHS } from './ui-map.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Context-aware action buttons per current status (large labelled actions, no generic dropdown). */
export function actionsForStatus(route, { hasException = false } = {}) {
  const s = route.status;
  if (s === 'Pending review') {
    return [
      { act: 'ready', label: 'Mark ready', cls: 'primary' },
      { act: 'revision', label: 'Needs revision', cls: 'ghost' },
      ...(hasException ? [{ act: 'exception', label: 'Approve exception', cls: 'ghost' }] : []),
    ];
  }
  if (s === 'Ready') return [];
  if (s === 'Approved exception') {
    return [{ act: 'reopen', label: 'Revise (back to pending review)', cls: 'ghost' }];
  }
  if (s === 'Needs revision') {
    return [
      { act: 'optimise', label: 'Optimise sequence', cls: 'primary' },
      { act: 'suggestMerge', label: 'Suggest merge', cls: 'ghost' },
      { act: 'ready', label: 'Mark ready after review', cls: 'ghost' },
      { act: 'reopen', label: 'Return to pending review', cls: 'ghost' },
    ];
  }
  return [];
}

export function statusBadge(status) {
  const col = STATUS_COLORS[status] || '#8E8E93';
  const g = STATUS_GLYPHS[status] || '●';
  return `<span class="statusbadge" style="background:color-mix(in srgb, ${col} 14%, transparent);color:${col}"><span class="pg">${g}</span>${esc(status)}</span>`;
}

/** Renders the whole right panel for the selected route. */
export function renderPanel({
  plan, index, route, legsInfo, labelsById, nearby, selectedCustomerIndex,
  callbacks, gateInfo, backtrackLabel, simulateHtml, corridorWidth,
}) {
  const el = document.getElementById('routePanel');
  if (!el) return;
  const params = plan.params || {};
  const cap = Number(params.cap ?? 12);
  const kmNow = Number(route.distance ?? 0);
  const kmIsLegs = legsInfo?.source === 'local-road' || legsInfo?.source === 'mixed' || legsInfo?.source === 'local-matrix-straight';
  const kmSrcLabel = legsInfo?.source === 'local-matrix-straight'
    ? 'validated local road matrix — exact paths visible in Google Maps'
    : kmIsLegs
      ? `from drawn road legs${legsInfo?.source === 'mixed' ? '; some straight-line' : ''}`
      : 'from the solver road matrix — road legs not yet drawn';
  const gmapsUrl = route.gmaps_url || null;

  const stops = (route.customers || []).map((c, j) => {
    const cc = labelsById.get(c.id) || c;
    const sel = j === selectedCustomerIndex ? 'on' : '';
    return `<div class="stop ${sel}" data-j="${j}">
      <span class="n">${j + 1}</span>
      <span class="nm">${esc(cc.name)}</span>
      <span class="muted">${Number(cc.orderVolume || 0).toFixed(2)} MT · ${((cc.orderValue || 0) / 1e5).toFixed(1)} lakh</span>
      <button type="button" class="btn ghost xs" data-sact="focus" data-j="${j}" title="Focus on map">◎</button>
      <button type="button" class="btn ghost xs" data-sact="custedit" data-j="${j}" title="Remove or move this customer">⋯</button>
    </div>`;
  }).join('');

  const exceptionExists = route.qualifiesBy === 'Below' || Number(route.volume || 0) > cap + 1e-9 || legsInfo?.hasFallbackLegs;
  const actions = actionsForStatus(route, { hasException: exceptionExists });

  const exForm = route.__exFormOpen === true ? `
    <div class="exform">
      <label class="field"><span>Exception category</span>
        <select id="exCat">${REASON_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Manager comment (required)</span>
        <textarea id="exReason" rows="2" placeholder="Why this exception is acceptable for dispatch"></textarea>
      </label>
      <div class="exbtns">
        <button type="button" class="btn primary" data-act="ex-apply">Approve exception</button>
        <button type="button" class="btn ghost" data-act="ex-cancel">Cancel</button>
      </div>
    </div>` : '';

  const gate = gateInfo || { canFinalise: false, blockers: [] };
  const finalise = plan.finalised
    ? `<div class="finok">Plan finalised ✓ — revisions and export available</div>
       <div class="exbtns">
         <button type="button" class="btn primary" data-act="export">Export Excel</button>
         <button type="button" class="btn ghost" data-act="createRevision">Create revision from finalised plan</button>
       </div>`
    : `<div class="finblock">
         <button type="button" class="btn primary" data-act="finalise">Finalise plan</button>
         <button type="button" class="btn ghost" data-act="export" ${gate.canFinalise ? '' : 'disabled'} title="${gate.canFinalise ? '' : 'Resolve all route decisions first'}">Export Excel</button>
         ${!gate.canFinalise ? `<div class="finwarn">Blocked: ${esc(gate.blockers.join(' · '))}</div>` : ''}
       </div>`;

  el.innerHTML = `
    <div class="phead">
      <div class="ptitle"><span class="prid">${esc(route.id || `R${index + 1}`)}</span>${statusBadge(route.status)}</div>
      <div class="pmeta">${(route.customers || []).length} stops · ${Number(route.volume || 0).toFixed(1)} MT / ${cap} MT · BDT ${(Number(route.value || 0) / 1e7).toFixed(2)} Cr · outbound ${kmNow.toFixed(1)} km <span class="note">(${esc(kmSrcLabel)})</span></div>
      <div class="pmeta btline">${esc(backtrackLabel || 'No backtracking')} · PDP: ${esc(route.qualifiesBy === 'Below' ? 'below threshold' : route.qualifiesBy)}</div>
      ${drawExplanations(route, legsInfo)}
      <div class="pacts">
        ${gmapsUrl ? `<a class="btn ghost gmaps" href="${esc(gmapsUrl)}" target="_blank" rel="noopener" title="Open this route (WH → stops) as turn-by-turn directions in Google Maps">View in Google Maps ↗</a>` : ''}
        ${actions.map((a) => `<button type="button" class="btn ${a.cls}" data-act="${a.act}">${esc(a.label)}</button>`).join('')}
      </div>
      ${exForm}
    </div>
    <div class="pbody">
      <div class="psec"><span>Stop sequence</span><span class="note">WH → stop 1 → … → last stop</span></div>
      <div class="stops">${stops || '<div class="note" style="padding:6px">Route emptied — deferred or merged.</div>'}</div>
      <div class="psec"><span>Nearby candidates</span>
        <span class="seg">
          <button type="button" data-act="corr" data-w="2" class="${corridorWidth === 2 ? 'onb' : ''}">2 km</button>
          <button type="button" data-act="corr" data-w="5" class="${corridorWidth === 5 ? 'onb' : ''}">5 km</button>
          <button type="button" class="btn ghost xs" data-act="corrtoggle">${nearby?.on ? 'Hide' : 'Find'}</button>
        </span>
      </div>
      <div class="nearby" id="nearbyList">${nearbyHtml(nearby)}</div>
      <div id="simArea">${simulateHtml || ''}</div>
      <div class="pfoot">
        <button type="button" class="btn ghost" data-act="undo">↩ Undo last change</button>
      </div>
      <div class="pfoot fin" id="finArea">${finalise}</div>
    </div>`;
}

function drawExplanations(route, legsInfo) {
  let out = '';
  if (route.status === 'Approved exception') {
    out += `<div class="pwhy"><b>Exception:</b> ${esc(route.reasonCategory || '')} — ${esc(route.reason || '')}</div>`;
  }
  if (route.status === 'Excluded / deferred') {
    out += `<div class="pwhy"><b>Decision:</b> ${esc(route.reason || '')}</div>`;
  }
  if (legsInfo?.hasFallbackLegs) {
    out += `<div class="pwhy warn">Some legs have no road path — shown as straight-line preview. “Mark ready” stays blocked.</div>`;
  }
  return out;
}

function nearbyHtml(nearby) {
  if (!nearby?.on) return '<div class="note" style="padding:6px">Corridor search off.</div>';
  if (!nearby.list?.length) return `<div class="note" style="padding:6px">No nearby BPs within ${nearby.w} km of this route.</div>`;
  return nearby.list.slice(0, 8).map((x) => `
    <div class="nb" data-act="sim-add" data-id="${esc(x.c.id)}">
      <span>${esc(x.c.name)} <span class="muted">(${esc(x.c.bpId)})</span></span>
      <span class="imp">+${x.detour.toFixed(1)} km · +${Number(x.c.orderVolume || 0).toFixed(2)} MT</span>
    </div>`).join('');
}

/** Event binding is centralized: the controller passes a single onPanelEvent callback. */
export function bindPanel(el, fireEvent) {
  if (el._bound) { el._fireEvent = fireEvent; return; }
  el._bound = true;
  el._fireEvent = fireEvent;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act],[data-sact]');
    if (!b) return;
    if (b.dataset.sact) {
      const j = Number(b.dataset.j);
      el._fireEvent(b.dataset.sact === 'focus' ? { type: 'focusStop', j } : { type: 'stopMenu', j });
      return;
    }
    const act = b.dataset.act;
    if (act === 'corr') { el._fireEvent({ type: 'corridor', w: Number(b.dataset.w) }); return; }
    if (act === 'sim-add') { el._fireEvent({ type: 'simulate', customerId: b.dataset.id }); return; }
    if (act === 'ex-apply') { el._fireEvent({ type: 'applyException', category: el.querySelector('#exCat')?.value, reason: el.querySelector('#exReason')?.value }); return; }
    el._fireEvent({ type: act, target: b.dataset.target, id: b.dataset.id, j: b.dataset.j });
  });
  el.querySelector('.stops')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-sact]')) return;
    const s = e.target.closest('.stop');
    if (s) el._fireEvent({ type: 'focusStop', j: Number(s.dataset.j) });
  });
}
