/**
 * Server side of "Refresh ownership": asks the two public OSS services (oss.uredjenazemlja.hr) about one
 * parcel and returns the land-registry owners in a fixed shape. Used by the Vercel function
 * (api/oss-parcel.ts) and by the Vite dev server (vite.config.ts) - the same handler in both.
 *
 * Nothing here writes owner names or OIBs to a log.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseShare, type OssLrUnit, type OssOwner, type OssParcelResult, type OssShare } from '../src/lib/ossParcel.js';
import { OSS_PARCEL_IDS } from './parcelAllowlist.generated.js';

const OSS = 'https://oss.uredjenazemlja.hr/oss/public';
const USER_AGENT = 'plot-ownership-map/1.0';
/** One upstream call may take this long. */
const CALL_TIMEOUT_MS = 15_000;
/** Retries after the first attempt, on network errors and 5xx answers. */
const RETRIES = 3;
const BACKOFF_MS = [500, 1000, 2000];
/** Everything must be answered within this time; the function itself is stopped at 30 s (maxDuration). */
const BUDGET_MS = 25_000;

const ALLOWED = new Set<number>(OSS_PARCEL_IDS);

// ---------- reading the OSS answers ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').replace(/\s+/g, ' ').trim();
const stripTags = (s: string) => s.replace(/<[^>]*>/g, ' ');

function owners(list: unknown): OssOwner[] {
  const out: OssOwner[] = [];
  for (const o of arr(list)) {
    if (!isObj(o)) continue;
    const name = text(o.name);
    if (!name) continue;
    const oib = text(o.taxNumber);
    out.push(/^\d{11}$/.test(oib) ? { name, oib } : { name });
  }
  return out;
}

/**
 * An item of subSharesAndEntries is a plain remark only if it names nobody, holds nothing nested and is
 * neither a share nor a predbilježba. Anything else is treated as a sub-share.
 */
function isPlainRemark(item: unknown): boolean {
  if (!isObj(item)) return false;
  if (arr(item.lrOwners).length || arr(item.subSharesAndEntries).length || arr(item.lrUnitShares).length) return false;
  const d = stripTags(text(item.description));
  return !!d && !/predbilje[zž]b/i.test(d) && !/\bdio\s*:/i.test(d);
}

function share(raw: unknown): OssShare | null {
  if (!isObj(raw)) return null;
  const rawDescription = text(raw.description);
  const sub = arr(raw.subSharesAndEntries);
  let who = owners(raw.lrOwners);
  // public goods have no owner entry; the holder is in publicOrCommonGood
  if (!who.length && text(raw.publicOrCommonGood)) who = [{ name: text(raw.publicOrCommonGood) }];
  return {
    share: parseShare(rawDescription),
    rawDescription,
    hasSubShares: sub.some((s) => !isPlainRemark(s)),
    annotations: sub.filter(isPlainRemark).length,
    owners: who,
  };
}

export class OssFormatError extends Error {}

/** The link from the cadastre to the land registry, or null when the parcel has none. */
export function lrUnitRef(parcelInfo: unknown): { lrUnitNumber: string; mainBookId: number; lrUnitId: number | null } | null {
  if (!isObj(parcelInfo) || !isObj(parcelInfo.lrUnit)) return null;
  const u = parcelInfo.lrUnit;
  const lrUnitNumber = text(u.lrUnitNumber);
  const mainBookId = Number(u.mainBookId);
  if (!lrUnitNumber || !Number.isInteger(mainBookId)) return null;
  return { lrUnitNumber, mainBookId, lrUnitId: Number.isInteger(u.lrUnitId) ? (u.lrUnitId as number) : null };
}

/**
 * Builds the answer from the two OSS responses. `lrUnitResponse` is the array returned by lr-unit
 * (undefined when the parcel has no land-registry unit). The cadastre possessors are not read at all.
 */
export function normalise(parcelInfo: unknown, lrUnitResponse?: unknown): OssParcelResult {
  if (!isObj(parcelInfo) || !Number.isInteger(parcelInfo.parcelId) || !text(parcelInfo.parcelNumber))
    throw new OssFormatError('parcel-info: unexpected answer');
  const area = Number(text(parcelInfo.area));
  const result: OssParcelResult = {
    parcelId: parcelInfo.parcelId as number,
    parcelNumber: text(parcelInfo.parcelNumber),
    municipalityRegNum: text(parcelInfo.cadMunicipalityRegNum),
    registeredArea: text(parcelInfo.area) && Number.isFinite(area) ? area : null,
    isHarmonized: parcelInfo.isHarmonized === true,
    lrUnit: null,
    shares: [],
  };
  const ref = lrUnitRef(parcelInfo);
  if (!ref) return result;

  const units = arr(lrUnitResponse).filter(isObj);
  const unit =
    units.find((u) => ref.lrUnitId !== null && u.lrUnitId === ref.lrUnitId) ??
    units.find((u) => text(u.lrUnitNumber) === ref.lrUnitNumber && Number(u.mainBookId) === ref.mainBookId);
  if (!unit) throw new OssFormatError('lr-unit: the unit named by the cadastre was not returned');

  const sheetB = isObj(unit.ownershipSheetB) ? unit.ownershipSheetB : {};
  const shares = arr(sheetB.lrUnitShares).map(share).filter((s): s is OssShare => s !== null);
  const rawShares = arr(sheetB.lrUnitShares).filter(isObj);
  const lrUnit: OssLrUnit = {
    number: text(unit.lrUnitNumber),
    mainBookId: Number(unit.mainBookId),
    mainBookName: text(unit.mainBookName),
    lastDiaryNumber: text(unit.lastDiaryNumber) || null,
    condominiums:
      unit.condominiums === true ||
      (parcelInfo.lrUnit as Obj).condominiums === true ||
      rawShares.some((s) => !!text(s.condominiumNumber) || arr(s.condominiums).length > 0),
    verificated: unit.verificated === true,
    activePlumbs: arr(unit.activePlumbs)
      .map((p) => (isObj(p) ? text(p.fileNumber) || '?' : text(p) || '?'))
      .filter((p, i, all) => all.indexOf(p) === i),
  };
  return { ...result, lrUnit, shares };
}

