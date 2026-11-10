import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoundaryFC, PlotsFC, ZonesFC } from '../types';
import { buildAreaContext, measure, ringSelfIntersects } from './area';

// the prepared source data, next to the app folder
const dir = join(__dirname, '..', '..', '..', 'upu-precko-zapad-map-data');
const read = <T,>(f: string): T => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const plots = read<PlotsFC>('plots.geojson');
const zones = read<ZonesFC>('zones.geojson');
const boundary = read<BoundaryFC>('boundary.geojson');
const ctx = buildAreaContext(
  zones.features.map((f) => ({ zone: f.properties.zone, geometry: f.geometry })),
  boundary.features.map((f) => f.geometry),
);

describe('area recalculation for edited boundaries', () => {
  // Coordinates are stored with 7 decimals (~1 cm). On long thin strips that rounding alone
  // changes the area by up to ~1 m² (same with pyproj), so allow 1 m².
  const tol = (_a: number) => 1.0;

  it('reproduces area_m2 and area_in_upu_m2 of every original shape', () => {
    for (const f of plots.features) {
      const m = measure(f.geometry, ctx);
      expect(Math.abs(m.area_m2 - f.properties.area_m2), f.properties.id).toBeLessThanOrEqual(tol(f.properties.area_m2));
      expect(Math.abs(m.area_in_upu_m2 - f.properties.area_in_upu_m2), f.properties.id).toBeLessThanOrEqual(tol(f.properties.area_m2));
    }
  });

  it('reproduces the zone overlaps of every original shape', () => {
    for (const f of plots.features) {
      const m = measure(f.geometry, ctx);
      const got = Object.fromEntries(m.zones.map((z) => [z.zone, z.overlap_m2]));
      for (const z of f.properties.zones) {
        if (z.overlap_m2 < 1) continue;
        expect(Math.abs((got[z.zone] ?? 0) - z.overlap_m2), `${f.properties.id} ${z.zone}`).toBeLessThanOrEqual(tol(z.overlap_m2));
      }
    }
  });

  it('detects a self-crossing ring', () => {
    expect(ringSelfIntersects([[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]])).toBe(true);
    expect(ringSelfIntersects([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]])).toBe(false);
  });
});
