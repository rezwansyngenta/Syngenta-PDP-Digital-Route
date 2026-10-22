/* Plan state core: creation, versions, audit history */
import { pairKey } from '../lib/road-distance.js';
import { optimizeOrder } from '../lib/route-opt.js';

export const STATUSES = ['Pending review', 'Ready', 'Approved exception', 'Needs revision', 'Excluded / deferred'];
export const REASON_CATEGORIES = [
  'Road path unavailable',
  'GPS pin needs validation',
  'Manager-confirmed local route',
  'Restricted-road / access exception',
  'Below-PDP accepted',
  'Overload approved'
];

export function createPlan(result, params = {}) {
  const plan = {
    planId: result && (result.solveId || result.id) ? (result.solveId || result.id) : `plan_${Date.now()}`,
    params: { ...params },
    routes: [],
    unassignedPool: [],
    history: [],
    undoStack: [],
    meta: {
      solverVersion: result?.solverVersion || 'v0',
      engineVersion: result?.engineVersion || null,
      restrictionVersion: result?.restrictionVersion || null
    },
    schemaVersion: 1
  };
  
  if (result && Array.isArray(result.routes)) {
    for (const r of result.routes) {
      plan.routes.push({
        id: r.id || r.routeId,
        status: 'Pending review',
        version: 0,
        solverCustomers: Array.isArray(r.customers) ? r.customers.map(c => c.id || c.customerId) : [],
        customers: Array.isArray(r.customers) ? r.customers.map(c => ({ ...c })) : [],
        volume: r.volume || 0,
        value: r.value || 0,
        distance: r.distance || 0,
        qualifiesBy: r.qualifiesBy || 'Below',
        history: [],
        reasonCategory: null,
        reason: null,
        geometrySource: r.geometrySource || 'solver-matrix',
        orig_order: r.orig_order ? [...r.orig_order] : undefined,
        orig_distance: r.orig_distance
      });
    }
  }
  if (result && Array.isArray(result.unassigned)) {
    plan.unassignedPool = result.unassigned.map(u => ({ ...u }));
  }
  
  return plan;
}

export function bumpVersion(route) {
  route.version = (route.version || 0) + 1;
  return route.version;
}

export function pushAudit(route, entry) {
  if (!route.history) route.history = [];
  route.history.push({
    at: entry.at || new Date().toISOString(),
    type: entry.type,
    version: entry.version !== undefined ? entry.version : route.version,
    before: entry.before || {},
    after: entry.after || {},
    geometrySource: entry.geometrySource || route.geometrySource || null,
    solverVersion: entry.solverVersion || null,
    engineVersion: entry.engineVersion || null,
    mapVersion: entry.mapVersion || null,
    restrictionVersion: entry.restrictionVersion || null,
    paramsSnapshot: entry.paramsSnapshot || null
  });
}

export function recomputeDerived(route, distMatrix, params = {}) {
  if (!route || !Array.isArray(route.customers)) {
    return { distance: 0, volume: 0, value: 0, qualifiesBy: 'Below' };
  }
  
  let distance = 0;
  const ids = route.customers.map(c => (typeof c === 'string' ? c : c.id)).filter(Boolean);
  if (ids.length === 0) {
    distance = 0;
  } else {
    // Directed legs: WH -> first -> ... -> last (never use reversed key substitution)
    const dWHFirst = distMatrix ? distMatrix[`WH|${ids[0]}`] : undefined;
    if (dWHFirst === undefined) {
      throw new Error(`Missing directed distance for WH|${ids[0]}`);
    }
    distance += dWHFirst;
    for (let i = 0; i < ids.length - 1; i++) {
      const key = `${ids[i]}|${ids[i + 1]}`;
      const v = distMatrix ? distMatrix[key] : undefined;
      if (v === undefined) {
        throw new Error(`Missing directed distance for ${key}`);
      }
      distance += v;
    }
  }
  
  let volume = 0;
  let value = 0;
  for (const c of route.customers) {
    const cust = typeof c === 'string' ? null : c;
    if (cust) {
      volume += cust.orderVolume || 0;
      value += cust.orderValue || 0;
    }
  }
  
  const pMin = params.pmin !== undefined ? params.pmin : (params.pMinCr !== undefined ? params.pMinCr : 10);
  const vMin = params.vmin !== undefined ? params.vmin : (params.vMin !== undefined ? params.vMin : 12);
  const pMinBDT = pMin * 10000000;
  
  const byVol = volume >= vMin - 1e-9;
  const byVal = value >= pMinBDT - 1e-9;
  let qualifiesBy;
  if (byVol && byVal) qualifiesBy = 'Both';
  else if (byVol) qualifiesBy = 'Volume';
  else if (byVal) qualifiesBy = 'Value';
  else qualifiesBy = 'Below';
  
  route.volume = Math.round(volume * 100) / 100;
  route.value = Math.round(value * 100) / 100;
  route.distance = Math.round(distance * 100) / 100;
  route.qualifiesBy = qualifiesBy;
  
  return { distance: route.distance, volume: route.volume, value: route.value, qualifiesBy };
}

