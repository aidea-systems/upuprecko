"""Builds the UPU plan layers (zones, UPU boundary, roads) in the frame of the official cadastre.

Done once on 2026-11-11; kept so the result can be reproduced. It always starts from the untouched
files in _backup_before_official_cadastre/, so running it again gives the same result.

1. Shift. The plan layers were digitised on the 2009 cadastral lines. Compared with today's official
   cadastre those lines sit 0.375 m too far east and 0.455 m too far south - a constant shift, measured
   on 471 parcel corners that are identical in both (spread 1.5 cm, no rotation or scale). Every plan
   layer is moved by that amount.

2. Zones. The zone outlines are taken from the colour fills of the plan PDF (map 1, "Korištenje i
   namjena površina") instead of the earlier simplified outlines. The PDF is placed with an affine fit
   on the plan's road lines (about 5 000 points, RMS under 1 cm). Each fill piece goes to the zone it
   lies in; IS has no fill in the PDF and keeps its outline.

3. Roads. Road area = UPU boundary minus all zones.

    python tools/build_plan_layers.py         (run from upu-precko-zapad-map-data/)

Needs: pyproj, shapely, numpy, scipy, pymupdf.
"""
import json
import pathlib
import sys

import numpy as np
import pymupdf
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union

DATA = pathlib.Path(__file__).resolve().parent.parent
SRC = DATA / '_backup_before_official_cadastre'
PDF = DATA / 'UPU prečko zapad I..pdf'
SHIFT_E, SHIFT_N = -0.375, 0.455  # metres in EPSG:3765, 2009 frame -> official cadastre
TO = Transformer.from_crs(4326, 3765, always_xy=True)
BACK = Transformer.from_crs(3765, 4326, always_xy=True)
FRAME = (
    'Official cadastre frame (HTRS96/TM, EPSG:3765 -> WGS84). Shifted by -0.375 m east, +0.455 m north '
    'from the 2009 UPU frame on 2026-11-11.'
)
FILL = {'M': (1.0, 0.87, 0.5), 'Z': (0.62, 1.0, 0.5), 'D': (1.0, 0.62, 0.5)}  # zone colours in the PDF


def conv(c, fn):
    if isinstance(c[0], (int, float)):
        return fn(c)
    return [conv(k, fn) for k in c]


def old_frame(geom):
    """GeoJSON geometry (lon/lat, 2009 frame) -> shapely geometry in metres (EPSG:3765 axes, still unshifted)."""
    return shape({'type': geom['type'], 'coordinates': conv(geom['coordinates'], lambda p: list(TO.transform(p[0], p[1])))})


def official_lonlat(coords):
    """Metric coordinates in the 2009 frame -> lon/lat in the official frame."""
    return conv(coords, lambda p: [round(v, 9) for v in BACK.transform(p[0] + SHIFT_E, p[1] + SHIFT_N)])


def read(name):
    return json.loads((SRC / f'{name}.geojson').read_text(encoding='utf-8'))


def write(name, fc):
    fc['frame'] = FRAME
    (DATA / f'{name}.geojson').write_text(json.dumps(fc, ensure_ascii=False), encoding='utf-8')


# ---------------------------------------------------------------- plan PDF
def subpaths(q):
    subs, cur = [], []
    for it in q['items']:
        if it[0] == 'l':
            a, b = it[1], it[2]
            if not cur or abs(cur[-1][0] - a.x) > 1e-6 or abs(cur[-1][1] - a.y) > 1e-6:
                if cur:
                    subs.append(cur)
                cur = [(a.x, a.y)]
            cur.append((b.x, b.y))
        else:  # 're' rectangle or 'qu' quad
            if cur:
                subs.append(cur)
                cur = []
            if it[0] == 're':
                r = it[1]
                subs.append([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)])
            elif it[0] == 'qu':
                d = it[1]
                subs.append([(d.ul.x, d.ul.y), (d.ur.x, d.ur.y), (d.lr.x, d.lr.y), (d.ll.x, d.ll.y), (d.ul.x, d.ul.y)])
    if cur:
        subs.append(cur)
    return subs


def fit(p, q):
    coef, *_ = np.linalg.lstsq(np.column_stack([p, np.ones(len(p))]), q, rcond=None)
    return coef


def apply(coef, pts):
    pts = np.asarray(pts)
    return np.column_stack([pts, np.ones(len(pts))]) @ coef


