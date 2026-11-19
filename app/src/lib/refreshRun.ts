/**
 * "Refresh ownership", browser side: asks /api/oss-parcel about the plots one after another.
 * No React here, so the order, the pauses and the error handling can be tested.
 */
import { strings as t } from '../i18n/strings';
import type { OssParcelResult } from './ossParcel';
import type { PlotIdentity } from './registryRefresh';

export interface RefreshTarget {
  /** plot number the ownership record is stored under */
  plotNumber: string;
  parcelId: number;
  /** what the cadastre calls the parcel - the registry's answer must say the same */
  identity: PlotIdentity;
}

/** Why the whole run has to stop (as opposed to one plot failing). */
export type Fatal = 'unauthorized' | 'not_configured' | 'unavailable';

export type FetchOutcome = { kind: 'ok'; result: OssParcelResult } | { kind: 'failed'; message: string } | { kind: 'fatal'; reason: Fatal };

const API = '/api/oss-parcel';
/** The server answers within 30 s; a little more for the way there and back. */
const CLIENT_TIMEOUT_MS = 40_000;

function looksLikeResult(v: unknown): v is OssParcelResult {
  const r = v as Partial<OssParcelResult> | null;
  return !!r && typeof r === 'object' && Number.isInteger(r.parcelId) && typeof r.parcelNumber === 'string' && Array.isArray(r.shares) && 'lrUnit' in r;
}

/** One call to /api/oss-parcel. Never throws, except when `signal` is aborted by the caller. */
export async function fetchParcelFromApi(parcelId: number, token: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<FetchOutcome> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, CLIENT_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${API}?parcelId=${parcelId}`, { headers: { 'X-Refresh-Token': token }, cache: 'no-store', signal: ctl.signal });
    if (r.status === 401) return { kind: 'fatal', reason: 'unauthorized' };
    if (r.status === 503) return { kind: 'fatal', reason: 'not_configured' };
    const isJson = (r.headers.get('content-type') ?? '').includes('json');
    // a site without the function answers with a page (or 404/405), not with JSON
    if (!isJson) return r.status >= 500 ? { kind: 'failed', message: t.refresh.failServer(r.status) } : { kind: 'fatal', reason: 'unavailable' };
    const body: unknown = await r.json().catch(() => null);
    if (r.ok) return looksLikeResult(body) ? { kind: 'ok', result: body } : { kind: 'failed', message: t.refresh.failUnexpected };
    const e = (body ?? {}) as { error?: string; stage?: string; reason?: string; upstreamStatus?: number | null };
    if (e.error === 'upstream') return { kind: 'failed', message: t.refresh.failUpstream(e.stage ?? '?', e.reason === 'http' ? `HTTP ${e.upstreamStatus}` : e.reason ?? '?') };
    if (e.error === 'parcel_not_allowed') return { kind: 'failed', message: t.refresh.failNotAllowed };
    return { kind: 'failed', message: t.refresh.failServer(r.status) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { kind: 'failed', message: ctl.signal.aborted ? t.refresh.failTimeout : t.refresh.failNetwork };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** Waits, but returns at once when the signal is aborted. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

export type RunEnd = { ended: 'done' } | { ended: 'cancelled' } | { ended: 'fatal'; reason: Fatal };

export interface RunOptions {
  fetchOne: (target: RefreshTarget, signal: AbortSignal) => Promise<FetchOutcome>;
  pauseMs: number;
  signal: AbortSignal;
  /** called just before a plot is asked about; `index` counts from 0 */
  onStart: (index: number, target: RefreshTarget) => void;
  /** called with the answer for a plot (never with a fatal one) */
  onResult: (target: RefreshTarget, outcome: Exclude<FetchOutcome, { kind: 'fatal' }>) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Asks about the plots strictly one after another, with a pause between two plots.
 * A plot that fails is reported through onResult and the run goes on. The run stops when the signal
 * is aborted (cancelled) or when the service itself refuses (fatal) - the plot it stopped at has no result.
 */
export async function runRefresh(targets: RefreshTarget[], o: RunOptions): Promise<RunEnd> {
  const wait = o.wait ?? pause;
  for (let i = 0; i < targets.length; i++) {
    if (o.signal.aborted) return { ended: 'cancelled' };
    if (i > 0) {
      await wait(o.pauseMs, o.signal);
      if (o.signal.aborted) return { ended: 'cancelled' };
    }
    o.onStart(i, targets[i]);
    let outcome: FetchOutcome;
    try {
      outcome = await o.fetchOne(targets[i], o.signal);
    } catch {
      if (o.signal.aborted) return { ended: 'cancelled' };
      outcome = { kind: 'failed', message: t.refresh.failNetwork };
    }
    if (outcome.kind === 'fatal') return { ended: 'fatal', reason: outcome.reason };
    o.onResult(targets[i], outcome);
  }
  return { ended: 'done' };
}
