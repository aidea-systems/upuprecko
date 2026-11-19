/**
 * "Refresh ownership": turns what the land registry says about a parcel (OssParcelResult, ownership sheet B)
 * into owner rows and compares them with the stored record. Pure functions, no network.
 */
import type { Owner, PlotRecord, RegistryInfo, Status } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { addFrac, formatFrac, isOne, parseFraction, type Frac } from './fraction';
import { isOurOwner, ownerKey } from './ownership';
import type { OssOwner, OssParcelResult, OssShare } from './ossParcel';

export { parseShare } from './ossParcel';

const ZERO: Frac = { n: 0n, d: 1n };
const sameFrac = (a: Frac, b: Frac) => a.n === b.n && a.d === b.d; // fractions are always reduced

/** Removes what is added to a name but is not part of it: "(predbilježba)", ", OIB: 61817894937". */
function stripSuffixes(name: string): string {
  let s = name.trim();
  for (;;) {
    const next = s.replace(/[\s,]*\([^()]*\)$/u, '').replace(/[\s,]*OIB\s*:?\s*\d{11}$/iu, '').trim();
    if (next === s) return s;
    s = next;
  }
}

/** A name for comparing: without case, extra spaces and suffixes such as "(predbilježba)" or ", OIB: …". */
export const nameKey = (name: string) => ownerKey(stripSuffixes(name));

/** Is this land-registry owner one of our companies? By OIB, or by name (config.ourOwners). */
export function isOurs(o: OssOwner, oibs: string[] = config.ourOwnerOibs): boolean {
  return (!!o.oib && oibs.includes(o.oib)) || isOurOwner(o.name);
}

/** One row per share entry of sheet B; several owners of one entry are joined into one row. */
export interface RegistryRow {
  name: string;
  /** null when the registry gives no fraction for the entry. */
  share: Frac | null;
  /** set when the row is a single owner with an OIB */
  oib?: string;
  ours: boolean;
  /** compare-keys of every spelling merged into this row */
  keys: string[];
}

export function ownerRows(shares: OssShare[], oibs: string[] = config.ourOwnerOibs): RegistryRow[] {
  return shares.map((s) => {
    const name = s.owners.map((o) => o.name).join(', ');
    return {
      name,
      share: s.share ? parseFraction(s.share) : null,
      oib: s.owners.length === 1 ? s.owners[0].oib : undefined,
      ours: s.owners.length > 0 && s.owners.every((o) => isOurs(o, oibs)),
      keys: [nameKey(name)],
    };
  });
}

/**
 * Merges rows of the same owner, adding the shares exactly. The same owner = the same OIB when the row
 * has one, otherwise the same name (compared like ownerKey). The first spelling is kept.
 * Rows without a readable share are left as they are.
 */
export function mergeRows(rows: RegistryRow[]): RegistryRow[] {
  const out: RegistryRow[] = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const id = r.oib ? `oib:${r.oib}` : `name:${r.keys[0]}`;
    const i = r.share ? at.get(id) : undefined;
    if (i !== undefined) {
      const prev = out[i];
      out[i] = { ...prev, share: addFrac(prev.share!, r.share!), ours: prev.ours || r.ours, keys: [...new Set([...prev.keys, ...r.keys])] };
    } else {
      out.push({ ...r });
      if (r.share) at.set(id, out.length - 1);
    }
  }
  return out;
}

/** Sum of the shares of our companies. */
export function ourShareOf(rows: RegistryRow[]): Frac {
  return rows.reduce((sum, r) => (r.ours && r.share ? addFrac(sum, r.share) : sum), ZERO);
}

/**
 * Status from our share: everything is ours → Owned; otherwise Not owned,
 * except that a Negotiating set by hand is kept.
 */
export function deriveStatus(ourShare: Frac, existing: Status): Status {
  if (isOne(ourShare)) return 'owned';
  return existing === 'negotiating' ? 'negotiating' : 'not_owned';
}

