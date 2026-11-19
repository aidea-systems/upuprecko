import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlotsFC } from '../src/types';
import type { OssParcelResult } from '../src/lib/ossParcel';
import { answer, createNodeHandler, fetchParcel, normalise, sameSecret, type Deps } from './ossParcel';
import { OSS_PARCEL_IDS } from './parcelAllowlist.generated';

const fixture = (f: string): unknown => JSON.parse(readFileSync(join(__dirname, '..', 'test-fixtures', 'oss', f), 'utf8'));
/** Real answers for plot 6356/1, k.o. Donje Vrapče, read on 19 Nov 2026. */
const parcelInfo = fixture('parcel-info-41106113.json');
const lrUnit = fixture('lr-unit-1000-250235.json');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fetch that answers from a list, one entry per call; records what was asked. */
function fakeFetch(answers: (Response | Error | (() => Response))[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const a = answers[calls.length - 1];
    if (a === undefined) throw new Error('unexpected extra call');
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a() : a;
  }) as typeof fetch;
  return { impl, calls };
}

const deps = (f: ReturnType<typeof fakeFetch>, more: Partial<Deps> = {}): Deps => ({
  token: 'secret',
  fetchImpl: f.impl,
  sleep: async () => undefined,
  ...more,
});
/** A request with the right token unless another one (or null = no header) is given. */
const get = (parcelId: string | number, token: string | null = 'secret') => ({ method: 'GET', url: `/api/oss-parcel?parcelId=${parcelId}`, token: token ?? undefined });

afterEach(() => vi.restoreAllMocks());

