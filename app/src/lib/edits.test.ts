import { describe, expect, it } from 'vitest';
import type { PlotProps, PlotRecord } from '../types';
import { applyEdits, checkRename, emptyRecord, normalizeDoc } from './ownership';
import { computeZoneStats } from './zoneStats';

const plot = (id: string, zones: [string, number][] = [['A', 100]]): PlotProps => ({
  id, plot_number: id, kind: 'plot', candidates: [id], area_m2: 100, area_in_upu_m2: 100,
  zones: zones.map(([zone, overlap_m2]) => ({ zone, overlap_m2 })),
});
const square = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
const rec = (r: Partial<PlotRecord>): PlotRecord => ({ ...emptyRecord(), ...r });
const numberOf = (p: PlotProps) => p.plot_number;

describe('plot number edits', () => {
  const feats = [plot('1'), plot('2'), plot('3')];

  it('moves the ownership record when the old number is no longer used', () => {
    const r = checkRename(feats, { plots: { '1': rec({ status: 'owned' }) } }, '1', '1', '9', numberOf);
    expect(r).toEqual({ ok: true, merge: false, moveRecord: true });
  });

  it('refuses when both numbers already have ownership data', () => {
    const r = checkRename(feats, { plots: { '1': rec({}), '9': rec({}) } }, '1', '1', '9', numberOf);
    expect(r.ok).toBe(false);
  });

  it('reports a merge when the new number is used by another shape', () => {
    const r = checkRename(feats, { plots: {} }, '1', '1', '2', numberOf);
    expect(r).toEqual({ ok: true, merge: true, moveRecord: false });
  });

  it('rejects an empty number', () => {
    expect(checkRename(feats, { plots: {} }, '1', '1', '', numberOf).ok).toBe(false);
  });

  it('applies the new number so calculations follow it', () => {
    const edited = applyEdits(feats.map((p) => ({ properties: p, geometry: square })), { '1': { plotNumber: '9', editedAt: '' } });
    expect(edited[0].properties.plot_number).toBe('9');
    const s = computeZoneStats(edited.map((f) => f.properties), { plots: { '9': rec({ status: 'owned' }) }, reviews: {} }, ['A']);
    expect(s.A.plots.map((p) => p.plotNumber)).toEqual(['2', '3', '9']);
    expect(s.A.pctArea).toBeCloseTo(1 / 3);
  });
});

describe('boundary edits', () => {
  it('replaces geometry, areas and zone overlaps; source objects are untouched', () => {
    const src = [{ properties: plot('1', [['A', 100]]), geometry: square }];
    const moved = { type: 'Polygon' as const, coordinates: [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]] };
    const out = applyEdits(src, {
      '1': { geometry: moved, area_m2: 200, area_in_upu_m2: 180, zones: [{ zone: 'A', overlap_m2: 120 }, { zone: 'B', overlap_m2: 60 }], editedAt: 'x' },
    });
    expect(out[0].geometry).toBe(moved);
    expect(out[0].properties.area_m2).toBe(200);
    expect(out[0].properties.zones).toHaveLength(2);
    expect(src[0].properties.area_m2).toBe(100);
    const s = computeZoneStats(out.map((f) => f.properties), { plots: { '1': rec({ status: 'owned' }) }, reviews: {} }, ['A', 'B']);
    expect(s.A.countedArea).toBe(120);
    expect(s.B.countedArea).toBe(60);
  });

  it('loads edits from a saved document and drops invalid ones', () => {
    const doc = normalizeDoc({
      version: 1,
      plots: {},
      reviews: {},
      edits: {
        a: { plotNumber: ' 77 ', editedAt: 't' },
        b: { geometry: square, area_m2: 5, area_in_upu_m2: 5, zones: [], editedAt: 't' },
        c: { geometry: { type: 'Point', coordinates: [0, 0] }, editedAt: 't' },
      },
    });
    expect(doc.edits.a.plotNumber).toBe('77');
    expect(doc.edits.b.area_m2).toBe(5);
    expect(doc.edits.c).toBeUndefined();
  });

  it('accepts older documents without edits', () => {
    expect(normalizeDoc({ version: 1, plots: {}, reviews: {} }).edits).toEqual({});
  });
});