/** Owners that match our company names but whose OIB is not in config.ourOwnerOibs. */
export function unlistedOurOibs(shares: OssShare[], oibs: string[] = config.ourOwnerOibs): { name: string; oib: string }[] {
  const out = new Map<string, { name: string; oib: string }>();
  for (const s of shares) for (const o of s.owners) if (o.oib && isOurOwner(o.name) && !oibs.includes(o.oib)) out.set(o.oib, { name: o.name, oib: o.oib });
  return [...out.values()];
}

export interface PlotIdentity {
  /** plot number in the cadastre (the map's source data) */
  plotNumber: string;
  /** cadastral municipality code, e.g. "339318" */
  municipalityRegNum: string;
}

interface Checked {
  /** things worth knowing that do not block a comparison (pending registrations …) */
  notes: string[];
  unlistedOibs: { name: string; oib: string }[];
}

export type PlotDiff =
  | ({ kind: 'flagged'; reasons: string[] } & Checked)
  | ({ kind: 'unchanged'; registry: RegistryInfo } & Checked)
  | ({ kind: 'changed'; differences: string[]; next: Pick<PlotRecord, 'owners' | 'ourShare' | 'status'>; registry: RegistryInfo } & Checked);

/** Reasons why the registry's answer cannot be turned into owner rows safely. */
function flagReasons(fetched: OssParcelResult, plot: PlotIdentity, rows: RegistryRow[]): string[] {
  const why: string[] = [];
  if (fetched.parcelNumber !== plot.plotNumber) why.push(t.refresh.flagPlotNumber(fetched.parcelNumber, plot.plotNumber));
  if (fetched.municipalityRegNum !== plot.municipalityRegNum) why.push(t.refresh.flagMunicipality(fetched.municipalityRegNum, plot.municipalityRegNum));
  if (!fetched.lrUnit) return [...why, t.refresh.flagNoUnit];
  if (fetched.lrUnit.condominiums) why.push(t.refresh.flagCondominiums);
  if (fetched.shares.length === 0) return [...why, t.refresh.flagNoShares];
  fetched.shares.forEach((s, i) => {
    if (s.hasSubShares) why.push(t.refresh.flagSubShares(s.rawDescription));
    if (!rows[i].share) why.push(t.refresh.flagShareUnreadable(s.rawDescription));
    if (s.owners.length === 0) why.push(t.refresh.flagNoOwner(s.rawDescription));
    const ours = s.owners.filter((o) => isOurs(o)).length;
    if (ours > 0 && ours < s.owners.length) why.push(t.refresh.flagMixed(s.rawDescription));
  });
  if (rows.every((r) => r.share)) {
    const sum = rows.reduce((a, r) => addFrac(a, r.share!), ZERO);
    if (!isOne(sum)) why.push(t.refresh.flagSum(formatFrac(sum)));
  }
  return why;
}

interface Total {
  name: string;
  /** null = at least one of the shares cannot be read */
  sum: Frac | null;
  text: string;
}

/** Stored owners added up per name (the stored data has names only). */
function storedTotals(owners: Owner[]): Map<string, Total> {
  const m = new Map<string, Total>();
  for (const o of owners) {
    if (!o.name.trim() && !o.share.trim()) continue;
    const k = nameKey(o.name);
    const f = parseFraction(o.share);
    const prev = m.get(k);
    if (!prev) m.set(k, { name: o.name, sum: f, text: f ? formatFrac(f) : o.share.trim() || t.refresh.noShare });
    else {
      const sum = prev.sum && f ? addFrac(prev.sum, f) : null;
      m.set(k, { name: prev.name, sum, text: sum ? formatFrac(sum) : `${prev.text} + ${o.share.trim() || t.refresh.noShare}` });
    }
  }
  return m;
}

/**
 * Compares the stored record with what the land registry says.
 *  - flagged: the answer cannot be read safely (see flagReasons) - nothing is proposed;
 *  - unchanged: same owners (names without case/spaces/suffixes, exact fractions), same our share, same status;
 *  - changed: the differences in words, and the owners / our share / status to store instead.
 * `checkedAt` goes into the registry note that is stored with the record.
 */