export function isPdpOk(route, params = {}) {
  const pMin = params.pmin !== undefined ? params.pmin : (params.pMinCr !== undefined ? params.pMinCr : 10);
  const vMin = params.vmin !== undefined ? params.vmin : (params.vMin !== undefined ? params.vMin : 12);
  const pMinBDT = pMin * 10000000;
  const vol = route.volume || 0;
  const val = route.value || 0;
  return vol >= vMin - 1e-9 || val >= pMinBDT - 1e-9;
}

export function isOver(route, params = {}) {
  const cap = params.cap !== undefined ? params.cap : 12;
  const vol = route.volume || 0;
  return vol > cap + 1e-9;
}

export function revertOnEdit(route) {
  if (!route) return;
  // edit ⇒ status reverts to Pending review
  if (route.status === 'Ready' || route.status === 'Approved exception') {
    route.status = 'Pending review';
  }
}

export function trySetStatus(plan, routeId, status, opts = {}) {
  const blockers = [];
  const route = plan.routes.find(r => r.id === routeId);
  if (!route) return { ok: false, blockers: ['Route not found'] };
  
  if (!STATUSES.includes(status)) {
    return { ok: false, blockers: ['Invalid status'] };
  }
  
  if (status === 'Approved exception') {
    if (!opts.reasonCategory || !REASON_CATEGORIES.includes(opts.reasonCategory)) {
      blockers.push('Approved exception requires a reason category');
    }
    if (!opts.reason || String(opts.reason).trim() === '') {
      blockers.push('Approved exception requires a comment');
    }
  }
  if (status === 'Excluded / deferred') {
    if (!opts.reason || String(opts.reason).trim() === '') {
      blockers.push('Excluded / deferred requires a reason');
    }
  }
  
  if (status === 'Ready') {
    if (!isPdpOk(route, plan.params)) {
      blockers.push('PDP not met');
    }
    if (isOver(route, plan.params)) {
      blockers.push('Over selected truck capacity');
    }
    if (route.hasFallbackLegs) {
      blockers.push('Route has fallback legs');
    }
  }
  
  if (blockers.length > 0) {
    return { ok: false, blockers };
  }
  
  const before = { km: route.distance, MT: route.volume, cr: route.value / 1e7, status: route.status };
  route.status = status;
  if (status === 'Approved exception') {
    route.reasonCategory = opts.reasonCategory;
    route.reason = opts.reason;
  } else if (status === 'Excluded / deferred') {
    route.reasonCategory = null;
    route.reason = opts.reason;
  } else {
    route.reasonCategory = null;
    route.reason = null;
  }
  bumpVersion(route);
  pushAudit(route, {
    type: `status:${status}`,
    version: route.version,
    before,
    after: { km: route.distance, MT: route.volume, cr: route.value / 1e7, status: route.status },
    paramsSnapshot: plan.params || null
  });
  
  return { ok: true, blockers: [] };
}

