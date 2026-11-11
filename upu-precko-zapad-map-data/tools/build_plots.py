"""Builds plots.geojson from the official cadastral parcels (one shape per official parcel, uncut).

A parcel is put on the map when
  - it is listed in the ZK workbook (061026_ZK DD Prečko.xlsx), or
  - at least 1 m2 of it lies inside the UPU boundary.

The shape is the official parcel exactly as published: the EPSG:3765 coordinates are only converted
to longitude/latitude (WGS84 = ETRS89 here), 9 decimals, which reproduces every corner to under 0.1 mm.
Parcels are never clipped, split, merged or simplified.

    python tools/fetch_cadastre.py     (optional: refresh the official parcels first)
    python tools/build_plots.py        (run from upu-precko-zapad-map-data/)

Needs: pyproj, shapely, openpyxl.
"""
import datetime
import json
import pathlib
import re
import sys

import openpyxl
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import unary_union

DATA = pathlib.Path(__file__).resolve().parent.parent
REPO = DATA.parent
OFFICIAL = DATA / 'official' / 'cadastre_parcels_EPSG3765.geojson'
WORKBOOK = REPO / '061026_ZK DD Prečko.xlsx'
OWNERSHIP = REPO / 'app' / 'data' / 'ownership.json'
MIN_IN_UPU_M2 = 1.0
MIN_ZONE_OVERLAP_M2 = 0.5  # same threshold as the app (src/lib/area.ts)
# A plot counts as "in a zone" only if the overlap is wider than 20 cm somewhere. Zone borders come from the
# UPU plan, which was drawn on the 2009 cadastre; where a zone border is meant to follow a parcel border the
# two can differ by a few centimetres, which gives hairline overlaps (0.5-1.6 m2 along a whole border).
# The ZK workbook lists none of those, and every plot-in-zone it does list passes this test.
HAIRLINE_HALF_WIDTH_M = 0.10
# Official parcels that replace a workbook plot number and must be on the map even if they lie outside the UPU.
ALSO_INCLUDE = {'6366/1'}  # workbook plot 6366 is 6366/1 + 6366/2 in the cadastre since 18 Oct 2026
MUNICIPALITIES = {'339318': 'Donje Vrapče', '340057': 'Stenjevec Jug', '339326': 'Lučko'}  # from cp:CadastralZoning

TO = Transformer.from_crs(4326, 3765, always_xy=True)
BACK = Transformer.from_crs(3765, 4326, always_xy=True)


def conv(c, fn):
    if isinstance(c[0], (int, float)):
        return fn(c)
    return [conv(k, fn) for k in c]


def projected(geom):
    """WGS84 GeoJSON geometry -> shapely geometry in EPSG:3765."""
    return shape({'type': geom['type'], 'coordinates': conv(geom['coordinates'], lambda p: list(TO.transform(p[0], p[1])))})


def workbook_plot_numbers():
    wb = openpyxl.load_workbook(WORKBOOK, read_only=True, data_only=True)
    out = set()
    for ws in wb.worksheets:
        if ws.title == 'KONSOLIDIRANO':
            continue
        for (a,) in ws.iter_rows(min_row=2, max_col=1, values_only=True):
            s = str(a).strip() if a is not None else ''
            if s[:1].isdigit():
                out.add(s)
    return out


def natural(s):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', s)]


