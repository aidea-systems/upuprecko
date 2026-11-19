import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlotRecord } from '../types';
import { normalise } from '../../server/ossParcel';
import type { OssParcelResult, OssShare } from './ossParcel';
import { formatFrac, parseFraction } from './fraction';
import { normalizeDoc } from './ownership';
import { applyDiff, deriveStatus, diffPlot, isOurs, mergeRows, nameKey, ourShareOf, ownerRows, parseShare, unlistedOurOibs } from './registryRefresh';

const fixture = (f: string): unknown => JSON.parse(readFileSync(join(__dirname, '..', '..', 'test-fixtures', 'oss', f), 'utf8'));
/** Plot 6356/1, k.o. Donje Vrapče (339318), as the two OSS services answered on 19 Nov 2026. */
const sample = normalise(fixture('parcel-info-41106113.json'), fixture('lr-unit-1000-250235.json'));
const plot = { plotNumber: '6356/1', municipalityRegNum: '339318' };
const NOW = '2026-11-19T10:00:00.000Z';

const rec = (over: Partial<PlotRecord> = {}): PlotRecord => ({ status: 'no_data', owners: [], ourShare: '', contact: '', notes: '', updatedAt: null, ...over });
const frac = (s: string) => parseFraction(s)!;

/** Invented owners for the cases the sample does not cover. */
const share = (n: number, fraction: string | null, owners: OssShare['owners'], more: Partial<OssShare> = {}): OssShare => ({
  share: fraction,
  rawDescription: fraction ? `${n}. Suvlasnički dio: ${fraction}` : `${n}. Suvlasnički dio s neodređenim omjerom`,
  hasSubShares: false,
  annotations: 0,
  owners,
  ...more,
});
const fetched = (shares: OssShare[], over: Partial<OssParcelResult> = {}): OssParcelResult => ({ ...sample, shares, ...over });
const IVO = { name: 'IVIĆ IVO', oib: '11111111111' };
const ANA = { name: 'ANIĆ ANA', oib: '22222222222' };
const US = { name: 'OPATOVINA PROJEKT d.o.o.', oib: '75108231896' };

describe('parseShare', () => {
  it('takes the fraction after the colon', () => {
    expect(parseShare('1. Suvlasnički dio: 1790/2803')).toBe('1790/2803');
    expect(parseShare('4. Vlasnički dio: 1/1')).toBe('1/1');
    expect(parseShare('2. Suvlasnički dio:  47 / 600 ')).toBe('47/600');
  });
  it('gives null when there is no fraction', () => {
    expect(parseShare('1. Suvlasnički dio s neodređenim omjerom ETAŽNO VLASNIŠTVO (E-1)')).toBeNull();
    expect(parseShare('1. Suvlasnički dio: 1/2 ETAŽNO VLASNIŠTVO (E-1)')).toBeNull();
    expect(parseShare('1. Suvlasnički dio: 1/0')).toBeNull();
    expect(parseShare('1/2')).toBeNull();
    expect(parseShare('')).toBeNull();
    expect(parseShare(undefined)).toBeNull();
  });
});

describe('nameKey', () => {
  it('ignores case, spaces and added suffixes', () => {
    expect(nameKey('Opatovina  projekt d.o.o. ')).toBe(nameKey('OPATOVINA PROJEKT d.o.o.'));
    expect(nameKey('LANDMARK GROUP d.o.o. (predbilježba)')).toBe(nameKey('Landmark Group d.o.o.'));
    expect(nameKey('JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRAD ZAGREB, OIB: 61817894937')).toBe(
      nameKey('Javno dobro u općoj uporabi u neotuđivom vlasništvu Grad Zagreb'),
    );
    expect(nameKey('šijan branko')).toBe(nameKey('ŠIJAN BRANKO'));
  });
  it('keeps different owners apart', () => {
    expect(nameKey('OPATOVINA PROJEKT d.o.o. u stečaju')).not.toBe(nameKey('OPATOVINA PROJEKT d.o.o.'));
    expect(nameKey('IVIĆ IVO')).not.toBe(nameKey('IVIĆ IVA'));
  });
});