// ---------- calling OSS ----------

export class UpstreamError extends Error {
  constructor(
    public stage: 'parcel-info' | 'lr-unit',
    public reason: 'http' | 'network' | 'timeout' | 'invalid',
    public upstreamStatus?: number,
  ) {
    super(`${stage}: ${reason}${upstreamStatus ? ` ${upstreamStatus}` : ''}`);
  }
}

export interface Deps {
  /** The secret the caller must send; undefined = not configured. */
  token: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  allowed?: ReadonlySet<number>;
}

async function getJson(stage: UpstreamError['stage'], url: string, deadline: number, deps: Required<Pick<Deps, 'fetchImpl' | 'sleep' | 'now'>>): Promise<unknown> {
  let last: UpstreamError = new UpstreamError(stage, 'timeout');
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await deps.sleep(BACKOFF_MS[attempt - 1]);
    const left = deadline - deps.now();
    if (left < 500) throw last; // out of time: report the last failure (a timeout if there was none)
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(CALL_TIMEOUT_MS, left));
    try {
      const r = await deps.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: ctl.signal,
        redirect: 'follow',
      });
      if (r.status >= 500) {
        last = new UpstreamError(stage, 'http', r.status);
        continue; // retry
      }
      if (!r.ok) throw new UpstreamError(stage, 'http', r.status);
      try {
        return await r.json();
      } catch {
        throw new UpstreamError(stage, 'invalid');
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      last = new UpstreamError(stage, ctl.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/** Asks OSS about one parcel: parcel-info first, then lr-unit if the parcel has a land-registry unit. */
export async function fetchParcel(parcelId: number, deps: Pick<Deps, 'fetchImpl' | 'sleep' | 'now'> = {}): Promise<OssParcelResult> {
  const d = {
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  };
  const deadline = d.now() + BUDGET_MS;
  const info = await getJson('parcel-info', `${OSS}/cad/parcel-info?parcelId=${parcelId}`, deadline, d);
  const ref = lrUnitRef(info);
  if (!ref) return normalise(info);
  const q = new URLSearchParams({ lrUnitNumber: ref.lrUnitNumber, mainBookId: String(ref.mainBookId), historicalOverview: 'false' });
  const unit = await getJson('lr-unit', `${OSS}/lr/lr-unit?${q}`, deadline, d);
  return normalise(info, unit);
}

// ---------- the HTTP handler ----------

/** Compares two secrets without revealing, through timing, where they differ. */
export function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(a), h(b));
}

export interface Answer {
  status: number;
  body: unknown;
}

/**
 * GET ?parcelId=<number> with header X-Refresh-Token.
 * 405 other methods · 503 token not configured · 401 wrong/missing token · 400 parcelId not a number ·
 * 403 parcelId not one of the map's parcels · 502/504 OSS failed · 200 the result.
 */
export async function answer(req: { method?: string; url?: string; token?: string }, deps: Deps): Promise<Answer> {
  if (req.method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
  if (!deps.token) return { status: 503, body: { error: 'not_configured' } };
  if (typeof req.token !== 'string' || !sameSecret(req.token, deps.token)) return { status: 401, body: { error: 'unauthorized' } };

  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('parcelId') ?? '';
  if (!/^[1-9]\d{0,14}$/.test(raw)) return { status: 400, body: { error: 'invalid_parcel_id' } };
  const parcelId = Number(raw);
  if (!(deps.allowed ?? ALLOWED).has(parcelId)) return { status: 403, body: { error: 'parcel_not_allowed' } };

  try {
    return { status: 200, body: await fetchParcel(parcelId, deps) };
  } catch (e) {
    if (e instanceof UpstreamError) {
      // stage and status only - never any part of the answer
      console.error(`oss-parcel ${parcelId}: ${e.message}`);
      return { status: e.reason === 'timeout' ? 504 : 502, body: { error: 'upstream', stage: e.stage, reason: e.reason, upstreamStatus: e.upstreamStatus ?? null } };
    }
    if (e instanceof OssFormatError) {
      console.error(`oss-parcel ${parcelId}: ${e.message}`);
      return { status: 502, body: { error: 'upstream', stage: e.message.split(':')[0], reason: 'invalid', upstreamStatus: null } };
    }
    console.error(`oss-parcel ${parcelId}: internal error`);
    return { status: 500, body: { error: 'internal' } };
  }
}

/** Node (req, res) handler: the Vercel function and the Vite dev middleware both use this. */
export function createNodeHandler(getToken: () => string | undefined, extra: Omit<Deps, 'token'> = {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const header = req.headers['x-refresh-token'];
    let a: Answer;
    try {
      a = await answer({ method: req.method, url: req.url, token: typeof header === 'string' ? header : undefined }, { ...extra, token: getToken() });
    } catch {
      a = { status: 500, body: { error: 'internal' } };
    }
    res.statusCode = a.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(a.body));
  };
}