export function sortForDrawer(routes) {
  const order = ['Needs revision', 'Pending review', 'Approved exception', 'Ready', 'Excluded / deferred'];
  return [...routes].sort((a, b) => {
    const ai = order.indexOf(a.status);
    const bi = order.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    return (a.id || '').localeCompare(b.id || '');
  });
}

export function computeFinaliseGate(plan) {
  const blockers = [];
  let pending = 0;
  let needsRev = 0;
  for (const r of plan.routes || []) {
    if (r.status === 'Pending review') pending++;
    if (r.status === 'Needs revision') needsRev++;
  }
  if (pending > 0) blockers.push(`${pending} pending`);
  if (needsRev > 0) blockers.push(`${needsRev} needs revision`);
  
  // unassigned pool without decision blocks finalise
  const undecided = (plan.unassignedPool || []).filter(u => !u.decision);
  if (undecided.length > 0) blockers.push(`${undecided.length} unassigned without decision`);
  
  // routes that are Ready but invalid? also check
  for (const r of plan.routes || []) {
    if (r.status === 'Ready') {
      if (!isPdpOk(r, plan.params)) blockers.push(`Route ${r.id} Ready but PDP not met`);
      if (isOver(r, plan.params)) blockers.push(`Route ${r.id} Ready but over capacity`);
      if (r.hasFallbackLegs) blockers.push(`Route ${r.id} Ready but has fallback legs`);
    }
  }
  
  return { canFinalise: blockers.length === 0, blockers };
}

export function pushUndo(plan, op) {
  if (!plan.undoStack) plan.undoStack = [];
  // snapshot-based undo as per plan
  plan.undoStack.push({
    type: op && op.type,
    snapshot: JSON.parse(JSON.stringify({ routes: plan.routes, unassignedPool: plan.unassignedPool }))
  });
}

export function undo(plan) {
  if (!plan.undoStack || plan.undoStack.length === 0) return { ok: false };
  const last = plan.undoStack.pop();
  if (last && last.snapshot) {
    plan.routes = JSON.parse(JSON.stringify(last.snapshot.routes));
    plan.unassignedPool = JSON.parse(JSON.stringify(last.snapshot.unassignedPool));
    return { ok: true };
  }
  return { ok: false };
}

function getCustId(c) {
  return typeof c === 'string' ? c : c.id;
}

function findRoute(plan, routeId) {
  return plan.routes.find(r => r.id === routeId);
}

function rebuildRouteMetrics(route, distMatrix, params) {
  let volume = 0, value = 0;
  for (const c of route.customers) {
    const cust = typeof c === 'string' ? null : c;
    if (cust) { volume += cust.orderVolume || 0; value += cust.orderValue || 0; }
  }
  route.volume = Math.round(volume * 100) / 100;
  route.value = Math.round(value * 100) / 100;
  if (distMatrix) {
    try {
      const res = recomputeDerived(route, distMatrix, params);
      route.distance = res.distance;
    } catch {}
  }
  const pMin = params.pmin !== undefined ? params.pmin : (params.pMinCr !== undefined ? params.pMinCr : 10);
  const vMin = params.vmin !== undefined ? params.vmin : (params.vMin !== undefined ? params.vMin : 12);
  const pMinBDT = pMin * 10000000;
  const byVol = route.volume >= vMin - 1e-9;
  const byVal = route.value >= pMinBDT - 1e-9;
  if (byVol && byVal) route.qualifiesBy = 'Both';
  else if (byVol) route.qualifiesBy = 'Volume';
  else if (byVal) route.qualifiesBy = 'Value';
  else route.qualifiesBy = 'Below';
}

const snap = (route) => ({ km: route.distance, MT: route.volume, cr: route.value / 1e7, status: route.status });

function recordOp(plan, routes, type) {
  for (const route of routes) {
    bumpVersion(route);
    pushAudit(route, {
      type,
      version: route.version,
      before: route.__before || {},
      after: snap(route),
      paramsSnapshot: plan.params || null
    });
    delete route.__before;
  }
}

