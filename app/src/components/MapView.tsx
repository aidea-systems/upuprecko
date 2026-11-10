import { useEffect, useRef } from 'react';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import { config } from '../config';
import type { BBox } from '../lib/geo';

export type ViewMode = 'plots' | 'zones' | 'landuse';
export type Basemap = 'satellite' | 'dark';
export interface LayerVisibility {
  plots: boolean;
  zones: boolean;
  roads: boolean;
  boundary: boolean;
  review: boolean;
}

export interface RoadData {
  areas: FeatureCollection;
  lines: FeatureCollection;
  labels: FeatureCollection;
}

interface Props {
  plots: FeatureCollection; // properties include _status, _label, _res
  zones: FeatureCollection; // properties include _band, _label
  boundary: FeatureCollection;
  roads: RoadData;
  /** shapes hidden from the normal plot layers (being edited) */
  hiddenFeatureIds: string[];
  initialBounds: BBox;
  layers: LayerVisibility;
  basemap: Basemap;
  viewMode: ViewMode;
  selectedFeatureIds: string[];
  selectedZone: string | null;
  onPlotClick: (featureId: string, lngLat: maplibregl.LngLat) => void;
  onZoneClick: (zone: string, lngLat: maplibregl.LngLat) => void;
  onBackgroundClick: () => void;
  onReady: (map: maplibregl.Map) => void;
}

const LAYER_GROUPS: Record<keyof LayerVisibility, string[]> = {
  plots: ['plots-fill', 'plots-line', 'plots-selected', 'plot-labels'],
  review: ['review-hatch', 'review-line'],
  zones: ['zones-fill', 'zones-line', 'zones-selected', 'zone-labels'],
  roads: ['roads-fill', 'road-detail', 'road-edge', 'road-carriageway', 'road-centre', 'road-labels'],
  boundary: ['boundary-line'],
};

/** Base filters of the plot layers; the hidden-ids filter is added on top. */
const PLOT_LAYER_FILTERS: Record<string, unknown[] | null> = {
  'plots-fill': null,
  'plots-line': null,
  'plot-labels': null,
  'review-hatch': ['==', ['get', '_res'], 'unresolved'],
  'review-line': ['==', ['get', '_res'], 'unresolved'],
};

const zw = (a: number, b: number): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 15, a, 19, b];

function hatchImage(color: string): ImageData {
  const s = 16;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.fillStyle = color + '33';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = color;
  g.lineWidth = 2.5;
  for (const o of [-s, 0, s]) {
    g.beginPath();
    g.moveTo(o, s);
    g.lineTo(o + s, 0);
    g.stroke();
  }
  return g.getImageData(0, 0, s, s);
}

const statusColor: ExpressionSpecification = [
  'match', ['get', '_status'],
  'owned', config.statusColors.owned,
  'negotiating', config.statusColors.negotiating,
  'not_owned', config.statusColors.not_owned,
  config.statusColors.no_data,
];
const bandColor: ExpressionSpecification = [
  'match', ['get', '_band'],
  'green', config.zoneBandColors.green,
  'yellow', config.zoneBandColors.yellow,
  'red', config.zoneBandColors.red,
  config.zoneBandColors.none,
];
const landuseColor: ExpressionSpecification = [
  'match', ['get', 'landuse_code'],
  ...Object.entries(config.landuseColors).flat(),
  '#cccccc',
] as unknown as ExpressionSpecification;

