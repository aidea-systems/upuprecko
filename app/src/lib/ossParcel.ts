/**
 * What /api/oss-parcel returns for one cadastral parcel: the land-registry (ZK) unit it belongs to and
 * the owners in ownership sheet B. Shared by the server function and the browser; this file must not
 * import anything, so the server function stays small.
 */

export interface OssOwner {
  name: string;
  /** OIB (11 digits) when the land registry gives one. */
  oib?: string;
}

export interface OssShare {
  /** The fraction in the description, e.g. "1790/2803"; null when the description has none. */
  share: string | null;
  /** The description as the land registry gives it, e.g. "1. Suvlasnički dio: 1790/2803". */
  rawDescription: string;
  /** true when the share has sub-shares or entries that name a person (for example a predbilježba). */
  hasSubShares: boolean;
  /** Number of plain remarks (zabilježba) on the share that name nobody; they do not change the owner. */
  annotations: number;
  owners: OssOwner[];
}

export interface OssLrUnit {
  /** ZK uložak number. */
  number: string;
  mainBookId: number;
  /** Land-registry main book (glavna knjiga), e.g. "DONJE VRAPČE". */
  mainBookName: string;
  /** Last entry made in the unit, e.g. "Z-55014/2026"; null when the registry gives none. */
  lastDiaryNumber: string | null;
  condominiums: boolean;
  verificated: boolean;
  /** File numbers of pending registrations (plombe), e.g. ["Z-55230/2026"]. */
  activePlumbs: string[];
}

export interface OssParcelResult {
  parcelId: number;
  parcelNumber: string;
  /** Cadastral municipality code, e.g. "339318". */
  municipalityRegNum: string;
  /** Area in the cadastre (m²). */
  registeredArea: number | null;
  /** true when the cadastre and the land registry are harmonised for this parcel. */
  isHarmonized: boolean;
  /** null when the cadastre links the parcel to no land-registry unit. */
  lrUnit: OssLrUnit | null;
  shares: OssShare[];
}

/**
 * The fraction after the colon of a share description:
 * "1. Suvlasnički dio: 1790/2803" → "1790/2803", "4. Vlasnički dio: 1/1" → "1/1".
 * null when there is no fraction there (e.g. "Suvlasnički dio s neodređenim omjerom ETAŽNO VLASNIŠTVO (E-1)").
 */
export function parseShare(description: string | null | undefined): string | null {
  const m = /:\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(description ?? '');
  if (!m || /^0+$/.test(m[2])) return null;
  return `${m[1]}/${m[2]}`;
}
