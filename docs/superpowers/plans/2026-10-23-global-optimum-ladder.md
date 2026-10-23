# Global-Optimum Ladder Plan

> **For agentic workers:** Use test-driven development task-by-task. Steps use checkbox syntax.

**Goal:** Make the solve provably optimal at every affordable layer: exact stop sequencing (replaces SA for small routes), fixed-point cross-route improvement (relocate + swap + 2-opt*, iterate until no move helps), and an on-screen proof badge.

**Spec basis:** conversation 2026-10-23 — Tier 1 (exact sequencing) + Tier 3 (iterative pool-to-fixed-point) + status badge. True global (branch-and-price) explicitly out of scope.

## Design decisions

- **Sequencing objective stays outbound** (WH → stops, no return leg), matching existing totals; return leg remains display-only.
- **Exact sequencer:** `exactOrder(startId, ids, dm)` — Held–Karp DP over subsets, free end (shortest Hamiltonian path), in `lib/route-opt.js`. Routes with n ≤ 13 → exact; n > 13 → keep existing SA chain (unreachable at normal fleet sizes). Deterministic, same result every run.
- **Fixed-point pass:** new `lib/converge.js`, exported `convergeResult(result, opts)` replaces the worker's inline post-ILP block (per-route SA + single-customer regroup loop + final re-seq). Steepest-descent over three move types:
  - relocate one customer ri→rj (best insertion position),
  - swap one customer between ri and rj,
  - 2-opt* tail exchange between two routes.
  Guards: capacity strict, both routes keep qualifying (existing OR-predicate vol≥vMin || val≥pMin), min-trucks mode forbids emptying a route (truck count is pinned by stage-1 ILP and cannot improve). Gain epsilon 0.5 km (matches current code), max 12 rounds, stop when best round gain ≤ 0.5.
- **After every applied round:** exact re-sequence every route touched by the applied moves; if any route > 13 stops → SA fallback (`sequencing: 'annealed'` in proof).
- **Proof object:** `result.proof = { poolStatus, sequencing: 'exact'|'annealed', rounds, moved: km, neighborhood }`. Status = 'Optimal'/'Time limit reached' from HiGHS passes through.
- **Badge (UI):** footer gains a proof chip: `✔ Proven: route-pool ILP optimal − exact stop sequencing − 3 improvement rounds (−12.4 km)`; amber `⚠ Best found (solver time limit)` when poolStatus is time-limit. Value planned/vol untouched.
- **No data/export changes.** Export still writes post-converge km.

## Review focus

1. Determinism: same inputs → same routes every solve (DP + steepest descent, no RNG in Tier 1/3 path; only SA fallback uses fixed seeds).
2. Min-trucks mode must end with the same truck count as stage-1 ILP chose (never fewer, never over cap).
3. Qualify predicate after moves must match the existing OR-rule, not the LP's AND-vMin rule.
4. n > 13 must never hit the DP (memory blow-up) — fall back to SA.
5. Browser E2E must still show return-leg row, leg pills, 4-sheet export unchanged.

---

### Task 1: Exact sequencer `exactOrder`

**Files:** `lib/route-opt.js` (add export), `tests/exact-seq.test.mjs` (new).

- [ ] RED: brute-force permutation comparison — random symmetric dm fixtures, n = 2..6: `exactOrder` km ≤ every permutation's km; equal for concrete fixture with known optimum; n = 0/1 edge; returns `null`-safe for n > maxN param (test 14 → null).
- [ ] GREEN: Held–Karp DP with free end; `npm test` full pass.
- [ ] Commit.

### Task 2: Fixed-point converger `convergeResult`

**Files:** `lib/converge.js` (new), `tests/converge.test.mjs` (new).

- [ ] RED tests: (a) fixture where relocating a customer to a neighboring route reduces total km but requires swap-or-relocate (single-greedy loop must find it) → applied, converges; second call changes nothing (fixed point); (b) capacity guard: over-cap move never applied; (c) qualify guard: move that drops donor route below OR-predicate never applied; (d) min-trucks: move that would empty a route never applied, count preserved; (e) result.proof rounds/sequencing/fields present.
- [ ] GREEN: implement `convergeResult(result, { dm, cap, vMin, pMin, mode, maxRounds = 12 })` with exact re-sequence via `exactOrder` after each applied round (SA fallback → `sequencing:'annealed'`).
- [ ] `npm test` full pass. Commit.

### Task 3: Worker integration + proof badge

**Files:** `worker.js` (replace post-ILP block with converge call; add `result.proof`), `app.js` (footer chip + time-limit note), `index.html` (only if a chip span needs adding).

- [ ] Replace inline post-ILP optimization with `convergeResult` (import from lib/converge.js); delete dead inline loop code.
- [ ] Footer: proof chip text per Design decisions; ⚠ amber for time-limit poolStatus.
- [ ] Browser E2E on :8788: demo solve both modes — deterministic re-solve gives identical table twice; min-trucks truck count equals previous run's 5; badge renders; no console errors; export still 4 sheets.
- [ ] Commit, push.

### Task 4: README + ship

- [ ] README headline one-liner: proven within-pool optimality + exact sequencing badge.
- [ ] Full `npm test`, push, `gh run list` success, live check.
