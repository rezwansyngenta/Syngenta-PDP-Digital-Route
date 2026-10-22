/* Generate demo GPS master + orders Excel files (Bogura area) for browser verification. */
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const src = fs.readFileSync(fileURLToPath(new URL('../vendor/xlsx.full.min.js', import.meta.url)), 'utf8');
const run = new Function(`${src}\n;return (typeof XLSX !== 'undefined' ? XLSX : (globalThis.XLSX || XLSX_));`);
const XLSX = run();

const WH = { lat: 24.8480, lon: 89.3710 }; // Bogura
// 35 customers around Bogura in scattered clusters
const clusters = [
  [24.85, 89.37], [24.87, 89.40], [24.83, 89.33], [24.90, 89.45], [24.80, 89.42],
  [24.86, 89.30], [24.78, 89.35], [24.92, 89.37], [24.88, 89.50], [24.82, 89.47],
];
const names = ['Rahim Traders','Karim Store','Jamal Agency','Akash Enterprise','Nabila Store','Bogura Feed','Bismillah Traders','Meghna Agro','Titas Distribution','Shohag Store'];
const gps = [['BP ID','Customer Name','Address','Latitude','Longitude']];
const orders = [['BP ID','Order Value','Order Volume']];
gps.push(['', 'Warehouse', 'Warehouse, Bogura', WH.lat, WH.lon]);
let i = 0;
for (let c = 0; c < clusters.length; c++) {
  for (let k = 0; k < 4; k++) {
    i++;
    const bp = `BP${String(i).padStart(4, '0')}`;
    const jitter = () => (Math.random() - 0.5) * 0.03;
    const lat = clusters[c][0] + k * 0.008 + jitter() * 0.002;
    const lon = clusters[c][1] + k * 0.008 + jitter() * 0.002;
    gps.push([bp, `${names[i % names.length]} ${i}`, `Ward ${c + 1}, Bogura`, Number(lat.toFixed(6)), Number(lon.toFixed(6))]);
    // mix value-heavy, volume-heavy and tiny customers
    const val = i % 5 === 0 ? 800000 : i % 3 === 0 ? 2500000 : 14000000;
    const vol = i % 5 === 0 ? 9.5 : i % 3 === 0 ? 6 : 3.5;
    orders.push([bp, val, vol]);
  }
}
fs.mkdirSync('demo', { recursive: true });
const save = (wb, file) => fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(gps), 'GPS');
  save(wb, 'demo/gps.xlsx');
}
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(orders), 'Orders');
  save(wb, 'demo/orders.xlsx');
}
console.log(`demo files: ${gps.length - 1} customers`);
