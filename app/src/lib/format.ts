import { strings as t } from '../i18n/strings';

const nf1 = new Intl.NumberFormat(t.locale, { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const pf = new Intl.NumberFormat(t.locale, { style: 'percent', maximumFractionDigits: 1 });
const df = new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' });

export const fmtArea = (m2: number) => `${nf1.format(m2)} m²`;
export const fmtNum = (v: number) => nf1.format(v);
export const fmtPct = (v: number | null) => (v === null ? '—' : pf.format(v));
export const fmtDate = (iso: string | null) => (iso ? df.format(new Date(iso)) : t.plot.never);
/**
 * The line next to the Update button: "Last updated: 19 Nov 2026, 10:47" in local time (or in the given
 * time zone), "Last updated: never" when the land registry has not been checked yet.
 */
export function lastUpdatedLabel(iso: string | null | undefined, timeZone?: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return t.data.lastUpdated(t.data.never);
  const f = timeZone ? new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }) : df;
  return t.data.lastUpdated(f.format(d));
}
export const sortPlotNumbers = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
