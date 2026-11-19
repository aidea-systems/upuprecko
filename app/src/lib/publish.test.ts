import { describe, expect, it } from 'vitest';
import type { OwnershipDoc, PlotRecord } from '../types';
import { publishDoc, unpublishedEdits } from './publish';

const rec = (over: Partial<PlotRecord> = {}): PlotRecord => ({ status: 'not_owned', owners: [{ name: 'A', share: '1' }], ourShare: '0', contact: '', notes: '', updatedAt: null, ...over });
const doc = (over: Partial<OwnershipDoc> = {}): OwnershipDoc => ({ version: 1, savedAt: '2026-11-19T09:50:00.000Z', plots: { '1': rec(), '2': rec(), '10/1': rec() }, reviews: {}, edits: {}, ...over });

describe('publishDoc', () => {
  const respond = (status: number, body: unknown, type = 'application/json') =>
    (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } })) as unknown as typeof fetch;

  it('posts the document, the base version and the token, and returns the commit', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ ok: true, commit: 'c0ffee1234567890', savedAt: 'x' });
    }) as unknown as typeof fetch;
    expect(await publishDoc(doc(), '2026-11-17T15:42:07.167Z', 'secret', f)).toEqual({ kind: 'ok', commit: 'c0ffee1234567890' });
    expect(seen!.url).toBe('/api/publish');
    expect(seen!.init.method).toBe('POST');
    expect((seen!.init.headers as Record<string, string>)['X-Refresh-Token']).toBe('secret');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ doc: doc(), baseSavedAt: '2026-11-17T15:42:07.167Z' });
  });

  it('sends an empty base when no published version is known', async () => {
    let body = '';
    const f = (async (_u: string, init: RequestInit) => ((body = String(init.body)), Response.json({ ok: true, commit: null }))) as unknown as typeof fetch;
    expect(await publishDoc(doc(), null, 't', f)).toEqual({ kind: 'ok', commit: null });
    expect(JSON.parse(body).baseSavedAt).toBe('');
  });

  it('tells a conflict, a refused token and a site that cannot publish apart', async () => {
    expect(await publishDoc(doc(), 'b', 't', respond(409, { error: 'conflict' }))).toEqual({ kind: 'conflict' });
    expect(await publishDoc(doc(), 'b', 't', respond(401, { error: 'unauthorized' }))).toEqual({ kind: 'unauthorized' });
    expect(await publishDoc(doc(), 'b', 't', respond(503, { error: 'not_configured' }))).toEqual({ kind: 'unavailable' });
    expect(await publishDoc(doc(), 'b', 't', respond(404, '<html>', 'text/html'))).toEqual({ kind: 'unavailable' });
    expect(await publishDoc(doc(), 'b', 't', respond(405, '', 'text/plain'))).toEqual({ kind: 'unavailable' });
  });

  it('reports every other failure in words, so it can be retried', async () => {
    const failed = async (f: typeof fetch) => {
      const o = await publishDoc(doc(), 'b', 't', f);
      expect(o.kind).toBe('failed');
      return o.kind === 'failed' ? o.message : '';
    };
    expect(await failed(respond(502, { error: 'github', step: 'write', githubStatus: 403 }))).toBe('GitHub refused or did not answer (write: HTTP 403).');
    expect(await failed(respond(504, { error: 'github', step: 'read', githubStatus: null }))).toBe('GitHub refused or did not answer (read).');
    expect(await failed(respond(413, { error: 'too_large' }))).toMatch(/too large/);
    expect(await failed(respond(400, { error: 'invalid_document', detail: 'plots["1"].status' }))).toContain('plots["1"].status');
    expect(await failed(respond(422, { error: 'too_few_plots', detail: 'the document has 1 plots, the published file 189' }))).toContain('189');
    expect(await failed(respond(500, { error: 'internal' }))).toContain('HTTP 500');
    expect(await failed(respond(502, 'Bad gateway', 'text/plain'))).toContain('HTTP 502');
    expect(await failed((async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toMatch(/No connection/);
  });
});

describe('unpublishedEdits', () => {
  it('finds nothing when the browser has what is published, whatever the order of the fields', () => {
    const published = doc();
    const mine = doc({ plots: { '10/1': { updatedAt: null, notes: '', contact: '', ourShare: '0', owners: [{ share: '1', name: 'A' }], status: 'not_owned' } as PlotRecord, '2': rec(), '1': rec() }, savedAt: 'later' });
    expect(unpublishedEdits(mine, published)).toEqual({ plots: [], shapes: 0 });
    expect(unpublishedEdits(doc({ registryCheckedAt: '2026-11-19T09:47:00.000Z' }), published)).toEqual({ plots: [], shapes: 0 });
  });

  it('lists plots whose record was changed, added or removed, in plot-number order', () => {
    const mine = doc({ plots: { '1': rec({ notes: 'edited' }), '10/1': rec({ owners: [{ name: 'B', share: '1' }] }), '3': rec() } });
    expect(unpublishedEdits(mine, doc())).toEqual({ plots: ['1', '2', '3', '10/1'], shapes: 0 });
  });

  it('counts shape and review edits', () => {
    const mine = doc({ edits: { a: { plotNumber: '9', editedAt: 'x' } }, reviews: { r: { type: 'not_plot', resolvedAt: 'x' } } });
    expect(unpublishedEdits(mine, doc())).toEqual({ plots: [], shapes: 2 });
  });

  it('says nothing when the published data is not known', () => {
    expect(unpublishedEdits(doc(), null)).toEqual({ plots: [], shapes: 0 });
  });
});
