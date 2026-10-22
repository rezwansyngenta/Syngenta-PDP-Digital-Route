# View-Only Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the status-workspace app with the restored view-only shell (old map design + exe touches), coordinate-keyed distance asset, and Min-km / Min-trucks solve modes.

**Architecture:** Engine (`lib/*`, `worker.js`) keeps the current pipeline; solver gains a mode parameter with a two-stage min-trucks objective. UI is recovered from git history (`87cc3ec~1:web/*`), adapted to the current engine contract, then restyled to the deskop-exe full-screen-map layout. The ID-keyed distance asset is replaced by a coordinate-keyed one generated from the local machine's `data.json`.

**Tech Stack:** Vanilla JS modules, Leaflet (vendored), HiGHS WASM ILP, SheetJS XLSX, Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-view-only-restore-design.md`

## Global Constraints

- Strict capacity: no route may exceed `capMax`; oversized single orders become unassigned (penalty candidates), never overloaded trucks.
- Repo must contain no customer names / BP IDs / addresses in data assets — coordinate keys only.
- Directed leg keys `a|b` + `b|a` in `distMatrix`; never reverse-substitute.
- Rounding for coordinate keys: `Math.round(x * 1e6) / 1e6` both sides, identical strings.
- Settings keys: `local_matrix_path: "data/road_matrix_coord.json"`, `prefer_local_matrix: true`.
- Commits atomic per task; push at end; Pages deploy publishes repo root.

## Review Focus

1. **Coordinate rounding mismatch** — GPS re-exports with fewer decimals should miss the matrix, not crash: expect OSRM fallback + low-match warning. Test: Task 2 step for miss path.
2. **Min-trucks stage-2 infeasibility** — if km-solve at k fails, relax to k+1 exactly once. Test: Task 3.
3. **Old UI's settings fetch** — old `app.js` fetches `./settings.json` itself; new keys must not break it. Test: Task 4 browser flow.
4. **Demo/customer IDs never match the coord asset** — demos run on OSRM fallback; asset only matches real master coords. Test: Task 2 (lookup is coord-only, no ID path).
5. **Export sheet list regression** — must be exactly 4 sheets: Route Summary, Route Stops, Google Maps Links, Unassigned. Test: Task 5 browser check.

---

### Task 1: Coordinate-keyed matrix asset + generator

**Files:**
- Create: `scripts/make-coord-matrix.mjs`
- Create: `data/road_matrix_coord.json` (generated, committed)
- Create: `tests/coord-matrix.test.mjs`
- Modify: `lib/road-distance.js` (add exported `round6`, `coordPairKey`)
- Delete: `data/road_matrix_cache.json` (ID-keyed — identifying)

**Interfaces:**
- Produces: `round6(lat, lon) -> "lon,lat"` string (see step 2: **key format `"lat,lon"`**), `coordPairKey([lat,lon], [lat,lon]) -> sorted pair string`, asset `{_version:3, distances: Record<key, km>}`. Asset format: `{ "_version": 3, "distances": { "24.81557,89.358517|24.980151,89.221401": 55.2 } }`.

- [ ] **Step 1: Write failing test** — `tests/coord-matrix.test.mjs`:
  - `round6(24.8155701506389, 89.35851746567042) === '24.815570,89.358517'`
  - `coordPairKey([24.8,89.3],[24.9,89.4]) === '24.8,89.3|24.9,89.4'` and reversed order gives same string.
  - committed asset parses, `_version === 3`, ≥9000 keys, no key contains `|WH` or starts with `C0` (privacy pin).
- [ ] **Step 2: Run `npm test` — expect FAIL (functions not defined / asset missing).**
- [ ] **Step 3: Implement `round6`/`coordPairKey` in `lib/road-distance.js`** (plain string `${round6 lat},${round6 lon}` — "lat,lon" order) and `scripts/make-coord-matrix.mjs`: reads local `../PDP-Software/data/data.json` via `process.argv[2]` fallback `C:/Users/.../PDP-Software/data/data.json` absolute default, uses its `id → lat,lon` + `distMatrix` (ID-keyed sorted-pair entries `a|b`), writes `data/road_matrix_coord.json` with coordinate keys, 6-dp, stable sort. Run it; regenerate asset.
- [ ] **Step 4: `npm test` PASS (privacy assertions included). `git rm --cached data/road_matrix_cache.json`, commit.**

### Task 2: buildMatrix coord overlay + worker switch

**Files:**
- Modify: `lib/road-distance.js` (replace `localMatrix` id-keyed option with `coordMatrix` matrix-keyed using `coordPairKey`)
- Modify: `worker.js` (fetch path → coord asset; low-match warning at <75% hit rate; pass `coordMatrix`)
- Modify: `tests/coord-matrix.test.mjs` (add overlay cases)

**Interfaces:**
- Consumes: `coordPairKey` (Task 1).
- Produces: `buildMatrix(locations, { coordMatrix, ... })` → `stats.localPairs`, `source` strings unchanged; worker `progress` warn message identical wording to existing warn.

- [ ] **Step 1: Update tests** — replace ID-overlay tests: fixture locations at the asset's real coordinates (from asset keys) → symmetric directed entries + `localPairs`; one bad coordinate → falls through to haversine + miss counted. (Keeps `tests/local-matrix.test.mjs` deleted from Task 1's `git rm`.)
- [ ] **Step 2: `npm test` FAIL (old option still there).**
- [ ] **Step 3: Implement:** in the seed loop use `coordMatrix?.[coordPairKey(coord[p.a], coord[p.b])] ?? null` instead of id `localMatrix`; worker fetch `settings.local_matrix_path`; after matrix build warn when `localPairs / pairs < 0.75` (wording: "Coordinate match rate low — uncovered pairs fall back to OSRM.") with existing `progress('warn', …)`; keep "Loaded local road matrix: N pairs" progress (now `N = coordMatrix key count`).
- [ ] **Step 4: `npm test` PASS. Commit.**

### Task 3: Solver modes (min-km / min-trucks)

**Files:**
- Modify: `lib/solver.js` (`buildLp` + `solve`)
- Create: `tests/solver-modes.test.mjs`

**Interfaces:**
- Consumes: candidate shape `{ route: [ids], distance, volume }` + `data.customers` (existing).
- Produces: `solve(data, candidates, { mode = 'min-km', capMax, vMin, pMin, timeLimit, highs })`; returns existing result shape + `mode` and `objectiveValue` per final LP. Worker later passes `params.mode`.

- [ ] **Step 1: Write failing tests** with a hand-built fixture: customers A(4MT,4Cr) B(4,4) C(4,4), cap 12 vMin 6 pMin 0 —
  - candidates: `[{route:[A,B,C], distance:21, volume:12, value:12}, {route:[A,B], distance:9, volume:8, value:8}, {route:[C], distance:8, volume:4, value:4}]`
  - `mode:'min-km'` → 2 routes, km 17; `mode:'min-trucks'` → 1 route, km 21.
  - `mode:'min-trucks'` with all single-candidates infeasible (customer volume 15 > cap) → unassigned, no over-cap route.
  - result.mode echoed.
- [ ] **Step 2: `npm test` FAIL.**
- [ ] **Step 3: Implement** — `buildLp(candidates, {mode='min-km', countK=null})`: cost per candidate = mode 'min-trucks' ? (isUnassigned?1000:1) : (distance + PENALTY if unassigned); if `countK !== null` add `ccount:` row over NON-unassigned candidate indices `= countK`. In `solve`: if mode min-trucks → stage1 LP (min cost, no countK), k = selected non-unassigned count (round of Count), stage2 = buildLp with countK k and km objective, re-solve; if stage2 status Optimal/Time-limit ok → use it; else retry once with k+1. Record `mode`.
- [ ] **Step 4: `npm test` PASS. Commit.**

### Task 4: Restore view-only shell (adapted)

**Files:**
- Modify: root `index.html` (old layout recovered from `git show 87cc3ec~1:web/index.html` — CSS/layout verbatim)
- Modify: root `app.js` (old `app.js` recovered + adapted)
- Modify: `worker.js` (forward `params.mode` into `solve` call)
- Modify: `settings.json` (`local_matrix_path` → coord asset, already; drop nothing else)

**Interfaces:**
- Consumes: worker `done` message `data/result/settings` shape (existing); `result.routes[].gmaps_url` (existing).
- Produces: fully working solve flow (demo + real files) on the restored UI; `#mode` select posts `params.mode` in the solve message.

