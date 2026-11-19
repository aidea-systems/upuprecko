import { describe, expect, it } from 'vitest';
import { normalizeDoc } from './ownership';
import { lastUpdatedLabel } from './format';

describe('the "Last updated" line next to the Update button', () => {
  it('shows the date and time of the last check in the given time zone', () => {
    expect(lastUpdatedLabel('2026-11-19T09:47:00.000Z', 'Europe/Zagreb')).toBe('Last updated: 19 Nov 2026, 10:47');
    expect(lastUpdatedLabel('2026-07-01T22:05:30.000Z', 'Europe/Zagreb')).toBe('Last updated: 2 Jul 2026, 00:05'); // summer time, next day
    expect(lastUpdatedLabel('2026-11-19T09:47:00.000Z', 'UTC')).toBe('Last updated: 19 Nov 2026, 09:47');
  });

  it('uses local time when no time zone is given', () => {
    const d = new Date(2026, 10, 19, 10, 47); // 19 Nov 2026, 10:47 on this machine's clock
    expect(lastUpdatedLabel(d.toISOString())).toBe('Last updated: 19 Nov 2026, 10:47');
  });

  it('says "never" when the field is missing or not a date', () => {
    expect(lastUpdatedLabel(undefined)).toBe('Last updated: never');
    expect(lastUpdatedLabel(null)).toBe('Last updated: never');
    expect(lastUpdatedLabel('')).toBe('Last updated: never');
    expect(lastUpdatedLabel('not a date')).toBe('Last updated: never');
  });
});

describe('registryCheckedAt in the stored document', () => {
  const base = { version: 1, savedAt: '2026-11-19T09:50:00.000Z', plots: {}, reviews: {}, edits: {} };

  it('is absent in a document that never had it', () => {
    expect('registryCheckedAt' in normalizeDoc(base)).toBe(false);
    expect(lastUpdatedLabel(normalizeDoc(base).registryCheckedAt)).toBe('Last updated: never');
  });

  it('is kept through save and load', () => {
    const doc = normalizeDoc({ ...base, registryCheckedAt: '2026-11-19T09:47:00.000Z' });
    expect(doc.registryCheckedAt).toBe('2026-11-19T09:47:00.000Z');
    expect(normalizeDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('is dropped when it is not a date', () => {
    expect(normalizeDoc({ ...base, registryCheckedAt: 5 }).registryCheckedAt).toBeUndefined();
    expect(normalizeDoc({ ...base, registryCheckedAt: 'soon' }).registryCheckedAt).toBeUndefined();
  });
});
