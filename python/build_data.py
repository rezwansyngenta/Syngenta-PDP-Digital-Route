#!/usr/bin/env python3
"""PDP v2 — build data.json from two Excel files (GPS master + orders).

Distance matrix is built with Google Maps (exact road km) via road_distance,
with Haversine fallback. No pre-computed distance Excel required.
"""
import json
import math
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent

# Default warehouse coordinates (origin). Override via settings.json, GPS master (row with Location ID == "WH"), or function args.
def _load_settings():
    try:
        s = json.loads((Path(__file__).resolve().parent / "settings.json").read_text(encoding="utf-8"))
        return {
            "name": s.get("warehouse_name") or "Warehouse",
            "lat": float(s.get("warehouse_lat") or 0.0),
            "lon": float(s.get("warehouse_lon") or 0.0),
        }
    except Exception:
        return {"name": "Warehouse", "lat": 0.0, "lon": 0.0}

DEFAULT_WH = _load_settings()


class BuildError(RuntimeError):
    pass


def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check(cond, msg):
    if not cond:
        raise BuildError(f"[build_data] FAIL: {msg}")


def _norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _find_col(headers, *keywords):
    """Return index of first header containing all keywords (case-insensitive)."""
    for i, h in enumerate(headers):
        hl = _norm(h)
        if all(k in hl for k in keywords):
            return i
    return None


