# PDP Digital Route

A zero-install, view-only route planner for Syngenta PDP distribution. Upload the customer GPS master and order file, choose Min km or Min trucks, and get every optimized route on the clean map at once - with per-leg km on select, filters, Google Maps links, and 4-sheet Excel export.

Distances come from a bundled coordinate-keyed road matrix (`data/road_matrix_coord.json` - anonymous `lat,lon|lat,lon` pairs only, no customer IDs or names) with OSRM/haversine fallback for uncovered coordinates.

## Live app

Published via GitHub Pages from the repo root: `https://<owner>.github.io/<repo>/`

## Quick start

1. Open the published page.
2. Upload the **GPS master** and **Order** Excel files.
3. Set PDP thresholds (value Cr / volume MT), truck capacity, and **Optimise for**: **Min km** or **Min trucks**.
4. Click **Solve Routes**.
5. Filter routes/customers, click a route for leg km + stop details, open it in Google Maps, then **Export** (Route Summary, Route Stops, Google Maps Links, Unassigned).

Capacity is strict: no route exceeds the truck capacity; oversized single orders are reported as unassigned with a reason.

If the warehouse isn't present as a row in the GPS master, type `lat, lon` in **Warehouse override**. Otherwise coordinates come from a row named `Warehouse` / `Bogura Warehouse` or a `Location ID` of `WH`.

## Files

```
lib/ + index.html, app.js, worker.js, worker assets   Published static app (GitHub Pages, repo root)
data/road_matrix_coord.json                           Anonymous coordinate-keyed road-km matrix
scripts/make-coord-matrix.mjs                         Regenerates the matrix from a local OSRM data.json
.github/workflows/pages.yml
```

## Settings

Edit `settings.json` to change the OSRM endpoint (`osrm_endpoint`), block size (`osrm_table_chunk`), or defaults. Distances prefer the bundled coordinate matrix (`prefer_local_matrix` + `local_matrix_path`); uncovered coordinate pairs fall back to OSRM (IndexedDB-cached), then haversine.

## Parity

Browser and Python solvers share the same algorithms (CPython MT19937 RNG, identical candidate generation, HiGHS ILP, SA stop ordering). Results are validated against the same inputs.

## Offline/legacy fallback

`python/` contains the original Flask app and a PyInstaller entry for an `.exe` build when a local install is required.

## Privacy

All processing happens locally in your browser tab. Your Excel files are never uploaded.