- [ ] **Step 1: Recover + adapt**: copy old `web/index.html` → root `index.html`, old `web/app.js` → root `app.js`; adjust: same asset/script paths (all exist), settings fetch unchanged; add **Optimise select** (`#paramMode`: `Min km` option value `min-km` default, `Min trucks` value `min-trucks`) into the params row and include `mode` in the `params` sent to the worker; worker.js `solve(data, candidates, { mode: params.mode === 'min-trucks' ? 'min-trucks' : 'min-km', ... })`.
- [ ] **Step 2: Browser E2E on :8788** (`python scripts/serve.py 8788`): load `/demo/gps.xlsx`+`/demo/orders.xlsx`, solve; assert (via in-page evaluate): `RESULT.routes.length ≥ 1`, route table rows rendered, `RESULT.routes[0].gmaps_url` starts `https://www.google.com/maps/dir/`, status footer text contains distance source, no console errors (`window.onerror` flag).
- [ ] **Step 3: Commit.**

### Task 5: Full-screen layout + exe touches + export

**Files:**
- Modify: `index.html` + `app.js` (layout + behaviors)
- Create: none

**Interfaces:**
- Consumes: `RESULT`, `DATA` (existing solved state).

- [ ] **Step 1: Layout** — map full-screen fixed (`position:fixed; inset:0; background:var(--sunken)`), left panel (KPIs, filters, route list), right details drawer (hidden until route selected). All routes drawn at once; thin solid polylines (weight 3, opacity .8).
- [ ] **Step 2: Exe touches in `app.js`:**
  1. per-leg km labels: `L.tooltip`-style div marker per leg midpoint (`63.8 km` pill); on route select show only that route's labels.
  2. dim-others-on-select: selected weight 6 / others opacity .2 (+ final hop to WH closed when route has return flag — display-only, km row `↩ Return to warehouse` uses `dm[last|WH]`; total km wording remains outbound).
  3. filters: multi-select route picker, qualifies-by (`All/Value/Volume/Both`), status (`All/Routed/Unassigned/No-order`), show-all-customers checkbox.
  4. details drawer: stop table (`# / name+BP / MT / Cr / leg km`), truck-fill %, **View in Google Maps** green button (`r.gmaps_url`), zoom to route bounds on select.
  5. corridor "Find nearby BPs" kept read-only (list + map dots, no Sim/Apply buttons — delete those).
