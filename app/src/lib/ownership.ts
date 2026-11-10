import type { FeatureEdit, Owner, OwnershipDoc, PlotGeometry, PlotProps, PlotRecord, Resolution, Status } from '../types';
import { STATUSES } from '../types';
import { addFrac, formatFrac, isOne, parseFraction, toNumber, type Frac } from './fraction';
import { strings as t } from '../i18n/strings';
import { config } from '../config';

export const emptyDoc = (): OwnershipDoc => ({ version: 1, savedAt: null, plots: {}, reviews: {}, edits: {} });

export const emptyRecord = (): PlotRecord => ({
  status: 'no_data',
  owners: [],
  ourShare: '',
  contact: '',
  notes: '',
  updatedAt: null,
});

export function getRecord(doc: Pick<OwnershipDoc, 'plots'>, plotNumber: string): PlotRecord {
  return doc.plots[plotNumber] ?? emptyRecord();
}

export interface EffectiveShare {
  value: number;
  /** explicit = from "our share"; status = Owned with no share entered; none = nothing entered; invalid = unparseable */
  source: 'explicit' | 'status' | 'none' | 'invalid';
}

/** Our share (0..1) used in percent-owned calculations. */
export function effectiveShare(rec: PlotRecord | undefined): EffectiveShare {
  if (!rec) return { value: 0, source: 'none' };
  if (rec.ourShare.trim()) {
    const f = parseFraction(rec.ourShare);
    if (!f) return { value: 0, source: 'invalid' };
    const v = toNumber(f);
    return v >= 0 && v <= 1 ? { value: v, source: 'explicit' } : { value: 0, source: 'invalid' };
  }
  if (rec.status === 'owned') return { value: 1, source: 'status' };
  return { value: 0, source: 'none' };
}

/** Owner name compared without regard to upper/lower case or extra spaces. */
export const ownerKey = (name: string) => name.normalize('NFC').toLocaleUpperCase('hr').replace(/\s+/g, ' ').trim();

export function isOurOwner(name: string, ours: string[] = config.ourOwners): boolean {
  const k = ownerKey(name);
  return !!k && ours.some((p) => k.startsWith(ownerKey(p)));
}

/**
 * Merges rows of the same owner (case-insensitive) into one, adding their shares exactly.
 * Rows whose share cannot be read are kept as they are, so nothing is lost.
 */
export function mergeOwners(owners: Owner[]): Owner[] {
  const out: Owner[] = [];
  const sums = new Map<string, { idx: number; sum: Frac }>();
  for (const o of owners) {
    const k = ownerKey(o.name);
    const f = parseFraction(o.share);
    const prev = k ? sums.get(k) : undefined;
    if (prev && f) {
      prev.sum = addFrac(prev.sum, f);
      out[prev.idx] = { name: out[prev.idx].name, share: formatFrac(prev.sum) };
    } else {
      out.push({ name: o.name, share: o.share });
      if (k && f && !prev) sums.set(k, { idx: out.length - 1, sum: f });
    }
  }
  return out;
}

/** Our share from the owner list (sum of our owners' shares), or null if one of our shares is unreadable. */
export function ourShareFromOwners(owners: Owner[]): string | null {
  let sum: Frac = { n: 0n, d: 1n };
  for (const o of owners) {
    if (!isOurOwner(o.name)) continue;
    const f = parseFraction(o.share);
    if (!f) return null;
    sum = addFrac(sum, f);
  }
  return formatFrac(sum);
}

export interface ShareCheck {
  /** true when there is nothing to check or the shares sum to exactly 1 */
  ok: boolean;
  sum: Frac | null;
  sumText: string;
  invalid: string[];
}

export function checkOwnerShares(owners: Owner[]): ShareCheck {
  const used = owners.filter((o) => o.name.trim() || o.share.trim());
  if (used.length === 0) return { ok: true, sum: null, sumText: '', invalid: [] };
  let sum: Frac = { n: 0n, d: 1n };
  const invalid: string[] = [];
  for (const o of used) {
    const f = parseFraction(o.share);
    if (!f) invalid.push(o.share || '(empty)');
    else sum = addFrac(sum, f);
  }
  return { ok: invalid.length === 0 && isOne(sum), sum, sumText: formatFrac(sum), invalid };
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z]/g, '');

const STATUS_ALIASES: Record<Status, string[]> = {
  owned: ['owned', 'own', 'ours', 'vlasnistvo', 'uvlasnistvu', 'nase', 'kupljeno'],
  negotiating: ['negotiating', 'negotiation', 'pregovori', 'upregovorima', 'pregovara'],
  not_owned: ['notowned', 'nijeuvlasnistvu', 'nijenase', 'tude'],
  no_data: ['nodata', 'nemapodataka', 'unknown', 'nepoznato'],
};

