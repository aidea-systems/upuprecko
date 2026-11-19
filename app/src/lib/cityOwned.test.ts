import { describe, expect, it } from 'vitest';
import type { OwnershipDoc, PlotProps, PlotRecord } from '../types';
import { config } from '../config';
import { displayStatus, isCityOwner } from './ownership';
import { computeZoneStats } from './zoneStats';

const rec = (over: Partial<PlotRecord> = {}): PlotRecord => ({ status: 'not_owned', owners: [], ourShare: '0', contact: '', notes: '', updatedAt: null, ...over });
const CITY = 'GRAD ZAGREB';
const PUBLIC_GOOD = 'JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU GRAD ZAGREB, OIB: 61817894937';

describe('isCityOwner', () => {
  it('knows the City of Zagreb in every form the land registry writes it', () => {
    for (const n of [CITY, 'Grad  Zagreb', PUBLIC_GOOD, 'GRAD ZAGREB - JAVNO DOBRO U OPĆOJ UPORABI U NEOTUĐIVOM VLASNIŠTVU', 'JAVNO DOBRO U OPĆOJ UPORABI - NERAZVRSTANA CESTA U NEOTUĐIVOM VLASNIŠTVU GRAD ZAGREB'])
      expect(isCityOwner(n), n).toBe(true);
  });
  it('does not take a company or a person with Zagreb in the name for the City', () => {
    for (const n of ['ZAGREBAČKA-HORVAĆANSKA RESIDENCE 1 d.o.o.', 'ZAGREBAČKI HOLDING d.o.o.', 'OPATOVINA PROJEKT d.o.o.', 'IVIĆ IVO, ZAGREB', ''])
      expect(isCityOwner(n), n).toBe(false);
  });
});

describe('displayStatus', () => {
  it('shows a plot that belongs wholly to the City as city-owned', () => {
    expect(displayStatus(rec({ owners: [{ name: CITY, share: '1' }] }))).toBe('city');
    expect(displayStatus(rec({ owners: [{ name: PUBLIC_GOOD, share: '1/2' }, { name: CITY, share: '1/2' }] }))).toBe('city');
  });
  it('leaves a plot the City shares with somebody else as Not owned', () => {
    expect(displayStatus(rec({ owners: [{ name: CITY, share: '1/2' }, { name: 'IVIĆ IVO', share: '1/2' }] }))).toBe('not_owned');
  });
  it('never changes Owned, Negotiating or No data', () => {
    expect(displayStatus(rec({ status: 'negotiating', owners: [{ name: CITY, share: '1' }] }))).toBe('negotiating');
    expect(displayStatus(rec({ status: 'owned', owners: [{ name: 'OPATOVINA PROJEKT d.o.o.', share: '1' }], ourShare: '1' }))).toBe('owned');
    expect(displayStatus(rec({ status: 'no_data' }))).toBe('no_data');
    expect(displayStatus(rec())).toBe('not_owned'); // no owners entered
    expect(displayStatus(undefined)).toBe('no_data');
  });
  it('has its own colour, and Negotiating keeps a different one', () => {
    expect(config.statusColors.city).toBe('#facc15'); // yellow
    expect(new Set(Object.values(config.statusColors)).size).toBe(5);
  });
});

describe('city-owned plots in the zone figures', () => {
  const plot = (id: string, zone: string): PlotProps => ({ id, plot_number: id, kind: 'plot', candidates: [id], area_m2: 100, area_in_upu_m2: 100, zones: [{ zone, overlap_m2: 100 }] });
  const doc: Pick<OwnershipDoc, 'plots' | 'reviews'> = {
    plots: {
      '1': rec({ status: 'owned', owners: [{ name: 'OPATOVINA PROJEKT d.o.o.', share: '1' }], ourShare: '1' }),
      '2': rec({ owners: [{ name: CITY, share: '1' }] }),
      '3': rec({ owners: [{ name: 'IVIĆ IVO', share: '1' }] }),
    },
    reviews: {},
  };
  const s = computeZoneStats([plot('1', 'A'), plot('2', 'A'), plot('3', 'A')], doc, ['A']).A;

  it('are counted apart for display, while the stored statuses and the percentages stay as they were', () => {
    expect(s.displayCounts).toEqual({ owned: 1, negotiating: 0, not_owned: 1, city: 1, no_data: 0 });
    expect(s.statusCounts).toEqual({ owned: 1, negotiating: 0, not_owned: 2, no_data: 0 });
    expect(s.pctArea).toBeCloseTo(1 / 3);
    expect(s.pctCount).toBeCloseTo(1 / 3);
    expect(s.plots.map((p) => [p.plotNumber, p.status, p.display])).toEqual([['1', 'owned', 'owned'], ['2', 'not_owned', 'city'], ['3', 'not_owned', 'not_owned']]);
    expect(s.notOwned.map((p) => p.plotNumber)).toEqual(['2', '3']); // a city plot is still not ours
  });
});
