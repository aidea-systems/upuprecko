import { describe, expect, it } from 'vitest';
import type { OwnershipDoc, PlotProps, PlotRecord } from '../types';
import { computeOverall, computeZoneStats } from './zoneStats';
import { emptyDoc } from './ownership';

const plot = (id: string, zones: [string, number][], over: Partial<PlotProps> = {}): PlotProps => ({
  id,
  plot_number: id,
  kind: 'plot',
  candidates: [id],
  area_m2: zones.reduce((a, [, v]) => a + v, 0),
  area_in_upu_m2: zones.reduce((a, [, v]) => a + v, 0),
  zones: zones.map(([zone, overlap_m2]) => ({ zone, overlap_m2 })),
  ...over,
});
const review = (id: string, zones: [string, number][], candidates: string[] = []): PlotProps =>
  plot(id, zones, { plot_number: null, kind: 'review', candidates, reason: 'test' });
const rec = (r: Partial<PlotRecord>): PlotRecord => ({
  status: 'no_data', owners: [], ourShare: '', contact: '', notes: '', updatedAt: null, ...r,
});
const docWith = (plots: Record<string, Partial<PlotRecord>>, reviews: OwnershipDoc['reviews'] = {}): OwnershipDoc => ({
  ...emptyDoc(),
  plots: Object.fromEntries(Object.entries(plots).map(([k, v]) => [k, rec(v)])),
  reviews,
});

describe('percent owned per zone', () => {
  it('starts at 0 % with every plot as no data', () => {
    const s = computeZoneStats([plot('1', [['A', 100]]), plot('2', [['A', 300]])], emptyDoc(), ['A']);
    expect(s.A.pctArea).toBe(0);
    expect(s.A.pctCount).toBe(0);
    expect(s.A.statusCounts.no_data).toBe(2);
  });

  it('uses overlap area × our share divided by total overlap', () => {
    const f = [plot('1', [['A', 100]]), plot('2', [['A', 300]])];
    const s = computeZoneStats(f, docWith({ '1': { status: 'owned', ourShare: '1' } }), ['A']);
    expect(s.A.pctArea).toBeCloseTo(100 / 400);
    expect(s.A.pctCount).toBeCloseTo(1 / 2);
  });

  it('counts a plot split across two zones in each zone by its overlap', () => {
    // plot 1: 200 m² in A and 800 m² in B, fully ours. Plot 2: 600 m² in A, not ours. Plot 3: 200 m² in B, not ours.
    const f = [plot('1', [['A', 200], ['B', 800]]), plot('2', [['A', 600]]), plot('3', [['B', 200]])];
    const s = computeZoneStats(f, docWith({ '1': { status: 'owned', ourShare: '1' }, '2': { status: 'not_owned' } }), ['A', 'B']);
    expect(s.A.countedArea).toBe(800);
    expect(s.A.pctArea).toBeCloseTo(200 / 800);
    expect(s.B.countedArea).toBe(1000);
    expect(s.B.pctArea).toBeCloseTo(800 / 1000);
    expect(s.A.plotCount).toBe(2);
    expect(s.B.plotCount).toBe(2);
    expect(s.A.pctCount).toBeCloseTo(0.5);
    // totals: area adds up across zones, count uses distinct plots
    const all = computeOverall([s.A, s.B]);
    expect(all.pctArea).toBeCloseTo(1000 / 1800);
    expect(all.plotCount).toBe(3);
    expect(all.pctCount).toBeCloseTo(1 / 3);
  });

  it('weights a co-owned plot by our share', () => {
    const f = [plot('1', [['A', 400]]), plot('2', [['A', 600]])];
    const doc = docWith({
      '1': { status: 'negotiating', ourShare: '1/2', owners: [{ name: 'Us', share: '1/2' }, { name: 'Other', share: '1/2' }] },
      '2': { status: 'owned', ourShare: '1/3' },
    });
    const s = computeZoneStats(f, doc, ['A']);
    expect(s.A.ownedArea).toBeCloseTo(400 * 0.5 + 600 / 3);
    expect(s.A.pctArea).toBeCloseTo((200 + 200) / 1000);
    expect(s.A.pctCount).toBeCloseTo((0.5 + 1 / 3) / 2);
    // both are still not fully ours
    expect(s.A.notOwned.map((p) => p.plotNumber)).toEqual(['1', '2']);
  });

  it('treats status Owned without an entered share as 100 %', () => {
    const s = computeZoneStats([plot('1', [['A', 100]])], docWith({ '1': { status: 'owned' } }), ['A']);
    expect(s.A.pctArea).toBe(1);
    expect(s.A.plots[0].share.source).toBe('status');
  });

  it('excludes an unresolved review feature and reports its area', () => {
    const f = [plot('1', [['A', 300]]), review('REVIEW-1', [['A', 700]], ['1', '2'])];
    const s = computeZoneStats(f, docWith({ '1': { status: 'owned', ourShare: '1' } }), ['A']);
    expect(s.A.pctArea).toBe(1); // only plot 1 is counted
    expect(s.A.countedArea).toBe(300);
    expect(s.A.totalOverlap).toBe(1000);
    expect(s.A.excludedReview).toEqual({ area: 700, featureIds: ['REVIEW-1'] });
    expect(s.A.plotCount).toBe(1);
  });

  it('includes a review feature once it is assigned to a plot number', () => {
    const f = [plot('1', [['A', 300]]), review('REVIEW-1', [['A', 700]], ['1', '2'])];
    const doc = docWith({ '1': { status: 'owned', ourShare: '1' } }, { 'REVIEW-1': { type: 'plot', plotNumber: '2', resolvedAt: '' } });
    const s = computeZoneStats(f, doc, ['A']);
    expect(s.A.excludedReview.area).toBe(0);
    expect(s.A.pctArea).toBeCloseTo(300 / 1000);
    expect(s.A.plotCount).toBe(2);
  });

  it('merges a review piece into the plot it is assigned to', () => {
    const f = [plot('1', [['A', 300]]), review('REVIEW-1', [['A', 100]])];
    const doc = docWith({ '1': { status: 'owned' } }, { 'REVIEW-1': { type: 'plot', plotNumber: '1', resolvedAt: '' } });
    const s = computeZoneStats(f, doc, ['A']);
    expect(s.A.plotCount).toBe(1);
    expect(s.A.plots[0].overlap).toBe(400);
    expect(s.A.plots[0].featureIds).toEqual(['1', 'REVIEW-1']);
  });

  it('leaves a review feature marked "not a plot" out of the calculation', () => {
    const f = [plot('1', [['A', 300]]), review('REVIEW-1', [['A', 50]])];
    const doc = docWith({ '1': { status: 'owned' } }, { 'REVIEW-1': { type: 'not_plot', resolvedAt: '' } });
    const s = computeZoneStats(f, doc, ['A']);
    expect(s.A.pctArea).toBe(1);
    expect(s.A.excludedReview.area).toBe(0);
    expect(s.A.notPlotArea).toBe(50);
  });

  it('returns null (not 0) for a zone containing only unresolved review features', () => {
    const s = computeZoneStats([review('REVIEW-1', [['A', 100]])], emptyDoc(), ['A', 'B']);
    expect(s.A.pctArea).toBeNull();
    expect(s.A.pctCount).toBeNull();
    expect(s.B.pctArea).toBeNull();
  });
});
