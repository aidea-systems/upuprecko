import proj4 from 'proj4';
import polygonClipping, { type MultiPolygon as PCMulti, type Polygon as PCPoly } from 'polygon-clipping';
import type { Polygon, Position } from 'geojson';
import type { PlotGeometry, ZoneOverlap } from '../types';

/**
 * Areas are measured in the official Croatian projection, HTRS96/TM (EPSG:3765) - the system the cadastre
 * publishes its parcel coordinates in. HTRS96 is ETRS89, which equals WGS84 here, so no datum shift is
 * involved: projecting the stored longitude/latitude gives back the published coordinates.
 */
const EPSG3765 = '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const toProj = proj4('EPSG:4326', EPSG3765);

const projRing = (r: Position[]) => r.map((p) => toProj.forward([p[0], p[1]]) as [number, number]);
const projPoly = (rings: Position[][]): PCPoly => rings.map(projRing);
export const projectGeometry = (g: PlotGeometry): PCMulti =>
  g.type === 'Polygon' ? [projPoly(g.coordinates)] : g.coordinates.map(projPoly);

function ringArea(r: [number, number][]) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a) / 2;
}
export const multiArea = (m: PCMulti) =>
  m.reduce((s, poly) => s + poly.reduce((t, ring, k) => t + (k === 0 ? 1 : -1) * ringArea(ring as [number, number][]), 0), 0);

export const areaOf = (g: PlotGeometry) => r1(multiArea(projectGeometry(g)));

export interface AreaContext {
  zones: { zone: string; geom: PCMulti }[];
  boundary: PCMulti;
}

export function buildAreaContext(zones: { zone: string; geometry: PlotGeometry }[], boundary: PlotGeometry[]): AreaContext {
  return {
    zones: zones.map((z) => ({ zone: z.zone, geom: projectGeometry(z.geometry) })),
    boundary: boundary.map(projectGeometry).flat(),
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** area_m2, area_in_upu_m2 and per-zone overlap_m2 for a (possibly edited) geometry. */
export function measure(g: PlotGeometry, ctx: AreaContext): { area_m2: number; area_in_upu_m2: number; zones: ZoneOverlap[] } {
  const p = projectGeometry(g);
  const zones: ZoneOverlap[] = [];
  for (const z of ctx.zones) {
    const ov = multiArea(polygonClipping.intersection(p, z.geom));
    if (ov >= 0.5) zones.push({ zone: z.zone, overlap_m2: r1(ov) });
  }
  return {
    area_m2: r1(multiArea(p)),
    area_in_upu_m2: r1(multiArea(polygonClipping.intersection(p, ctx.boundary))),
    zones,
  };
}

/** Does a closed ring cross itself? (segments that are not neighbours intersect) */
export function ringSelfIntersects(ring: Position[]): boolean {
  const n = ring.length - 1; // closed ring
  const cross = (a: Position, b: Position, c: Position, d: Position) => {
    const o = (p: Position, q: Position, r: Position) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (cross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  return false;
}

export const closeRing = (open: Position[]): Position[] => [...open, open[0]];
export const polygonFromRings = (rings: Position[][]): Polygon => ({ type: 'Polygon', coordinates: rings });