export function applyOp(plan, op, distMatrix) {
  if (!op || !op.type) return { ok: false, blockers: ['Invalid op'] };
  // snapshot before
  pushUndo(plan, op);
  
  const params = plan.params || {};
  
  if (op.type === 'removeCustomer') {
    const route = findRoute(plan, op.routeId);
    if (!route) return { ok: false, blockers: ['Route not found'] };
    const idx = route.customers.findIndex(c => getCustId(c) === op.customerId);
    if (idx < 0) return { ok: false, blockers: ['Customer not found'] };
    route.__before = snap(route);
    const cust = route.customers[idx];
    const custObj = typeof cust === 'string' ? { id: cust } : { ...cust };
    route.customers.splice(idx, 1);
    revertOnEdit(route);
    if (!plan.unassignedPool) plan.unassignedPool = [];
    plan.unassignedPool.push({
      bp: { id: custObj.id, bpId: custObj.bpId, name: custObj.name, vol: custObj.orderVolume, val: custObj.orderValue },
      from: op.routeId,
      decision: null,
      reason: null
    });
    rebuildRouteMetrics(route, distMatrix, params);
    recordOp(plan, [route], `remove:${op.customerId}`);
    return { ok: true };
  }
  
  if (op.type === 'addCustomer') {
    const route = findRoute(plan, op.routeId);
    if (!route) return { ok: false, blockers: ['Route not found'] };
    const c = op.customer;
    const nv = (route.volume || 0) + (c.orderVolume || 0);
    const cap = params.cap !== undefined ? params.cap : 12;
    if (nv > cap + 1e-9 && !op.approveOverload) {
      // rollback - but we already pushed undo; easier to restore by popping
      undo(plan);
      return { ok: false, blockers: ['Over selected truck capacity — approval required'] };
    }
    route.__before = snap(route);
    if (!route.customers) route.customers = [];
    route.customers.push({ ...c });
    revertOnEdit(route);
    // remove from pool if present
    if (plan.unassignedPool) {
      plan.unassignedPool = plan.unassignedPool.filter(u => !(u.bp && u.bp.id === (c.id || op.customerId)));
    }
    rebuildRouteMetrics(route, distMatrix, params);
    recordOp(plan, [route], `add:${c.id || op.customerId}`);
    return { ok: true };
  }
  
  if (op.type === 'moveCustomer') {
    // remove from source, add to target
    const src = findRoute(plan, op.fromRouteId);
    const tgt = findRoute(plan, op.toRouteId);
    if (!src || !tgt) { undo(plan); return { ok: false, blockers: ['Route not found'] }; }
    const idx = src.customers.findIndex(c => getCustId(c) === op.customerId);
    if (idx < 0) { undo(plan); return { ok: false, blockers: ['Customer not found'] }; }
    const cust = src.customers.splice(idx, 1)[0];
    const c = typeof cust === 'string' ? { id: cust } : { ...cust };
    const nv = (tgt.volume || 0) + (c.orderVolume || 0);
    const cap = params.cap !== undefined ? params.cap : 12;
    if (nv > cap + 1e-9 && !op.approveOverload) {
      undo(plan); return { ok: false, blockers: ['Over selected truck capacity — approval required'] };
    }
    src.__before = snap(src); tgt.__before = snap(tgt);
    if (!tgt.customers) tgt.customers = [];
    tgt.customers.push(c);
    revertOnEdit(src); revertOnEdit(tgt);
    rebuildRouteMetrics(src, distMatrix, params);
    rebuildRouteMetrics(tgt, distMatrix, params);
    recordOp(plan, [src, tgt], `move:${op.customerId}`);
    return { ok: true };
  }
  
  if (op.type === 'setExcluded') {
    const route = findRoute(plan, op.routeId);
    if (!route) { undo(plan); return { ok: false, blockers: ['Route not found'] }; }
    if (!op.reason) { undo(plan); return { ok: false, blockers: ['Excluded / deferred requires a reason'] }; }
    route.__before = snap(route);
    route.status = 'Excluded / deferred';
    route.reason = op.reason;
    route.reasonCategory = null;
    recordOp(plan, [route], `defer:${route.id}`);
    return { ok: true };
  }
  
  if (op.type === 'acceptUnassigned') {
    if (!plan.unassignedPool) plan.unassignedPool = [];
    const idx = plan.unassignedPool.findIndex(u => (u.bp && u.bp.id) === op.customerId || u.customerId === op.customerId);
    if (idx >= 0) {
      plan.unassignedPool[idx].decision = 'ACCEPTED_UNASSIGNED';
    }
    return { ok: true };
  }
  
  if (op.type === 'deferUnassigned') {
    if (!plan.unassignedPool) plan.unassignedPool = [];
    const idx = plan.unassignedPool.findIndex(u => (u.bp && u.bp.id) === op.customerId);
    if (idx >= 0) {
      plan.unassignedPool[idx].decision = 'DEFERRED_FUTURE_PLAN';
      if (op.reason) plan.unassignedPool[idx].reason = op.reason;
    }
    return { ok: true };
  }
  
  if (op.type === 'restoreCustomer') {
    const route = findRoute(plan, op.routeId);
    if (!route) { undo(plan); return { ok: false, blockers: ['Route not found'] }; }
    if (!plan.unassignedPool) { undo(plan); return { ok: false, blockers: ['Pool empty'] }; }
    const idx = plan.unassignedPool.findIndex(u => (u.bp && u.bp.id) === op.customerId);
    if (idx < 0) { undo(plan); return { ok: false, blockers: ['Customer not found in pool'] }; }
    route.__before = snap(route);
    const u = plan.unassignedPool.splice(idx, 1)[0];
    if (!route.customers) route.customers = [];
    route.customers.push({ id: u.bp.id, bpId: u.bp.bpId, name: u.bp.name, orderVolume: u.bp.vol, orderValue: u.bp.val });
    revertOnEdit(route);
    rebuildRouteMetrics(route, distMatrix, params);
    recordOp(plan, [route], `restore:${op.customerId}`);
    return { ok: true };
  }
  
  if (op.type === 'reoptimiseSequence') {
    const route = findRoute(plan, op.routeId);
    if (!route) { undo(plan); return { ok: false, blockers: ['Route not found'] }; }
    route.__before = snap(route);
    const ids = route.customers.map(getCustId);
    let order;
    try {
      order = optimizeOrder(ids, distMatrix, op.iterations || 5000, op.seed || 42);
    } catch {
      order = ids;
    }
    const custById = new Map(route.customers.map(c => [getCustId(c), c]));
    route.customers = order.map(id => custById.get(id)).filter(Boolean);
    revertOnEdit(route);
    rebuildRouteMetrics(route, distMatrix, params);
    recordOp(plan, [route], `reoptimise:${route.id}`);
    return { ok: true, distance: route.distance };
  }
  
  undo(plan);
  return { ok: false, blockers: ['Unknown op'] };
}