describe('owner rows from the sample (plot 6356/1)', () => {
  const rows = ownerRows(sample.shares);

  it('makes one row per share entry', () => {
    expect(rows.map((r) => [r.name, formatFrac(r.share!)])).toEqual([
      ['Opatovina projekt d.o.o.', '1790/2803'],
      ['PROJEKT MAKSIMUS d.o.o.', '587/2803'],
      ['OPATOVINA PROJEKT d.o.o.', '426/2803'],
    ]);
  });

  it('merges the two spellings of Opatovina projekt (same OIB) into 2216/2803', () => {
    const merged = mergeRows(rows);
    expect(merged.map((r) => [r.name, formatFrac(r.share!), r.ours])).toEqual([
      ['Opatovina projekt d.o.o.', '2216/2803', true],
      ['PROJEKT MAKSIMUS d.o.o.', '587/2803', true],
    ]);
  });

  it('gives our share 1 and status Owned', () => {
    const our = ourShareOf(mergeRows(rows));
    expect(formatFrac(our)).toBe('1');
    expect(deriveStatus(our, 'not_owned')).toBe('owned');
  });
});

describe('ownerRows / mergeRows', () => {
  it('joins several owners of one share entry into one row', () => {
    const rows = ownerRows([share(1, '1/2', [{ name: 'LOJEN STJEPAN' }, { name: 'ŠKORIĆ MIRJANA', oib: '33333333333' }]), share(2, '1/2', [ANA])]);
    expect(rows[0]).toMatchObject({ name: 'LOJEN STJEPAN, ŠKORIĆ MIRJANA', oib: undefined, ours: false });
    expect(rows[1]).toMatchObject({ name: 'ANIĆ ANA', oib: '22222222222' });
  });

  it('merges by OIB when there is one, otherwise by name; adds exactly', () => {
    const merged = mergeRows(
      ownerRows([
        share(1, '1/3', [IVO]),
        share(2, '1/3', [{ name: 'Ivić  Ivo', oib: '11111111111' }]), // same OIB, other spelling
        share(3, '1/6', [{ name: 'ANIĆ ANA' }]),
        share(4, '1/6', [{ name: 'anić ana' }]), // no OIB: same name
      ]),
    );
    expect(merged.map((r) => [r.name, formatFrac(r.share!)])).toEqual([
      ['IVIĆ IVO', '2/3'],
      ['ANIĆ ANA', '1/3'],
    ]);
  });

  it('keeps two people with the same name but different OIBs apart', () => {
    const merged = mergeRows(ownerRows([share(1, '1/2', [IVO]), share(2, '1/2', [{ name: 'IVIĆ IVO', oib: '99999999999' }])]));
    expect(merged).toHaveLength(2);
  });
});

describe('who is ours', () => {
  it('is decided by OIB or by name', () => {
    expect(isOurs({ name: 'Neko drugo ime d.o.o.', oib: '46094261044' })).toBe(true); // OIB in the list
    expect(isOurs({ name: 'FLAMMULA NEKRETNINE d.o.o.' })).toBe(true); // name in the list, no OIB given
    expect(isOurs({ name: 'FLAMMULA NEKRETNINE d.o.o.', oib: '12345678901' })).toBe(true);
    expect(isOurs(IVO)).toBe(false);
  });

  it('reports a name that matches with an OIB that is not in the list', () => {
    const shares = [share(1, '1/2', [{ name: 'FLAMMULA NEKRETNINE d.o.o.', oib: '12345678901' }]), share(2, '1/4', [US]), share(3, '1/4', [{ name: 'MATARA NEKRETNINE d.o.o.' }])];
    expect(unlistedOurOibs(shares)).toEqual([{ name: 'FLAMMULA NEKRETNINE d.o.o.', oib: '12345678901' }]);
    expect(unlistedOurOibs(sample.shares)).toEqual([]);
  });
});

