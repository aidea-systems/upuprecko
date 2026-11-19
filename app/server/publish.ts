/**
 * Server side of publishing: POST /api/publish commits the ownership document to
 * app/data/ownership.json on the main branch through the GitHub Contents API. Vercel then builds and
 * deploys the site with the new data.
 *
 * Neither the document nor any token is ever written to a log.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeatureEdit, OwnershipDoc, PlotRecord, RegistryInfo, Resolution } from '../src/types.js';
import { sameSecret } from './ossParcel.js';

const GITHUB = 'https://api.github.com';
const FILE_PATH = 'app/data/ownership.json';
const BRANCH = 'main';
const USER_AGENT = 'plot-ownership-map/1.0';
/** Largest request body accepted. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const GITHUB_TIMEOUT_MS = 10_000;

// ---------- checking the document ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isDate = (v: unknown): v is string => isStr(v, 40) && !Number.isNaN(Date.parse(v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const onlyKeys = (o: Obj, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const STATUSES = ['owned', 'negotiating', 'not_owned', 'no_data'];

class Invalid extends Error {}
const need = (ok: boolean, what: string): void => {
  if (!ok) throw new Invalid(what);
};

function registry(v: unknown, at: string): RegistryInfo {
  need(isObj(v) && onlyKeys(v, ['parcelId', 'lrUnitNumber', 'mainBookId', 'mainBookName', 'lastDiaryNumber', 'activePlumbs', 'checkedAt']), `${at}.registry`);
  const r = v as Obj;
  need(Number.isInteger(r.parcelId) && isStr(r.lrUnitNumber, 40) && Number.isInteger(r.mainBookId) && isStr(r.mainBookName, 200), `${at}.registry`);
  need(r.lastDiaryNumber === null || isStr(r.lastDiaryNumber, 60), `${at}.registry.lastDiaryNumber`);
  need(Array.isArray(r.activePlumbs) && r.activePlumbs.length <= 100 && r.activePlumbs.every((p) => isStr(p, 60)), `${at}.registry.activePlumbs`);
  need(isDate(r.checkedAt), `${at}.registry.checkedAt`);
  return {
    parcelId: r.parcelId as number,
    lrUnitNumber: r.lrUnitNumber as string,
    mainBookId: r.mainBookId as number,
    mainBookName: r.mainBookName as string,
    lastDiaryNumber: r.lastDiaryNumber as string | null,
    activePlumbs: r.activePlumbs as string[],
    checkedAt: r.checkedAt as string,
  };
}

function plotRecord(v: unknown, at: string): PlotRecord {
  need(isObj(v) && onlyKeys(v, ['status', 'owners', 'ourShare', 'contact', 'notes', 'updatedAt', 'registry']), at);
  const r = v as Obj;
  need(typeof r.status === 'string' && STATUSES.includes(r.status), `${at}.status`);
  need(Array.isArray(r.owners) && r.owners.length <= 500, `${at}.owners`);
  const owners = (r.owners as unknown[]).map((o) => {
    need(isObj(o) && onlyKeys(o, ['name', 'share']) && isStr(o.name, 500) && isStr(o.share, 60), `${at}.owners`);
    return { name: (o as Obj).name as string, share: (o as Obj).share as string };
  });
  need(isStr(r.ourShare, 60) && isStr(r.contact, 5000) && isStr(r.notes, 20000), `${at} (ourShare, contact, notes)`);
  need(r.updatedAt === null || isDate(r.updatedAt), `${at}.updatedAt`);
  const out: PlotRecord = {
    status: r.status as PlotRecord['status'],
    owners,
    ourShare: r.ourShare as string,
    contact: r.contact as string,
    notes: r.notes as string,
    updatedAt: r.updatedAt as string | null,
  };
  if (r.registry !== undefined) out.registry = registry(r.registry, at);
  return out;
}

function resolution(v: unknown, at: string): Resolution {
  need(isObj(v) && isDate(v.resolvedAt), at);
  const r = v as Obj;
  if (r.type === 'not_plot') {
    need(onlyKeys(r, ['type', 'resolvedAt']), at);
    return { type: 'not_plot', resolvedAt: r.resolvedAt as string };
  }
  need(r.type === 'plot' && onlyKeys(r, ['type', 'plotNumber', 'resolvedAt']) && isStr(r.plotNumber, 40) && !!r.plotNumber, at);
  return { type: 'plot', plotNumber: r.plotNumber as string, resolvedAt: r.resolvedAt as string };
}

function featureEdit(v: unknown, at: string): FeatureEdit {
  need(isObj(v) && onlyKeys(v, ['plotNumber', 'geometry', 'area_m2', 'area_in_upu_m2', 'zones', 'editedAt']) && isDate(v.editedAt), at);
  const e = v as Obj;
  const out: FeatureEdit = { editedAt: e.editedAt as string };
  if (e.plotNumber !== undefined) {
    need(isStr(e.plotNumber, 40) && !!e.plotNumber, `${at}.plotNumber`);
    out.plotNumber = e.plotNumber as string;
  }
  if (e.geometry !== undefined) {
    const g = e.geometry;
    need(isObj(g) && onlyKeys(g, ['type', 'coordinates']) && g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length >= 1 && g.coordinates.length <= 100, `${at}.geometry`);
    const rings = ((g as Obj).coordinates as unknown[]).map((ring) => {
      need(Array.isArray(ring) && ring.length >= 4 && ring.length <= 20000, `${at}.geometry`);
      return (ring as unknown[]).map((p) => {
        need(Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]), `${at}.geometry`);
        return [(p as number[])[0], (p as number[])[1]];
      });
    });
    need(isNum(e.area_m2) && isNum(e.area_in_upu_m2) && Array.isArray(e.zones) && e.zones.length <= 100, `${at} (areas, zones)`);
    out.geometry = { type: 'Polygon', coordinates: rings };
    out.area_m2 = e.area_m2 as number;
    out.area_in_upu_m2 = e.area_in_upu_m2 as number;
    out.zones = (e.zones as unknown[]).map((z) => {
      need(isObj(z) && onlyKeys(z, ['zone', 'overlap_m2']) && isStr(z.zone, 40) && isNum(z.overlap_m2), `${at}.zones`);
      return { zone: (z as Obj).zone as string, overlap_m2: (z as Obj).overlap_m2 as number };
    });
  }
  need(!!out.plotNumber || !!out.geometry, at);
  return out;
}

const goodKey = (k: string) => k.length > 0 && k.length <= 40 && !/[\u0000-\u001f]/.test(k);

/**
 * Checks that the value is an ownership document (version 1, nothing unknown in it) and returns it
 * rebuilt field by field. Returns the reason as text when it is not.
 */