export function MapView(p: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loaded = useRef(false);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: { version: 8, glyphs: config.glyphs, sources: {}, layers: [] },
      bounds: p.initialBounds,
      fitBoundsOptions: { padding: { top: 80, bottom: 40, left: 360, right: 360 } },
      maxZoom: config.maxZoom,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      const s = latest.current;
      map.addImage('hatch', hatchImage(config.reviewColor), { pixelRatio: 2 });
      for (const [id, b] of Object.entries(config.basemaps))
        map.addSource(id, { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution });
      map.addSource('zones', { type: 'geojson', data: s.zones });
      map.addSource('plots', { type: 'geojson', data: s.plots });
      map.addSource('boundary', { type: 'geojson', data: s.boundary });
      map.addSource('road-areas', { type: 'geojson', data: s.roads.areas });
      map.addSource('road-lines', { type: 'geojson', data: s.roads.lines });
      map.addSource('road-labels', { type: 'geojson', data: s.roads.labels });

      map.addLayer({ id: 'satellite', type: 'raster', source: 'satellite' });
      map.addLayer({ id: 'dark', type: 'raster', source: 'dark' });
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': landuseColor, 'fill-opacity': 0 } });
      map.addLayer({ id: 'roads-fill', type: 'fill', source: 'road-areas', paint: { 'fill-color': '#1e1b2e', 'fill-opacity': 0.55 } });
      map.addLayer({
        id: 'plots-fill', type: 'fill', source: 'plots',
        paint: { 'fill-color': statusColor, 'fill-opacity': 0 },
      });
      map.addLayer({
        id: 'review-hatch', type: 'fill', source: 'plots',
        filter: ['==', ['get', '_res'], 'unresolved'],
        paint: { 'fill-pattern': 'hatch' },
      });
      map.addLayer({
        id: 'plots-line', type: 'line', source: 'plots',
        paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 19, 1.4], 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'review-line', type: 'line', source: 'plots',
        filter: ['==', ['get', '_res'], 'unresolved'],
        paint: { 'line-color': config.reviewColor, 'line-width': 1.8 },
      });
      map.addLayer({
        id: 'zones-line', type: 'line', source: 'zones',
        paint: { 'line-color': '#000000', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1.2, 19, 3] },
      });
      map.addLayer({
        id: 'road-detail', type: 'line', source: 'road-lines', minzoom: 16, filter: ['==', ['get', 'kind'], 'road_detail'],
        paint: { 'line-color': '#e2e8f0', 'line-width': zw(0.3, 1), 'line-opacity': 0.75 },
      });
      map.addLayer({
        id: 'road-edge', type: 'line', source: 'road-lines', filter: ['==', ['get', 'kind'], 'road_edge'],
        paint: { 'line-color': '#f8fafc', 'line-width': zw(0.6, 1.6) },
      });
      map.addLayer({
        id: 'road-carriageway', type: 'line', source: 'road-lines', filter: ['==', ['get', 'kind'], 'carriageway'],
        paint: { 'line-color': '#ff4d4d', 'line-width': zw(0.7, 1.8) },
      });
      map.addLayer({
        id: 'road-centre', type: 'line', source: 'road-lines', filter: ['==', ['get', 'kind'], 'centreline'],
        paint: { 'line-color': '#facc15', 'line-width': zw(0.5, 1.3) },
      });
      map.addLayer({
        id: 'boundary-line', type: 'line', source: 'boundary',
        paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [3, 2] },
      });
      map.addLayer({
        id: 'zones-selected', type: 'line', source: 'zones', filter: ['==', ['get', 'zone'], ''],
        paint: { 'line-color': '#22d3ee', 'line-width': 4 },
      });
      map.addLayer({
        id: 'plots-selected', type: 'line', source: 'plots', filter: ['in', ['get', 'id'], ['literal', []]],
        paint: { 'line-color': '#22d3ee', 'line-width': 3.5 },
      });
      map.addLayer({
        id: 'plot-labels', type: 'symbol', source: 'plots', minzoom: config.plotLabelMinZoom,
        layout: {
          'text-field': ['get', '_label'], 'text-font': config.font, 'text-size': 11,
          'text-max-width': 6, 'symbol-placement': 'point',
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.4 },
      });
      map.addLayer({
        id: 'zone-labels', type: 'symbol', source: 'zones',
        layout: {
          'text-field': ['get', '_label'], 'text-font': config.font,
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 11, 19, 16], 'text-allow-overlap': true,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1.6 },
      });
      map.addLayer({
        id: 'road-labels', type: 'symbol', source: 'road-labels',
        layout: {
          'text-field': ['get', 'name'], 'text-font': config.font, 'text-size': zw(11, 15),
          'text-rotate': ['get', 'angle'], 'text-rotation-alignment': 'map', 'text-allow-overlap': true,
          'text-letter-spacing': 0.05,
        },
        paint: { 'text-color': '#fde68a', 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1.6 },
      });
      loaded.current = true;
      applyAll(map, latest.current);
      latest.current.onReady(map);
    });

    map.on('click', (e) => {
      const s = latest.current;
      const plotLayers = [s.layers.plots && 'plots-fill', s.layers.review && 'review-hatch'].filter(Boolean) as string[];
      if (s.viewMode === 'plots' && plotLayers.length) {
        const hit = map.queryRenderedFeatures(e.point, { layers: plotLayers });
        if (hit.length) return s.onPlotClick(String(hit[0].properties.id), e.lngLat);
      }
      if (s.layers.zones) {
        const z = map.queryRenderedFeatures(e.point, { layers: ['zones-fill'] });
        if (z.length) return s.onZoneClick(String(z[0].properties.zone), e.lngLat);
      }
      if (plotLayers.length) {
        const hit = map.queryRenderedFeatures(e.point, { layers: plotLayers });
        if (hit.length) return s.onPlotClick(String(hit[0].properties.id), e.lngLat);
      }
      s.onBackgroundClick();
    });
    map.on('mousemove', (e) => {
      if (!loaded.current) return;
      const layers = ['plots-fill', 'review-hatch', 'zones-fill'].filter((l) => map.getLayoutProperty(l, 'visibility') !== 'none');
      map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers }).length ? 'pointer' : '';
    });

    return () => {
      loaded.current = false;
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded.current) (map.getSource('plots') as GeoJSONSource).setData(p.plots);
  }, [p.plots]);
  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded.current) (map.getSource('zones') as GeoJSONSource).setData(p.zones);
  }, [p.zones]);
  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded.current) applyAll(map, p);
  }, [p.layers, p.basemap, p.viewMode, p.selectedFeatureIds, p.selectedZone, p.hiddenFeatureIds]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={container} className="map" />;
}

