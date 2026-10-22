/* Excel rows -> planning dataset. Mirrors python/build_data.py. */

export class BuildError extends Error {
  constructor(msg) { super(msg); this.name = 'BuildError'; }
}

const check = (cond, msg) => { if (!cond) throw new BuildError(msg); };

const BD = { latMin: 20.0, latMax: 27.0, lonMin: 88.0, lonMax: 93.0 };

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBlank = (row) => !row || row.every((v) => v == null || String(v).trim() === '');

function findCol(headers, ...keywords) {
  for (let i = 0; i < headers.length; i++) {
    const hl = norm(headers[i]);
    if (keywords.every((k) => hl.includes(k))) return i;
  }
  return -1;
}

function inBangladesh(lat, lon) {
  return lat >= BD.latMin && lat <= BD.latMax && lon >= BD.lonMin && lon <= BD.lonMax;
}

/**
 * @param {any[][]} gpsRows    sheet rows (header first) from SheetJS header:1
 * @param {any[][]} ordersRows same for the orders sheet
 * @param {object} settings    settings.json values
 */
export function buildData(gpsRows, ordersRows, settings = {}) {
  check(Array.isArray(gpsRows) && gpsRows.length > 1, 'GPS master sheet has no data rows');
  check(Array.isArray(ordersRows) && ordersRows.length > 1, 'Orders sheet has no data rows');

  // ---------------- GPS master ----------------
  const hdr = (gpsRows[0] || []).map((c) => (c == null ? '' : String(c).trim()));
  const bpCol = findCol(hdr, 'bp');
  let nameCol = findCol(hdr, 'customer', 'name');
  if (nameCol < 0) nameCol = findCol(hdr, 'name');
  let addrCol = findCol(hdr, 'address');
  if (addrCol < 0) addrCol = findCol(hdr, 'location');
  const latCol = findCol(hdr, 'lat');
  const lonCol = findCol(hdr, 'lon');
  let idCol = findCol(hdr, 'location', 'id');
  if (idCol < 0) idCol = findCol(hdr, 'location');
  if (idCol >= 0 && latCol >= 0 && idCol === addrCol) idCol = -1;

  check(bpCol >= 0, `Cannot find a BP ID column in the GPS master. Headers: ${hdr.join(', ')}`);
  check(latCol >= 0, `Cannot find a Latitude column. Headers: ${hdr.join(', ')}`);
  check(lonCol >= 0, `Cannot find a Longitude column. Headers: ${hdr.join(', ')}`);

  const cell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');

  // An explicit override (typed in the UI) beats the GPS master row.
  const whOverride = settings.warehouse_override === true
    && isNum(settings.warehouse_lat) && isNum(settings.warehouse_lon);

  let warehouseFound = whOverride;
  let whName = settings.warehouse_name || '';
  let whLat = whOverride ? settings.warehouse_lat : (settings.warehouse_lat ?? null);
  let whLon = whOverride ? settings.warehouse_lon : (settings.warehouse_lon ?? null);

  const raw = [];
  const seen = new Set();
  const dupGps = [];

  for (const r of gpsRows.slice(1)) {
    if (isBlank(r)) continue;
    const nameVal = cell(r, nameCol);
    const bp = cell(r, bpCol);
    const lidHint = cell(r, idCol);

    const isWhRow = !bp && (nameVal.toLowerCase().includes('warehouse') || lidHint.toLowerCase() === 'wh');
    if (isWhRow) {
      if (!whOverride) {
        check(isNum(r[latCol]) && isNum(r[lonCol]),
          `Warehouse row "${nameVal}" has invalid coordinates (${r[latCol]}, ${r[lonCol]})`);
        whLat = r[latCol];
        whLon = r[lonCol];
        if (nameVal) whName = nameVal;
        warehouseFound = true;
      }
      continue;
    }
    if (!bp) continue;

    const lat = r[latCol];
    const lon = r[lonCol];
    check(isNum(lat) && isNum(lon), `GPS master: invalid coordinates for BP ${bp}`);
    check(inBangladesh(lat, lon),
      `GPS master: coordinates outside Bangladesh for BP ${bp} (${lat}, ${lon})`);
    if (seen.has(bp)) { dupGps.push(bp); continue; }
    seen.add(bp);
    raw.push({
      bp,
      name: nameVal,
      address: cell(r, addrCol),
      lat,
      lon,
    });
  }

  check(raw.length > 0, 'No customers found in the GPS master');
  if (!warehouseFound) whName = settings.warehouse_name || 'Warehouse';
  check(isNum(whLat) && isNum(whLon),
    'No warehouse coordinates: add a "Warehouse" row to the GPS master, or set warehouse_lat / warehouse_lon in settings.json');
  check(!(Math.abs(whLat) < 1e-9 && Math.abs(whLon) < 1e-9),
    'Warehouse coordinates are 0, 0: add a "Warehouse" row to the GPS master, or set warehouse_lat / warehouse_lon in settings.json');
  check(inBangladesh(whLat, whLon), `Warehouse coordinates outside Bangladesh (${whLat}, ${whLon})`);

  // ---------------- orders ----------------
  const ohdr = (ordersRows[0] || []).map((c) => (c == null ? '' : String(c).trim()));
  let obpCol = findCol(ohdr, 'bp');
  if (obpCol < 0) obpCol = findCol(ohdr, 'id');
  const ovalCol = findCol(ohdr, 'value');
  const ovolCol = findCol(ohdr, 'volume');
  let onameCol = findCol(ohdr, 'customer', 'name');
  if (onameCol < 0) onameCol = findCol(ohdr, 'name');

  check(obpCol >= 0, `Cannot find a BP ID column in the orders sheet. Headers: ${ohdr.join(', ')}`);
  check(ovalCol >= 0, `Cannot find an Order Value column. Headers: ${ohdr.join(', ')}`);
  check(ovolCol >= 0, `Cannot find an Order Volume column. Headers: ${ohdr.join(', ')}`);

  const orders = new Map();
  const dupOrders = [];
  for (const r of ordersRows.slice(1)) {
    if (isBlank(r)) continue;
    const bp = cell(r, obpCol);
    if (!bp) continue;
    const v = r[ovalCol], q = r[ovolCol];
    check(isNum(v) && v >= 0, `Orders: bad value for BP ${bp}`);
    check(isNum(q) && q >= 0, `Orders: bad volume for BP ${bp}`);
    const cname = cell(r, onameCol);
    const prev = orders.get(bp);
    if (prev) {
      prev.value += v; prev.volume += q;
      dupOrders.push(bp);
    } else {
      orders.set(bp, { value: v, volume: q, name: cname });
    }
  }
  check(orders.size > 0, 'No orders found');

  // ---------------- merge ----------------
  const customers = [];
  const orderedIds = [];
  let matched = 0;
  raw.forEach((cr, i) => {
    const id = `C${String(i + 1).padStart(3, '0')}`;
    const o = orders.get(cr.bp);
    const ov = o ? o.value : 0;
    const ovol = o ? o.volume : 0;
    if (o) {
      matched++;
      if (o.name) cr.name = o.name;
    }
    const excluded = ov <= 0 && ovol <= 0;
    customers.push({
      id,
      name: cr.name || cr.bp,
      bpId: cr.bp,
      address: cr.address,
      lat: cr.lat,
      lon: cr.lon,
      orderValue: ov,
      orderVolume: ovol,
      excluded,
    });
    if (!excluded) orderedIds.push(id);
  });
  check(matched > 0, 'No BP IDs matched between the GPS master and the orders sheet');

  const gpsBps = new Set(raw.map((c) => c.bp));
  const orderBps = new Set(orders.keys());
  const unmatchedGps = [...gpsBps].filter((b) => !orderBps.has(b));
  const unmatchedOrders = [...orderBps].filter((b) => !gpsBps.has(b));

  return {
    warehouse: { id: 'WH', name: whName, lat: whLat, lon: whLon },
    customers,
    orderedIds,
    meta: {
      totalCustomers: customers.length,
      matchedOrders: matched,
      orderedCount: orderedIds.length,
      excludedZeroZero: customers.length - orderedIds.length,
      duplicatesAggregated: [...new Set(dupOrders)],
      duplicateGpsRows: [...new Set(dupGps)],
      unmatchedGps,
      unmatchedOrders,
      warehouseFrom: warehouseFound ? 'gps' : 'settings',
    },
  };
}
