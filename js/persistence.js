const SCHEMA_VERSION = 1;
const INDEX_KEY = 'pdp.planIndex';
const ACTIVE_KEY = 'pdp.activePlan';
const PLAN_PREFIX = 'pdp.plan.';

function getStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  const mem = new Map();
  return {
    getItem: (k) => mem.has(k) ? mem.get(k) : null,
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  };
}

export function listPlans(storage) {
  const s = getStorage(storage);
  try {
    const raw = s.getItem(INDEX_KEY);
    if (!raw) return [];
    const idx = JSON.parse(raw);
    if (!Array.isArray(idx)) return [];
    return idx;
  } catch {
    return [];
  }
}

export function savePlan(plan, storage) {
  const s = getStorage(storage);
  if (!plan || !plan.planId) return;
  const key = PLAN_PREFIX + plan.planId;
  const data = JSON.stringify({ schemaVersion: SCHEMA_VERSION, plan });
  s.setItem(key, data);
  const idx = listPlans(storage);
  const entry = {
    planId: plan.planId,
    solvedAt: plan.solvedAt || new Date().toISOString(),
    revisionOf: plan.revisionOf || null,
    finalised: plan.finalised || false,
    label: plan.label || plan.planId
  };
  const existing = idx.findIndex(i => i.planId === plan.planId);
  if (existing >= 0) idx[existing] = entry; else idx.push(entry);
  s.setItem(INDEX_KEY, JSON.stringify(idx));
}

export function getPlan(planId, storage) {
  const s = getStorage(storage);
  try {
    const raw = s.getItem(PLAN_PREFIX + planId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed.plan;
  } catch {
    return null;
  }
}

export function getActivePlanId(storage) {
  const s = getStorage(storage);
  try { return s.getItem(ACTIVE_KEY); } catch { return null; }
}

export function setActivePlanId(planId, storage) {
  const s = getStorage(storage);
  try { if (planId) s.setItem(ACTIVE_KEY, planId); else s.removeItem(ACTIVE_KEY); } catch {}
}

export { SCHEMA_VERSION };
