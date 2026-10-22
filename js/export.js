/* Export: finalised plan workbook rows + plan archive. Pure functions (no XLSX dependency). */

export function fmtCr(v) { return (Number(v || 0) / 1e7).toFixed(2); }
export function fmtLakh(v) { return (Number(v || 0) / 1e5).toFixed(1); }

const routeLabel = (r, i) => r.id || `R${String(i + 1).padStart(2, '0')}`;

export function buildSummaryRows(plan) {
  const rows = [['Route ID', 'Status', 'Customers', 'Volume (MT)', 'Value (Cr BDT)',
    'Outbound km', 'Distance source', 'PDP', 'Reason category', 'Reason', 'Version', 'Last changed']];
  (plan.routes || []).forEach((r, i) => {
    rows.push([
      routeLabel(r, i),
      r.status || '',
      (r.customers || []).length,
      Number(r.volume || 0).toFixed(1),
      fmtCr(r.value),
      Number(r.distance || 0).toFixed(1),
      r.geometrySource || '',
      r.qualifiesBy || '',
      r.reasonCategory || '',
      r.reason || '',
      r.version || 0,
      (r.history && r.history.length) ? r.history[r.history.length - 1].at : ''
    ]);
  });
  return rows;
}

export function buildStopRows(plan) {
  const rows = [['Route ID', 'Stop', 'BP ID', 'Customer Name', 'Volume (MT)', 'Value (Cr BDT)']];
  (plan.routes || []).forEach((r, i) => {
    (r.customers || []).forEach((c, j) => {
      rows.push([routeLabel(r, i), j + 1, c.bpId || '', c.name || '',
        Number(c.orderVolume || 0).toFixed(2), fmtCr(c.orderValue)]);
    });
  });
  return rows;
}

export function decisionCodeFor(item) {
  if (item.decision) return item.decision;
  return '';
}

export function buildDecisionRows(plan) {
  const rows = [['BP ID', 'Customer Name', 'Volume (MT)', 'Value (Cr BDT)', 'Decision code', 'Reason', 'Route context']];
  for (const u of plan.unassignedPool || []) {
    const bp = u.bp || {};
    rows.push([
      bp.bpId || '',
      bp.name || '',
      Number(bp.vol || 0).toFixed(2),
      fmtCr(bp.val),
      decisionCodeFor(u),
      u.reason || '',
      u.from || ''
    ]);
  }
  // Route-level deferrals / merges (Excluded / deferred routes carry codes too)
  (plan.routes || []).forEach((r, i) => {
    if (r.status !== 'Excluded / deferred' || !(r.customers || []).length) return;
    const isMerge = r.reason && r.reason.startsWith('Merged into ');
    for (const c of r.customers) {
      rows.push([
        c.bpId || '',
        c.name || '',
        Number(c.orderVolume || 0).toFixed(2),
        fmtCr(c.orderValue),
        isMerge ? `MERGED_INTO_ROUTE:${String(r.reason).replace('Merged into ', '')}` : 'DEFERRED_FUTURE_PLAN',
        r.reason || '',
        routeLabel(r, i)
      ]);
    }
  });
  return rows;
}

export function buildAuditRows(plan) {
  const rows = [['Route ID', 'At', 'Type', 'Before (km/MT/Cr/status)', 'After (km/MT/Cr/status)']];
  (plan.routes || []).forEach((r, i) => {
    for (const h of r.history || []) {
      rows.push([
        routeLabel(r, i),
        h.at || '',
        h.type || '',
        `${h.before?.km ?? ''}/${h.before?.MT ?? ''}/${h.before?.cr ?? ''}/${h.before?.status ?? ''}`,
        `${h.after?.km ?? ''}/${h.after?.MT ?? ''}/${h.after?.cr ?? ''}/${h.after?.status ?? ''}`
      ]);
    }
  });
  return rows;
}

export function buildPlanArchive(plan, geometryRefs = null) {
  return {
    archivedAt: new Date().toISOString(),
    schemaVersion: plan.schemaVersion || 1,
    planId: plan.planId,
    params: plan.params,
    meta: plan.meta,
    routes: plan.routes,
    unassignedPool: plan.unassignedPool,
    finalised: !!plan.finalised,
    geometryRefs
  };
}

/* Workbook assembly (browser only; XLSX global provided by vendor script) */
export function buildWorkbook(plan, { include_stops = true, include_audit = true } = {}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSummaryRows(plan)), 'Route summary');
  if (include_stops) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildStopRows(plan)), 'Route stops');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildDecisionRows(plan)), 'Unassigned decisions');
  if (include_audit) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildAuditRows(plan)), 'Audit history');
  // Google Maps links only on explicit opt-in
  const settings = plan.settings || {};
  if (settings.include_gmaps_links) {
    const rows = [['Route ID', 'Google Maps URL']];
    (plan.routes || []).forEach((r, i) => rows.push([routeLabel(r, i), r.gmaps_url || '']));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Google Maps links');
  }
  return wb;
}
