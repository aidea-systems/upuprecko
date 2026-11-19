import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OwnershipDoc, PlotRecord } from '../src/types';
import { normalizeDoc } from '../src/lib/ownership';
import { checkDoc, createPublishHandler, fileText, MAX_BODY_BYTES, publish, type PublishDeps } from './publish';

const NOW = '2026-11-19T09:47:00.000Z';
const BASE = '2026-11-17T15:42:07.167Z';
const rec = (over: Partial<PlotRecord> = {}): PlotRecord => ({ status: 'not_owned', owners: [{ name: 'IVIĆ IVO', share: '1' }], ourShare: '0', contact: '', notes: 'n', updatedAt: BASE, ...over });
const makeDoc = (over: Partial<OwnershipDoc> = {}): OwnershipDoc => ({
  version: 1,
  savedAt: NOW,
  plots: { '6356/1': rec({ registry: { parcelId: 41106113, lrUnitNumber: '1000', mainBookId: 250235, mainBookName: 'DONJE VRAPČE', lastDiaryNumber: null, activePlumbs: ['Z-1/2026'], checkedAt: NOW } }), '3665': rec() },
  reviews: {},
  edits: {},
  registryCheckedAt: NOW,
  ...over,
});
const published = (savedAt = BASE, plots: Record<string, PlotRecord> = { '3665': rec(), '6356/1': rec() }): OwnershipDoc => ({ version: 1, savedAt, plots, reviews: {}, edits: {} });

/** A stand-in for the GitHub Contents API holding one file; records every call. */
function fakeGithub(file: string | null, opts: { putStatus?: number; getStatus?: number; noContent?: boolean } = {}) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: { message: string; content: string; sha: string; branch: string } }[] = [];
  const state = { text: file, sha: 'blob-1' };
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') {
      if (opts.getStatus) return new Response('{"message":"x"}', { status: opts.getStatus });
      if (state.text === null) return new Response('{"message":"Not Found"}', { status: 404 });
      if (headers.Accept === 'application/vnd.github.raw+json') return new Response(state.text, { status: 200 });
      const content = opts.noContent ? '' : Buffer.from(state.text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
      return Response.json({ sha: state.sha, encoding: opts.noContent ? 'none' : 'base64', content });
    }
    if (opts.putStatus) return new Response('{"message":"x"}', { status: opts.putStatus });
    const body = JSON.parse(String(init!.body));
    if (body.sha !== state.sha) return new Response('{"message":"does not match"}', { status: 409 });
    state.text = Buffer.from(body.content, 'base64').toString('utf8');
    state.sha = 'blob-2';
    return Response.json({ content: { sha: 'blob-2' }, commit: { sha: 'c0ffee1234567890' } });
  }) as typeof fetch;
  return { impl, calls, state };
}

const deps = (gh: ReturnType<typeof fakeGithub>, more: Partial<PublishDeps> = {}): PublishDeps => ({
  refreshToken: 'secret',
  githubToken: 'gh-token',
  githubRepo: 'aidea-systems/upuprecko',
  fetchImpl: gh.impl,
  now: () => new Date('2026-11-19T23:30:00.000Z'), // already 20 Nov in Zagreb
  ...more,
});
const post = (body: unknown, token: string | null = 'secret') => ({ method: 'POST', token: token ?? undefined, body });

afterEach(() => vi.restoreAllMocks());

describe('publish: who may call it', () => {
  it('answers 503 when REFRESH_TOKEN, GITHUB_TOKEN or GITHUB_REPO is missing, and calls nothing', async () => {
    const gh = fakeGithub(fileText(published()));
    const body = { doc: makeDoc(), baseSavedAt: BASE };
    expect(await publish(post(body), deps(gh, { refreshToken: undefined }))).toMatchObject({ status: 503, body: { error: 'not_configured' } });
    expect(await publish(post(body), deps(gh, { githubToken: undefined }))).toMatchObject({ status: 503 });
    expect(await publish(post(body), deps(gh, { githubRepo: '' }))).toMatchObject({ status: 503 });
    expect(await publish(post(body), deps(gh, { githubRepo: 'not a repo' }))).toMatchObject({ status: 503 });
    expect(gh.calls).toHaveLength(0);
  });

  it('answers 401 for a missing or wrong token, and calls nothing', async () => {
    const gh = fakeGithub(fileText(published()));
    const body = { doc: makeDoc(), baseSavedAt: BASE };
    expect(await publish(post(body, null), deps(gh))).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    expect(await publish(post(body, 'Secret'), deps(gh))).toMatchObject({ status: 401 });
    expect(await publish(post(body, 'gh-token'), deps(gh))).toMatchObject({ status: 401 });
    expect(gh.calls).toHaveLength(0);
  });

  it('answers 405 for anything but POST', async () => {
    const gh = fakeGithub(fileText(published()));
    expect(await publish({ ...post({}), method: 'GET' }, deps(gh))).toMatchObject({ status: 405 });
    expect(await publish({ ...post({}), method: 'PUT' }, deps(gh))).toMatchObject({ status: 405 });
  });
});

