# PDP Digital Route — View-Only Restore: Design Spec

**Date:** 2026-10-22
**Status:** Approved direction (user), spec for review
**Repo:** rezwansyngenta/Syngenta-PDP-Digital-Route (root-deployed to GitHub Pages)

---

## 1. Problem

The rebuilt review workspace over-humanized the flow: statuses (*Mark Ready*, *Needs
Revision*, exceptions, finalise gate), manipulated plans, and a busy one-route-at-a-time
map. The user's simpler mental model — proven by the bundled desktop
`PDP-Software.exe` and the original `web/` app — is:

> Load data → solve with a validated local distance matrix → see all optimized routes
> on a clean map → inspect leg km → open exact roads in Google Maps → export.

This spec replaces the workspace with the restored view-only shell, adds the
desktop-exe's best UI touches, makes the distance asset coordinate-keyed (data
privacy), and adds a second optimization mode (min trucks).

## 2. Decisions locked by the user

1. **View-only, zero editing.** No statuses, no exceptions flow, no gates, no
   move/add/remove, no merge/undo. The solver assigns; the UI displays.
2. **Old map design exactly**, enhanced with five exe touches (§5).
3. **Coordinate-keyed distance matrix** replaces the ID-keyed asset — no customer
   names, BP IDs or addresses in the repo.
4. **Two optimization modes:** *Min km* and *Min trucks* (km tiebreak inside the
   chosen truck count).
5. **Strict capacity refusal** in Min-trucks mode — a truck never exceeds cap; the
   overflow becomes unassigned with a reason (existing penalty-candidate behavior).

## 3. Plant (kept)

- `lib/road-distance.js` — matrix builder; gains coordinate-key lookup support (§6).
- `lib/candidates.js`, `lib/route-opt.js`, `lib/build-data.js` — unchanged.
- `lib/solver.js` — gains two-stage objective (§7). `utilisation` already emitted.
- `worker.js` — pipeline (data → matrix → candidates → ILP → stop order →
  `gmaps_url` per route + `distanceSource`/`distanceStats` in meta). Coordinate
  matrix fetch replaces ID-matrix fetch (§6).
- `settings.json`, `scripts/serve.py` (no-store), `demo/*`, Pages workflow.

## 4. Removed

- `js/state.js`, `js/ui-panel.js`, `js/ui-map.js`, `js/ui-drawer.js`,
  `js/ui-strip.js`, `js/impact.js`, `js/geometry.js`, `js/export.js`,
  `js/osrm.js`, `js/persistence.js` — the whole plan-lifecycle surface.
- `tests/gating.test.mjs`, `tests/local-matrix.test.mjs` (ID-keyed overlay tests —
  superseded by §6 tests), current root `app.js` + `index.html`.
- `data/road_matrix_cache.json` (ID-keyed, identifiable) — out of the repo.

## 5. Restored UI (root `index.html` + `app.js`)

Recovered from git (`87cc3ec~1:web/*`), adapted to the current engine contract.
Layout per old design + desktop-exe touches:

