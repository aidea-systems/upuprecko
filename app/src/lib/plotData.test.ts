import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlotsFC } from '../types';

const dir = join(__dirname, '..', '..', '..', 'upu-precko-zapad-map-data');
const plots: PlotsFC = JSON.parse(readFileSync(join(dir, 'plots.geojson'), 'utf8'));
const official: { features: { properties: { ref: string; gml_id: string } }[] } = JSON.parse(
  readFileSync(join(dir, 'official', 'cadastre_parcels_EPSG3765.geojson'), 'utf8'),
);

describe('OSS parcel id of every plot', () => {
  it('is a distinct whole number on every plot', () => {
    const ids = plots.features.map((f) => f.properties.oss_parcel_id);
    for (const [i, id] of ids.entries()) expect(Number.isInteger(id) && id! > 0, plots.features[i].properties.id).toBe(true);
    expect(new Set(ids).size).toBe(plots.features.length);
  });

  it('is the number in the DGU feature id of the same official parcel', () => {
    const gml = new Map(official.features.map((f) => [f.properties.ref, f.properties.gml_id]));
    for (const f of plots.features) expect(`CP.${f.properties.oss_parcel_id}`, f.properties.id).toBe(gml.get(f.properties.cadastral_ref!));
  });

  it('gives 41106113 for plot 6356/1 in Donje Vrapče (339318) - the id checked by hand against OSS', () => {
    const p = plots.features.find((f) => f.properties.cadastral_ref === '339318-6356/1')!.properties;
    expect(p.oss_parcel_id).toBe(41106113);
  });
});
