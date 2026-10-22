#!/usr/bin/env python3
"""Road-distance matrix builder.

Supports:
- Google Maps Distance Matrix API (exact, needs API key + billing).
- OSRM public table service (real road km, no key, best-effort).
- Haversine straight-line fallback.

Distances are returned keyed by location-id pair ("A|B", sorted) but cached by
coordinate pair, so one cache file is safe to reuse across warehouses or files
whose ids are assigned positionally (C001, C002, ...).
"""
import json
import math
import time
import urllib3
from pathlib import Path

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CACHE_VERSION = 3
COORD_DECIMALS = 6


def hav(lat1, lon1, lat2, lon2):
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def _key(a, b):
    return "|".join(sorted((a, b)))


def _coord_key(a, b, coord):
    """Order-independent cache key from rounded coordinates."""
    pa = (round(coord[a][0], COORD_DECIMALS), round(coord[a][1], COORD_DECIMALS))
    pb = (round(coord[b][0], COORD_DECIMALS), round(coord[b][1], COORD_DECIMALS))
    if pb < pa:
        pa, pb = pb, pa
    return f"{pa[0]},{pa[1]}|{pb[0]},{pb[1]}"


def load_cache(cache_path):
    p = Path(cache_path)
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        if raw.get("_version") != CACHE_VERSION:
            return {}
        return raw.get("distances", {})
    except Exception:
        return {}


def save_cache(cache_path, distances, coord):
    """Write the matrix, re-keying id pairs onto coordinate pairs."""
    by_coord = {}
    for k, v in distances.items():
        if v is None:
            continue
        a, sep, b = k.partition("|")
        if not sep or a not in coord or b not in coord:
            continue
        by_coord[_coord_key(a, b, coord)] = v
    p = Path(cache_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"_version": CACHE_VERSION, "distances": by_coord},
                           ensure_ascii=False), encoding="utf-8")


def _init_distances(locations):
    ids = [loc["id"] for loc in locations]
    coord = {loc["id"]: (float(loc["lat"]), float(loc["lon"])) for loc in locations}
    distances = {}
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            distances[_key(ids[i], ids[j])] = None
    return ids, coord, distances


def _seed_from_cache(cache_path, ids, coord, distances):
    """Fill still-missing pairs from the coordinate-keyed cache."""
    if not cache_path:
        return 0
    cached = load_cache(cache_path)
    if not cached:
        return 0
    hits = 0
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            k = _key(ids[i], ids[j])
            if distances.get(k) is not None:
                continue
            v = cached.get(_coord_key(ids[i], ids[j], coord))
            if v is not None:
                distances[k] = v
                hits += 1
    return hits


def _have_all(distances):
    return all(v is not None for v in distances.values())


def build_matrix_google(locations, api_key="", cache_path=None, chunk=10, sleep=0.2):
    ids, coord, distances = _init_distances(locations)
    _seed_from_cache(cache_path, ids, coord, distances)

    used_api = False
    if api_key and not _have_all(distances):
        try:
            import googlemaps
            gmaps = googlemaps.Client(key=api_key)
            try:
                gmaps.requests_kwargs["verify"] = False
            except Exception:
                pass
            for oi in range(0, len(ids), chunk):
                for di in range(0, len(ids), chunk):
                    origins = ids[oi:oi + chunk]
                    dests = ids[di:di + chunk]
                    block_missing = False
                    for o in origins:
                        for d in dests:
                            if o == d:
                                continue
                            if distances.get(_key(o, d)) is None:
                                block_missing = True
                                break
                        if block_missing:
                            break
                    if not block_missing:
                        continue
                    origin_coords = [coord[o] for o in origins]
                    dest_coords = [coord[d] for d in dests]
                    try:
                        res = gmaps.distance_matrix(origin_coords, dest_coords,
                                                    mode="driving", units="metric")
                        rows = res.get("rows", [])
                        for ri, row in enumerate(rows):
                            for ci, el in enumerate(row.get("elements", [])):
                                o = origins[ri]
                                d = dests[ci]
                                if o == d:
                                    continue
                                if el.get("status") == "OK" and "distance" in el:
                                    distances[_key(o, d)] = round(el["distance"]["value"] / 1000.0, 2)
                                    used_api = True
                    except Exception:
                        pass
                    time.sleep(sleep)
        except Exception:
            pass

    used_osrm = _fill_osrm(locations, distances)
    _fill_haversine(ids, coord, distances)

    if used_api:
        source = "google maps (driving km)"
    elif used_osrm:
        source = "osrm (driving km)"
    else:
        source = "haversine (straight-line km)"

    if cache_path:
        save_cache(cache_path, distances, coord)
    return distances, source


