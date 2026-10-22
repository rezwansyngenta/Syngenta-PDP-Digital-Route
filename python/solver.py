#!/usr/bin/env python3
"""PDP Route Solver v2 — Set Covering ILP solver.

Selects minimum-cost set of candidate routes that covers all customers.
Uses PuLP with CBC solver.

Input: data.json + candidates.json
Output: routes.json
"""
import json
import sys
import time
from pathlib import Path

import pulp

ROOT = Path(__file__).resolve().parent
PENALTY = 10_000.0  # large constant for unassigned routes


def qualify(volume, value, v_min=12.0, p_min=10_000_000):
    """Qualification label: Value / Volume / Both (T2-T4)."""
    by_vol = volume >= v_min - 1e-9
    by_val = value >= p_min - 1e-9
    if by_vol and by_val:
        return "Both"
    if by_vol:
        return "Volume"
    if by_val:
        return "Value"
    return "Below"


def solve(data, candidates, cap_max=12.0, v_min=12.0, p_min=10_000_000):
    """Run Set Covering ILP and return selected routes + unassigned."""
    customers = data["customers"]
    if "orderedIds" in data:
        keep = set(data["orderedIds"])
        customers = [c for c in customers if c["id"] in keep]
    else:
        customers = [c for c in customers if not c.get("excluded")]
    cust_ids = {c["id"] for c in customers}
    wh = data["warehouse"]

    # build customer-to-candidate index
    cust_to_routes = {cid: [] for cid in cust_ids}
    for idx, cand in enumerate(candidates):
        for cid in cand["route"]:
            if cid in cust_to_routes:
                cust_to_routes[cid].append(idx)

    # create ILP
    prob = pulp.LpProblem("RouteCovering", pulp.LpMinimize)

    # decision variables: y[s] = 1 if candidate s is selected
    y = {}
    for idx, cand in enumerate(candidates):
        y[idx] = pulp.LpVariable(f"y_{idx}", cat=pulp.LpBinary)

    # objective: minimize total distance + penalty for unassigned
    prob += pulp.lpSum(
        cand["distance"] * y[idx] + (PENALTY if cand["isUnassigned"] else 0) * y[idx]
        for idx, cand in enumerate(candidates)
    )

    # constraints: each customer covered by exactly one selected route
    for cid in cust_ids:
        route_indices = cust_to_routes[cid]
        prob += pulp.lpSum(y[idx] for idx in route_indices) == 1, f"cover_{cid}"

    # solve
    import sys
    from pathlib import Path
    cbc_path = None
    if getattr(sys, "frozen", False):
        cand = Path(sys._MEIPASS) / "solverdir" / "cbc" / "win" / "i64" / "cbc.exe"
        if cand.exists():
            cbc_path = str(cand)
    if cbc_path:
        solver = pulp.COIN_CMD(msg=False, timeLimit=60, path=cbc_path)
    else:
        solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=60)
    start = time.time()
    prob.solve(solver)
    solve_time = round(time.time() - start, 2)

    # extract results
    selected_routes = []
    unassigned = []
    cust_lookup = {c["id"]: c for c in customers}

    for idx, cand in enumerate(candidates):
        if y[idx].varValue and y[idx].varValue > 0.5:
            if cand["isUnassigned"]:
                cid = cand["route"][0]
                c = cust_lookup.get(cid, {})
                if c.get("orderVolume", 0) > cap_max:
                    reason = f"Single order {c['orderVolume']:.1f}MT exceeds truck capacity {cap_max}MT"
                else:
                    reason = "No feasible qualifying route found"
                unassigned.append({"customerId": cid, "reason": reason})
            else:
                selected_routes.append(cand)

    # enrich routes with customer details + qualification label (T2-T4)
    for route in selected_routes:
        enriched = []
        for cid in route["route"]:
            c = cust_lookup.get(cid, {})
            enriched.append({
                "id": cid,
                "name": c.get("name", ""),
                "bpId": c.get("bpId", ""),
                "orderVolume": c.get("orderVolume", 0),
                "orderValue": c.get("orderValue", 0),
            })
        route["customers"] = enriched
        route["qualifiesBy"] = qualify(route["volume"], route["value"], v_min, p_min)
        route["utilisation"] = round(route["volume"] / cap_max, 3) if cap_max else 0
        del route["isUnassigned"]

    result = {
        "status": pulp.LpStatus[prob.status],
        "objectiveValue": round(pulp.value(prob.objective), 2) if prob.status == pulp.constants.LpStatusOptimal else None,
        "solveTime": solve_time,
        "routeCount": len(selected_routes),
        "unassignedCount": len(unassigned),
        "totalDistance": round(sum(r["distance"] for r in selected_routes), 2),
        "routes": selected_routes,
        "unassigned": unassigned,
        "solverInfo": {
            "solver": "CBC",
            "candidateCount": len(candidates),
            "penalty": PENALTY,
        },
    }

    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python solver.py <data.json> <candidates.json> [output.json]")
        sys.exit(1)

    data_path = Path(sys.argv[1]).resolve()
    cand_path = Path(sys.argv[2]).resolve()
    out_path = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else ROOT / "output" / "routes.json"

    data = json.loads(data_path.read_text(encoding="utf-8"))
    candidates = json.loads(cand_path.read_text(encoding="utf-8"))

    print(f"[solver] {len(data['customers'])} customers, {len(candidates)} candidates")
    result = solve(data, candidates)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[solver] status: {result['status']}")
    print(f"[solver] routes: {result['routeCount']}, unassigned: {result['unassignedCount']}")
    print(f"[solver] total distance: {result['totalDistance']} km")
    print(f"[solver] solve time: {result['solveTime']}s")
    print(f"[solver] wrote {out_path}")
