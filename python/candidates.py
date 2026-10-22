#!/usr/bin/env python3
"""PDP Route Solver v2 — generate candidate routes for Set Covering ILP.

Three heuristic strategies + unassigned routes:
  1. Nearest-neighbour with random starts
  2. Farthest-seed clustering
  3. Volume-packing

Each candidate is pre-ordered with nearest-neighbour + 2-opt.
Only routes satisfying threshold (volume ≥ V_min - V_tol OR value ≥ P_min - P_tol) are kept.
"""
import json
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def dist(a, b, dist_matrix):
    """Distance between two location IDs."""
    key = "|".join(sorted((a, b)))
    return dist_matrix.get(key, 99999.0)


def route_distance(route, dist_matrix):
    """Total distance of a route (outbound: WH → c1 → c2 → ... → cn)."""
    wh = "WH"
    d = dist(wh, route[0], dist_matrix)
    for i in range(len(route) - 1):
        d += dist(route[i], route[i + 1], dist_matrix)
    return round(d, 2)


def two_opt(route, dist_matrix):
    """Improve route order with 2-opt swaps."""
    if len(route) < 3:
        return route
    improved = True
    best = route[:]
    while improved:
        improved = False
        for i in range(len(best) - 1):
            for j in range(i + 2, len(best)):
                new = best[:i + 1] + best[i + 1:j + 1][::-1] + best[j + 1:]
                if route_distance(new, dist_matrix) < route_distance(best, dist_matrix):
                    best = new
                    improved = True
    return best


def is_feasible(route_customers, cap_max, v_min, p_min, v_tol, p_tol):
    """Check if a set of customers meets threshold and capacity."""
    vol = sum(c["orderVolume"] for c in route_customers)
    val = sum(c["orderValue"] for c in route_customers)
    if vol > cap_max:
        return False
    if vol >= (v_min - v_tol) or val >= (p_min - p_tol):
        return True
    return False


def nn_random_starts(customers, dist_matrix, n_candidates, cap_max, v_min, p_min, v_tol, p_tol, seed=42):
    """Nearest-neighbour with random starts. Each start builds one route."""
    rng = random.Random(seed)
    cust_list = list(customers)
    candidates = []

    for _ in range(n_candidates):
        remaining = cust_list[:]
        rng.shuffle(remaining)
        route = []
        vol = 0.0
        val = 0.0

        # pick random seed
        seed_c = remaining.pop(0)
        route.append(seed_c["id"])
        vol += seed_c["orderVolume"]
        val += seed_c["orderValue"]

        # greedily add nearest feasible customer
        while remaining:
            last = route[-1]
            best_c = None
            best_d = float("inf")
            for c in remaining:
                new_vol = vol + c["orderVolume"]
                new_val = val + c["orderValue"]
                if new_vol > cap_max:
                    continue
                d = dist(last, c["id"], dist_matrix)
                if d < best_d:
                    best_d = d
                    best_c = c
            if best_c is None:
                break
            route.append(best_c["id"])
            vol += best_c["orderVolume"]
            val += best_c["orderValue"]
            remaining.remove(best_c)

        if len(route) >= 2:
            if is_feasible(
                [{"orderVolume": vol, "orderValue": val}], cap_max, v_min, p_min, v_tol, p_tol
            ):
                ordered = two_opt(route, dist_matrix)
                candidates.append(ordered)

    return candidates