def build(gps_xlsx, orders_xlsx, out_dir=None, api_key="", cache_path=None,
          wh_lat=None, wh_lon=None):
    GPS_XLSX = Path(gps_xlsx).resolve()
    ORDERS_XLSX = Path(orders_xlsx).resolve()
    check(GPS_XLSX.exists(), f"gps master file not found: {GPS_XLSX}")
    check(ORDERS_XLSX.exists(), f"orders file not found: {ORDERS_XLSX}")

    # ---------------- GPS master ----------------
    wb_gps = openpyxl.load_workbook(GPS_XLSX, data_only=True)
    check(len(wb_gps.sheetnames) > 0, "gps master workbook is empty")
    ws = wb_gps[wb_gps.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    check(len(rows) > 1, "gps master has no data rows")

    hdr = [str(c).strip() if c is not None else "" for c in rows[0]]
    bp_col = _find_col(hdr, "bp")
    name_col = _find_col(hdr, "customer", "name")
    if name_col is None:
        name_col = _find_col(hdr, "name")
    addr_col = _find_col(hdr, "address")
    if addr_col is None:
        addr_col = _find_col(hdr, "location")
    lat_col = _find_col(hdr, "lat")
    lon_col = _find_col(hdr, "lon")
    id_col = _find_col(hdr, "location", "id")
    if id_col is None:
        id_col = _find_col(hdr, "location")
    # avoid confusing location-id with address/location text
    if id_col is not None and lat_col is not None and id_col == addr_col:
        id_col = None

    check(bp_col is not None, f"cannot find BP ID column in GPS master; headers: {hdr}")
    check(lat_col is not None, f"cannot find Latitude column; headers: {hdr}")
    check(lon_col is not None, f"cannot find Longitude column; headers: {hdr}")

    customers_raw = []
    seen_bp = set()
    warehouse_found = False
    wh_name = DEFAULT_WH["name"]
    wh_lat = DEFAULT_WH["lat"] if wh_lat is None else wh_lat
    wh_lon = DEFAULT_WH["lon"] if wh_lon is None else wh_lon
    for r in rows[1:]:
        if all(v is None or str(v).strip() == "" for v in r):
            continue
        name_val = str(r[name_col]).strip() if (name_col is not None and r[name_col] is not None) else ""
        bp = str(r[bp_col]).strip() if r[bp_col] is not None else ""
        lid_hint = str(r[id_col]).strip() if (id_col is not None and r[id_col] is not None) else ""
        is_wh_row = (not bp) and ("warehouse" in name_val.lower() or lid_hint.lower() == "wh")
        if is_wh_row:
            check(num(r[lat_col]) and num(r[lon_col]),
                  f"warehouse row '{name_val}' has invalid coordinates ({r[lat_col]}, {r[lon_col]})")
            wh_lat = float(r[lat_col])
            wh_lon = float(r[lon_col])
            wh_name = name_val or wh_name
            warehouse_found = True
            continue
        if not bp:
            continue
        lat = r[lat_col]
        lon = r[lon_col]
        check(num(lat) and num(lon), f"GPS master: invalid coords for BP {bp}")
        check(20.0 <= lat <= 27.0 and 88.0 <= lon <= 93.0,
              f"GPS master: coords outside Bangladesh for BP {bp} ({lat}, {lon})")
        name = str(r[name_col]).strip() if (name_col is not None and r[name_col] is not None) else ""
        addr = str(r[addr_col]).strip() if (addr_col is not None and r[addr_col] is not None) else ""
        lid = lid_hint
        if bp in seen_bp:
            # duplicate BP: skip (or could aggregate; keep first)
            continue
        seen_bp.add(bp)
        customers_raw.append({"bp": bp, "name": name, "address": addr,
                             "lat": float(lat), "lon": float(lon), "lid_hint": lid})

    check(len(customers_raw) > 0, "no customers in GPS master")

    # warehouse: a GPS master row wins; settings.json is only the fallback
    if not warehouse_found:
        wh_name = DEFAULT_WH["name"]
    check(wh_lat is not None and wh_lon is not None,
          "no warehouse coordinates: add a 'Warehouse' row to the GPS master "
          "or set warehouse_lat / warehouse_lon in settings.json")
    check(not (abs(wh_lat) < 1e-9 and abs(wh_lon) < 1e-9),
          "warehouse coordinates are 0, 0: add a 'Warehouse' row to the GPS master "
          "or set warehouse_lat / warehouse_lon in settings.json")
    check(20.0 <= wh_lat <= 27.0 and 88.0 <= wh_lon <= 93.0,
          f"warehouse coords outside Bangladesh ({wh_lat}, {wh_lon})")

    # ---------------- Orders ----------------
    wb_orders = openpyxl.load_workbook(ORDERS_XLSX, data_only=True)
    check(len(wb_orders.sheetnames) > 0, "orders workbook is empty")
    ows = wb_orders[wb_orders.sheetnames[0]]
    orows = list(ows.iter_rows(values_only=True))
    check(len(orows) > 1, "orders file has no data rows")
    ohdr = [str(c).strip() if c is not None else "" for c in orows[0]]

    obp_col = _find_col(ohdr, "bp")
    if obp_col is None:
        obp_col = _find_col(ohdr, "id")
    oval_col = _find_col(ohdr, "value")
    ovol_col = _find_col(ohdr, "volume")
    oname_col = _find_col(ohdr, "customer", "name")
    if oname_col is None:
        oname_col = _find_col(ohdr, "name")

    check(obp_col is not None, f"cannot find BP ID column in orders; headers: {ohdr}")
    check(oval_col is not None, f"cannot find Order Value column; headers: {ohdr}")
    check(ovol_col is not None, f"cannot find Order Volume column; headers: {ohdr}")

    orders = {}
    dup_log = []
    for r in orows[1:]:
        if all(v is None or str(v).strip() == "" for v in r):
            continue
        bp = str(r[obp_col]).strip() if r[obp_col] is not None else ""
        if not bp:
            continue
        raw_val, raw_vol = r[oval_col], r[ovol_col]
        check(num(raw_val) and raw_val >= 0, f"orders: bad value for BP {bp}")
        check(num(raw_vol) and raw_vol >= 0, f"orders: bad volume for BP {bp}")
        val, vol = float(raw_val), float(raw_vol)
        cname = str(r[oname_col]).strip() if (oname_col is not None and r[oname_col] is not None) else ""
        if bp in orders:
            orders[bp]["value"] += val
            orders[bp]["volume"] += vol
            dup_log.append(bp)
        else:
            orders[bp] = {"value": val, "volume": vol, "name": cname}
    check(len(orders) > 0, "no orders")

    # ---------------- merge ----------------
    bp_set_orders = set(orders)
    bp_set_gps = {c["bp"] for c in customers_raw}

    matched = 0
    customers = {}
    ordered_ids = []
    all_ids = ["WH"] + [f"C{i+1:03d}" for i in range(len(customers_raw))]
    # assign location ids
    for i, cr in enumerate(customers_raw):
        lid = f"C{i+1:03d}"
        bp = cr["bp"]
        o = orders.get(bp)
        if o is not None:
            ov, ovol = o["value"], o["volume"]
            matched += 1
            if o["name"]:
                cr["name"] = o["name"]
        else:
            ov, ovol = 0.0, 0.0
        excluded = (ov <= 0 and ovol <= 0)
        customers[lid] = {
            "id": lid, "name": cr["name"] or bp, "bpId": bp,
            "address": cr["address"], "lat": cr["lat"], "lon": cr["lon"],
            "orderValue": ov, "orderVolume": ovol, "excluded": excluded,
        }
        if not excluded:
            ordered_ids.append(lid)

    check(matched > 0, "no BPs matched between GPS master and orders")

    # ---------------- distance matrix via Google Maps ----------------
    import road_distance as rd
    locs = [{"id": "WH", "lat": wh_lat, "lon": wh_lon}] + \
           [{"id": lid, "lat": customers[lid]["lat"], "lon": customers[lid]["lon"]}
            for lid in customers]
    cache_path = cache_path or (Path(out_dir or ROOT / "data") / "road_matrix_cache.json")
    distances, source = rd.build_matrix(locs, api_key=api_key,
                                       cache_path=str(cache_path))
    # convert to tuple-keyed style already string keys; build_data expects dict with "A|B" keys (string)
    # rd returns string keys "A|B". Good.

    # strict-ish: all ordered pairs must exist (they do, via fallback)
    # geography summary
    wh_km = sorted(distances.get(f"WH|{lid}", distances.get(f"{lid}|WH", 99999))
                   for lid in customers)
    geo = {
        "minKm": round(wh_km[0], 1) if wh_km else 0,
        "medianKm": round(wh_km[len(wh_km) // 2], 1) if wh_km else 0,
        "maxKm": round(wh_km[-1], 1) if wh_km else 0,
    }

    warehouse = {"id": "WH", "name": wh_name, "lat": wh_lat, "lon": wh_lon}

    data = {
        "warehouse": warehouse,
        "customers": list(customers.values()),
        "distMatrix": distances,
        "geo": geo,
        "orderedIds": sorted(ordered_ids),
        "meta": {
            "sourceGps": GPS_XLSX.name,
            "sourceOrders": ORDERS_XLSX.name,
            "totalCustomers": len(customers),
            "matchedOrders": matched,
            "orderedCount": len(ordered_ids),
            "excludedZeroZero": len(customers) - len(ordered_ids),
            "duplicatesAggregated": sorted(set(dup_log)),
            "strictDistances": True,
            "distanceSource": source,
            "distanceWarning": f"Distance basis: {source}.",
        },
    }

    out_dir = Path(out_dir) if out_dir else ROOT / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "data.json"
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[build_data] wrote {out_path}")
    print(f"[build_data] {len(customers)} customers, matched {matched}, ordered {len(ordered_ids)}, distance source: {source}")
    unmatched_gps = sorted(bp_set_gps - bp_set_orders)
    unmatched_orders = sorted(bp_set_orders - bp_set_gps)
    if unmatched_gps:
        print(f"[build_data] WARNING: {len(unmatched_gps)} GPS BPs with no orders: {unmatched_gps[:5]}")
    if unmatched_orders:
        print(f"[build_data] WARNING: {len(unmatched_orders)} order BPs with no GPS: {unmatched_orders[:5]}")
    return data


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python build_data.py <gps-master.xlsx> <orders.xlsx> [api_key]")
        sys.exit(1)
    api_key = sys.argv[3] if len(sys.argv) > 3 else ""
    try:
        build(sys.argv[1], sys.argv[2], api_key=api_key)
    except BuildError as e:
        print(str(e))
        sys.exit(1)
