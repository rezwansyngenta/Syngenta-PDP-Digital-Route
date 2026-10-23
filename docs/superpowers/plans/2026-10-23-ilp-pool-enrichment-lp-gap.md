# ILP Pool Enrichment + LP Gap Bound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native inline, established workflow). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining route-partition gap provably: feed the converged solution back into the candidate pool and re-solve the ILP to a fixed point (lever 1), and compute an LP-relaxation lower bound so the footer badge reports `gap ≤ X%` (lever 2).

**Architecture:** Three new/extended lib modules behind `lib/`: `enrich.js` (builds extra candidates from a converged solution), `pool-iterate.js` (drives solve→converge→enrich→re-solve loop, injected with solve/converge for testability), `solver.js` gains `buildLpRelaxed` + `lpLowerBound`. Worker wires the loop after the first `convergeResult`; app.js extends the proof chip.

**Tech Stack:** existing HiGHS WASM LP line format (LINDO-style `Minimize / Subject To / Binaries|Continuous / End`), node:test.

**Spec basis:** conversation 2026-10-23 — levers 1+2 of the plateau analysis. Lever 5 (branch-and-price) stays out of scope.

## Global Constraints

- Deterministic everywhere: no RNG in enrichment/iteration; dedupe keeps first occurrence, base pool before extras.
- Strict capacity `vol <= capMax + 1e-9` AND OR-qualify (`vol >= vMin - 1e-9 || val >= pMin - 1e-9`) enforced on **both** the enriched set (receiver∪customer) and the donor residual (donor∖customer).
- `solve()` mutates candidate records (`delete isUnassigned`, injects `customers`) — every re-solve clones candidates `({ route: [...ids], distance, volume, value, isUnassigned })`; clone from the **pristine** pool each round.
- Monotonic acceptance: accept a re-solve only if strictly better; in min-trucks a lower truck count is better; a higher count is rejected even with lower km; equal count → compare km. Min-km: compare km only.
- Merged pool never exceeds `maxCandidates` (15000): base pool first (indexes stable), then extras.
- Empty donor residuals are skipped (a candidate route can't be empty).
- LP relaxation LB stays valid: continuous vars ≥0, same covering rows; objective penalties (PENALTY=10000, 1000 truck stage uses count obj not used for bound) — LB ≤ true optimum by definition. For min-trucks, the bound is on km given `countK = result.routeCount`.
- Time budget: enrichment loop caps at 3 re-solves, each `time_limit: 60` (same as first solve).

## Review Focus

1. Monotonicity: a worse re-solve (higher km / higher truck count) must never replace the best — test pins it (pool-iterate test "rejects worse re-solve").
2. Min-trucks count drift: enriched stage-1 must not produce a different k silently — accepted only when strictly lower (tested).
3. Pool cap overflow: base pool at 15000 → zero extras merged, loop must not crash or duplicate — tested with small `maxExtras`.
4. Unassigned markers: `isUnassigned` singletons must survive cloning across re-solves (else min-trucks stage-1 cost changes) — tested in enrichment/copy-path.
5. Gap honesty: `gapPct` must clamp to ≥0 and be omitted when the LP solve is not Optimal — tested.

---

### Task 1: Enrichment candidates `lib/enrich.js`

**Files:**
- Create: `lib/enrich.js`
- Test: `tests/enrich.test.mjs`

**Interfaces:**
- Produces:
  - `enrichCandidates(data, result, { capMax, vMin, pMin, maxExtras = 3000 })` → array of candidate records `{ route, distance, volume, value, isUnassigned: false }`, feasible-only, from result.routes' customer-id sets: the solution route itself, and for every (donor, customer, receiver) triple the pair `(receiver∪{c}, donor∖{c})`, both validated.
  - `mergePools(base, extras, maxCandidates)` → dedupe by sorted-set key (`setKey`), base first, cap applied.

- [ ] **Step 1: failing test** `tests/enrich.test.mjs`:
  - fixture data: customers A(2vol/5e7 val) B(2/5e7) F(2/1e8) D(2/5e7) E(2/5e7) G(2/1e8), cap 11; solution routes R1=[A,B,F] R2=[D,E,G] (mk like `tests/converge.test.mjs`, distances via `routeDistance` with a symmetric filled dm);
  - assert: R1 and R2 survive as candidates (setKey match, correct volume/value sum);
  - assert: inserting F into R2 (receiver vol 8 ≤ 11 qualifies, donor residual [A,B] val 1e8 qualifies) yields candidate pair receiver∪{F} + residual [A,B];
  - assert: customer whose insertion pushes receiver to 12 > cap 11 is excluded (set cap 11, insert B(2)+10-vol customer → drop);
  - assert: donor residual failing OR-predicate (single-customer donor residual after removal with vol< vMin and val < pMin) is excluded;
  - assert: `mergePools` dedupes extras already in base, caps total at small `maxExtras=2`.
- [ ] **Step 2:** `node --test tests/enrich.test.mjs` → FAIL (module missing).
- [ ] **Step 3: implement** `lib/enrich.js` (routeDistance from candidates.js; qualify OR-rule inline or import from solver.js).
- [ ] **Step 4:** node --test → 6/6 PASS; `npm test` full PASS.
- [ ] **Step 5:** commit `feat: enrichment candidates from converged solution`.

### Task 2: LP lower bound `lib/solver.js`

**Files:**
- Modify: `lib/solver.js` (add exports, no change to existing `solve`/`buildLp`)
- Test: `tests/lp-bound.test.mjs`

**Interfaces:**
- Produces:
  - `buildLpRelaxed(candidates, { mode = 'min-km', countK = null })` → LP text identical to `buildLp` except the `Binaries` section header is `Continuous`.
  - `lpLowerBound(candidates, { mode = 'min-km', countK = null, timeLimit = 60, highs })` → `{ lb, status }` (lb = round(ObjectiveValue,2)) or `null` when `status` is not Optimal/Time-limit-with-objective (return null on any non-Optimal status to stay conservative: only `Optimal` returns a bound; time-limit → null).
- Consumes: `buildLp` structure; injected HiGHS instance (same fake pattern as `tests/solver-modes.test.mjs`).

- [ ] **Step 1: failing test** `tests/lp-bound.test.mjs`:
  - fake highs recording LP text; candidates `mk` from solver-modes fixture (three-route 21/9/8 km);
  - assert LP text has `Continuous` section, no `Binaries`;
  - assert `countK = 2` adds `ccount` row;
  - stub solve returning `ObjectiveValue: 17` `Status: 'Optimal'` → `{ lb: 17 }`;
  - stub returning `Status: 'Time limit reached'` → `null`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** PASS + full npm test.
- [ ] **Step 5:** commit `feat: LP relaxation lower bound (buildLpRelaxed + lpLowerBound)`.

### Task 3: Pool-iteration loop `lib/pool-iterate.js`

**Files:**
- Create: `lib/pool-iterate.js`
- Test: `tests/pool-iterate.test.mjs`

**Interfaces:**
- Produces: `runPoolLoop({ candidates, base, opts, solveFn, convergeFn, enrichOpts, mode, maxPoolRounds = 3, minGain = 0.5, candidateCap = 15000, onProgress })` → `{ result, ilpRounds }` where `result` is the best accepted result (already converged) and ilpRounds counts accepted re-solves. `solveFn(pool)` receives a fresh clone; `convergeFn(result)` is awaited.
- Consumes: `enrichCandidates`/`mergePools` (Task 1), `clonePool` helper exported here for reuse.

- [ ] **Step 1: failing test** `tests/pool-iterate.test.mjs` (pure injected fakes, no HiGHS):
  - accepts an improving chain: solveFn returns first result km 17→converge to 15, then enriched solve km 14 → `{ ilpRounds: 1 }`, returned result km 14, second pool contains the converged route's set (assert via solveFn spy capturing pool arrays);
  - rejects worse re-solve: enriched solve km 16 > best 15 → loop stops, base returned, `ilpRounds: 0`;
  - rejects gain ≤ minGain: enriched km 14.6 with best 15 → not accepted;
  - min-trucks count guard: enriched solve with routeCount 2 > base 1 → rejected (even with lower km); routeCount 0→ lower count accepted → `ilpRounds: 1`;
  - stops cleanly when enrich yields no extras (all dup of base).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: implement** (clone pool per solve; acceptance lexicographic: lower routeCount wins, else lower totalDistance).
- [ ] **Step 4:** PASS + full npm test.
- [ ] **Step 5:** commit `feat: ILP pool-enrichment fixed-point loop`.

### Task 4: Worker wiring + badge gap

**Files:**
- Modify: `worker.js` (post-converge section ~line 104-110)
- Modify: `app.js` (`renderFoot`)
- Test: browser E2E on :8788

**Interfaces:**
- Consumes: `runPoolLoop`, `lpLowerBound` (Tasks 2, 3). Worker imports both; passes `highsInstance`, same opts as first solve `{ capMax: cap, vMin, pMin, timeLimit: 60, mode }`.
- Produces: `result.proof` extended: `ilpRounds`, `lbKm`, `gapPct` (number, ≥0, or null). `gapPct = max(0, (totalDistance − lb) / totalDistance × 100)` computed only when `lb != null` and `totalDistance > 0`; badge footer appends `· {ilpRounds} ILP pool round(s)` when >0 and `· gap ≤ {ceil(gapPct×100)/100}%` when gapPct != null.

- [ ] **Step 1: worker** — after first `convergeResult`, call `runPoolLoop` with injected `solveFn` (real solve + progress spam once per round), `convergeFn`, `onProgress`; replace `result` with loop result; compute `lpLowerBound` on the pristine base candidates (`countK = result.routeCount` in min-trucks; none in min-km); attach proof fields. Keep existing gmaps + totalDistance recomputation untouched.
- [ ] **Step 2: app.js** — extend the proof-chip bits per Interfaces above.
- [ ] **Step 3: browser E2E** :8788 demo flow (established driver: gpsFile + orderFile inputs, solve, wait `solved in`): min-km shows badge with gap ≤ value and route count ≤ 5; min-trucks keeps 5 trucks; re-solve on fresh reload gives identical footer; no console errors; export still 4 sheets; return-leg row + leg pills intact.
- [ ] **Step 4:** commit `feat: ILP pool enrichment rounds + LP gap readout on badge`; push; verify Pages run success + live asset check of `lib/pool-iterate.js`.

### Task 5: README + close ledger

**Files:** `README.md` (one paragraph under the badge paragraph), `.superpowers/sdd/2026-10-23-ilp-pool-enrichment-lp-gap/progress.md`.

- [ ] README: explain the enrichment loop (converged routes re-enter the pool; ILP re-solves to fixed point) and the `gap ≤ X%` bound meaning.
- [ ] Full `npm test`, commit `docs: pool enrichment + gap bound in README`, push, `gh run list` success.