describe('publish: what it accepts', () => {
  const bad = async (body: unknown) => {
    const gh = fakeGithub(fileText(published()));
    const a = await publish(post(body), deps(gh));
    expect(gh.calls, 'nothing is asked of GitHub for an invalid body').toHaveLength(0);
    return a;
  };

  it('answers 400 when the body is not { doc, baseSavedAt }', async () => {
    for (const b of [undefined, null, 'x', [], {}, { doc: makeDoc() }, { doc: makeDoc(), baseSavedAt: 5 }, { doc: makeDoc(), baseSavedAt: BASE, extra: 1 }])
      expect(await bad(b)).toMatchObject({ status: 400, body: { error: 'invalid_body' } });
  });

  it('answers 400 for a document of the wrong shape, naming the place', async () => {
    const cases: [unknown, string][] = [
      [{ ...makeDoc(), version: 2 }, 'version'],
      [{ ...makeDoc(), savedAt: null }, 'savedAt'],
      [{ ...makeDoc(), savedAt: 'yesterday' }, 'savedAt'],
      [{ ...makeDoc(), plots: {} }, 'plots (count)'],
      [{ ...makeDoc(), plots: [] }, 'plots, reviews, edits'],
      [{ ...makeDoc(), reviews: undefined }, 'plots, reviews, edits'],
      [{ ...makeDoc(), somethingElse: 1 }, 'document'],
      [{ ...makeDoc(), registryCheckedAt: 'x' }, 'registryCheckedAt'],
      [makeDoc({ plots: { '1': { ...rec(), status: 'mine' as never } } }), 'plots["1"].status'],
      [makeDoc({ plots: { '1': { ...rec(), owners: [{ name: 'A', share: '1', oib: '11111111111' } as never] } } }), 'plots["1"].owners'],
      [makeDoc({ plots: { '1': { ...rec(), notes: 5 as never } } }), 'plots["1"] (ourShare, contact, notes)'],
      [makeDoc({ plots: { '1': { ...rec(), secret: 'x' } as never } }), 'plots["1"]'],
      [makeDoc({ plots: { '1': { ...rec(), registry: { parcelId: 'x' } as never } } }), 'plots["1"].registry'],
      [makeDoc({ plots: { '': rec() } }), 'plots (key)'],
      [makeDoc({ reviews: { r1: { type: 'plot', resolvedAt: NOW } as never } }), 'reviews["r1"]'],
      [makeDoc({ edits: { e1: { editedAt: NOW } } }), 'edits["e1"]'],
      [makeDoc({ edits: { e1: { editedAt: NOW, geometry: { type: 'Polygon', coordinates: [[[1, 2], [3, 'x']]] } as never, area_m2: 1 } } }), 'edits["e1"].geometry'],
    ];
    for (const [doc, where] of cases) expect(await bad({ doc, baseSavedAt: BASE }), where).toEqual({ status: 400, body: { error: 'invalid_document', detail: where } });
  });

  it('accepts the real ownership file and every document the app can produce from it', () => {
    const real = JSON.parse(readFileSync(join(__dirname, '..', '..', 'upu-precko-zapad-map-data', '_backup_before_oss_update', 'ownership.json'), 'utf8'));
    const checked = checkDoc(normalizeDoc(real));
    expect('doc' in checked && checked.doc).toEqual(real);
    const edited = makeDoc({
      reviews: { r1: { type: 'plot', plotNumber: '1', resolvedAt: NOW }, r2: { type: 'not_plot', resolvedAt: NOW } },
      edits: {
        a: { plotNumber: '77', editedAt: NOW },
        b: { geometry: { type: 'Polygon', coordinates: [[[15.9, 45.79], [15.91, 45.79], [15.91, 45.8], [15.9, 45.79]]] }, area_m2: 10.5, area_in_upu_m2: 3, zones: [{ zone: 'M1-1', overlap_m2: 3 }], editedAt: NOW },
      },
    });
    const again = checkDoc(JSON.parse(JSON.stringify(edited)));
    expect('doc' in again && again.doc).toEqual(edited);
  });
});

