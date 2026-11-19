import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnershipDoc } from '../types';
import { config } from '../config';
import { LocalJsonRepository } from './localJsonRepository';

const doc = (savedAt: string, plot: string): OwnershipDoc => ({
  version: 1,
  savedAt,
  plots: { [plot]: { status: 'owned', owners: [], ourShare: '1', contact: '', notes: '', updatedAt: savedAt } },
  reviews: {},
  edits: {},
});

/** Static hosting: no /api/ownership; the seed is served (or not); the browser may hold its own copy. */
function staticSite(seed: OwnershipDoc | null, local: OwnershipDoc | null) {
  const store = new Map<string, string>();
  if (local) store.set(config.storageKey, JSON.stringify(local));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('ownership.seed.json') && seed)
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => seed };
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, json: async () => ({}) };
  });
}

describe('ownership data on the published (static) site', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the published data when the browser has no copy', async () => {
    staticSite(doc('2026-11-11T09:00:00.000Z', 'new'), null);
    const r = await new LocalJsonRepository().load();
    expect(Object.keys(r.doc.plots)).toEqual(['new']);
    expect(r.persistence).toBe('browser');
    expect(r.notice).toBeUndefined();
  });

  it('uses the published data when it is newer than the browser copy, and says so', async () => {
    staticSite(doc('2026-11-11T09:00:00.000Z', 'new'), doc('2026-11-10T12:00:00.000Z', 'old'));
    const r = await new LocalJsonRepository().load();
    expect(Object.keys(r.doc.plots)).toEqual(['new']);
    expect(r.notice).toBeTruthy();
  });

  it('keeps the browser copy when it is newer than the published data', async () => {
    staticSite(doc('2026-11-11T09:00:00.000Z', 'new'), doc('2026-11-12T08:00:00.000Z', 'mine'));
    const r = await new LocalJsonRepository().load();
    expect(Object.keys(r.doc.plots)).toEqual(['mine']);
    expect(r.notice).toBeUndefined();
  });

  it('keeps the browser copy when no published data can be read', async () => {
    staticSite(null, doc('2026-11-10T12:00:00.000Z', 'mine'));
    const r = await new LocalJsonRepository().load();
    expect(Object.keys(r.doc.plots)).toEqual(['mine']);
  });
});

describe('which published version the browser copy was made from (for publishing)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const S0 = '2026-11-17T15:42:07.167Z';
  const S1 = '2026-11-18T08:00:00.000Z';
  const LOCAL = '2026-11-18T12:00:00.000Z';

  /** Static site with a full localStorage; returns the store so tests can look into it. */
  function site(seed: OwnershipDoc | null, local: OwnershipDoc | null, base?: object) {
    const store = new Map<string, string>();
    if (local) store.set(config.storageKey, JSON.stringify(local));
    if (base) store.set(config.storageBaseKey, JSON.stringify(base));
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('ownership.seed.json') && seed)
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => seed };
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, json: async () => ({}) };
    });
    return store;
  }

  it('publishes from the published version when the browser has no copy', async () => {
    site(doc(S0, 'p'), null);
    const repo = new LocalJsonRepository();
    await repo.load();
    expect(repo.publishState()).toMatchObject({ canPublish: true, baseSavedAt: S0, diverged: false });
    expect(Object.keys(repo.publishState().published!.plots)).toEqual(['p']);
  });

  it('notes the version with the browser copy on the first save', async () => {
    const store = site(doc(S0, 'p'), null);
    const repo = new LocalJsonRepository();
    await repo.load();
    await repo.replaceAll(doc(LOCAL, 'mine'));
    expect(JSON.parse(store.get(config.storageBaseKey)!)).toEqual({ savedAt: S0 });

    // next visit: the copy is newer and was made from what is still published
    const again = new LocalJsonRepository();
    expect(Object.keys((await again.load()).doc.plots)).toEqual(['mine']);
    expect(again.publishState()).toMatchObject({ baseSavedAt: S0, diverged: false });
  });

  it('sees that the published data moved on after the copy was made', async () => {
    site(doc(S1, 'theirs'), doc(LOCAL, 'mine'), { savedAt: S0 });
    const repo = new LocalJsonRepository();
    expect(Object.keys((await repo.load()).doc.plots)).toEqual(['mine']); // the newer copy is still the one shown
    expect(repo.publishState()).toMatchObject({ baseSavedAt: S0, diverged: true }); // but it cannot be published
  });

  it('is not misled while a version published from here is still being deployed', async () => {
    // this browser published LOCAL; the site still serves S0 for a minute
    site(doc(S0, 'old'), doc(LOCAL, 'mine'), { savedAt: LOCAL });
    const repo = new LocalJsonRepository();
    await repo.load();
    expect(repo.publishState()).toMatchObject({ baseSavedAt: LOCAL, diverged: false });
  });

  it('takes a copy saved before versions were noted to come from what is published now', async () => {
    site(doc(S1, 'p'), doc(LOCAL, 'mine'));
    const repo = new LocalJsonRepository();
    await repo.load();
    expect(repo.publishState()).toMatchObject({ baseSavedAt: S1, diverged: false });
  });

  it('after publishing, the published version is the one just sent', async () => {
    const store = site(doc(S0, 'p'), null);
    const repo = new LocalJsonRepository();
    await repo.load();
    const mine = doc(LOCAL, 'mine');
    await repo.replaceAll(mine);
    repo.markPublished(mine);
    expect(repo.publishState()).toMatchObject({ baseSavedAt: LOCAL, diverged: false, published: mine });
    expect(JSON.parse(store.get(config.storageBaseKey)!)).toEqual({ savedAt: LOCAL });
  });

  it('remembers a refused publish across a reload, until the published data is loaded', async () => {
    const store = site(doc(S0, 'p'), null);
    const repo = new LocalJsonRepository();
    await repo.load();
    await repo.replaceAll(doc(LOCAL, 'mine'));
    repo.markConflict();
    expect(repo.publishState().diverged).toBe(true);

    const reloaded = new LocalJsonRepository();
    await reloaded.load(); // the site still serves S0: only the note tells that newer data exists
    expect(reloaded.publishState()).toMatchObject({ baseSavedAt: S0, diverged: true });

    reloaded.discardLocal();
    expect(store.has(config.storageKey)).toBe(false);
    expect(store.has(config.storageBaseKey)).toBe(false);
    const fresh = new LocalJsonRepository();
    expect(Object.keys((await fresh.load()).doc.plots)).toEqual(['p']);
    expect(fresh.publishState()).toMatchObject({ baseSavedAt: S0, diverged: false });
  });

  it('does not publish under the dev server (the file API answers)', async () => {
    const file = doc(S0, 'file');
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => file }));
    const repo = new LocalJsonRepository();
    expect((await repo.load()).persistence).toBe('file');
    expect(repo.publishState().canPublish).toBe(false);
  });
});
