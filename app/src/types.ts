import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';
export type { Polygon };

export type Status = 'owned' | 'negotiating' | 'not_owned' | 'no_data';
export const STATUSES: Status[] = ['owned', 'negotiating', 'not_owned', 'no_data'];

export interface ZoneOverlap {
  zone: string;
  overlap_m2: number;
}

/** Properties of a feature in plots.geojson (areas come from the projected source data). */
export interface PlotProps {
  id: string;
  plot_number: string | null;
  kind: 'plot' | 'review';
  candidates: string[];
  area_m2: number;
  area_in_upu_m2: number;
  zones: ZoneOverlap[];
  reason?: string;
}

export interface ZoneProps {
  zone: string;
  landuse_code: string;
  landuse_hr?: string;
  landuse_en?: string;
  area_m2: number;
  playground?: string;
}

export type PlotGeometry = Polygon | MultiPolygon;
export type PlotsFC = FeatureCollection<PlotGeometry, PlotProps>;
export type ZonesFC = FeatureCollection<PlotGeometry, ZoneProps>;
export type BoundaryFC = FeatureCollection<PlotGeometry, { name?: string; area_m2?: number }>;

export interface Owner {
  name: string;
  /** Fraction as entered, e.g. "1/2", "0.5" or "50%". */
  share: string;
}

export interface PlotRecord {
  status: Status;
  owners: Owner[];
  /** Our share of the plot as entered ("1", "1/2", "50%"). Empty = not entered. */
  ourShare: string;
  contact: string;
  notes: string;
  updatedAt: string | null;
}

export type Resolution =
  | { type: 'plot'; plotNumber: string; resolvedAt: string }
  | { type: 'not_plot'; resolvedAt: string };

/**
 * A user change to one map shape (keyed by feature id). The source GeoJSON is never modified;
 * these overrides are applied on load. Areas are recalculated in EPSG:3907 when the boundary changes.
 */
export interface FeatureEdit {
  plotNumber?: string;
  geometry?: Polygon;
  area_m2?: number;
  area_in_upu_m2?: number;
  zones?: ZoneOverlap[];
  editedAt: string;
}

/** Everything the user enters. Keyed by plot number (plots), review feature id (reviews), feature id (edits). */
export interface OwnershipDoc {
  version: 1;
  savedAt: string | null;
  plots: Record<string, PlotRecord>;
  reviews: Record<string, Resolution>;
  edits: Record<string, FeatureEdit>;
}