def farthest_seed_clustering(customers, dist_matrix, k, cap_max, v_min, p_min, v_tol, p_tol):
    """Farthest-seed clustering: seed K routes, assign each customer to nearest feasible route."""
    cust_list = list(customers)
    if len(cust_list) < k:
        k = len(cust_list)

    # pick farthest-point seeds from warehouse
    def wh_dist(c):
        return dist("WH", c["id"], dist_matrix)

    seeded = sorted(cust_list, key=wh_dist, reverse=True)[:k]
    seeds = [c["id"] for c in seeded]

    # assign each customer to nearest seed's route
    routes = {s: [] for s in seeds}
    route_vol = {s: 0.0 for s in seeds}
    route_val = {s: 0.0 for s in seeds}

    assigned = set(seeds)
    for c in cust_list:
        if c["id"] in assigned:
            continue
        best_seed = None
        best_d = float("inf")
        for s in seeds:
            d = dist(c["id"], s, dist_matrix)
            if d < best_d:
                best_d = d
                best_seed = s
        routes[best_seed].append(c["id"])
        route_vol[best_seed] += c["orderVolume"]
        route_val[best_seed] += c["orderValue"]
        assigned.add(c["id"])

    # split oversized routes
    candidates = []
    for s in seeds:
        members = [s] + routes[s]
        vol = route_vol[s] + next(c["orderVolume"] for c in cust_list if c["id"] == s)
        val = route_val[s] + next(c["orderValue"] for c in cust_list if c["id"] == s)

        if vol <= cap_max and is_feasible(
            [{"orderVolume": vol, "orderValue": val}], cap_max, v_min, p_min, v_tol, p_tol
        ):
            ordered = two_opt(members, dist_matrix)
            candidates.append(ordered)
        elif len(members) > 1:
            # split into smaller groups
            for start in range(0, len(members), 3):
                chunk = members[start:start + 3]
                if len(chunk) >= 1:
                    chunk_vol = sum(
                        next(c["orderVolume"] for c in cust_list if c["id"] == cid)
                        for cid in chunk
                    )
                    chunk_val = sum(
                        next(c["orderValue"] for c in cust_list if c["id"] == cid)
                        for cid in chunk
                    )
                    if is_feasible(
                        [{"orderVolume": chunk_vol, "orderValue": chunk_val}],
                        cap_max, v_min, p_min, v_tol, p_tol
                    ):
                        ordered = two_opt(chunk, dist_matrix)
                        candidates.append(ordered)

    return candidates


def volume_packing(customers, dist_matrix, cap_max, v_min, p_min, v_tol, p_tol):
    """Greedily pack customers into routes by volume until threshold is met."""
    cust_list = sorted(customers, key=lambda c: c["orderVolume"], reverse=True)
    candidates = []
    used = set()

    for seed in cust_list:
        if seed["id"] in used:
            continue
        route = [seed["id"]]
        vol = seed["orderVolume"]
        val = seed["orderValue"]
        used.add(seed["id"])

        for c in cust_list:
            if c["id"] in used:
                continue
            new_vol = vol + c["orderVolume"]
            if new_vol > cap_max:
                continue
            route.append(c["id"])
            vol += c["orderVolume"]
            val += c["orderValue"]
            used.add(c["id"])
            if vol >= (v_min - v_tol) or val >= (p_min - p_tol):
                break

        if is_feasible(
            [{"orderVolume": vol, "orderValue": val}], cap_max, v_min, p_min, v_tol, p_tol
        ):
            ordered = two_opt(route, dist_matrix)
            candidates.append(ordered)

    return candidates


def pairing_heuristic(customers, dist_matrix, cap_max, v_min, p_min, v_tol, p_tol,
                      allow_triples=True):
    """Explicitly pair customers to meet threshold. Try all pairs, then triples."""
    candidates = []
    cust_list = list(customers)
    n = len(cust_list)

    # pairs
    for i in range(n):
        for j in range(i + 1, n):
            a, b = cust_list[i], cust_list[j]
            vol = a["orderVolume"] + b["orderVolume"]
            val = a["orderValue"] + b["orderValue"]
            if vol > cap_max:
                continue
            if vol >= (v_min - v_tol) or val >= (p_min - p_tol):
                route = two_opt([a["id"], b["id"]], dist_matrix)
                candidates.append(route)

    # triples (only if needed and allowed)
    if allow_triples and n <= 300:
        for i in range(n):
            for j in range(i + 1, n):
                for k in range(j + 1, n):
                    a, b, c = cust_list[i], cust_list[j], cust_list[k]
                    vol = a["orderVolume"] + b["orderVolume"] + c["orderVolume"]
                    val = a["orderValue"] + b["orderValue"] + c["orderValue"]
                    if vol > cap_max:
                        continue
                    if vol >= (v_min - v_tol) or val >= (p_min - p_tol):
                        route = two_opt([a["id"], b["id"], c["id"]], dist_matrix)
                        candidates.append(route)

    return candidates