def _fill_haversine(ids, coord, distances):
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            k = _key(ids[i], ids[j])
            if distances.get(k) is None:
                a, b = ids[i], ids[j]
                distances[k] = round(hav(coord[a][0], coord[a][1],
                                         coord[b][0], coord[b][1]), 2)


def _fill_osrm(locations, distances):
    """Fill missing pairs via OSRM table service. Returns True if anything was used."""
    import requests
    ids = [loc["id"] for loc in locations]
    coord = {loc["id"]: (float(loc["lat"]), float(loc["lon"])) for loc in locations}
    # unordered pairs only: compare by index, never by id ordering ("WH" sorts last)
    missing_pairs = [(ids[i], ids[j]) for i in range(len(ids))
                     for j in range(i + 1, len(ids))
                     if distances.get(_key(ids[i], ids[j])) is None]
    if not missing_pairs:
        return False
    chunk_size = 50
    chunks = [ids[i:i + chunk_size] for i in range(0, len(ids), chunk_size)]
    used = False
    for ci, chunk_a in enumerate(chunks):
        for cj in range(ci, len(chunks)):
            chunk_b = chunks[cj]
            union = chunk_a + [x for x in chunk_b if x not in chunk_a]
            if len(union) > 100:
                continue
            # 6-decimal coords keep OSRM snapping identical to the browser build
            coord_str = ";".join(f"{coord[x][1]:.6f},{coord[x][0]:.6f}" for x in union)
            url = f"http://router.project-osrm.org/table/v1/driving/{coord_str}?annotations=distance"
            try:
                try:
                    r = requests.get(url, timeout=120)
                except requests.exceptions.SSLError:
                    # corporate TLS interception: retry without verification
                    r = requests.get(url, timeout=120, verify=False)
                if r.status_code != 200:
                    continue
                data = r.json()
                if data.get("code") != "Ok" or not data.get("distances"):
                    continue
                mat = data["distances"]
                idx = {loc: i for i, loc in enumerate(union)}
                for a in chunk_a:
                    for b in chunk_b:
                        if a == b:
                            continue
                        k = _key(a, b)
                        if distances.get(k) is not None:
                            continue
                        d = mat[idx[a]][idx[b]]
                        if d is None:
                            continue
                        distances[k] = round(d / 1000.0, 2)
                        used = True
            except Exception:
                pass
            time.sleep(1.0)
    return used


def build_matrix_osrm(locations, cache_path=None):
    ids, coord, distances = _init_distances(locations)
    _seed_from_cache(cache_path, ids, coord, distances)
    used_osrm = _fill_osrm(locations, distances)
    _fill_haversine(ids, coord, distances)
    source = "osrm (driving km)" if used_osrm else "haversine (straight-line km)"
    if cache_path:
        save_cache(cache_path, distances, coord)
    return distances, source


def build_matrix(locations, api_key="", cache_path=None):
    """Backwards-compatible entry point."""
    if api_key:
        return build_matrix_google(locations, api_key=api_key, cache_path=cache_path)
    return build_matrix_osrm(locations, cache_path=cache_path)
