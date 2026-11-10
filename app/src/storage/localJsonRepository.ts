import type { OwnershipDoc } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { emptyDoc, normalizeDoc } from '../lib/ownership';
import type { LoadResult, OwnershipRepository, Persistence } from './repository';

/**
 * JSON file in the repo (data/ownership.json, written through the dev server's
 * /api/ownership endpoint) plus a copy in localStorage. Without the endpoint
 * (static hosting) it falls back to localStorage, seeded from ownership.seed.json.
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
    if (local) return { doc: local, persistence: 'browser' };
    try {
      const r = await fetch(this.seedUrl, { cache: 'no-store' });
      if (r.ok) return { doc: normalizeDoc(await r.json()), persistence: 'browser' };
    } catch {
      /* no seed */
    }
    return { doc: emptyDoc(), persistence: 'browser' };
  }

  private async persist(doc: OwnershipDoc): Promise<Persistence> {
    // file first: if the server refuses (conflict), the browser copy must not get the refused data either
    const ok = await this.writeFile(doc);
    this.writeLocal(doc);
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