/** Parses status text in English or Croatian. Empty → null (caller decides). Unknown → undefined. */
export function parseStatus(v: string): Status | null | undefined {
  const n = norm(v);
  if (!n) return null;
  for (const s of STATUSES) {
    if (STATUS_ALIASES[s].includes(n) || norm(t.status[s]) === n) return s;
  }
  return undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates/fills an ownership document read from file, storage or an import. */
export function normalizeDoc(raw: unknown): OwnershipDoc {
  if (!isObj(raw) || raw.version !== 1) throw new Error('not an ownership document (version 1)');
  const doc = emptyDoc();
  doc.savedAt = typeof raw.savedAt === 'string' ? raw.savedAt : null;
  if (isObj(raw.plots)) {
    for (const [pn, r] of Object.entries(raw.plots)) {
      if (!isObj(r)) continue;
      const status = STATUSES.includes(r.status as Status) ? (r.status as Status) : 'no_data';
      const owners = Array.isArray(r.owners)
        ? r.owners.filter(isObj).map((o) => ({ name: String(o.name ?? ''), share: String(o.share ?? '') }))
        : [];
      doc.plots[pn] = {
        status,
        owners,
        ourShare: String(r.ourShare ?? ''),
        contact: String(r.contact ?? ''),
        notes: String(r.notes ?? ''),
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
      };
    }
  }
  if (isObj(raw.reviews)) {
    for (const [id, r] of Object.entries(raw.reviews)) {
      if (!isObj(r)) continue;
      const at = typeof r.resolvedAt === 'string' ? r.resolvedAt : new Date(0).toISOString();
      if (r.type === 'not_plot') doc.reviews[id] = { type: 'not_plot', resolvedAt: at };
      else if (r.type === 'plot' && typeof r.plotNumber === 'string' && r.plotNumber.trim())
        doc.reviews[id] = { type: 'plot', plotNumber: r.plotNumber.trim(), resolvedAt: at } as Resolution;
    }
  }
  if (isObj(raw.edits)) {
    for (const [id, e] of Object.entries(raw.edits)) {
      if (!isObj(e)) continue;
      const edit: FeatureEdit = { editedAt: typeof e.editedAt === 'string' ? e.editedAt : new Date(0).toISOString() };
      if (typeof e.plotNumber === 'string' && e.plotNumber.trim()) edit.plotNumber = e.plotNumber.trim();
      const g = e.geometry as { type?: unknown; coordinates?: unknown } | undefined;
      if (isObj(g) && g.type === 'Polygon' && Array.isArray(g.coordinates) && typeof e.area_m2 === 'number') {
        edit.geometry = g as unknown as FeatureEdit['geometry'];
        edit.area_m2 = e.area_m2;
        edit.area_in_upu_m2 = typeof e.area_in_upu_m2 === 'number' ? e.area_in_upu_m2 : e.area_m2;
        edit.zones = Array.isArray(e.zones)
          ? e.zones.filter(isObj).map((z) => ({ zone: String(z.zone), overlap_m2: Number(z.overlap_m2) || 0 }))
          : [];
      }
      if (edit.plotNumber || edit.geometry) doc.edits[id] = edit;
    }
  }
  return doc;
}

/** Applies plot-number and boundary edits to the source features (returns new objects). */
export function applyEdits<F extends { properties: PlotProps; geometry: PlotGeometry }>(features: F[], edits: OwnershipDoc['edits']): F[] {
  return features.map((f) => {
    const e = edits[f.properties.id];
    if (!e) return f;
    const props: PlotProps = { ...f.properties };
    if (e.plotNumber && props.kind === 'plot') props.plot_number = e.plotNumber;
    if (e.geometry) {
      props.area_m2 = e.area_m2 ?? props.area_m2;
      props.area_in_upu_m2 = e.area_in_upu_m2 ?? props.area_in_upu_m2;
      props.zones = e.zones ?? props.zones;
    }
    return { ...f, properties: props, geometry: e.geometry ?? f.geometry };
  });
}

export type RenameCheck =
  | { ok: true; merge: boolean; moveRecord: boolean }
  | { ok: false; error: string };

/**
 * Can feature `featureId` change its plot number from `from` to `to`?
 * - The ownership record moves with the number if no other shape keeps the old number.
 * - If both numbers already have ownership data, refuse (nothing is overwritten).
 * - If another shape already uses `to`, both shapes become one plot (merge = true).
 */
export function checkRename(
  features: PlotProps[],
  doc: Pick<OwnershipDoc, 'plots'>,
  featureId: string,
  from: string,
  to: string,
  plotNumberOf: (p: PlotProps) => string | null,
): RenameCheck {
  if (!to) return { ok: false, error: t.plot.numberEmpty };
  if (to === from) return { ok: true, merge: false, moveRecord: false };
  const others = features.filter((p) => p.id !== featureId);
  const oldStillUsed = others.some((p) => plotNumberOf(p) === from);
  const merge = others.some((p) => plotNumberOf(p) === to);
  const moveRecord = !oldStillUsed && !!doc.plots[from];
  if (moveRecord && doc.plots[to]) return { ok: false, error: t.plot.numberBothHaveData(from, to) };
  return { ok: true, merge, moveRecord };
}
