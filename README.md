# PDP Digital Route

A zero-install route planner for Syngenta PDP distribution. Runs entirely in the browser — upload the customer GPS master and order file, set thresholds and truck capacity, and get optimized routes with road distances, a map, and Excel export.

## Live app

Published via GitHub Pages from the `web/` folder. After first deploy: `https://<owner>.github.io/<repo>/`

## Quick start (browser)

1. Open the published page.
2. Upload **Customer Location** (`.xlsx`/`.xls`) and **Customer Order** (`.xlsx`/`.xls`).
3. Set **PDP value threshold (Cr BDT)**, **PDP volume threshold (MT)**, and **Truck capacity (MT)**.
4. Click **Solve Routes**.
5. Inspect routes on the map, adjust individually, and **Export to Excel**.

If the warehouse isn't present as a row in the GPS master, type `lat, lon` in **Warehouse override**. Otherwise coordinates come from a row named `Warehouse` / `Bogura Warehouse` or a `Location ID` of `WH`.

## Files

```
web/        Published static app (GitHub Pages)
python/     Original desktop/server sources and fix reference
.github/workflows/pages.yml
```

## Settings

Edit `web/settings.json` to change the OSRM endpoint (`osrm_endpoint`), block size (`osrm_table_chunk`), or defaults. Route distances use the OSRM demo service by default and are cached in your browser (IndexedDB) by coordinate pair.

## Parity

Browser and Python solvers share the same algorithms (CPython MT19937 RNG, identical candidate generation, HiGHS ILP, SA stop ordering). Results are validated against the same inputs.

## Offline/legacy fallback

`python/` contains the original Flask app and a PyInstaller entry for an `.exe` build when a local install is required.

## Privacy

All processing happens locally in your browser tab. Your Excel files are never uploaded.