- **Header:** Syngenta logo, file inputs (#gpsFile/#orderFile), params
  (pMin Cr, vMin, cap, warehouse override), **Optimise selector**, Resolve,
  theme toggle.
- **KPI strip:** proposed routes, outbound road km, volume planned, value.
- **Exceptions bar (passive):** "N below PDP · M unassigned" + read-only list with
  unassigned reasons. No Review button, no approve forms.
- **Map (full-screen, exe layout):** flat `--sunken` background — **no street
  tiles**; green `districts.geojson` outlines; **all routes drawn simultaneously**
  as solid colored polylines (weight 3); numbered circular stop badges per route
  color (22 px; 28 px WH badge); red unassigned dots with reason popup; volume
  layers toggle (all-customers dots / no-order GPS grey); scale control.
  Exe touches folded in:
  1. **Per-leg km labels** rendered on polyline segments (small pill `63.8 km`).
  2. **Dim-others-on-select:** selected route weight 6/opacity 1, others opacity
     0.2; details panel zooms to the route's bounds.
  3. **Filters** (multi-select route list, qualifies-by, routed/unassigned/
     no-order, show-all-customers) — exe-style, replacing the flat route table.
  4. **Return-to-warehouse leg** shown in details when a route returns (R02-style
     closed loop display only; solver km remains outbound).
  5. **Details drawer** (right panel): route totals + stop table with per-leg km +
     green **View in Google Maps** button (`gmaps_url`, whole route as
     directions).
- **Corridor "Find nearby BPs"** (2/5 km) — read-only: nearby dot list, no
  Simulate/Apply buttons.
- **Footer:** distance source ("Local road matrix (validated km, all pairs)"),
  stats counts, customers/order counts, solve time.

## 6. Coordinate-keyed distance asset

**Why:** the ID-keyed file encodes customer identity order (C001… + WH); combined
with a leaked data master it is re-identifiable. Coordinates → anonymous geometry.

- **Asset:** `data/road_matrix_coord.json` —
  `{ "_version": 3, "distances": { "<lat>,<lon>|<lat>,<lon>": km } }`, keys built
  from 6-decimal-rounded coordinates, sorted pair (lexicographic), values from the
  validated local run. ~9,900 pairs, ~200 KB.
- **Generator:** `scripts/make-coord-matrix.mjs` — reads the local (outside repo)
  `PDP-Software/data/data.json` (id → lat/lon, 141 locations) and its ID-keyed
  matrix; emits the coord-keyed asset. Committed once; run again if the local run
  changes. Not part of CI.
- **Lookup (runtime):** `round6(lat, lon) → "24.81557,89.358517"`. Intersection
  key = sorted pair of rounded "lat,lon" strings. Both read and write use the same
  rounding, so exact-coord matches hit deterministically.
- **worker.js:** fetches `settings.local_matrix_path` (now the coord file);
  `buildMatrix` seeds `distMatrix[a|b]`/`[b|a]` symmetrically from
  `coordMatrix[coordKey(a,b)]`; covered pairs never touch OSRM. Stats:
  `localPairs` via coord overlay; progress shows "Loaded local road matrix: N
  coordinate pairs". **Warn path:** if GPS coords don't round-match (customer
  master changed), `localPairs === min(k, total)` reported + warn when misses >
  25%: "Coordinate match rate low — matrix may be stale or coordinates
  edited; uncovered pairs fall back to OSRM."
- Settings: `local_matrix_path: "data/road_matrix_coord.json"`,
  `prefer_local_matrix: true`.

## 7. Solver — two optimization modes

Lib (LP text already generated by `buildLp`) gains a mode parameter:

```
solve(data, candidates, { mode: 'min-km' | 'min-trucks', ... })
```

- **min-km (current behavior):** objective = Σ distance · xᵢ (+ PENALTY · xᵢ for
  unassigned singletons). One HiGHS solve.
- **min-trucks (two-stage, strict capacity):**
  - *Stage 1:* minimize truck count — cost 1 per non-unassigned candidate,
    1 000 per unassigned candidate. Read route count k = |selected non-unassigned|
    (rounded).
  - *Stage 2*: re-solve with added equality constraint
    `x₀ + x₁ + … = k` (sum over non-unassigned candidates), objective = km
    (+ PENALTY unassigned). If stage 2 returns no feasible solution at k, relax to
    k+1 and retry once.
  - Capacity stays strict in both modes: candidates are generated ≤ cap only;
    single orders over cap become penalized unassigned candidates — never over-
    capacity routes. PDP (vMin/pMin) constraints unchanged in both modes.
- Result metadata: `mode`, per-mode `objectiveValue`; UI labels
  "42 trucks · 3,214 km (min-trucks)" / "47 trucks · 2,988 km (min-km)".

## 8. Export (restored, view-only)

Old 3-sheet XLSX: **Route Summary** (route, stops, volume, value, km, PDP status,
utilisation), **Route Stops** (per stop: BP ID, name, volume, value, leg km),
**Google Maps Links**. Unassigned list appended to Route Summary? — No; separate
**Unassigned** sheet (BP ID, name, volume, value, reason, decision-free). Pure
function colocated per old app (inline), verified in browser.

## 9. Testing

- `tests/*.mjs` — keep engine tests that remain valid (directed keys, haversine
  fallback) and add: `lib/solver.js` mode tests (fixture: 6 customers — min-trucks
  < min-km route count, stage-2 km < stage-1 greedy km, unassigned under strict
  cap) and `lib/road-distance.js` coord-key tests (hit, miss-warn path, symmetric).
- Browser E2E on dev server: demo solve → routes drawn, labels, filters work,
  gmaps opens ok, export contains 4 sheets.

## 10. Success criteria

1. Demo solve: **0 OSRM requests**, distances identical to the desktop run.
2. Whole-batch solve (112 ordered customers) feasible; Min-trucks returns fewer
   trucks than Min-km; no route over cap in either mode.
3. Repo contains no customer name/BP-ID/address; only the coord-keyed matrix.
4. UI shows no status/gate/permission language anywhere.
5. Solve → inspect → gmaps → export completes without any decision step.
