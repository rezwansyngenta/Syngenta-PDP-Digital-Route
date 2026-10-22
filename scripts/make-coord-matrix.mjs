#!/usr/bin/env node
/* Generate data/road_matrix_coord.json from a local (outside-repo) id-keyed
 * data.json + its id→coordinates, so the repo ships only anonymous
 * coordinate-pair road km. Run: node scripts/make-coord-matrix.mjs [source.json] */
import { readFileSync, writeFileSync } from 'node:fs';
import { round6, coordPairKey } from '../lib/road-distance.js';

const DEFAULT_SRC = 'C:/Users/s1408765/OneDrive - Syngenta/Work/Warehouse Project/PDP/PDP-Software/data/data.json';
const src = process.argv[2] || DEFAULT_SRC;

const data = JSON.parse(readFileSync(src, 'utf8'));
const coordById = new Map();
coordById.set(data.warehouse.id, [data.warehouse.lat, data.warehouse.lon]);
for (const c of data.customers) coordById.set(c.id, [c.lat, c.lon]);

const distances = {};
const dm = data.distMatrix; // id-keyed sorted pairs "A|B", symmetric km
for (const [key, km] of Object.entries(dm)) {
  const [ida, idb] = key.split('|');
  const ca = coordById.get(ida);
  const cb = coordById.get(idb);
  if (!ca || !cb) { console.error(`missing coords for ${key}`); process.exit(1); }
  distances[coordPairKey(ca, cb)] = km;
}

const out = { _version: 3, distances };
const dst = new URL('../data/road_matrix_coord.json', import.meta.url);
writeFileSync(dst, JSON.stringify(out));
console.log(`wrote ${Object.keys(distances).length} coordinate pairs to ${dst.pathname}`);