export function diffPlot(stored: PlotRecord, fetched: OssParcelResult, plot: PlotIdentity, checkedAt: string): PlotDiff {
  const notes: string[] = [];
  if (fetched.lrUnit?.activePlumbs.length) notes.push(t.refresh.notePlumbs(fetched.lrUnit.activePlumbs.join(', ')));
  if (!fetched.isHarmonized) notes.push(t.refresh.noteNotHarmonized);
  const remarks = fetched.shares.reduce((n, s) => n + s.annotations, 0);
  if (remarks) notes.push(t.refresh.noteAnnotations(remarks));
  const checked: Checked = { notes, unlistedOibs: unlistedOurOibs(fetched.shares) };

  const rows = ownerRows(fetched.shares);
  const reasons = flagReasons(fetched, plot, rows);
  if (reasons.length || !fetched.lrUnit) return { kind: 'flagged', reasons, ...checked };

  const registry: RegistryInfo = {
    parcelId: fetched.parcelId,
    lrUnitNumber: fetched.lrUnit.number,
    mainBookId: fetched.lrUnit.mainBookId,
    mainBookName: fetched.lrUnit.mainBookName,
    lastDiaryNumber: fetched.lrUnit.lastDiaryNumber,
    activePlumbs: fetched.lrUnit.activePlumbs,
    checkedAt,
  };

  const merged = mergeRows(rows);
  const before = storedTotals(stored.owners);
  // the registry's owners added up per name, under the stored name's key where one of the spellings matches
  const after = new Map<string, Total>();
  for (const r of merged) {
    const k = r.keys.find((x) => before.has(x)) ?? r.keys[0];
    const prev = after.get(k);
    const sum = prev?.sum ? addFrac(prev.sum, r.share!) : r.share!;
    after.set(k, { name: prev?.name ?? r.name, sum, text: formatFrac(sum) });
  }

  const differences: string[] = [];
  for (const [k, a] of after) {
    const b = before.get(k);
    if (!b) differences.push(t.refresh.ownerAdded(a.name, a.text));
    else if (!b.sum || !sameFrac(b.sum, a.sum!)) differences.push(t.refresh.shareChanged(b.name, b.text, a.text));
  }
  for (const [k, b] of before) if (!after.has(k)) differences.push(t.refresh.ownerRemoved(b.name, b.text));

  const ourShare = ourShareOf(merged);
  const storedOur = parseFraction(stored.ourShare);
  if (!storedOur || !sameFrac(storedOur, ourShare))
    differences.push(t.refresh.ourShareChanged(stored.ourShare.trim() || t.refresh.noShare, formatFrac(ourShare)));
  const status = deriveStatus(ourShare, stored.status);
  if (status !== stored.status) differences.push(t.refresh.statusChanged(t.status[stored.status], t.status[status]));

  if (differences.length === 0) return { kind: 'unchanged', registry, ...checked };

  // Owners to store: the spelling already in the data where the owner is the same and the stored name has
  // nothing added to it; otherwise the registry's spelling, without an OIB written into the name.
  const owners: Owner[] = merged.map((r) => {
    const same = stored.owners.find((o) => r.keys.includes(nameKey(o.name)) && nameKey(o.name) === ownerKey(o.name));
    return { name: same ? same.name.trim() : r.name.replace(/[\s,]*OIB\s*:?\s*\d{11}$/iu, '').trim(), share: formatFrac(r.share!) };
  });
  return { kind: 'changed', differences, next: { owners, ourShare: formatFrac(ourShare), status }, registry, ...checked };
}

/**
 * The record to store for a checked plot: for a change the new owners, our share and status (notes and
 * contact are never touched); for an unchanged plot only the registry note. null for a flagged plot.
 */
export function applyDiff(stored: PlotRecord, diff: PlotDiff, now: string): PlotRecord | null {
  if (diff.kind === 'flagged') return null;
  if (diff.kind === 'unchanged') return { ...stored, registry: diff.registry };
  return { ...stored, ...diff.next, registry: diff.registry, updatedAt: now };
}
