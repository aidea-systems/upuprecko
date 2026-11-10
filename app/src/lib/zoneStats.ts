import type { OwnershipDoc, PlotProps, Status } from '../types';
import { effectiveShare, getRecord, type EffectiveShare } from './ownership';

export type FeatureResolution =
  | { kind: 'plot'; plotNumber: string; fromReview: boolean }
  | { kind: 'unresolved' }
  | { kind: 'not_plot' };

/** What a map feature counts as, given the user's review resolutions. */
export function resolveFeature(p: PlotProps, reviews: OwnershipDoc['reviews']): FeatureResolution {
  if (p.kind === 'plot' && p.plot_number) return { kind: 'plot', plotNumber: p.plot_number, fromReview: false };
  const r = reviews[p.id];
  if (!r) return { kind: 'unresolved' };
  if (r.type === 'not_plot') return { kind: 'not_plot' };
  return { kind: 'plot', plotNumber: r.plotNumber, fromReview: true };
}

export interface ZonePlotEntry {
  plotNumber: string;
  /** Sum of overlap_m2 of all features with this plot number inside the zone. */
  overlap: number;
  featureIds: string[];
  status: Status;
  share: EffectiveShare;
}

export interface ZoneStats {
  zone: string;
  /** All overlap area in the zone, including review shapes and roads. */
  totalOverlap: number;
  /** Overlap area of resolved plots — the denominator for % by area. */
  countedArea: number;
  /** Σ overlap × our share. */
  ownedArea: number;
  pctArea: number | null;
  plotCount: number;
  /** Σ our share over plots (a half-owned plot counts 0.5). */
  ownedCount: number;
  pctCount: number | null;
  statusCounts: Record<Status, number>;
  excludedReview: { area: number; featureIds: string[] };
  notPlotArea: number;
  plots: ZonePlotEntry[];
  notOwned: ZonePlotEntry[];
}

const emptyStats = (zone: string): ZoneStats => ({
  zone,
  totalOverlap: 0,
  countedArea: 0,
  ownedArea: 0,
  pctArea: null,
  plotCount: 0,
  ownedCount: 0,
  pctCount: null,
  statusCounts: { owned: 0, negotiating: 0, not_owned: 0, no_data: 0 },
  excludedReview: { area: 0, featureIds: [] },
  notPlotArea: 0,
  plots: [],
  notOwned: [],
});

/**
 * Percent owned per zone.
 *  by area:  Σ(overlap_m2 × our share) / Σ overlap_m2   over resolved plots in the zone
 *  by count: Σ(our share) / number of plots              over resolved plots in the zone
 * A plot crossing zones counts in each zone with its overlap there. Unresolved review
 * shapes are left out of both and reported in excludedReview; shapes marked "not a plot"
 * are left out and reported in notPlotArea.
 */
export function computeZoneStats(
  features: PlotProps[],
  doc: Pick<OwnershipDoc, 'plots' | 'reviews'>,
  zoneNames: string[],
): Record<string, ZoneStats> {
  const out: Record<string, ZoneStats> = {};
  for (const z of zoneNames) out[z] = emptyStats(z);
  const byZone: Record<string, Map<string, { overlap: number; featureIds: string[] }>> = {};

  for (const f of features) {
    const res = resolveFeature(f, doc.reviews);
    for (const { zone, overlap_m2 } of f.zones) {
      if (!(overlap_m2 > 0)) continue;
      const s = (out[zone] ??= emptyStats(zone));
      s.totalOverlap += overlap_m2;
      if (res.kind === 'unresolved') {
        s.excludedReview.area += overlap_m2;
        s.excludedReview.featureIds.push(f.id);
      } else if (res.kind === 'not_plot') {
        s.notPlotArea += overlap_m2;
      } else {
        const m = (byZone[zone] ??= new Map());
        const e = m.get(res.plotNumber) ?? { overlap: 0, featureIds: [] };
        e.overlap += overlap_m2;
        e.featureIds.push(f.id);
        m.set(res.plotNumber, e);
      }
    }
  }

  for (const [zone, m] of Object.entries(byZone)) {
    const s = out[zone];
    for (const [plotNumber, e] of m) {
      const rec = getRecord(doc, plotNumber);
      const share = effectiveShare(doc.plots[plotNumber]);
      const entry: ZonePlotEntry = { plotNumber, overlap: e.overlap, featureIds: e.featureIds, status: rec.status, share };
      s.plots.push(entry);
      s.countedArea += e.overlap;
      s.ownedArea += e.overlap * share.value;
      s.plotCount += 1;
      s.ownedCount += share.value;
      s.statusCounts[rec.status] += 1;
    }
    s.plots.sort((a, b) => a.plotNumber.localeCompare(b.plotNumber, undefined, { numeric: true }));
    s.notOwned = s.plots.filter((p) => p.share.value < 1);
  }

  for (const s of Object.values(out)) {
    s.pctArea = s.countedArea > 0 ? s.ownedArea / s.countedArea : null;
    s.pctCount = s.plotCount > 0 ? s.ownedCount / s.plotCount : null;
  }
  return out;
}

/** Totals over all zones. Area adds up (zones do not overlap); count uses distinct plot numbers. */
export function computeOverall(stats: ZoneStats[]) {
  let countedArea = 0;
  let ownedArea = 0;
  let excluded = 0;
  const shares = new Map<string, number>();
  for (const s of stats) {
    countedArea += s.countedArea;
    ownedArea += s.ownedArea;
    excluded += s.excludedReview.area;
    for (const p of s.plots) shares.set(p.plotNumber, p.share.value);
  }
  const n = shares.size;
  const owned = [...shares.values()].reduce((a, b) => a + b, 0);
  return {
    countedArea,
    ownedArea,
    excludedReviewArea: excluded,
    plotCount: n,
    pctArea: countedArea > 0 ? ownedArea / countedArea : null,
    pctCount: n > 0 ? owned / n : null,
  };
}
