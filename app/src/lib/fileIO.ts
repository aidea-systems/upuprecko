import type { OwnershipDoc, PlotGeometry, PlotProps } from '../types';
import { strings as t } from '../i18n/strings';
import { effectiveShare, getRecord } from './ownership';
import { resolveFeature, type ZoneStats } from './zoneStats';

const stamp = () => new Date().toISOString().slice(0, 10);
const FILE_BASE = 'upu-precko-zapad-ownership';

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportJson(doc: OwnershipDoc) {
  download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), `${FILE_BASE}-${stamp()}.json`);
}

/** Plots as currently shown (edited numbers and boundaries applied) with their status. */
export function exportGeojson(features: { properties: PlotProps; geometry: PlotGeometry }[], doc: OwnershipDoc) {
  const fc = {
    type: 'FeatureCollection',
    features: features.map((f) => {
      const r = resolveFeature(f.properties, doc.reviews);
      const pn = r.kind === 'plot' ? r.plotNumber : null;
      const rec = pn ? getRecord(doc, pn) : null;
      const e = doc.edits[f.properties.id];
      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          ...f.properties,
          plot_number: pn,
          resolution: r.kind,
          status: rec?.status ?? null,
          our_share: rec ? effectiveShare(rec).value : null,
          boundary_edited: !!e?.geometry,
          number_edited: !!e?.plotNumber,
        },
      };
    }),
  };
  download(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `upu-precko-zapad-plots-${stamp()}.geojson`);
}

export type ReadResult = { kind: 'json'; data: unknown } | { kind: 'rows'; rows: Record<string, unknown>[] };

export async function readImportFile(file: File): Promise<ReadResult> {
  if (/\.json$/i.test(file.name)) return { kind: 'json', data: JSON.parse(await file.text()) };
  const XLSX = await import('xlsx');
  // raw: keep CSV text as typed, so "1/2" stays a fraction instead of becoming a date
  const wb = /\.(csv|txt)$/i.test(file.name)
    ? XLSX.read(await file.text(), { type: 'string', raw: true })
    : XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return { kind: 'rows', rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false }) };
}

export async function exportExcel(doc: OwnershipDoc, features: PlotProps[], stats: ZoneStats[], zoneLanduse: Record<string, string>) {
  const XLSX = await import('xlsx');
  const fmtShare = (pn: string) => {
    const r = doc.plots[pn];
    return r?.ourShare || (effectiveShare(r).source === 'status' ? '1' : '');
  };

  // one row per plot number (features with the same number are combined)
  const plots = new Map<string, { zones: Map<string, number>; area: number; inUpu: number; edited: boolean }>();
  for (const f of features) {
    const r = resolveFeature(f, doc.reviews);
    if (r.kind !== 'plot') continue;
    const e = plots.get(r.plotNumber) ?? { zones: new Map(), area: 0, inUpu: 0, edited: false };
    e.edited ||= !!doc.edits[f.id];
    e.area += f.area_m2;
    e.inUpu += f.area_in_upu_m2;
    for (const z of f.zones) e.zones.set(z.zone, (e.zones.get(z.zone) ?? 0) + z.overlap_m2);
    plots.set(r.plotNumber, e);
  }
  const plotRows = [...plots.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([pn, e]) => {
      const rec = getRecord(doc, pn);
      return [
        pn,
        [...e.zones.entries()].map(([z, a]) => `${z} (${a.toFixed(1)})`).join('; '),
        +e.area.toFixed(1),
        +e.inUpu.toFixed(1),
        t.status[rec.status],
        rec.owners.map((o) => o.name).join('; '),
        rec.owners.map((o) => o.share).join('; '),
        fmtShare(pn),
        rec.contact,
        rec.notes,
        rec.updatedAt ?? '',
        e.edited ? 'yes' : '',
      ];
    });
  const pct = (v: number | null) => (v === null ? '' : +(v * 100).toFixed(1));
  const zoneRows = stats.map((s) => [
    s.zone, zoneLanduse[s.zone] ?? '', +s.totalOverlap.toFixed(1), +s.countedArea.toFixed(1), +s.ownedArea.toFixed(1),
    pct(s.pctArea), s.plotCount, pct(s.pctCount), s.statusCounts.owned, s.statusCounts.negotiating,
    s.statusCounts.not_owned, s.statusCounts.no_data, +s.excludedReview.area.toFixed(1),
  ]);
  const reviewRows = features
    .filter((f) => f.kind === 'review')
    .map((f) => {
      const r = doc.reviews[f.id];
      return [
        f.id, f.candidates.join('; '), f.area_m2, f.zones.map((z) => z.zone).join('; '), f.reason ?? '',
        !r ? t.excel.unresolved : r.type === 'plot' ? t.excel.resolvedPlot(r.plotNumber) : t.excel.resolvedRoad,
      ];
    });

  const wb = XLSX.utils.book_new();
  const sheet = (cols: string[], rows: unknown[][], textCols: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet([cols, ...rows]);
    // force text type so plot numbers and fractions like 1/2 are not turned into dates
    for (let r = 1; r <= rows.length; r++)
      for (const c of textCols) {
        const ref = XLSX.utils.encode_cell({ r, c });
        if (ws[ref]) Object.assign(ws[ref], { t: 's', z: '@', v: String(ws[ref].v) });
      }
    ws['!cols'] = cols.map((c) => ({ wch: Math.max(12, c.length + 2) }));
    return ws;
  };
  XLSX.utils.book_append_sheet(wb, sheet(t.excel.plotCols, plotRows, [0, 6, 7]), t.excel.plotsSheet);
  XLSX.utils.book_append_sheet(wb, sheet(t.excel.zoneCols, zoneRows, [0]), t.excel.zonesSheet);
  XLSX.utils.book_append_sheet(wb, sheet(t.excel.reviewCols, reviewRows, [0, 1]), t.excel.reviewSheet);
  XLSX.writeFile(wb, `${FILE_BASE}-${stamp()}.xlsx`);
}
