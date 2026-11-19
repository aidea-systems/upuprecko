/**
 * Browser side of publishing: sends the ownership document to /api/publish, which commits it to the
 * repository so the site is rebuilt with it. Also: what in the browser's data is not published yet.
 */
import type { OwnershipDoc } from '../types';
import { strings as t } from '../i18n/strings';
import { sortPlotNumbers } from './format';

export type PublishOutcome =
  | { kind: 'ok'; commit: string | null }
  /** newer data was published meanwhile - nothing was committed */
  | { kind: 'conflict' }
  | { kind: 'unauthorized' }
  /** this site cannot publish: the variables are not set, or there is no /api/publish */
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string };

const API = '/api/publish';
const CLIENT_TIMEOUT_MS = 45_000;

/** One call to /api/publish. Never throws. */
export async function publishDoc(doc: OwnershipDoc, baseSavedAt: string | null, token: string, fetchImpl: typeof fetch = fetch): Promise<PublishOutcome> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
  try {
    const r = await fetchImpl(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Refresh-Token': token },
      body: JSON.stringify({ doc, baseSavedAt: baseSavedAt ?? '' }),
      cache: 'no-store',
      signal: ctl.signal,
    });
    if (r.status === 401) return { kind: 'unauthorized' };
    if (r.status === 409) return { kind: 'conflict' };
    if (r.status === 503) return { kind: 'unavailable' };
    const isJson = (r.headers.get('content-type') ?? '').includes('json');
    if (!isJson) return r.status >= 500 ? { kind: 'failed', message: t.publish.failServer(r.status) } : { kind: 'unavailable' };
    const body = ((await r.json().catch(() => null)) ?? {}) as { ok?: boolean; commit?: unknown; error?: string; detail?: string; step?: string; githubStatus?: number | null };
    if (r.ok && body.ok) return { kind: 'ok', commit: typeof body.commit === 'string' ? body.commit : null };
    if (body.error === 'github') return { kind: 'failed', message: t.publish.failGithub(body.step ?? '?', body.githubStatus ?? null) };
    if (body.error === 'too_large') return { kind: 'failed', message: t.publish.failTooLarge };
    if (body.error === 'invalid_document' || body.error === 'invalid_body' || body.error === 'too_few_plots') return { kind: 'failed', message: t.publish.failRefused(body.detail ?? body.error) };
    return { kind: 'failed', message: t.publish.failServer(r.status) };
  } catch {
    return { kind: 'failed', message: ctl.signal.aborted ? t.publish.failTimeout : t.publish.failNetwork };
  } finally {
    clearTimeout(timer);
  }
}

/** JSON with object keys in a fixed order, so two records with the same content always compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export interface Unpublished {
  /** plot numbers whose record differs from the published one (changed, added or removed) */
  plots: string[];
  /** changed plot numbers / borders and review decisions that differ */
  shapes: number;
}

/** What the browser's data holds that the published data does not (and the other way round). */
export function unpublishedEdits(doc: OwnershipDoc, published: OwnershipDoc | null): Unpublished {
  if (!published) return { plots: [], shapes: 0 };
  const differing = (a: Record<string, unknown>, b: Record<string, unknown>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stable(a[k]) !== stable(b[k]));
  return {
    plots: differing(doc.plots, published.plots).sort(sortPlotNumbers),
    shapes: differing(doc.edits, published.edits).length + differing(doc.reviews, published.reviews).length,
  };
}
