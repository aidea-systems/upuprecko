import { describe, expect, it } from 'vitest';
import { formatFrac, parseFraction } from './fraction';
import { checkOwnerShares, effectiveShare, emptyDoc, emptyRecord, isOurOwner, mergeOwners, ourShareFromOwners, parseStatus } from './ownership';
import { buildImport } from './importRows';
import { zoneBand } from '../config';

describe('fractions', () => {
  it('parses fractions, decimals and percents', () => {
    expect(formatFrac(parseFraction('2/4')!)).toBe('1/2');
    expect(formatFrac(parseFraction('0,25')!)).toBe('1/4');
    expect(formatFrac(parseFraction('50%')!)).toBe('1/2');
    expect(formatFrac(parseFraction('1')!)).toBe('1');
    expect(parseFraction('abc')).toBeNull();
    expect(parseFraction('1/0')).toBeNull();
  });
});

describe('owner share check', () => {
  it('accepts shares that sum exactly to 1 (including thirds)', () => {
    expect(checkOwnerShares([{ name: 'A', share: '1/3' }, { name: 'B', share: '1/3' }, { name: 'C', share: '1/3' }]).ok).toBe(true);
  });
  it('warns when shares do not sum to 1', () => {
    const c = checkOwnerShares([{ name: 'A', share: '1/2' }, { name: 'B', share: '1/3' }]);
    expect(c.ok).toBe(false);
    expect(c.sumText).toBe('5/6');
  });
  it('reports invalid shares', () => {
    expect(checkOwnerShares([{ name: 'A', share: 'half' }]).invalid).toEqual(['half']);
  });
  it('has nothing to check without owners', () => {
    expect(checkOwnerShares([]).ok).toBe(true);
  });
});

describe('status and our share', () => {
  it('parses English and Croatian status names', () => {
    expect(parseStatus('Owned')).toBe('owned');
    expect(parseStatus('u pregovorima')).toBe('negotiating');
    expect(parseStatus('Not owned')).toBe('not_owned');
    expect(parseStatus('')).toBeNull();
    expect(parseStatus('maybe')).toBeUndefined();
  });
  it('rejects our share above 1', () => {
    expect(effectiveShare({ ...emptyRecord(), ourShare: '3/2' }).source).toBe('invalid');
  });
  it('bands percentages by thresholds', () => {
    expect(zoneBand(0.8)).toBe('green');
    expect(zoneBand(0.4)).toBe('yellow');
    expect(zoneBand(0.39)).toBe('red');
    expect(zoneBand(null)).toBe('none');
  });
});

describe('our owners and case-insensitive names', () => {
  it('recognises our companies regardless of case and spacing', () => {
    expect(isOurOwner('opatovina projekt d.o.o.')).toBe(true);
    expect(isOurOwner('OPATOVINA  PROJEKT D.O.O.')).toBe(true);
    expect(isOurOwner('LANDMARK GROUP d.o.o. (predbilježba)')).toBe(true);
    expect(isOurOwner('Landmark Group d.o.o. za savjetovanje')).toBe(true);
    expect(isOurOwner('GRAD ZAGREB')).toBe(false);
    expect(isOurOwner('')).toBe(false);
  });
  it('merges the same owner written in different case and adds the shares', () => {
    const m = mergeOwners([
      { name: 'OPATOVINA PROJEKT d.o.o.', share: '213/650' },
      { name: 'Opatovina projekt d.o.o.', share: '437/650' },
      { name: 'Somek Damir', share: '1/4' },
    ]);
    expect(m).toEqual([{ name: 'OPATOVINA PROJEKT d.o.o.', share: '1' }, { name: 'Somek Damir', share: '1/4' }]);
  });
  it('keeps rows with unreadable shares instead of dropping them', () => {
    expect(mergeOwners([{ name: 'A', share: '1/2' }, { name: 'a', share: '?' }])).toHaveLength(2);
  });
  it('calculates our share from the owners', () => {
    expect(ourShareFromOwners([
      { name: 'LANDMARK GROUP d.o.o.', share: '1/2' },
      { name: 'opatovina projekt d.o.o.', share: '1/4' },
      { name: 'Balaško Ivana', share: '1/4' },
    ])).toBe('3/4');
    expect(ourShareFromOwners([{ name: 'Grad Zagreb', share: '1' }])).toBe('0');
  });
});

describe('spreadsheet import', () => {
  const known = new Set(['3633', '3678/1']);
  it('reads rows, reports unknown plot numbers and share problems', () => {
    const rows = [
      { 'Plot number': '3633', Status: 'owned', Owners: 'Ana; Ivo', Shares: '1/2; 1/2', Notes: 'ok' },
      { 'Plot number': '9999', Status: 'owned', Owners: '', Shares: '', Notes: '' },
      { 'Plot number': '3678/1', Status: 'negotiating', Owners: 'Marko; Petra', Shares: '1/2; 1/4', Notes: '' },
      { 'Plot number': '3633', Status: 'whatever', Owners: '', Shares: '', Notes: '' },
    ];
    const r = buildImport(rows, known, emptyDoc(), 'T');
    expect(Object.keys(r.records).sort()).toEqual(['3633', '3678/1']);
    expect(r.records['3633'].owners).toEqual([{ name: 'Ana', share: '1/2' }, { name: 'Ivo', share: '1/2' }]);
    expect(r.unknownPlots).toEqual([{ row: 3, plotNumber: '9999', message: '9999' }]);
    expect(r.warnings.map((w) => w.row)).toEqual([4]);
    expect(r.errors.map((e) => e.row)).toEqual([5]);
  });
  it('accepts Croatian headers', () => {
    const r = buildImport([{ 'Broj čestice': '3633', Status: 'naše', Vlasnici: 'Ana', Udjeli: '1', Napomena: 'x' }], known, emptyDoc());
    expect(r.records['3633'].status).toBe('owned');
    expect(r.records['3633'].notes).toBe('x');
  });
  it('accepts "|" between owners (for semicolon-delimited CSV)', () => {
    const r = buildImport([{ 'Plot number': '3633', Owners: 'Ana | Ivo', Shares: '1/2 | 1/2' }], known, emptyDoc());
    expect(r.records['3633'].owners.map((o) => o.name)).toEqual(['Ana', 'Ivo']);
    expect(r.warnings).toEqual([]);
  });
  it('fails clearly without a plot number column', () => {
    expect(buildImport([{ Foo: 1 }], known, emptyDoc()).fatal).toBeTruthy();
  });
});