function applyAll(map: maplibregl.Map, p: Props) {
  map.setLayoutProperty('satellite', 'visibility', p.basemap === 'satellite' ? 'visible' : 'none');
  map.setLayoutProperty('dark', 'visibility', p.basemap === 'dark' ? 'visible' : 'none');
  for (const [group, ids] of Object.entries(LAYER_GROUPS))
    for (const id of ids) map.setLayoutProperty(id, 'visibility', p.layers[group as keyof LayerVisibility] ? 'visible' : 'none');

  const plotsMode = p.viewMode === 'plots';
  map.setPaintProperty('plots-fill', 'fill-opacity', [
    'case',
    ['==', ['get', '_res'], 'unresolved'], 0.01, // invisible but clickable
    ['==', ['get', '_res'], 'not_plot'], plotsMode ? 0.12 : 0.01,
    plotsMode ? config.plotFillOpacity : 0.01,
  ]);
  map.setPaintProperty('plots-line', 'line-opacity', plotsMode ? 0.85 : 0.35);
  map.setPaintProperty('zones-fill', 'fill-color', p.viewMode === 'zones' ? bandColor : landuseColor);
  map.setPaintProperty('zones-fill', 'fill-opacity', plotsMode ? 0.01 : config.zoneFillOpacity);
  map.setPaintProperty('zones-line', 'line-color', p.basemap === 'dark' && plotsMode ? '#cbd5e1' : '#000000');
  const notHidden = ['!', ['in', ['get', 'id'], ['literal', p.hiddenFeatureIds]]];
  for (const [id, base] of Object.entries(PLOT_LAYER_FILTERS))
    map.setFilter(id, (base ? ['all', base, notHidden] : notHidden) as maplibregl.FilterSpecification);
  map.setFilter('plots-selected', ['in', ['get', 'id'], ['literal', p.selectedFeatureIds]]);
  map.setFilter('zones-selected', ['==', ['get', 'zone'], p.selectedZone ?? '']);
}