describe('publish: committing', () => {
  it('commits the file to main and returns the commit sha', async () => {
    const gh = fakeGithub(fileText(published()));
    const doc = makeDoc();
    const a = await publish(post({ doc, baseSavedAt: BASE }), deps(gh));
    expect(a).toEqual({ status: 200, body: { ok: true, commit: 'c0ffee1234567890', savedAt: NOW } });

    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.com/repos/aidea-systems/upuprecko/contents/app/data/ownership.json?ref=main',
      'PUT https://api.github.com/repos/aidea-systems/upuprecko/contents/app/data/ownership.json',
    ]);
    for (const c of gh.calls) {
      expect(c.headers.Authorization).toBe('Bearer gh-token');
      expect(c.headers['User-Agent']).toBeTruthy();
      expect(c.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    }
    const put = gh.calls[1].body!;
    expect(put.branch).toBe('main');
    expect(put.sha).toBe('blob-1');
    expect(put.message).toBe('Update ownership from land registry (20 Nov 2026)'); // the date in Zagreb
    const written = Buffer.from(put.content, 'base64').toString('utf8');
    expect(written).toBe(JSON.stringify(doc, null, 2) + '\n');
    expect(normalizeDoc(JSON.parse(written))).toEqual(doc); // the app reads back exactly what was published
    expect(written).toContain('DONJE VRAPČE'); // UTF-8 survives
  });

  it('answers 409 and commits nothing when the published file is not the one the caller started from', async () => {
    const gh = fakeGithub(fileText(published('2026-11-18T08:00:00.000Z')));
    const a = await publish(post({ doc: makeDoc(), baseSavedAt: BASE }), deps(gh));
    expect(a).toEqual({ status: 409, body: { error: 'conflict', publishedSavedAt: '2026-11-18T08:00:00.000Z' } });
    expect(gh.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('answers 409 when the file changes between the read and the write', async () => {
    const gh = fakeGithub(fileText(published()), { putStatus: 409 });
    expect(await publish(post({ doc: makeDoc(), baseSavedAt: BASE }), deps(gh))).toMatchObject({ status: 409, body: { error: 'conflict' } });
  });

  it('answers 409 when the published file cannot be read as a document', async () => {
    const gh = fakeGithub('not json');
    expect(await publish(post({ doc: makeDoc(), baseSavedAt: BASE }), deps(gh))).toMatchObject({ status: 409 });
    expect(gh.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('treats a repeated request for a document that is already published as done, without a second commit', async () => {
    const gh = fakeGithub(fileText(published()));
    const body = { doc: makeDoc(), baseSavedAt: BASE };
    expect((await publish(post(body), deps(gh))).status).toBe(200);
    const again = await publish(post(body), deps(gh));
    expect(again).toEqual({ status: 200, body: { ok: true, commit: null, alreadyPublished: true, savedAt: NOW } });
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('refuses a document that would drop most of the published plots', async () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), rec()]));
    const gh = fakeGithub(fileText(published(BASE, many)));
    const a = await publish(post({ doc: makeDoc(), baseSavedAt: BASE }), deps(gh));
    expect(a).toMatchObject({ status: 422, body: { error: 'too_few_plots' } });
    expect(gh.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('reads a published file of over 1 MB, which GitHub sends without content, as raw text', async () => {
    const gh = fakeGithub(fileText(published()), { noContent: true });
    expect((await publish(post({ doc: makeDoc(), baseSavedAt: BASE }), deps(gh))).status).toBe(200);
    expect(gh.calls.map((c) => `${c.method} ${c.headers.Accept}`)).toEqual(['GET application/vnd.github+json', 'GET application/vnd.github.raw+json', 'PUT application/vnd.github+json']);
  });

  it('answers 502 when GitHub refuses, 504 when it does not answer, and logs neither the document nor a token', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = { doc: makeDoc(), baseSavedAt: BASE };
    expect(await publish(post(body), deps(fakeGithub(null)))).toEqual({ status: 502, body: { error: 'github', step: 'read', githubStatus: 404 } });
    expect(await publish(post(body), deps(fakeGithub(fileText(published()), { getStatus: 401 })))).toMatchObject({ status: 502, body: { step: 'read', githubStatus: 401 } });
    expect(await publish(post(body), deps(fakeGithub(fileText(published()), { putStatus: 403 })))).toEqual({ status: 502, body: { error: 'github', step: 'write', githubStatus: 403 } });

    const down = { ...fakeGithub(''), impl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch };
    expect(await publish(post(body), deps(down))).toMatchObject({ status: 502, body: { step: 'read', githubStatus: null } });

    const real = globalThis.AbortController;
    vi.stubGlobal('AbortController', class { signal = { aborted: true }; abort() {} });
    expect(await publish(post(body), deps(down))).toMatchObject({ status: 504 });
    vi.stubGlobal('AbortController', real);

    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('github read: 404');
    expect(logged).not.toMatch(/IVIĆ|gh-token|secret|6356/);
  });

  it('logs nothing on success', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await publish(post({ doc: makeDoc(), baseSavedAt: BASE }), deps(fakeGithub(fileText(published()))));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('the HTTP handler', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  /** Runs the handler behind a real HTTP server; `vercelBody` imitates Vercel, which reads the body first. */
  async function serve(gh: ReturnType<typeof fakeGithub>, more: Partial<PublishDeps> = {}, vercelBody?: () => unknown) {
    const handler = createPublishHandler(() => deps(gh, more));
    server = createServer((req, res) => {
      if (!vercelBody) return void handler(req, res);
      req.resume();
      req.on('end', () => {
        Object.defineProperty(req, 'body', { get: vercelBody });
        void handler(req, res);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/publish`;
    return (body: string, headers: Record<string, string> = { 'X-Refresh-Token': 'secret' }, method = 'POST') =>
      fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : body });
  }

  it('publishes a posted document and answers with JSON and Cache-Control: no-store', async () => {
    const gh = fakeGithub(fileText(published()));
    const call = await serve(gh);
    const r = await call(JSON.stringify({ doc: makeDoc(), baseSavedAt: BASE }));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ ok: true, commit: 'c0ffee1234567890', savedAt: NOW });
    expect(JSON.parse(gh.state.text!).registryCheckedAt).toBe(NOW);
  });

  it('refuses without reading the body: 401, 405, 503', async () => {
    const gh = fakeGithub(fileText(published()));
    const call = await serve(gh);
    const body = JSON.stringify({ doc: makeDoc(), baseSavedAt: BASE });
    expect((await call(body, {})).status).toBe(401);
    expect((await call(body, { 'X-Refresh-Token': 'wrong' })).status).toBe(401);
    expect((await call('', { 'X-Refresh-Token': 'secret' }, 'GET')).status).toBe(405);
    server!.close();
    const off = await serve(gh, { githubToken: undefined });
    expect((await off(body)).status).toBe(503);
    expect(gh.calls).toHaveLength(0);
  });

  it('answers 400 for a body that is not JSON and 413 for one over 2 MB', async () => {
    const gh = fakeGithub(fileText(published()));
    const call = await serve(gh);
    const notJson = await call('{"doc": ');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'invalid_json' });

    const big = makeDoc({ plots: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [String(i + 1), rec({ notes: 'x'.repeat(19000) })])) });
    const text = JSON.stringify({ doc: big, baseSavedAt: BASE });
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_BODY_BYTES);
    const tooBig = await call(text);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ error: 'too_large' });
    expect(gh.calls).toHaveLength(0);
  });

  it('accepts a body just under the limit', async () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i + 1), rec({ notes: 'x'.repeat(19000) })]));
    const gh = fakeGithub(fileText(published(BASE, many)));
    const call = await serve(gh);
    const text = JSON.stringify({ doc: makeDoc({ plots: many }), baseSavedAt: BASE });
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_BODY_BYTES);
    expect((await call(text)).status).toBe(200);
  });

  it('works where the runtime has already read the body (Vercel): parsed object, invalid JSON, oversize', async () => {
    const gh = fakeGithub(fileText(published()));
    const body = { doc: makeDoc(), baseSavedAt: BASE };
    let call = await serve(gh, {}, () => body);
    expect((await call(JSON.stringify(body))).status).toBe(200);
    server!.close();

    call = await serve(gh, {}, () => { throw new Error('Invalid JSON'); });
    expect((await call('{')).status).toBe(400);
    server!.close();

    const big = { doc: makeDoc({ plots: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [String(i + 1), rec({ notes: 'x'.repeat(19000) })])) }), baseSavedAt: BASE };
    call = await serve(gh, {}, () => big);
    expect((await call('{}')).status).toBe(413);
  });
});
