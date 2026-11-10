// Copies the prepared GeoJSON from ../upu-precko-zapad-map-data into public/data
// and makes sure data/ownership.json exists (the ownership file kept in the repo).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(app, '..', 'upu-precko-zapad-map-data');
const dst = path.join(app, 'public', 'data');

await fs.mkdir(dst, { recursive: true });
for (const f of ['plots.geojson', 'zones.geojson', 'boundary.geojson', 'review.json', 'roads.geojson', 'road_lines.geojson', 'road_labels.geojson']) {
  await fs.copyFile(path.join(src, f), path.join(dst, f));
}

const own = path.join(app, 'data', 'ownership.json');
try {
  await fs.access(own);
} catch {
  await fs.mkdir(path.dirname(own), { recursive: true });
  await fs.writeFile(own, JSON.stringify({ version: 1, savedAt: null, plots: {}, reviews: {} }, null, 2) + '\n');
}
// read-only seed for static builds without the local file API
await fs.copyFile(own, path.join(dst, 'ownership.seed.json'));
console.log('data synced to public/data');