def main():
    official = json.loads(OFFICIAL.read_text(encoding='utf-8'))
    zones = [(f['properties']['zone'], projected(f['geometry'])) for f in json.loads((DATA / 'zones.geojson').read_text(encoding='utf-8'))['features']]
    boundary_fc = json.loads((DATA / 'boundary.geojson').read_text(encoding='utf-8'))
    if 'frame' not in boundary_fc:
        sys.exit('boundary.geojson is not in the official frame yet - run tools/align_plan_layers.py first.')
    boundary = unary_union([projected(f['geometry']) for f in boundary_fc['features']])
    in_workbook = workbook_plot_numbers()

    feats, skipped_slivers, hairlines, max_dev = [], [], [], 0.0
    for f in official['features']:
        p = f['properties']
        g = shape(f['geometry'])  # EPSG:3765, as published
        in_upu = g.intersection(boundary).area
        if p['label'] not in in_workbook and p['label'] not in ALSO_INCLUDE and in_upu < MIN_IN_UPU_M2:
            if in_upu >= 0.05:
                skipped_slivers.append((p['label'], round(in_upu, 2)))
            continue
        wgs = conv(f['geometry']['coordinates'], lambda c: [round(v, 9) for v in BACK.transform(c[0], c[1])])
        # proof of exactness: converting the stored corners back gives the published coordinates
        back = conv(wgs, lambda c: list(TO.transform(c[0], c[1])))
        flat_a, flat_b = [], []
        conv(f['geometry']['coordinates'], lambda c: flat_a.append(c))
        conv(back, lambda c: flat_b.append(c))
        max_dev = max(max_dev, max(max(abs(a[0] - b[0]), abs(a[1] - b[1])) for a, b in zip(flat_a, flat_b)))
        zs = []
        for name, z in zones:
            part = g.intersection(z)
            ov = part.area
            if ov >= MIN_ZONE_OVERLAP_M2:
                if part.buffer(-HAIRLINE_HALF_WIDTH_M).area < 0.01:
                    hairlines.append((p['label'], name, round(ov, 1)))
                    continue
                zs.append({'zone': name, 'overlap_m2': round(ov, 1)})
        feats.append({
            'type': 'Feature',
            'properties': {
                'id': p['label'],
                'plot_number': p['label'],
                'candidates': [p['label']],
                'kind': 'plot',
                'area_m2': round(g.area, 1),
                'area_in_upu_m2': round(in_upu, 1),
                'zones': zs,
                'registered_area_m2': p['registered_area_m2'],
                'cadastral_ref': p['ref'],
                'municipality': MUNICIPALITIES.get(p['municipality_code'], p['municipality_code']),
                'valid_from': p['valid_from'][:10],
            },
            'geometry': {'type': f['geometry']['type'], 'coordinates': wgs},
        })

    labels = [f['properties']['id'] for f in feats]
    dup = sorted({x for x in labels if labels.count(x) > 1})
    if dup:
        sys.exit(f'Same plot number in two cadastral municipalities: {dup} - ids must be made unique first.')
    feats.sort(key=lambda f: natural(f['properties']['id']))

    (DATA / 'plots.geojson').write_text(json.dumps({
        'type': 'FeatureCollection',
        'source': official['source'],
        'cadastre_downloaded_at': official['downloaded_at'],
        'built_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'note': 'One feature per official cadastral parcel, geometry exactly as published (EPSG:3765 -> WGS84, 9 decimals).',
        'features': feats,
    }, ensure_ascii=False), encoding='utf-8')

    on_map = set(labels)
    covered = unary_union([shape(f['geometry']) for f in official['features'] if f['properties']['label'] in on_map])
    print(f'{len(feats)} parcels written to plots.geojson (official download of {official["downloaded_at"]})')
    print(f'  largest difference from the published coordinates: {max_dev * 1000:.3f} mm')
    print(f'  UPU area not covered by a parcel on the map: {boundary.difference(covered).area:.2f} m2 of {boundary.area:.0f} m2')
    print(f'  in the workbook: {len(on_map & in_workbook)}; not in the workbook: {sorted(on_map - in_workbook, key=natural)}')
    print(f'  workbook plot numbers with no official parcel: {sorted(in_workbook - on_map, key=natural)}')
    print(f'  neighbours left out (under {MIN_IN_UPU_M2} m2 inside the UPU boundary): {sorted(skipped_slivers, key=lambda t: -t[1])}')
    print(f'  hairline plot/zone overlaps ignored ({sum(h[2] for h in hairlines):.1f} m2 in all): {hairlines}')
    if OWNERSHIP.exists():
        own = json.loads(OWNERSHIP.read_text(encoding='utf-8'))['plots']
        print(f'  on the map without an ownership record: {sorted(on_map - set(own), key=natural)}')
        print(f'  ownership records without a parcel on the map: {sorted(set(own) - on_map, key=natural)}')


if __name__ == '__main__':
    main()