export function checkDoc(raw: unknown): { doc: OwnershipDoc } | { error: string } {
  try {
    need(isObj(raw) && onlyKeys(raw, ['version', 'savedAt', 'plots', 'reviews', 'edits', 'registryCheckedAt']), 'document');
    const d = raw as Obj;
    need(d.version === 1, 'version');
    need(isDate(d.savedAt), 'savedAt');
    need(isObj(d.plots) && isObj(d.reviews) && isObj(d.edits), 'plots, reviews, edits');
    const doc: OwnershipDoc = { version: 1, savedAt: d.savedAt as string, plots: {}, reviews: {}, edits: {} };
    const plots = Object.entries(d.plots as Obj);
    need(plots.length >= 1 && plots.length <= 5000, 'plots (count)');
    for (const [k, v] of plots) {
      need(goodKey(k), 'plots (key)');
      doc.plots[k] = plotRecord(v, `plots["${k}"]`);
    }
    for (const [k, v] of Object.entries(d.reviews as Obj)) {
      need(goodKey(k), 'reviews (key)');
      doc.reviews[k] = resolution(v, `reviews["${k}"]`);
    }
    for (const [k, v] of Object.entries(d.edits as Obj)) {
      need(goodKey(k), 'edits (key)');
      doc.edits[k] = featureEdit(v, `edits["${k}"]`);
    }
    if (d.registryCheckedAt !== undefined) {
      need(isDate(d.registryCheckedAt), 'registryCheckedAt');
      doc.registryCheckedAt = d.registryCheckedAt as string;
    }
    return { doc };
  } catch (e) {
    if (e instanceof Invalid) return { error: e.message };
    throw e;
  }
}

/** The file exactly as it is written to the repository (same form the dev server writes). */
export const fileText = (doc: OwnershipDoc) => JSON.stringify(doc, null, 2) + '\n';

// ---------- GitHub ----------

