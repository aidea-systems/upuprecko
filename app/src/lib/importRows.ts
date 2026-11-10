import type { Owner, OwnershipDoc, PlotRecord } from '../types';
import { strings as t } from '../i18n/strings';
import { checkOwnerShares, emptyRecord, mergeOwners, ourShareFromOwners, parseStatus } from './ownership';
import { parseFraction } from './fraction';

export type Field = 'plot' | 'status' | 'owners' | 'shares' | 'notes' | 'ourShare' | 'contact';

const normHeader = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Accepted column headers (English and Croatian), compared without case, spaces or accents. */
const ALIASES: Record<Field, string[]> = {
  plot: ['plotnumber', 'plot', 'plotno', 'parcel', 'parcelnumber', 'brojcestice', 'cestica', 'kcbr', 'kc', 'katastarskacestica'],
  status: ['status', 'stanje'],
  owners: ['owners', 'owner', 'vlasnici', 'vlasnik'],
  shares: ['shares', 'share', 'ownershares', 'udjeli', 'udio'],
  notes: ['notes', 'note', 'napomena', 'napomene', 'biljeske'],
  ourShare: ['ourshare', 'nasudio'],
  contact: ['contact', 'kontakt'],
};

export function mapHeaders(headers: string[]): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const h of headers) {
    const n = normHeader(h);
    for (const f of Object.keys(ALIASES) as Field[]) if (!out[f] && ALIASES[f].includes(n)) out[f] = h;
  }
  return out;
}

export interface ImportIssue {
  row: number;
  plotNumber?: string;
  message: string;
}

export interface ImportReport {
  rowCount: number;
  records: Record<string, PlotRecord>;
  unknownPlots: ImportIssue[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  fatal?: string;
}

const cell = (row: Record<string, unknown>, col?: string) => (col ? String(row[col] ?? '').trim() : '');
/** Owners / shares in one cell: separated by ";" or "|" ("|" is for semicolon-delimited CSV files) or line breaks. */
const splitList = (s: string) => s.split(/[;|\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * Turns spreadsheet rows into plot records. Row numbers in the report match the
 * spreadsheet (header = row 1). Columns not present in the file keep existing values.
 */
export function buildImport(
  rows: Record<string, unknown>[],
  knownPlotNumbers: Set<string>,
  doc: OwnershipDoc,
  now = new Date().toISOString(),
): ImportReport {
  const report: ImportReport = { rowCount: 0, records: {}, unknownPlots: [], errors: [], warnings: [] };
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const col = mapHeaders(headers);
  if (!col.plot) return { ...report, rowCount: rows.length, fatal: t.import.noPlotColumn };
  const seen = new Map<string, number>();

  rows.forEach((row, i) => {
    const line = i + 2;
    if (Object.values(row).every((v) => String(v ?? '').trim() === '')) return;
    report.rowCount++;
    const pn = cell(row, col.plot);
    if (!pn) return report.errors.push({ row: line, message: t.import.missingPlotNumber });
    if (!knownPlotNumbers.has(pn)) return report.unknownPlots.push({ row: line, plotNumber: pn, message: pn });

    const base: PlotRecord = { ...(doc.plots[pn] ?? emptyRecord()) };
    const issue = (message: string) => report.errors.push({ row: line, plotNumber: pn, message });

    if (col.status) {
      const raw = cell(row, col.status);
      const s = parseStatus(raw);
      if (s === undefined) return issue(t.import.badStatus(raw));
      base.status = s ?? 'no_data';
    }
    if (col.owners || col.shares) {
      const names = splitList(cell(row, col.owners));
      const shares = splitList(cell(row, col.shares));
      if (shares.length && names.length && shares.length !== names.length)
        return issue(t.import.shareCountMismatch(names.length, shares.length));
      const n = Math.max(names.length, shares.length);
      const owners: Owner[] = Array.from({ length: n }, (_, k) => ({ name: names[k] ?? '', share: shares[k] ?? '' }));
      const bad = owners.filter((o) => o.share && !parseFraction(o.share));
      if (bad.length) return issue(t.plot.invalidShare(bad[0].share));
      const merged = mergeOwners(owners); // same owner in different case = one row
      const chk = checkOwnerShares(merged);
      if (!chk.ok && chk.sum && merged.every((o) => o.share))
        report.warnings.push({ row: line, plotNumber: pn, message: t.plot.sharesSum(chk.sumText) });
      base.owners = merged;
      if (!col.ourShare) base.ourShare = ourShareFromOwners(merged) ?? base.ourShare;
    }
    if (col.ourShare) {
      const v = cell(row, col.ourShare);
      const f = parseFraction(v);
      if (v && (!f || Number(f.n) > Number(f.d))) return issue(t.plot.ourShareInvalid);
      base.ourShare = v;
    }
    if (col.notes) base.notes = cell(row, col.notes);
    if (col.contact) base.contact = cell(row, col.contact);
    base.updatedAt = now;

    if (seen.has(pn)) report.warnings.push({ row: line, plotNumber: pn, message: t.import.duplicateRow(seen.get(pn)!) });
    seen.set(pn, line);
    report.records[pn] = base;
  });
  return report;
}