def zones_from_pdf(old_zones, road_lines):
    drawings = pymupdf.open(PDF)[0].get_drawings()
    pieces = {k: [] for k in FILL}
    stroke_pts = []
    for q in drawings:
        subs = subpaths(q)
        if q['type'] in ('s', 'fs') and q.get('color') is not None:
            for s in subs:
                stroke_pts.extend(s)
        f = q.get('fill')
        for k, c in FILL.items():
            if f is not None and all(abs(a - b) < 0.012 for a, b in zip(f, c)):
                for s in subs:
                    if len(s) >= 3:
                        g = Polygon(s).buffer(0)
                        if g.area > 0:
                            pieces[k].append(g)

    # first guess: the five green zones, paired by size; then refine on the road lines
    green = sorted([g for g in unary_union(pieces['Z']).geoms if g.area > 1000], key=lambda g: -g.area)[:5]
    ref = sorted([g for n, g in old_zones.items() if n.startswith('Z1')], key=lambda g: -g.area)
    coef = fit(np.array([[g.centroid.x, g.centroid.y] for g in green]), np.array([[g.centroid.x, g.centroid.y] for g in ref]))
    ref_pts = np.unique(np.round(np.array([c for g in road_lines for c in g.coords]), 3), axis=0)
    tree = cKDTree(ref_pts)
    pdf_pts = np.unique(np.round(np.array(stroke_pts), 4), axis=0)
    for tol in (3.0, 1.0, 0.3, 0.1, 0.05, 0.03, 0.03):
        d, idx = tree.query(apply(coef, pdf_pts))
        m = d < tol
        coef = fit(pdf_pts[m], ref_pts[idx[m]])
    res = apply(coef, pdf_pts[m]) - ref_pts[idx[m]]
    rms = float(np.sqrt((res ** 2).sum(axis=1).mean()))
    print(f'  plan PDF placed on {int(m.sum())} road-line points, RMS {rms * 100:.1f} cm')
    if m.sum() < 3000 or rms > 0.02:
        sys.exit('The PDF could not be placed precisely - zones not rebuilt.')

    def world(g):
        return Polygon([tuple(v) for v in apply(coef, np.array(g.exterior.coords))])

    out = {}
    for k, names in (('M', [n for n in old_zones if n[0] == 'M']), ('Z', [n for n in old_zones if n[0] == 'Z']), ('D', ['D4'])):
        groups = {n: [] for n in names}
        for g in (world(p) for p in pieces[k]):
            best = max(names, key=lambda n: old_zones[n].intersection(g).area)
            if old_zones[best].intersection(g).area >= 0.5 * g.area:  # else: legend swatch
                groups[best].append(g)
        for n, gs in groups.items():
            u = unary_union(gs).buffer(0.02, join_style=2).buffer(-0.02, join_style=2)  # close hairline seams between pieces
            if u.geom_type != 'Polygon':
                u = max(u.geoms, key=lambda x: x.area)
            u = Polygon(u.exterior).simplify(0.005)  # drop points that are on a straight line (5 mm)
            diff = old_zones[n].symmetric_difference(u).area
            if abs(u.area - old_zones[n].area) > 0.005 * old_zones[n].area or diff > 0.01 * old_zones[n].area:
                sys.exit(f'{n}: the PDF outline differs too much from the earlier one ({u.area:.0f} vs {old_zones[n].area:.0f} m2).')
            out[n] = u
    return out, rms


def main():
    zones_fc = read('zones')
    old_zones = {f['properties']['zone']: old_frame(f['geometry']) for f in zones_fc['features']}
    road_lines = [old_frame(f['geometry']) for f in read('road_lines')['features']]
    new_zones, rms = zones_from_pdf(old_zones, road_lines)

    # zones must not overlap: where two outlines overlap by a hair, the later one gives way
    done = []
    for f in zones_fc['features']:
        n = f['properties']['zone']
        g = new_zones.get(n, old_zones[n])  # IS keeps its outline
        for other in done:
            if g.intersects(other) and g.intersection(other).area > 0:
                g = g.difference(other)
                if g.geom_type != 'Polygon':
                    g = max(g.geoms, key=lambda x: x.area)
        done.append(g)
        new_zones[n] = g
        f['geometry'] = {'type': 'Polygon', 'coordinates': official_lonlat(mapping(g)['coordinates'])}
        before = f['properties']['area_m2']
        f['properties']['area_m2'] = round(g.area, 1)
        if n != 'IS':
            f['properties']['source'] = f'UPU PDF map 1, zone fill (placed on the plan road lines, RMS {rms * 100:.1f} cm)'
        print(f'  {n:5} {before:9.1f} -> {g.area:9.1f} m2   {len(g.exterior.coords)} corners')
    write('zones', zones_fc)

    boundary_fc = read('boundary')
    boundary = unary_union([old_frame(f['geometry']) for f in boundary_fc['features']])
    for f in boundary_fc['features']:
        g = old_frame(f['geometry'])
        f['geometry']['coordinates'] = official_lonlat(mapping(g)['coordinates'])
        f['properties']['area_m2'] = round(g.area, 1)
    write('boundary', boundary_fc)

    for name in ('road_lines', 'road_labels'):
        fc = read(name)
        for f in fc['features']:
            f['geometry']['coordinates'] = official_lonlat(mapping(old_frame(f['geometry']))['coordinates'])
        write(name, fc)

    roads = boundary.difference(unary_union(list(new_zones.values())))
    parts = [p for p in (roads.geoms if roads.geom_type == 'MultiPolygon' else [roads]) if p.area >= 1]
    roads = parts[0] if len(parts) == 1 else MultiPolygon(parts)
    write('roads', {
        'type': 'FeatureCollection',
        'features': [{
            'type': 'Feature',
            'properties': {'kind': 'road_area', 'area_m2': round(roads.area, 1)},
            'geometry': {'type': roads.geom_type, 'coordinates': official_lonlat(mapping(roads)['coordinates'])},
        }],
    })
    all_zones = unary_union(list(new_zones.values()))
    print(f'  UPU boundary {boundary.area:.1f} m2 = zones {all_zones.intersection(boundary).area:.1f} + roads {roads.area:.1f}'
          f' (zones outside the boundary: {all_zones.difference(boundary).area:.1f} m2)')


if __name__ == '__main__':
    main()
