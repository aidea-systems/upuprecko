"""Downloads the current official cadastral parcels around the UPU area.

Source: State Geodetic Administration (DGU) INSPIRE download service, layer cp:CadastralParcel,
https://api.uredjenazemlja.hr/services/inspire/cp/wfs  (open, no login).

The coordinates are written exactly as the service publishes them (EPSG:3765, HTRS96/TM, centimetres).
Nothing is reprojected, rounded or simplified here.

    python tools/fetch_cadastre.py            (run from upu-precko-zapad-map-data/)

Needs: pyproj.
"""
import datetime
import json
import pathlib
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

from pyproj import Transformer

DATA = pathlib.Path(__file__).resolve().parent.parent
OUT = DATA / 'official' / 'cadastre_parcels_EPSG3765.geojson'
WFS = 'https://api.uredjenazemlja.hr/services/inspire/cp/wfs'
MARGIN_M = 150  # around the UPU boundary
PAGE = 200
NS = {
    'wfs': 'http://www.opengis.net/wfs/2.0',
    'gml': 'http://www.opengis.net/gml/3.2',
    'cp': 'http://inspire.ec.europa.eu/schemas/cp/4.0',
}
GML = '{%s}' % NS['gml']


def boundary_bbox():
    to = Transformer.from_crs(4326, 3765, always_xy=True)
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            x, y = to.transform(c[0], c[1])
            xs.append(x)
            ys.append(y)
        else:
            for k in c:
                walk(k)

    for f in json.loads((DATA / 'boundary.geojson').read_text(encoding='utf-8'))['features']:
        walk(f['geometry']['coordinates'])
    return (int(min(xs) - MARGIN_M), int(min(ys) - MARGIN_M), int(max(xs) + MARGIN_M) + 1, int(max(ys) + MARGIN_M) + 1)


def get(url):
    """The service often answers with a database error (ORA-01000); it works on a retry."""
    for _ in range(25):
        try:
            body = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'upu-precko-map'}), timeout=120).read()
            if b'ExceptionReport' not in body:
                return body
        except Exception:  # noqa: BLE001 - network hiccup, retry
            pass
        time.sleep(2)
    sys.exit('The cadastre service keeps failing - try again later.')


def ring(pos_list):
    v = pos_list.text.split()
    return [[float(v[i]), float(v[i + 1])] for i in range(0, len(v), 2)]


def main():
    x0, y0, x1, y1 = boundary_bbox()
    feats, start, matched = [], 0, None
    while True:
        url = (
            f'{WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=cp:CadastralParcel'
            f'&bbox={x0},{y0},{x1},{y1},urn:ogc:def:crs:EPSG::3765&count={PAGE}&startIndex={start}&sortBy=cp:label'
        )
        root = ET.fromstring(get(url))
        matched = int(root.get('numberMatched'))
        members = root.findall('wfs:member', NS)
        for m in members:
            p = m.find('cp:CadastralParcel', NS)
            polys = []
            for poly in p.iter(GML + 'Polygon'):
                rings = [ring(poly.find(GML + 'exterior').find('.//' + GML + 'posList'))]
                rings += [ring(i.find('.//' + GML + 'posList')) for i in poly.findall(GML + 'interior')]
                polys.append(rings)
            geom = {'type': 'Polygon', 'coordinates': polys[0]} if len(polys) == 1 else {'type': 'MultiPolygon', 'coordinates': polys}
            ref = p.find('cp:nationalCadastralReference', NS).text
            feats.append({
                'type': 'Feature',
                'properties': {
                    'label': p.find('cp:label', NS).text,
                    'ref': ref,
                    'municipality_code': ref.split('-')[0],
                    'registered_area_m2': float(p.find('cp:areaValue', NS).text),
                    'valid_from': p.find('cp:beginLifespanVersion', NS).text,
                    'gml_id': p.get(GML + 'id'),
                },
                'geometry': geom,
            })
        print(f'  {start + len(members)} / {matched}', flush=True)
        if len(members) < PAGE:
            break
        start += PAGE

    ids = [f['properties']['gml_id'] for f in feats]
    if len(feats) != matched or len(set(ids)) != len(ids):
        sys.exit(f'Incomplete download ({len(feats)} features, {len(set(ids))} distinct, service says {matched}) - run again.')
    feats.sort(key=lambda f: f['properties']['ref'])
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        'type': 'FeatureCollection',
        'name': 'Official cadastral parcels (DGU), coordinates as published',
        'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:EPSG::3765'}},
        'source': WFS + ' (cp:CadastralParcel)',
        'downloaded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'bbox_EPSG3765': [x0, y0, x1, y1],
        'features': feats,
    }, ensure_ascii=False), encoding='utf-8')
    print(f'{len(feats)} parcels -> {OUT}')


if __name__ == '__main__':
    main()
