import type { Feature, FeatureCollection, Position } from 'geojson';
import type { PlotGeometry } from '../types';

export type BBox = [number, number, number, number];

function rings(g: PlotGeometry): Position[][] {
  return g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
}

export function bboxOf(geoms: PlotGeometry[]): BBox {
  const b: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const g of geoms)
    for (const r of rings(g))
      for (const [x, y] of r) {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
  return b;
}

/** A point inside the polygon (for popups/labels). Uses the widest horizontal span at mid-height. */
export function interiorPoint(g: PlotGeometry): [number, number] {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  // largest polygon by bbox area
  let best = polys[0];
  let bestA = -1;
  for (const p of polys) {
    const [x0, y0, x1, y1] = bboxOf([{ type: 'Polygon', coordinates: p }]);
    const a = (x1 - x0) * (y1 - y0);
    if (a > bestA) [best, bestA] = [p, a];
  }
  const [, y0, , y1] = bboxOf([{ type: 'Polygon', coordinates: best }]);
  let bestPt: [number, number] | null = null;
  let bestW = -1;
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const y = y0 + (y1 - y0) * t;
    const xs: number[] = [];
    for (const ring of best)
      for (let i = 0; i < ring.length - 1; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[i + 1];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (w > bestW) [bestW, bestPt] = [w, [(xs[i] + xs[i + 1]) / 2, y]];
    }
    if (bestPt) break;
  }
  const [x0b, , x1b] = bboxOf([g]);
  return bestPt ?? [(x0b + x1b) / 2, (y0 + y1) / 2];
}

/** Ids of shapes that share at least one corner (to 7 decimals) with the target's outer ring. */
export function cornerNeighbours(targetId: string, features: { id: string; geometry: PlotGeometry }[]): string[] {
  const k = (p: Position) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const target = features.find((f) => f.id === targetId);
  if (!target || target.geometry.type !== 'Polygon') return [];
  const keys = new Set(target.geometry.coordinates[0].map(k));
  return features
    .filter((f) => f.id !== targetId && rings(f.geometry).some((r) => r.some((p) => keys.has(k(p)))))
    .map((f) => f.id);
}

/** Applies a constant shift in metres (east, north) to every coordinate. */
export function shiftCollection<G extends PlotGeometry, P>(
  fc: FeatureCollection<G, P>,
  dxM: number,
  dyM: number,
): FeatureCollection<G, P> {
  if (!dxM && !dyM) return fc;
  const b = bboxOf(fc.features.map((f) => f.geometry));
  const lat0 = (b[1] + b[3]) / 2;
  const dLon = dxM / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const dLat = dyM / 110574;
  const mv = (r: Position[]) => r.map(([x, y]) => [x + dLon, y + dLat]);
  return {
    ...fc,
    features: fc.features.map(
      (f): Feature<G, P> => ({
        ...f,
        geometry: (f.geometry.type === 'Polygon'
          ? { type: 'Polygon', coordinates: f.geometry.coordinates.map(mv) }
          : { type: 'MultiPolygon', coordinates: f.geometry.coordinates.map((p) => p.map(mv)) }) as G,
      }),
    ),
  };
}