describe('deriveStatus', () => {
  it('is Owned only when everything is ours', () => {
    expect(deriveStatus(frac('1'), 'no_data')).toBe('owned');
    expect(deriveStatus(frac('2803/2803'), 'negotiating')).toBe('owned');
    expect(deriveStatus(frac('2802/2803'), 'owned')).toBe('not_owned');
    expect(deriveStatus(frac('0'), 'no_data')).toBe('not_owned');
  });
  it('keeps a Negotiating set by hand while the plot is not fully ours', () => {
    expect(deriveStatus(frac('1/2'), 'negotiating')).toBe('negotiating');
    expect(deriveStatus(frac('0'), 'negotiating')).toBe('negotiating');
  });
});

describe('diffPlot', () => {
  const storedSample = rec({
    status: 'owned',
    owners: [
      { name: 'OPATOVINA PROJEKT d.o.o.', share: '2216/2803' },
      { name: 'PROJEKT MAKSIMUS d.o.o.', share: '587/2803' },
    ],
    ourShare: '1',
    notes: 'kept',
    contact: 'kept too',
    updatedAt: '2026-11-10T00:00:00.000Z',
  });

  it('finds the sample unchanged against a record that already says the same', () => {
    const d = diffPlot(storedSample, sample, plot, NOW);
    expect(d.kind).toBe('unchanged');
    if (d.kind !== 'unchanged') return;
    expect(d.registry).toEqual({ parcelId: 41106113, lrUnitNumber: '1000', mainBookId: 250235, mainBookName: 'DONJE VRAPČE', lastDiaryNumber: 'Z-55014/2026', activePlumbs: [], checkedAt: NOW });
    expect(d.notes).toEqual([]);
  });

  it('ignores case, spaces, the order of owners and how the stored shares are written', () => {
    const stored = rec({
      status: 'owned',
      owners: [
        { name: 'projekt maksimus  D.O.O.', share: '587/2803' },
        { name: 'Opatovina projekt d.o.o.', share: '1790/2803' },
        { name: 'OPATOVINA PROJEKT d.o.o.', share: '426/2803' },
      ],
      ourShare: '100%',
    });
    expect(diffPlot(stored, sample, plot, NOW).kind).toBe('unchanged');
  });

  it('proposes owners, our share and status for a plot without data', () => {
    const d = diffPlot(rec(), sample, plot, NOW);
    expect(d.kind).toBe('changed');
    if (d.kind !== 'changed') return;
    expect(d.next).toEqual({
      owners: [
        { name: 'Opatovina projekt d.o.o.', share: '2216/2803' },
        { name: 'PROJEKT MAKSIMUS d.o.o.', share: '587/2803' },
      ],
      ourShare: '1',
      status: 'owned',
    });
    expect(d.differences).toEqual([
      'New owner: Opatovina projekt d.o.o. (2216/2803)',
      'New owner: PROJEKT MAKSIMUS d.o.o. (587/2803)',
      'Our share: not entered → 1',
      'Status: No data → Owned',
    ]);
  });

  it('says who left, who came and whose share changed; keeps the spelling already in the data', () => {
    const stored = rec({
      status: 'not_owned',
      owners: [
        { name: 'OPATOVINA PROJEKT d.o.o.', share: '1/2' },
        { name: 'IVIĆ IVO', share: '1/2' },
      ],
      ourShare: '1/2',
    });
    const d = diffPlot(stored, sample, plot, NOW);
    expect(d.kind).toBe('changed');
    if (d.kind !== 'changed') return;
    expect(d.differences).toEqual([
      'OPATOVINA PROJEKT d.o.o.: share 1/2 → 2216/2803',
      'New owner: PROJEKT MAKSIMUS d.o.o. (587/2803)',
      'No longer an owner: IVIĆ IVO (was 1/2)',
      'Our share: 1/2 → 1',
      'Status: Not owned → Owned',
    ]);
    expect(d.next.owners[0]).toEqual({ name: 'OPATOVINA PROJEKT d.o.o.', share: '2216/2803' });
  });

  it('turns Owned into Not owned when the registry no longer shows everything as ours', () => {
    const d = diffPlot(storedSample, fetched([share(1, '2216/2803', [US]), share(2, '587/2803', [IVO])]), plot, NOW);
    expect(d.kind).toBe('changed');
    if (d.kind !== 'changed') return;
    expect(d.next.status).toBe('not_owned');
    expect(d.next.ourShare).toBe('2216/2803');
    expect(d.differences).toContain('Status: Owned → Not owned');
    expect(d.differences).toContain('No longer an owner: PROJEKT MAKSIMUS d.o.o. (was 587/2803)');
  });

  it('keeps Negotiating, and then reports no status difference', () => {
    const stored = rec({ status: 'negotiating', owners: [{ name: 'IVIĆ IVO', share: '1' }], ourShare: '0' });
    expect(diffPlot(stored, fetched([share(1, '1/1', [IVO])]), plot, NOW).kind).toBe('unchanged');
  });

  it('reports a status that does not follow from the owners', () => {
    const stored = rec({ status: 'not_owned', owners: storedSample.owners, ourShare: '1' });
    const d = diffPlot(stored, sample, plot, NOW);
    expect(d.kind === 'changed' && d.differences).toEqual(['Status: Not owned → Owned']);
  });

  it('matches a stored name with "(predbilježba)" or ", OIB: …" added, and does not store an OIB in a new name', () => {
    const good = 'JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRAD ZAGREB, OIB: 61817894937';
    const stored = rec({ status: 'not_owned', owners: [{ name: good, share: '1' }], ourShare: '0' });
    expect(diffPlot(stored, fetched([share(1, '1/1', [{ name: good }])]), plot, NOW).kind).toBe('unchanged');

    const fresh = diffPlot(rec(), fetched([share(1, '1/1', [{ name: good }])]), plot, NOW);
    expect(fresh.kind === 'changed' && fresh.next.owners).toEqual([{ name: 'JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRAD ZAGREB', share: '1' }]);

    // a pre-registration that has become ownership: the registry's plain name replaces "… (predbilježba)"
    const pre = rec({ status: 'not_owned', owners: [{ name: 'LANDMARK GROUP d.o.o. (predbilježba)', share: '1/2' }, { name: 'IVIĆ IVO', share: '1/2' }], ourShare: '1/2' });
    const d = diffPlot(pre, fetched([share(1, '1/1', [{ name: 'LANDMARK GROUP d.o.o.', oib: '46094261044' }])]), plot, NOW);
    expect(d.kind === 'changed' && d.next.owners).toEqual([{ name: 'LANDMARK GROUP d.o.o.', share: '1' }]);
  });

  it('adds up two people of the same name when comparing with the stored row', () => {
    const stored = rec({ status: 'not_owned', owners: [{ name: 'IVIĆ IVO', share: '1' }], ourShare: '0' });
    const d = diffPlot(stored, fetched([share(1, '1/2', [IVO]), share(2, '1/2', [{ name: 'IVIĆ IVO', oib: '99999999999' }])]), plot, NOW);
    expect(d.kind).toBe('unchanged');
  });

  it('reports a stored share that cannot be read', () => {
    const stored = rec({ status: 'not_owned', owners: [{ name: 'IVIĆ IVO', share: '' }, { name: 'ANIĆ ANA', share: '1/2' }], ourShare: '0' });
    const d = diffPlot(stored, fetched([share(1, '1/2', [IVO]), share(2, '1/2', [ANA])]), plot, NOW);
    expect(d.kind === 'changed' && d.differences).toEqual(['IVIĆ IVO: share not entered → 1/2']);
  });

  it('notes pending registrations, remarks and a parcel that is not harmonised', () => {
    const d = diffPlot(
      storedSample,
      { ...sample, isHarmonized: false, lrUnit: { ...sample.lrUnit!, activePlumbs: ['Z-55230/2026'] }, shares: sample.shares.map((s, i) => ({ ...s, annotations: i === 0 ? 2 : 0 })) },
      plot,
      NOW,
    );
    expect(d.kind).toBe('unchanged');
    expect(d.notes).toEqual([
      'Pending registration (plomba): Z-55230/2026',
      'Cadastre and land registry are not harmonised for this parcel.',
      '2 remark(s) (zabilježba) on the shares – they do not change the owners.',
    ]);
    expect(d.kind === 'unchanged' && d.registry.activePlumbs).toEqual(['Z-55230/2026']);
  });

  describe('flags instead of proposing a change', () => {
    const flagged = (f: OssParcelResult, p = plot) => {
      const d = diffPlot(storedSample, f, p, NOW);
      expect(d.kind).toBe('flagged');
      return d.kind === 'flagged' ? d.reasons : [];
    };

    it('when the parcel has no land-registry unit', () => {
      expect(flagged({ ...sample, lrUnit: null, shares: [] })).toEqual(['The cadastre links this parcel to no land-registry unit (ZK uložak).']);
    });
    it('for condominium ownership', () => {
      expect(flagged({ ...sample, lrUnit: { ...sample.lrUnit!, condominiums: true } })[0]).toMatch(/Condominium/);
    });
    it('when a share has sub-shares or a pre-registration', () => {
      const r = flagged(fetched([share(1, '1/2', [IVO]), share(2, '1/2', [ANA], { hasSubShares: true })]));
      expect(r).toEqual(['"2. Suvlasnički dio: 1/2" has sub-shares or a pre-registration (predbilježba).']);
    });
    it('when a share has no fraction', () => {
      expect(flagged(fetched([share(1, null, [IVO, ANA])]))).toEqual(['"1. Suvlasnički dio s neodređenim omjerom" has no readable share.']);
    });
    it('when the shares do not add up to 1', () => {
      expect(flagged(fetched([share(1, '1/2', [IVO]), share(2, '1/3', [ANA])]))).toEqual(['The shares add up to 5/6, not 1.']);
    });
    it('when a share names no owner (a pre-registered share without a holder)', () => {
      const r = flagged(fetched([share(1, '1/2', [IVO]), share(2, '1/2', [ANA]), share(3, '363/1038', [], { hasSubShares: true })]));
      expect(r).toEqual([
        '"3. Suvlasnički dio: 363/1038" has sub-shares or a pre-registration (predbilježba).',
        '"3. Suvlasnički dio: 363/1038" names no owner.',
        'The shares add up to 467/346, not 1.',
      ]);
    });
    it('when the unit lists no shares', () => {
      expect(flagged(fetched([]))).toEqual(['The land-registry unit lists no ownership shares.']);
    });
    it('when one of our companies holds a share jointly with somebody else', () => {
      expect(flagged(fetched([share(1, '1/1', [US, IVO])]))).toEqual(['"1. Suvlasnički dio: 1/1" is held jointly by one of our companies and somebody else.']);
    });
    it('when the registry answers with another plot number or municipality (split or renumbered parcel)', () => {
      expect(flagged(sample, { plotNumber: '6356', municipalityRegNum: '339318' })).toEqual(['The registry returns plot 6356/1 for this parcel; the map has 6356 (split or renumbered?).']);
      expect(flagged(sample, { plotNumber: '6356/1', municipalityRegNum: '340057' })).toEqual(['The registry returns cadastral municipality 339318; the map has 340057.']);
    });
  });
});