/* Directed route total over ordered WH -> ids legs; null when any directed leg is unavailable. */
export function directedRouteKm(ids, dm) {
  if (!ids.length) return 0;
  let total = 0;
  const leg = (a, b) => (dm ? dm[`${a}|${b}`] : undefined);
  let v = leg('WH', ids[0]);
  if (v == null) return null;
  total += v;
  for (let i = 1; i < ids.length; i++) {
    v = leg(ids[i - 1], ids[i]);
    if (v == null) return null;
    total += v;
  }
  return Math.round(total * 100) / 100;
}

function bestInsertDelta(targetIds, id, dm) {
  let best = null;
  const base = directedRouteKm(targetIds, dm);
  if (base == null) return null;
  for (let p = 0; p <= targetIds.length; p++) {
    const order = targetIds.slice(0, p).concat([id], targetIds.slice(p));
    const d = directedRouteKm(order, dm);
    if (d == null) continue;
    if (best === null || d < best.d) best = { order, d, delta: d - base };
  }
  return best;
}

export function planMerge(plan, sourceId, distMatrix = null) {
  const source = findRoute(plan, sourceId);
  if (!source || !(source.customers || []).length) {
    return { none: true, message: 'No feasible merge found within selected truck capacity. Review nearby BPs, approve an exception, or defer these customers.' };
  }
  const dm = distMatrix || plan.distMatrix || null;
  const srcIds = source.customers.map(getCustId);
  const cap = plan.params?.cap || 12;
  const candidates = [];
  for (const r of plan.routes) {
    if (r.id === sourceId) continue;
    if ((r.status || '') === 'Excluded / deferred') continue;
    const nvVol = (r.volume || 0) + (source.volume || 0);
    if (nvVol > cap + 1e-9) continue;
    if (!isPdpOk({ volume: nvVol, value: (r.value || 0) + (source.value || 0) }, plan.params)) continue;
    // feasibility: sum of independent best-insertion deltas (road km, directed legs)
    const tgtIds = r.customers.map(getCustId);
    let delta = 0;
    let feasible = true;
    for (const cid of srcIds) {
      const ins = bestInsertDelta(tgtIds, cid, dm);
      if (!ins) { feasible = false; break; }
      delta += ins.delta;
    }
    if (!feasible && dm) continue;
    candidates.push({ targetId: r.id, delta: feasible ? Math.round(delta * 100) / 100 : null });
  }
  if (candidates.length === 0) {
    return { none: true, message: 'No feasible merge found within selected truck capacity. Review nearby BPs, approve an exception, or defer these customers.' };
  }
  candidates.sort((a, b) => (a.delta ?? Infinity) - (b.delta ?? Infinity));
  return { best: candidates[0], alternatives: candidates.slice(1) };
}