def unassigned_routes(customers):
    """Single-customer routes for every customer (used for infeasible assignment)."""
    return [[c["id"]] for c in customers]


def generate_candidates(data, n_nn=500, n_clusters=50, cap_max=12.0,
                        v_min=12.0, p_min=10_000_000, v_tol=0.0, p_tol=0.0,
                        seed=42, max_triple_n=60):
    """Generate all candidate routes and deduplicate.

    Only ordered customers (positive MT or BDT) are considered; zero-zero
    rows excluded upstream by build_data (T1). Triples enumeration is capped
    at max_triple_n customers to avoid combinatorial blow-up on full-demand days.
    """
    customers = [c for c in data["customers"] if not c.get("excluded")]
    if "orderedIds" in data:
        keep = set(data["orderedIds"])
        customers = [c for c in customers if c["id"] in keep]
    dist_matrix = data["distMatrix"]

    candidates = []

    # 1. nearest-neighbour random starts
    candidates.extend(nn_random_starts(
        customers, dist_matrix, n_nn, cap_max, v_min, p_min, v_tol, p_tol, seed
    ))

    # 2. farthest-seed clustering (vary K)
    n_cust = len(customers)
    for k in range(max(3, n_cust // 20), max(4, n_cust // 5) + 1, max(1, n_cust // 20)):
        candidates.extend(farthest_seed_clustering(
            customers, dist_matrix, k, cap_max, v_min, p_min, v_tol, p_tol
        ))

    # 3. volume-packing
    candidates.extend(volume_packing(
        customers, dist_matrix, cap_max, v_min, p_min, v_tol, p_tol
    ))

    # 4. explicit pairing (all pairs + triples that meet threshold;
    #     triples capped to avoid blow-up on full-demand days)
    candidates.extend(pairing_heuristic(
        customers, dist_matrix, cap_max, v_min, p_min, v_tol, p_tol,
        allow_triples=len(customers) <= max_triple_n,
    ))

    # 5. unassigned (single-customer) routes
    candidates.extend(unassigned_routes(customers))

    # deduplicate (same set of customers = same route)
    seen = set()
    unique = []
    for c in candidates:
        key = frozenset(c)
        if key not in seen:
            seen.add(key)
            unique.append(c)

    # compute distances
    by_id = {cu["id"]: cu for cu in customers}
    result = []
    for route in unique:
        d = route_distance(route, dist_matrix)
        vol = sum(by_id.get(cid, {}).get("orderVolume", 0) for cid in route)
        val = sum(by_id.get(cid, {}).get("orderValue", 0) for cid in route)
        # a single-customer route that itself qualifies is a REAL route
        # (T2/T3); only non-qualifying singles are unassigned fallbacks
        single_ok = (len(route) == 1 and is_feasible(
            [{"orderVolume": vol, "orderValue": val}],
            cap_max, v_min, p_min, v_tol, p_tol))
        result.append({
            "route": route,
            "distance": d,
            "volume": round(vol, 2),
            "value": round(val, 2),
            "isUnassigned": len(route) == 1 and not single_ok,
        })

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python candidates.py <data.json> [output.json]")
        sys.exit(1)

    data_path = Path(sys.argv[1]).resolve()
    out_path = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else data_path.parent / "candidates.json"

    data = json.loads(data_path.read_text(encoding="utf-8"))
    candidates = generate_candidates(data)

    out_path.write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[candidates] generated {len(candidates)} candidate routes -> {out_path}")