describe('normalise', () => {
  it('reads plot 6356/1 from the two sample answers', () => {
    expect(normalise(parcelInfo, lrUnit)).toEqual<OssParcelResult>({
      parcelId: 41106113,
      parcelNumber: '6356/1',
      municipalityRegNum: '339318',
      registeredArea: 2629,
      isHarmonized: true,
      lrUnit: {
        number: '1000',
        mainBookId: 250235,
        mainBookName: 'DONJE VRAPČE',
        lastDiaryNumber: 'Z-55014/2026',
        condominiums: false,
        verificated: true,
        activePlumbs: [],
      },
      shares: [
        { share: '1790/2803', rawDescription: '1. Suvlasnički dio: 1790/2803', hasSubShares: false, annotations: 0, owners: [{ name: 'Opatovina projekt d.o.o.', oib: '75108231896' }] },
        { share: '587/2803', rawDescription: '2. Suvlasnički dio: 587/2803', hasSubShares: false, annotations: 0, owners: [{ name: 'PROJEKT MAKSIMUS d.o.o.', oib: '86374543635' }] },
        { share: '426/2803', rawDescription: '3. Suvlasnički dio: 426/2803', hasSubShares: false, annotations: 0, owners: [{ name: 'OPATOVINA PROJEKT d.o.o.', oib: '75108231896' }] },
      ],
    });
  });

  it('does not take anything from the cadastre possessors', () => {
    const out = JSON.stringify(normalise(parcelInfo, lrUnit));
    const possessors = (parcelInfo as { possessionSheets: { possessors: { name: string }[] }[] }).possessionSheets.flatMap((s) => s.possessors.map((p) => p.name.trim()));
    expect(possessors.length).toBeGreaterThan(0);
    // FLAMMULA and SIGILLUM are possessors in the cadastre but not owners in the land registry
    expect(out).not.toContain('FLAMMULA');
    expect(out).not.toContain('SIGILLUM');
  });

  it('gives lrUnit null and no shares when the cadastre names no land-registry unit', () => {
    const { lrUnit: _drop, ...noUnit } = parcelInfo as Record<string, unknown>;
    const r = normalise(noUnit);
    expect(r.lrUnit).toBeNull();
    expect(r.shares).toEqual([]);
    expect(r.parcelNumber).toBe('6356/1');
  });

  // The shapes below were seen in other units on 19 Nov 2026; names here are invented.
  const unitWith = (shares: unknown[], more: Record<string, unknown> = {}) => [
    { lrUnitId: 13858397, lrUnitNumber: '1000', mainBookId: 250235, mainBookName: 'DONJE VRAPČE', verificated: true, condominiums: false, activePlumbs: [], ownershipSheetB: { lrUnitShares: shares }, ...more },
  ];

  it('reads pending registrations (plombe) as file numbers', () => {
    const r = normalise(parcelInfo, unitWith([], { activePlumbs: [{ cadPlumb: false, fileNumber: 'Z-55230/2026' }, { cadPlumb: false, fileNumber: 'Z-55227/2026' }] }));
    expect(r.lrUnit!.activePlumbs).toEqual(['Z-55230/2026', 'Z-55227/2026']);
  });

  it('gives null for a missing last diary number', () => {
    expect(normalise(parcelInfo, unitWith([])).lrUnit!.lastDiaryNumber).toBeNull();
  });

  it('treats a predbilježba (a share without owner whose sub-entry names a person) as a sub-share', () => {
    const r = normalise(
      parcelInfo,
      unitWith([
        {
          description: '6. Suvlasnički dio: 363/1038',
          subSharesAndEntries: [
            { description: 'Zaprimljeno 03.08.2026.g. pod brojem Z-1/2026<br>PREDBILJEŽBA, PRAVO VLASNIŠTVA', lrOwners: [{ name: 'KUPAC d.o.o.', taxNumber: '12345678901' }], lrEntryId: 1, orderNumber: '6.1' },
          ],
        },
      ]),
    );
    expect(r.shares[0]).toMatchObject({ share: '363/1038', hasSubShares: true, annotations: 0, owners: [] });
  });

  it('counts a remark that names nobody as an annotation, not as a sub-share', () => {
    const r = normalise(
      parcelInfo,
      unitWith([
        {
          description: '1. Suvlasnički dio: 29/120',
          lrOwners: [{ name: 'IVIĆ IVO', taxNumber: '11111111111' }],
          subSharesAndEntries: [{ description: 'Zaprimljeno 22.05.2026.g. pod brojem Z-2/2026<br>ZABILJEŽBA, ODBIJENI PRIJEDLOG', lrEntryId: 2, orderNumber: '1.1' }],
        },
      ]),
    );
    expect(r.shares[0]).toMatchObject({ share: '29/120', hasSubShares: false, annotations: 1 });
  });

  it('treats a remark that mentions a predbilježba, or a nested share, as a sub-share', () => {
    const r = normalise(
      parcelInfo,
      unitWith([
        { description: '1. Suvlasnički dio: 1/2', lrOwners: [{ name: 'A' }], subSharesAndEntries: [{ description: 'PREDBILJEŽBA prava vlasništva', lrEntryId: 3 }] },
        { description: '2. Suvlasnički dio: 1/2', lrOwners: [{ name: 'B' }], subSharesAndEntries: [{ description: '2.1 Suvlasnički dio: 1/4', lrEntryId: 4 }] },
      ]),
    );
    expect(r.shares.map((s) => s.hasSubShares)).toEqual([true, true]);
  });

  it('takes the holder of a public good from publicOrCommonGood', () => {
    const r = normalise(parcelInfo, unitWith([{ description: '1. Vlasnički dio: 1/1', subSharesAndEntries: [], publicOrCommonGood: 'JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRAD ZAGREB, OIB: 61817894937' }]));
    expect(r.shares[0]).toMatchObject({ share: '1/1', owners: [{ name: 'JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRAD ZAGREB, OIB: 61817894937' }] });
  });

  it('reports condominium ownership and leaves a share without a fraction as null', () => {
    const r = normalise(
      parcelInfo,
      unitWith([{ description: '1. Suvlasnički dio s neodređenim omjerom ETAŽNO VLASNIŠTVO (E-1)', condominiumNumber: 'E-1', condominiums: ['STAN'], lrOwners: [{ name: 'A' }, { name: 'B', taxNumber: '22222222222' }] }]),
    );
    expect(r.lrUnit!.condominiums).toBe(true);
    expect(r.shares[0]).toMatchObject({ share: null, owners: [{ name: 'A' }, { name: 'B', oib: '22222222222' }] });
  });

  it('keeps only OIBs of 11 digits and tidies spaces in names', () => {
    const r = normalise(parcelInfo, unitWith([{ description: '1. Vlasnički dio: 1/1', lrOwners: [{ name: '  IVIĆ   IVO ', taxNumber: '123' }] }]));
    expect(r.shares[0].owners).toEqual([{ name: 'IVIĆ IVO' }]);
  });

  it('refuses an answer that does not contain the unit the cadastre names', () => {
    expect(() => normalise(parcelInfo, [])).toThrow();
    expect(() => normalise(parcelInfo, [{ lrUnitId: 1, lrUnitNumber: '999', mainBookId: 250235 }])).toThrow();
    expect(() => normalise({ foo: 1 })).toThrow();
  });
});