describe('applyDiff', () => {
  const stored = rec({ status: 'not_owned', owners: [{ name: 'IVIĆ IVO', share: '1' }], ourShare: '0', notes: 'my notes', contact: 'my contact', updatedAt: '2026-11-10T00:00:00.000Z' });

  it('replaces owners, our share and status of a changed plot and leaves notes and contact alone', () => {
    const out = applyDiff(stored, diffPlot(stored, sample, plot, NOW), '2026-11-19T11:00:00.000Z')!;
    expect(out).toMatchObject({ status: 'owned', ourShare: '1', notes: 'my notes', contact: 'my contact', updatedAt: '2026-11-19T11:00:00.000Z' });
    expect(out.owners).toHaveLength(2);
    expect(out.registry).toMatchObject({ lrUnitNumber: '1000', checkedAt: NOW });
  });

  it('adds only the registry note to an unchanged plot', () => {
    const same = rec({ ...stored, status: 'owned', ourShare: '1', owners: [{ name: 'OPATOVINA PROJEKT d.o.o.', share: '2216/2803' }, { name: 'PROJEKT MAKSIMUS d.o.o.', share: '587/2803' }] });
    const out = applyDiff(same, diffPlot(same, sample, plot, NOW), '2026-11-19T11:00:00.000Z')!;
    expect(out).toEqual({ ...same, registry: expect.objectContaining({ lrUnitNumber: '1000', lastDiaryNumber: 'Z-55014/2026', checkedAt: NOW }) });
  });

  it('gives nothing for a flagged plot', () => {
    expect(applyDiff(stored, diffPlot(stored, { ...sample, lrUnit: null, shares: [] }, plot, NOW), NOW)).toBeNull();
  });

  it('never stores an OIB', () => {
    const out = applyDiff(stored, diffPlot(stored, fetched([share(1, '1/2', [IVO]), share(2, '1/2', [ANA])]), plot, NOW), NOW);
    expect(JSON.stringify(out)).not.toMatch(/\d{11}/);
  });
});

