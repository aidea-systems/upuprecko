import { strings as t } from '../i18n/strings';

const nf1 = new Intl.NumberFormat(t.locale, { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const pf = new Intl.NumberFormat(t.locale, { style: 'percent', maximumFractionDigits: 1 });
const df = new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' });

export const fmtArea = (m2: number) => `${nf1.format(m2)} m²`;
export const fmtNum = (v: number) => nf1.format(v);
export const fmtPct = (v: number | null) => (v === null ? '—' : pf.format(v));
export const fmtDate = (iso: string | null) => (iso ? df.format(new Date(iso)) : t.plot.never);
export const sortPlotNumbers = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