describe('fetchParcel', () => {
  it('asks parcel-info, then lr-unit with the unit the cadastre names', async () => {
    const f = fakeFetch([json(parcelInfo), json(lrUnit)]);
    const r = await fetchParcel(41106113, deps(f));
    expect(r.parcelNumber).toBe('6356/1');
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://oss.uredjenazemlja.hr/oss/public/cad/parcel-info?parcelId=41106113',
      'https://oss.uredjenazemlja.hr/oss/public/lr/lr-unit?lrUnitNumber=1000&mainBookId=250235&historicalOverview=false',
    ]);
    for (const c of f.calls) {
      expect(c.headers.Accept).toBe('application/json');
      expect(c.headers['User-Agent']).toBeTruthy();
    }
  });

  it('makes one call only when the parcel has no land-registry unit', async () => {
    const { lrUnit: _drop, ...noUnit } = parcelInfo as Record<string, unknown>;
    const f = fakeFetch([json(noUnit)]);
    expect((await fetchParcel(41106113, deps(f))).lrUnit).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it('retries on 5xx and on network errors, waiting longer each time', async () => {
    const waits: number[] = [];
    const f = fakeFetch([json({}, 503), new TypeError('fetch failed'), json(parcelInfo), json({}, 500), json(lrUnit)]);
    const r = await fetchParcel(41106113, deps(f, { sleep: async (ms) => void waits.push(ms) }));
    expect(r.shares).toHaveLength(3);
    expect(f.calls).toHaveLength(5);
    expect(waits).toEqual([500, 1000, 500]);
  });

  it('gives up after three retries', async () => {
    const f = fakeFetch([json({}, 502), json({}, 502), json({}, 502), json({}, 502)]);
    await expect(fetchParcel(41106113, deps(f))).rejects.toMatchObject({ stage: 'parcel-info', reason: 'http', upstreamStatus: 502 });
    expect(f.calls).toHaveLength(4);
  });

  it('does not retry a 4xx answer', async () => {
    const f = fakeFetch([json({}, 404)]);
    await expect(fetchParcel(41106113, deps(f))).rejects.toMatchObject({ stage: 'parcel-info', reason: 'http', upstreamStatus: 404 });
    expect(f.calls).toHaveLength(1);
  });

  it('stops when the time for the whole request is used up', async () => {
    let t = 0;
    const f = fakeFetch([() => ((t += 24_800), json({}, 503)), json(parcelInfo)]);
    await expect(fetchParcel(41106113, deps(f, { now: () => t }))).rejects.toMatchObject({ stage: 'parcel-info' });
    expect(f.calls).toHaveLength(1);
  });

  it('reports an answer that is not JSON', async () => {
    const f = fakeFetch([new Response('<html>', { status: 200 })]);
    await expect(fetchParcel(41106113, deps(f))).rejects.toMatchObject({ stage: 'parcel-info', reason: 'invalid' });
  });
});

