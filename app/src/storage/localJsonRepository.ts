import type { OwnershipDoc } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { emptyDoc, normalizeDoc } from '../lib/ownership';
import type { LoadResult, OwnershipRepository, Persistence, PublishState } from './repository';

/**
 * JSON file in the repo (data/ownership.json, written through the dev server's
 * /api/ownership endpoint) plus a copy in localStorage. Without the endpoint
 * (static hosting) it uses localStorage or the published ownership.seed.json, whichever is newer.
 */
export class LocalJsonRepository implements OwnershipRepository {
  constructor(
    private apiUrl = '/api/ownership',
    private seedUrl = `${import.meta.env.BASE_URL}data/ownership.seed.json`,
  ) {}

  private readLocal(): OwnershipDoc | null {
    try {
      const s = localStorage.getItem(config.storageKey);
      return s ? normalizeDoc(JSON.parse(s)) : null;
    } catch {
      return null;
    }
  }

  private writeLocal(doc: OwnershipDoc) {
    try {
      localStorage.setItem(config.storageKey, JSON.stringify(doc));
    } catch {
      /* storage unavailable: the file API is still used */
    }
  }

  private async readFile(): Promise<OwnershipDoc | null> {
    try {
      const r = await fetch(this.apiUrl, { cache: 'no-store' });
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
      return normalizeDoc(await r.json());
    } catch {
      return null;
    }
  }

  // ---- the published data (static hosting only) ----
  private isStatic = false;
  private published: OwnershipDoc | null = null;
  /** savedAt of the published version the data in use was made from */
  private base: string | null = null;
  private diverged = false;

  /** { savedAt, conflict? } kept next to the browser copy: which published version it was made from. */
  private readBase(): { savedAt: string; conflict: boolean } | null {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(config.storageBaseKey) ?? 'null');
      const o = v as { savedAt?: unknown; conflict?: unknown } | null;
      return o && typeof o.savedAt === 'string' ? { savedAt: o.savedAt, conflict: o.conflict === true } : null;
    } catch {
      return null;
    }
  }

  private writeBase() {
    try {
      if (this.base) localStorage.setItem(config.storageBaseKey, JSON.stringify(this.diverged ? { savedAt: this.base, conflict: true } : { savedAt: this.base }));
      else localStorage.removeItem(config.storageBaseKey);
    } catch {
      /* storage unavailable */
    }
  }

  publishState(): PublishState {
    return { canPublish: this.isStatic, baseSavedAt: this.base, published: this.published, diverged: this.diverged };
  }

  markPublished(doc: OwnershipDoc) {
    this.published = doc;
    this.base = doc.savedAt;
    this.diverged = false;
    this.writeBase();
  }

  markConflict() {
    this.diverged = true;
    this.writeBase();
  }

  discardLocal() {
    try {
      localStorage.removeItem(config.storageKey);
      localStorage.removeItem(config.storageBaseKey);
    } catch {
      /* storage unavailable */
    }
  }

  /** savedAt of the file version this tab last loaded or wrote; sent so the server can refuse stale writes. */
  private baseSavedAt: string | null = null;

  private async writeFile(doc: OwnershipDoc): Promise<boolean> {
    let r: Response;
    try {
      r = await fetch(this.apiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Base-Saved-At': this.baseSavedAt ?? '' },
        body: JSON.stringify(doc),
      });
    } catch {
      return false;
    }
    if (r.status === 409) throw new Error(t.data.conflict);
    if (r.ok) this.baseSavedAt = doc.savedAt;
    return r.ok;
  }

  async load(): Promise<LoadResult> {
    const local = this.readLocal();
    const file = await this.readFile();
    const newer = (a: OwnershipDoc | null, b: OwnershipDoc | null) => !!a?.savedAt && (!b?.savedAt || a.savedAt > b.savedAt);

    if (file) {
      this.baseSavedAt = file.savedAt;
      if (newer(local, file)) {
        const ok = await this.writeFile(local!);
        return { doc: local!, persistence: ok ? 'file' : 'browser', notice: t.data.newerInBrowser };
      }
      this.writeLocal(file);
      return { doc: file, persistence: 'file' };
    }
    // Static hosting: the published data (seed) against this browser's own copy - the newer one wins,
    // so a browser that once saved a change here still gets the data published after that.
    let seed: OwnershipDoc | null = null;
    try {
      const r = await fetch(this.seedUrl, { cache: 'no-store' });
      if (r.ok) seed = normalizeDoc(await r.json());
    } catch {
      /* no seed */
    }
    this.isStatic = true;
    this.published = seed;
    if (local && !newer(seed, local)) {
      // The browser copy is in use. It was made from the published version noted with it; a copy saved
      // before that note existed is taken to come from the version published now.
      const made = this.readBase();
      this.base = made?.savedAt ?? seed?.savedAt ?? null;
      // published data that is newer than the version the copy was made from is missing in the copy
      this.diverged = !!made && (made.conflict || (!!seed?.savedAt && seed.savedAt > made.savedAt));
      return { doc: local, persistence: 'browser' };
    }
    this.base = seed?.savedAt ?? null;
    if (seed) return { doc: seed, persistence: 'browser', notice: local ? t.data.newerPublished : undefined };
    return { doc: emptyDoc(), persistence: 'browser' };
  }

  private async persist(doc: OwnershipDoc): Promise<Persistence> {
    // file first: if the server refuses (conflict), the browser copy must not get the refused data either
    const ok = await this.writeFile(doc);
    this.writeLocal(doc);
    if (this.isStatic) this.writeBase(); // the copy just written was made from this published version
    return ok ? 'file' : 'browser';
  }

  savePlot(_pn: string, _rec: unknown, doc: OwnershipDoc) {
    return this.persist(doc);
  }
  saveResolution(_id: string, _res: unknown, doc: OwnershipDoc) {
    return this.persist(doc);
  }
  saveFeatureEdits(_edits: unknown, _move: unknown, doc: OwnershipDoc) {
    return this.persist(doc);
  }
  replaceAll(doc: OwnershipDoc) {
    return this.persist(doc);
  }
}