export function newSolverVersion(plan, newResult, params) {
  // Archive current plan, start a new chain entry
  const archivedId = plan.planId;
  const chain = plan.reSolveChain || [];
  chain.push(archivedId);
  const next = createPlan(newResult, params);
  next.reSolveChain = chain;
  next.solvedAt = new Date().toISOString();
  return next;
}

export function replaceCurrentDraft(plan, result, params) {
  const gate = computeFinaliseGate(plan);
  const hasApprovedRoute = (plan.routes || []).some(r => r.status === 'Ready' || r.status === 'Approved exception');
  if (hasApprovedRoute) {
    throw new Error('Route decisions (Ready / Approved exception) exist — create a revision instead of replacing the draft.');
  }
  const next = createPlan(result, params);
  next.planId = plan.planId;
  next.reSolveChain = plan.reSolveChain || [];
  return next;
}

export function createRevision(plan) {
  const rev = JSON.parse(JSON.stringify(plan));
  rev.planId = `${plan.planId}_rev${(plan.revisionCount || 0) + 1}`;
  rev.revisionOf = plan.planId;
  rev.revisionCount = (plan.revisionCount || 0) + 1;
  rev.finalised = false;
  rev.undoStack = [];
  return rev;
}

export function applyMerge(plan, sourceId, targetId, opts = {}) {
  pushUndo(plan, { type: 'merge' });
  const source = findRoute(plan, sourceId);
  const target = findRoute(plan, targetId);
  if (!source || !target) { undo(plan); return { ok: false }; }
  source.__before = snap(source); target.__before = snap(target);
  // Move all customers
  if (!target.customers) target.customers = [];
  target.customers.push(...(source.customers || []));
  source.customers = [];
  revertOnEdit(target);
  // Update statuses per spec
  target.status = 'Needs revision';
  source.status = 'Excluded / deferred';
  source.reason = `Merged into ${targetId}`;
  source.reasonCategory = null;
  const params = plan.params || {};
  rebuildRouteMetrics(source, opts.distMatrix, params);
  rebuildRouteMetrics(target, opts.distMatrix, params);
  recordOp(plan, [source, target], `merge:${sourceId}->${targetId}`);
  return { ok: true };
}
