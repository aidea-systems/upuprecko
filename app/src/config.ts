import type { Status } from './types';

/** All tunable settings in one place. */
export const config = {
  /**
   * Constant shift applied to all geometry when it is loaded, in metres (x = east, y = north).
   * The plots are the official cadastral parcels and the plan layers are already in that frame, so 0 / 0.
   */
  geometryShiftMeters: { x: 0, y: 0 },

  /**
   * Owners that count as "us". Compared ignoring upper/lower case and extra spaces, and matched at the
   * start of the name, so "Opatovina projekt d.o.o." = "OPATOVINA PROJEKT D.O.O." and
   * "LANDMARK GROUP d.o.o. (predbilježba)" counts as Landmark Group.
   */
  ourOwners: [
    'OPATOVINA PROJEKT',
    'PROJEKT MAKSIMUS',
    'FLAMMULA NEKRETNINE',
    'MONERIS NEKRETNINE',
    'MATARA NEKRETNINE',
    'AEQUUS NEKRETNINE',
    'CURIS NEKRETNINE',
    'SIGILLUM NEKRETNINE',
    'LANDMARK GROUP',
  ],

  /** Plot fill colours by ownership status. */
  statusColors: {
    owned: '#22c55e',
    negotiating: '#facc15',
    not_owned: '#ef4444',
    no_data: '#94a3b8',
  } as Record<Status, string>,

  /** Zone outline and zone name plate. */
  zoneLineColor: '#0f172a',

  /** "Needs review" shapes: orange hatch. */
  reviewColor: '#fb923c',

  /** Zone colouring in "Zone % owned" mode. pct >= green → green, pct >= yellow → yellow, else red. */
  zoneThresholds: { green: 0.8, yellow: 0.4 },
  zoneBandColors: { green: '#22c55e', yellow: '#facc15', red: '#ef4444', none: '#64748b' },

  /** UPU land-use colours, taken from the plan PDF (M1 and M2 share one colour there). */
  landuseColors: {
    M1: '#ffdf7f',
    M2: '#ffdf7f',
    D4: '#ff9f7f',
    Z1: '#9fff7f',
    IS: '#fafafa',
  } as Record<string, string>,

  plotFillOpacity: 0.45,
  /** How strongly the land outside the UPU boundary is darkened (0 = not at all). Parcels stay whole and clickable. */
  outsideDimOpacity: 0.5,
  zoneFillOpacity: 0.55,
  plotLabelMinZoom: 17,
  maxZoom: 21,

  basemaps: {
    satellite: {
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    dark: {
      // keyless; CARTO's dark tiles now require an API key
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
      maxzoom: 16,
      attribution: 'Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors',
    },
  },
  glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
  font: ['Noto Sans Medium'],

  /** localStorage key for the browser copy of the ownership data. */
  storageKey: 'upu-precko-zapad.ownership.v1',
};

export type Band = 'green' | 'yellow' | 'red' | 'none';

export function zoneBand(pct: number | null, t = config.zoneThresholds): Band {
  if (pct === null) return 'none';
  if (pct >= t.green) return 'green';
  if (pct >= t.yellow) return 'yellow';
  return 'red';
}
