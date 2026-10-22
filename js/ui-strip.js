/* Top strip: route pills, reviewed count, Plan overview, Show all routes, unassigned pool. */
import { STATUS_COLORS, STATUS_GLYPHS } from './ui-map.js';

export function planProgress(plan) {
  const n = (plan.routes || []).length;
  const counts = { 'Pending review': 0, Ready: 0, 'Approved exception': 0, 'Needs revision': 0, 'Excluded / deferred': 0 };
  for (const r of plan.routes || []) counts[r.status] = (counts[r.status] || 0) + 1;
  const reviewed = n - counts['Pending review'];
  return `${reviewed} of ${n} routes reviewed — ${counts.Ready} ready · ${counts['Approved exception']} approved exception · ${counts['Needs revision']} needs revision · ${counts['Pending review']} pending`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderTopStrip(plan, { selected, callbacks }) {
  const el = document.getElementById('topStrip');
  if (!el) return;
  const pills = (plan.routes || []).map((r, i) => {
    const col = STATUS_COLORS[r.status] || '#8E8E93';
    const g = STATUS_GLYPHS[r.status] || '●';
    return `<button type="button" class="pill ${i === selected ? 'on' : ''}" data-i="${i}" title="${esc(r.id || '')} · ${esc(r.status)} · ${Number(r.distance || 0).toFixed(1)} km" style="border-color:${col}"><span class="pg" style="color:${col}">${g}</span>R${String(i + 1).padStart(2, '0')}</button>`;
  }).join('');
  const pool = plan.unassignedPool || [];
  const poolUndecided = pool.filter((u) => !u.decision).length;
  const vol = pool.reduce((a, u) => a + (u.bp?.vol || 0), 0);
  el.innerHTML = `
    <div class="strip-progress">${esc(planProgress(plan))}</div>
    <div class="strip-pills" id="stripPills">${pills}</div>
    <button type="button" class="btn ghost strip-btn" data-act="overview" title="Temporarily show the whole plan">Plan overview</button>
    <button type="button" class="btn ghost strip-btn" data-act="drawer" title="Show all routes">Show all routes</button>
    <button type="button" class="btn ghost strip-btn pool-chip" data-act="pool" title="Unassigned pool">Unassigned: ${poolUndecided ? poolUndecided + ' of ' : ''}${pool.length} BPs · ${vol.toFixed(1)} MT</button>`;
  el.querySelector('#stripPills')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) callbacks.onSelect(Number(b.dataset.i));
  });
  el.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'overview') callbacks.onOverview?.();
      if (act === 'drawer') callbacks.onDrawer?.();
      if (act === 'pool') { callbacks.onDrawer?.(); callbacks.onPoolTab?.(); }
    });
  });
}