describe('the registry note in the stored document', () => {
  const registry = { parcelId: 41106113, lrUnitNumber: '1000', mainBookId: 250235, mainBookName: 'DONJE VRAPČE', lastDiaryNumber: 'Z-55014/2026', activePlumbs: ['Z-1/2026'], checkedAt: NOW };

  it('loads a document saved before the feature existed exactly as it is', () => {
    // the ownership file as it was on 17 Nov 2026, kept in the repository
    const old = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'upu-precko-zapad-map-data', '_backup_before_oss_update', 'ownership.json'), 'utf8'));
    const doc = normalizeDoc(old);
    expect(doc).toEqual(old);
    expect(Object.keys(doc.plots)).toHaveLength(189);
    expect(Object.values(doc.plots).some((r) => 'registry' in r)).toBe(false);
    expect(doc.version).toBe(1);
  });

  it('keeps the registry note through save and load', () => {
    const doc = normalizeDoc({ version: 1, savedAt: NOW, plots: { '6356/1': rec({ registry }) }, reviews: {}, edits: {} });
    expect(doc.plots['6356/1'].registry).toEqual(registry);
    expect(normalizeDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('drops a registry note that cannot be read, and tidies a partial one', () => {
    const load = (r: unknown) => normalizeDoc({ version: 1, savedAt: null, plots: { '1': { ...rec(), registry: r } }, reviews: {} }).plots['1'].registry;
    expect(load('x')).toBeUndefined();
    expect(load({ parcelId: 'abc', lrUnitNumber: '1', checkedAt: NOW })).toBeUndefined();
    expect(load({ parcelId: 1, lrUnitNumber: '1' })).toBeUndefined();
    expect(load({ parcelId: 1, lrUnitNumber: '7', checkedAt: NOW, activePlumbs: ['Z-1/2026', 5, ''], extra: 'ignored' })).toEqual({
      parcelId: 1, lrUnitNumber: '7', mainBookId: 0, mainBookName: '', lastDiaryNumber: null, activePlumbs: ['Z-1/2026'], checkedAt: NOW,
    });
  });
});
