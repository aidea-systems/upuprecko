import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';
export type { Polygon };

export type Status = 'owned' | 'negotiating' | 'not_owned' | 'no_data';
export const STATUSES: Status[] = ['owned', 'negotiating', 'not_owned', 'no_data'];

/**
 * What a plot is shown as. The same as its status, except that a plot that is not ours and belongs
 * wholly to the City of Zagreb is shown as "city" - worked out from the owners, never stored.
 */
export type DisplayStatus = Status | 'city';
export const DISPLAY_STATUSES: DisplayStatus[] = ['owned', 'negotiating', 'not_owned', 'city', 'no_data'];

export interface ZoneOverlap {
  zone: string;
  overlap_m2: number;
}

/** Properties of a feature in plots.geojson: one official cadastral parcel (areas in EPSG:3765). */
export interface PlotProps {
  id: string;
  plot_number: string | null;
  kind: 'plot' | 'review';
  candidates: string[];
  area_m2: number;
  area_in_upu_m2: number;
  zones: ZoneOverlap[];
  reason?: string;
  /** Area registered in the cadastre (whole m²); area_m2 is the area enclosed by the published borders. */
  registered_area_m2?: number;
  /** National cadastral reference, e.g. "339318-6353/1" (municipality code - plot number). */
  cadastral_ref?: string;
  /** Cadastral municipality (k.o.). */
  municipality?: string;
  /** Date since which the cadastre shows the parcel in this form. */
  valid_from?: string;
  /**
   * Parcel id used by the OSS services (oss.uredjenazemlja.hr); the number in the DGU feature id "CP.<id>".
   * Missing on shapes that are not an official parcel.
   */
  oss_parcel_id?: number;
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

/** What the land registry said about a plot the last time "Refresh ownership" checked it. */
export interface RegistryInfo {
  /** OSS parcel id the check was made with. */
  parcelId: number;
  /** ZK uložak number. */
  lrUnitNumber: string;
  mainBookId: number;
  /** Land-registry main book (glavna knjiga). */
  mainBookName: string;
  /** Last entry made in the unit ("Z-55014/2026"); null when the registry gave none. */
  lastDiaryNumber: string | null;
  /** File numbers of registrations pending at the time of the check (plombe). */
  activePlumbs: string[];
  checkedAt: string;
}

export interface PlotRecord {
  status: Status;
  owners: Owner[];
  /** Our share of the plot as entered ("1", "1/2", "50%"). Empty = not entered. */
  ourShare: string;
  contact: string;
  notes: string;
  updatedAt: string | null;
  /** Set by "Refresh ownership" when the plot was checked against the land registry; absent before that. */
  registry?: RegistryInfo;
}

export type Resolution =
  | { type: 'plot'; plotNumber: string; resolvedAt: string }
  | { type: 'not_plot'; resolvedAt: string };

/**
 * A user change to one map shape (keyed by feature id). The source GeoJSON is never modified;
 * these overrides are applied on load. Areas are recalculated in EPSG:3765 when the boundary changes.
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
  /**
   * When "Update" last went through every plot and its result was confirmed (even if nothing changed).
   * Absent until that has happened once.
   */
  registryCheckedAt?: string;
}
