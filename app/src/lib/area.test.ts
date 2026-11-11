import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoundaryFC, PlotsFC, ZonesFC } from '../types';
import { buildAreaContext, measure, projectGeometry, ringSelfIntersects } from './area';

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
  // Coordinates are stored with 9 decimals (0.1 mm); stored areas are rounded to 0.1 m².
  const tol = (_a: number) => 0.2;

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

describe('plots are the official cadastral parcels', () => {
  interface Official {
    features: { properties: { label: string; registered_area_m2: number }; geometry: { type: string; coordinates: number[][][] } }[];
  }
  const official = read<Official>('official/cadastre_parcels_EPSG3765.geojson');
  const byLabel = new Map(official.features.map((f) => [f.properties.label, f]));

  it('has one shape per parcel, under its official number', () => {
    const ids = plots.features.map((f) => f.properties.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of plots.features) {
      expect(f.properties.kind).toBe('plot');
      expect(f.properties.plot_number).toBe(f.properties.id);
      expect(byLabel.has(f.properties.id), f.properties.id).toBe(true);
    }
  });

  it('every corner is the published coordinate (EPSG:3765) to within 1 mm', () => {
    let worst = 0;
    for (const f of plots.features) {
      const src = byLabel.get(f.properties.id)!;
      expect(f.geometry.type).toBe('Polygon');
      const mine = projectGeometry(f.geometry)[0];
      expect(mine.length, f.properties.id).toBe(src.geometry.coordinates.length);
      mine.forEach((ring, r) => {
        expect(ring.length, f.properties.id).toBe(src.geometry.coordinates[r].length);
        ring.forEach(([x, y], i) => {
          const [ox, oy] = src.geometry.coordinates[r][i];
          worst = Math.max(worst, Math.abs(x - ox), Math.abs(y - oy));
        });
      });
      expect(f.properties.registered_area_m2).toBe(src.properties.registered_area_m2);
    }
    expect(worst).toBeLessThan(0.001);
  });
});

