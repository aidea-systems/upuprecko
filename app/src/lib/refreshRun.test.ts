import { describe, expect, it } from 'vitest';
import type { OssParcelResult } from './ossParcel';
import { fetchParcelFromApi, runRefresh, type FetchOutcome, type RefreshTarget } from './refreshRun';

const result = (parcelId: number): OssParcelResult => ({ parcelId, parcelNumber: String(parcelId), municipalityRegNum: '339318', registeredArea: 1, isHarmonized: true, lrUnit: null, shares: [] });
const targets: RefreshTarget[] = [1, 2, 3, 4].map((n) => ({ plotNumber: `p${n}`, parcelId: n, identity: { plotNumber: `p${n}`, municipalityRegNum: '339318' } }));
const ok = (n: number): FetchOutcome => ({ kind: 'ok', result: result(n) });

/** Runs with a scripted answer per plot and records everything in order. */
async function run(answers: Record<string, FetchOutcome | 'throw'>, abortAt?: { plot: string; ctl: AbortController }) {
  const log: string[] = [];
  const ctl = abortAt?.ctl ?? new AbortController();
  let active = 0;
  const end = await runRefresh(targets, {
    pauseMs: 1500,
    signal: ctl.signal,
    wait: async (ms) => void log.push(`wait ${ms}`),
    onStart: (i, t) => log.push(`start ${i} ${t.plotNumber}`),
    onResult: (t, o) => log.push(`${o.kind} ${t.plotNumber}`),
    fetchOne: async (t) => {
      expect(++active, 'only one plot is asked about at a time').toBe(1);
      await Promise.resolve();
      active--;
      if (abortAt?.plot === t.plotNumber) ctl.abort();
      const a = answers[t.plotNumber] ?? ok(t.parcelId);
      if (a === 'throw') throw new Error('boom');
      return a;
    },
  });
  return { end, log };
}

describe('runRefresh', () => {
  it('asks plot by plot, in order, with a pause between two plots (none before the first or after the last)', async () => {
    const { end, log } = await run({});
    expect(end).toEqual({ ended: 'done' });
    expect(log).toEqual(['start 0 p1', 'ok p1', 'wait 1500', 'start 1 p2', 'ok p2', 'wait 1500', 'start 2 p3', 'ok p3', 'wait 1500', 'start 3 p4', 'ok p4']);
  });

  it('records a failed plot and goes on', async () => {
    const { end, log } = await run({ p2: { kind: 'failed', message: 'x' }, p3: 'throw' });
    expect(end).toEqual({ ended: 'done' });
    expect(log.filter((l) => !l.startsWith('wait') && !l.startsWith('start'))).toEqual(['ok p1', 'failed p2', 'failed p3', 'ok p4']);
  });

  it('stops at once when the service refuses, leaving that plot without a result', async () => {
    const { end, log } = await run({ p2: { kind: 'fatal', reason: 'unauthorized' } });
    expect(end).toEqual({ ended: 'fatal', reason: 'unauthorized' });
    expect(log).toEqual(['start 0 p1', 'ok p1', 'wait 1500', 'start 1 p2']);
  });

  it('stops when cancelled: the plot in flight is finished, nothing more is asked', async () => {
    const ctl = new AbortController();
    const { end, log } = await run({}, { plot: 'p2', ctl });
    expect(end).toEqual({ ended: 'cancelled' });
    expect(log).toEqual(['start 0 p1', 'ok p1', 'wait 1500', 'start 1 p2', 'ok p2']);
  });

  it('asks nothing when it is cancelled before it starts', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const log: string[] = [];
    const end = await runRefresh(targets, { pauseMs: 1, signal: ctl.signal, onStart: () => log.push('start'), onResult: () => log.push('result'), fetchOne: async () => ok(1) });
    expect(end).toEqual({ ended: 'cancelled' });
    expect(log).toEqual([]);
  });
});

describe('fetchParcelFromApi', () => {
  const respond = (status: number, body: unknown, type = 'application/json') =>
    (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } })) as unknown as typeof fetch;

  it('sends the parcel id and the token, and returns the result', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const f = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(result(41106113)), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }) as unknown as typeof fetch;
    const o = await fetchParcelFromApi(41106113, 'secret', undefined, f);
    expect(o).toEqual({ kind: 'ok', result: result(41106113) });
    expect(seen!.url).toBe('/api/oss-parcel?parcelId=41106113');
    expect((seen!.init!.headers as Record<string, string>)['X-Refresh-Token']).toBe('secret');
    expect(seen!.init!.cache).toBe('no-store');
  });

  it('treats 401, 503 and a site without the function as reasons to stop the whole run', async () => {
    expect(await fetchParcelFromApi(1, 't', undefined, respond(401, { error: 'unauthorized' }))).toEqual({ kind: 'fatal', reason: 'unauthorized' });
    expect(await fetchParcelFromApi(1, 't', undefined, respond(503, { error: 'not_configured' }))).toEqual({ kind: 'fatal', reason: 'not_configured' });
    expect(await fetchParcelFromApi(1, 't', undefined, respond(404, '<html>not found</html>', 'text/html'))).toEqual({ kind: 'fatal', reason: 'unavailable' });
    expect(await fetchParcelFromApi(1, 't', undefined, respond(200, '<html>index</html>', 'text/html'))).toEqual({ kind: 'fatal', reason: 'unavailable' });
  });

  it('treats everything else as a failure of that plot only', async () => {
    const failed = async (f: typeof fetch) => {
      const o = await fetchParcelFromApi(1, 't', undefined, f);
      expect(o.kind).toBe('failed');
      return o.kind === 'failed' ? o.message : '';
    };
    expect(await failed(respond(502, { error: 'upstream', stage: 'lr-unit', reason: 'http', upstreamStatus: 500 }))).toContain('lr-unit: HTTP 500');
    expect(await failed(respond(504, { error: 'upstream', stage: 'parcel-info', reason: 'timeout', upstreamStatus: null }))).toContain('parcel-info: timeout');
    expect(await failed(respond(403, { error: 'parcel_not_allowed' }))).toMatch(/deployed again/);
    expect(await failed(respond(500, { error: 'internal' }))).toContain('HTTP 500');
    expect(await failed(respond(502, 'Bad gateway', 'text/plain'))).toContain('HTTP 502');
    expect(await failed(respond(200, { something: 'else' }))).toMatch(/unexpected/);
    expect(await failed((async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toMatch(/No connection/);
  });

  it('passes a cancel on to the caller', async () => {
    const ctl = new AbortController();
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const p = fetchParcelFromApi(1, 't', ctl.signal, f);
    ctl.abort();
    await expect(p).rejects.toBeTruthy();
  });
});
