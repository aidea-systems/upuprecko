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