export interface PublishDeps {
  /** REFRESH_TOKEN: the secret the caller must send */
  refreshToken: string | undefined;
  /** GITHUB_TOKEN: may write the repository's contents */
  githubToken: string | undefined;
  /** GITHUB_REPO: "owner/name" */
  githubRepo: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

class GithubError extends Error {
  constructor(
    public step: 'read' | 'write',
    public status: number | null,
    public timedOut = false,
  ) {
    super(`github ${step}: ${timedOut ? 'timeout' : status ?? 'network'}`);
  }
}

async function github(step: GithubError['step'], deps: Required<Pick<PublishDeps, 'fetchImpl'>> & { githubToken: string }, url: string, init: { method: string; accept: string; body?: string }): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), GITHUB_TIMEOUT_MS);
  try {
    return await deps.fetchImpl(url, {
      method: init.method,
      headers: {
        Accept: init.accept,
        Authorization: `Bearer ${deps.githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body,
      signal: ctl.signal,
    });
  } catch {
    throw new GithubError(step, null, ctl.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

/** The published file as it is on the main branch now: its text and the blob sha needed to replace it. */
async function readPublished(deps: Required<Pick<PublishDeps, 'fetchImpl'>> & { githubToken: string }, repo: string): Promise<{ text: string; sha: string }> {
  const url = `${GITHUB}/repos/${repo}/contents/${FILE_PATH}?ref=${BRANCH}`;
  const r = await github('read', deps, url, { method: 'GET', accept: 'application/vnd.github+json' });
  if (!r.ok) throw new GithubError('read', r.status);
  const meta = (await r.json().catch(() => null)) as { sha?: unknown; content?: unknown; encoding?: unknown } | null;
  if (!meta || typeof meta.sha !== 'string') throw new GithubError('read', r.status);
  if (meta.encoding === 'base64' && typeof meta.content === 'string' && meta.content) return { text: Buffer.from(meta.content, 'base64').toString('utf8'), sha: meta.sha };
  // files over 1 MB come without content: ask for the raw file
  const raw = await github('read', deps, url, { method: 'GET', accept: 'application/vnd.github.raw+json' });
  if (!raw.ok) throw new GithubError('read', raw.status);
  return { text: await raw.text(), sha: meta.sha };
}

export interface Answer {
  status: number;
  body: unknown;
}

const commitDate = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Zagreb' }).format(d);

/** What can be refused before the body is looked at: the method, missing variables, the token. */
export function gate(method: string | undefined, token: string | undefined, deps: PublishDeps): Answer | null {
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  if (!deps.refreshToken) return { status: 503, body: { error: 'not_configured' } };
  if (typeof token !== 'string' || !sameSecret(token, deps.refreshToken)) return { status: 401, body: { error: 'unauthorized' } };
  if (!deps.githubToken || !deps.githubRepo || !/^[\w.-]+\/[\w.-]+$/.test(deps.githubRepo)) return { status: 503, body: { error: 'not_configured' } };
  return null;
}

/**
 * POST with header X-Refresh-Token and body { doc, baseSavedAt }.
 * 405 other methods · 503 a variable is not set · 401 wrong/missing token · 400 not a valid body ·
 * 409 the published file is not the one the caller started from (nothing is committed) ·
 * 422 the document would drop most of the published plots · 502/504 GitHub failed · 200 { ok, commit }.
 */
export async function publish(req: { method?: string; token?: string; body: unknown }, deps: PublishDeps): Promise<Answer> {
  const refused = gate(req.method, req.token, deps);
  if (refused) return refused;
  if (!deps.githubToken || !deps.githubRepo) return { status: 503, body: { error: 'not_configured' } }; // gate() has checked; this is for the types

  if (!isObj(req.body) || !onlyKeys(req.body, ['doc', 'baseSavedAt']) || typeof req.body.baseSavedAt !== 'string')
    return { status: 400, body: { error: 'invalid_body', detail: 'expected { doc, baseSavedAt }' } };
  const checked = checkDoc(req.body.doc);
  if ('error' in checked) return { status: 400, body: { error: 'invalid_document', detail: checked.error } };
  const { doc } = checked;
  const baseSavedAt = req.body.baseSavedAt;
  const text = fileText(doc);
  const gh = { fetchImpl: deps.fetchImpl ?? fetch, githubToken: deps.githubToken };

  try {
    const current = await readPublished(gh, deps.githubRepo);
    let published: { savedAt?: unknown; plots?: unknown } | null = null;
    try {
      published = JSON.parse(current.text);
    } catch {
      /* an unreadable file counts as "not what the caller started from" */
    }
    const publishedSavedAt = typeof published?.savedAt === 'string' ? published.savedAt : null;
    // the same document is already there (a repeated request after a lost answer): nothing to do
    if (current.text === text) return { status: 200, body: { ok: true, commit: null, alreadyPublished: true, savedAt: doc.savedAt } };
    if (publishedSavedAt !== baseSavedAt) return { status: 409, body: { error: 'conflict', publishedSavedAt } };
    const before = isObj(published?.plots) ? Object.keys(published.plots).length : 0;
    if (Object.keys(doc.plots).length * 2 < before) return { status: 422, body: { error: 'too_few_plots', detail: `the document has ${Object.keys(doc.plots).length} plots, the published file ${before}` } };

    const message = `Update ownership from land registry (${commitDate((deps.now ?? (() => new Date()))())})`;
    const put = await github('write', gh, `${GITHUB}/repos/${deps.githubRepo}/contents/${FILE_PATH}`, {
      method: 'PUT',
      accept: 'application/vnd.github+json',
      body: JSON.stringify({ message, content: Buffer.from(text, 'utf8').toString('base64'), sha: current.sha, branch: BRANCH }),
    });
    // 409: the file changed between our read and our write - the same as a conflict found earlier
    if (put.status === 409) return { status: 409, body: { error: 'conflict', publishedSavedAt: null } };
    if (!put.ok) throw new GithubError('write', put.status);
    const out = (await put.json().catch(() => null)) as { commit?: { sha?: unknown } } | null;
    return { status: 200, body: { ok: true, commit: typeof out?.commit?.sha === 'string' ? out.commit.sha : null, savedAt: doc.savedAt } };
  } catch (e) {
    if (e instanceof GithubError) {
      console.error(`publish: ${e.message}`); // step and status only
      return { status: e.timedOut ? 504 : 502, body: { error: 'github', step: e.step, githubStatus: e.status } };
    }
    console.error('publish: internal error');
    return { status: 500, body: { error: 'internal' } };
  }
}

// ---------- the HTTP handler ----------

/**
 * The JSON body of the request, at most MAX_BODY_BYTES.
 * On Vercel the runtime has already read the stream and offers the parsed body as req.body; anywhere
 * else the stream is read here.
 */
export async function readJsonBody(req: IncomingMessage): Promise<{ value: unknown } | { status: 400 | 413 }> {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return { status: 413 };
  let ready: unknown;
  try {
    ready = (req as IncomingMessage & { body?: unknown }).body; // Vercel: throws on invalid JSON
  } catch {
    return { status: 400 };
  }
  let text: string;
  if (ready !== undefined && ready !== null) {
    if (Buffer.isBuffer(ready)) text = ready.toString('utf8');
    else if (typeof ready === 'string') text = ready;
    else return Buffer.byteLength(JSON.stringify(ready), 'utf8') > MAX_BODY_BYTES ? { status: 413 } : { value: ready };
  } else {
    const read = await new Promise<string | null>((resolve) => {
      if (req.readableEnded) return resolve('');
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      req.on('data', (c: Buffer) => {
        if (over) return;
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          over = true;
          chunks.length = 0;
          resolve(null); // keep draining so the answer can be sent, but keep nothing
        } else chunks.push(c);
      });
      req.on('end', () => !over && resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => !over && resolve(''));
    });
    if (read === null) return { status: 413 };
    text = read;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { status: 413 };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { status: 400 };
  }
}

/** Node (req, res) handler for the Vercel function. */
export function createPublishHandler(getDeps: () => PublishDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (a: Answer) => {
      res.statusCode = a.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(a.body));
    };
    try {
      const deps = getDeps();
      const header = req.headers['x-refresh-token'];
      const token = typeof header === 'string' ? header : undefined;
      // refuse before reading the body: method, configuration and token need nothing from it
      const refused = gate(req.method, token, deps);
      if (refused) return send(refused);
      const body = await readJsonBody(req);
      if ('status' in body) {
        if (body.status === 413) res.setHeader('Connection', 'close'); // do not wait for the rest of the upload
        return send({ status: body.status, body: { error: body.status === 413 ? 'too_large' : 'invalid_json' } });
      }
      send(await publish({ method: req.method, token, body: body.value }, deps));
    } catch {
      send({ status: 500, body: { error: 'internal' } });
    }
  };
}