describe('answer (the HTTP rules)', () => {
  it('answers 503 when no token is configured, before anything else', async () => {
    const f = fakeFetch([]);
    expect(await answer(get(41106113, 'whatever'), deps(f, { token: undefined }))).toMatchObject({ status: 503, body: { error: 'not_configured' } });
    expect(await answer(get(41106113, ''), deps(f, { token: '' }))).toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(0);
  });

  it('answers 401 for a missing or wrong token and calls nothing', async () => {
    const f = fakeFetch([]);
    expect(await answer(get(41106113, null), deps(f))).toMatchObject({ status: 401 });
    expect(await answer(get(41106113, 'secreT'), deps(f))).toMatchObject({ status: 401 });
    expect(await answer(get(41106113, 'secret '), deps(f))).toMatchObject({ status: 401 });
    expect(await answer(get('not-a-number', 'wrong'), deps(f))).toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(0);
  });

  it('answers 400 for a parcelId that is not a whole number', async () => {
    const f = fakeFetch([]);
    for (const bad of ['', 'abc', '41106113x', '-5', '1.5', '0', '41106113%20'])
      expect(await answer(get(bad), deps(f)), bad).toMatchObject({ status: 400, body: { error: 'invalid_parcel_id' } });
    expect(await answer({ method: 'GET', url: '/api/oss-parcel', token: 'secret' }, deps(f))).toMatchObject({ status: 400 });
    expect(f.calls).toHaveLength(0);
  });

  it('answers 403 for a parcel that is not on the map', async () => {
    const f = fakeFetch([]);
    expect(await answer(get(12345678), deps(f))).toMatchObject({ status: 403, body: { error: 'parcel_not_allowed' } });
    expect(f.calls).toHaveLength(0);
  });

  it('answers 405 for anything but GET', async () => {
    const f = fakeFetch([]);
    expect(await answer({ ...get(41106113), method: 'POST' }, deps(f))).toMatchObject({ status: 405 });
  });

  it('answers 200 with the normalised result', async () => {
    const f = fakeFetch([json(parcelInfo), json(lrUnit)]);
    const a = await answer(get(41106113), deps(f));
    expect(a.status).toBe(200);
    expect((a.body as OssParcelResult).lrUnit?.number).toBe('1000');
  });

  it('answers 502 when OSS fails, 504 when it does not answer in time, and logs no part of an answer', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fakeFetch([json(parcelInfo), json({}, 404)]);
    expect(await answer(get(41106113), deps(f))).toEqual({ status: 502, body: { error: 'upstream', stage: 'lr-unit', reason: 'http', upstreamStatus: 404 } });

    let t = 0;
    const slow = fakeFetch([() => ((t += 30_000), json({}, 503))]);
    expect(await answer(get(41106113), deps(slow, { now: () => t }))).toMatchObject({ status: 502, body: { stage: 'parcel-info', upstreamStatus: 503 } });

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    let t2 = 0;
    const hung = fakeFetch([() => { t2 += 30_000; throw abort; }]);
    const real = globalThis.AbortController;
    // a call that ran into its time limit: the abort signal is set when fetch throws
    vi.stubGlobal('AbortController', class { signal = { aborted: true }; abort() {} });
    expect(await answer(get(41106113), deps(hung, { now: () => t2 }))).toMatchObject({ status: 504, body: { reason: 'timeout' } });
    vi.stubGlobal('AbortController', real);

    const unitWithoutMatch = fakeFetch([json(parcelInfo), json([])]);
    expect(await answer(get(41106113), deps(unitWithoutMatch))).toMatchObject({ status: 502, body: { stage: 'lr-unit', reason: 'invalid' } });

    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('41106113');
    expect(logged).not.toMatch(/opatovina|maksimus|75108231896|86374543635/i);
  });

  it('logs nothing at all on success', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await answer(get(41106113), deps(fakeFetch([json(parcelInfo), json(lrUnit)])));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('sameSecret', () => {
  it('is true only for identical secrets, whatever their lengths', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('', 'abc')).toBe(false);
    expect(sameSecret('šđ', 'šđ')).toBe(true);
  });
});

describe('the Node handler', () => {
  const run = async (headers: Record<string, string>, token: string | undefined, f = fakeFetch([json(parcelInfo), json(lrUnit)])) => {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' };
    const res = {
      set statusCode(v: number) { out.status = v; },
      setHeader: (k: string, v: string) => void (out.headers[k.toLowerCase()] = v),
      end: (b: string) => void (out.body = b),
    } as unknown as ServerResponse;
    // under Vite the mount path is cut off req.url, on Vercel it is not - both must work
    const req = { method: 'GET', url: '/?parcelId=41106113', headers } as unknown as IncomingMessage;
    await createNodeHandler(() => token, { fetchImpl: f.impl, sleep: async () => undefined })(req, res);
    return out;
  };

  it('sends JSON with Cache-Control: no-store on success and on refusal', async () => {
    const ok = await run({ 'x-refresh-token': 'secret' }, 'secret');
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['content-type']).toContain('application/json');
    expect(JSON.parse(ok.body).parcelNumber).toBe('6356/1');

    const refused = await run({}, 'secret');
    expect(refused.status).toBe(401);
    expect(refused.headers['cache-control']).toBe('no-store');

    expect((await run({ 'x-refresh-token': 'secret' }, undefined)).status).toBe(503);
  });
});

describe('the allowlist', () => {
  it('holds exactly the OSS parcel ids of the plots on the map', () => {
    const plots: PlotsFC = JSON.parse(readFileSync(join(__dirname, '..', '..', 'upu-precko-zapad-map-data', 'plots.geojson'), 'utf8'));
    const ids = plots.features.map((f) => f.properties.oss_parcel_id!).sort((a, b) => a - b);
    expect([...OSS_PARCEL_IDS]).toEqual(ids);
  });
});