- [ ] **Step 3: Export** — restore old export with 4 sheets (Route Summary, Route Stops, Google Maps Links, Unassigned). Snap to `XLSX.writeFile('route-plan-YYYY-MM-DD.xlsx')`.
- [ ] **Step 4: Browser E2E** — run demo + real-matching solve: all-route polylines count = route count; clicking a route dims others (`opacity attr` check); leg labels present; details gmaps button; export xlsx has 4 sheets (evaluate `XLSX.book_new` monkey? — simplest: hidden iframe download skip; assert via `wb` build function exposed as `window.__exportWorkbook` returning sheet names).
- [ ] **Step 5: Commit.**

### Task 6: Retire dead code, final verify, ship

**Files:**
- Delete: `js/` (10 files), `tests/gating.test.mjs`, `tests/stateful? any other stale tests`
- Modify: `.gitignore` — nothing (data/ ipl). `README.md` (update headline: coordinates-only matrix + two modes; remove status workflow references).

**Interfaces:**
- Consumes: nothing deprecated left.

- [ ] **Step 1: `git rm -r js tests/gating.test.mjs`; prune imports; `npm test` full PASS.**
- [ ] **Step 2: Browser E2E full pass on :8788** (all Task 4+5 asserts, no console errors).
- [ ] **Step 3: Update README headline** (2 lines), commit, push, confirm Pages deploy (`gh run list` success), verify live site assets (`/data/road_matrix_coord.json` fetch 200, `worker.js` contains `min-trucks`).
