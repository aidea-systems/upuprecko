import { useCallback, useEffect, useMemo, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { BoundaryFC, FeatureEdit, PlotGeometry, PlotProps, PlotRecord, PlotsFC, Polygon, ZoneProps, ZonesFC } from './types';
import { config, zoneBand } from './config';
import { strings as t } from './i18n/strings';
import { bboxOf, cornerNeighbours, interiorPoint, shiftCollection, type BBox } from './lib/geo';
import { applyEdits, checkRename, getRecord, normalizeDoc } from './lib/ownership';
import { computeZoneStats, resolveFeature } from './lib/zoneStats';
import { buildImport } from './lib/importRows';
import { exportExcel, exportGeojson, exportJson, readImportFile } from './lib/fileIO';
import { fmtPct, sortPlotNumbers } from './lib/format';
import { areaOf, buildAreaContext, measure } from './lib/area';
import { LocalJsonRepository } from './storage/localJsonRepository';
import { useOwnership } from './storage/useOwnership';
import { MapView, type Basemap, type LayerVisibility, type RoadData, type ViewMode } from './components/MapView';
import { MapPopup } from './components/MapPopup';
import { PlotPopup, type PlotSummary } from './components/PlotPopup';
import { BoundaryEditor } from './components/BoundaryEditor';
import { ReviewPopup } from './components/ReviewPopup';
import { ZonePopup } from './components/ZonePopup';
import { LayersPanel } from './components/LayersPanel';
import { ZoneSummaryPanel, type CalcMode } from './components/ZoneSummaryPanel';
import { SearchBar, type SearchItem } from './components/SearchBar';
import { ImportDialog, type PendingImport } from './components/ImportDialog';

interface MapData {
  plots: PlotsFC;
  zones: ZonesFC;
  boundary: BoundaryFC;
  roads: RoadData;
}

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };

type Popup =
  | { type: 'feature'; featureId: string; lngLat: [number, number] }
  | { type: 'zone'; zone: string; lngLat: [number, number] }
  | null;

async function loadMapData(): Promise<MapData> {
  const get = async <T,>(f: string): Promise<T> => {
    const r = await fetch(`${import.meta.env.BASE_URL}data/${f}`);
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.json();
  };
  const optional = (f: string) => get<FeatureCollection>(f).catch(() => EMPTY_FC);
  const { x, y } = config.geometryShiftMeters;
  const [plots, zones, boundary, areas, lines, labels] = await Promise.all([
    get<PlotsFC>('plots.geojson'),
    get<ZonesFC>('zones.geojson'),
    get<BoundaryFC>('boundary.geojson'),
    optional('roads.geojson'),
    optional('road_lines.geojson'),
    optional('road_labels.geojson'),
  ]);
  const shiftAny = (fc: FeatureCollection) => (x || y ? shiftFC(fc, x, y) : fc);
  return {
    plots: shiftCollection(plots, x, y),
    zones: shiftCollection(zones, x, y),
    boundary: shiftCollection(boundary, x, y),
    roads: { areas: shiftAny(areas), lines: shiftAny(lines), labels: shiftAny(labels) },
  };
}

/** Shift for road layers (points, lines, polygons). */
function shiftFC(fc: FeatureCollection, dxM: number, dyM: number): FeatureCollection {
  const lat0 = 45.79;
  const dLon = dxM / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const dLat = dyM / 110574;
  const mv = (c: unknown): unknown => (typeof (c as number[])[0] === 'number' ? [(c as number[])[0] + dLon, (c as number[])[1] + dLat] : (c as unknown[]).map(mv));
  return {
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      geometry: { ...f.geometry, coordinates: mv((f.geometry as { coordinates: unknown }).coordinates) } as Feature['geometry'],
    })),
  };
}

export default function App() {
  const [data, setData] = useState<MapData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const repo = useMemo(() => new LocalJsonRepository(), []);
  const own = useOwnership(repo);
  const doc = own.doc;

  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const [layers, setLayers] = useState<LayerVisibility>({ plots: true, zones: true, roads: true, boundary: true, review: true, focus: true });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<Basemap>('satellite');
  const [viewMode, setViewMode] = useState<ViewMode>('plots');
  const [calcMode, setCalcMode] = useState<CalcMode>('area');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [pending, setPending] = useState<PendingImport | null>(null);

  useEffect(() => {
    loadMapData().then(setData).catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
      if (e.key === 'Escape' && !typing) setPopup(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- shapes with the user's plot-number / boundary edits applied ----------
  const features = useMemo(() => (data && doc ? applyEdits(data.plots.features, doc.edits) : []), [data, doc]);
  const sourceById = useMemo(() => new Map((data?.plots.features ?? []).map((f) => [f.properties.id, f])), [data]);
  const areaCtx = useMemo(
    () =>
      data
        ? buildAreaContext(
            data.zones.features.map((f) => ({ zone: f.properties.zone, geometry: f.geometry })),
            data.boundary.features.map((f) => f.geometry),
          )
        : null,
    [data],
  );

  // ---------- indexes ----------
  const featureById = useMemo(() => new Map(features.map((f) => [f.properties.id, f])), [features]);
  const zoneByName = useMemo(() => new Map((data?.zones.features ?? []).map((f) => [f.properties.zone, f])), [data]);
  const zoneList = useMemo(() => (data?.zones.features ?? []).map((f) => f.properties), [data]);
  const mapPlotNumbers = useMemo(
    () => new Set(features.filter((f) => f.properties.kind === 'plot' && f.properties.plot_number).map((f) => f.properties.plot_number!)),
    [features],
  );
  /** plot number → feature ids, including review shapes assigned to it */
  const plotIndex = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!data || !doc) return m;
    for (const f of features) {
      const r = resolveFeature(f.properties, doc.reviews);
      if (r.kind === 'plot') m.set(r.plotNumber, [...(m.get(r.plotNumber) ?? []), f.properties.id]);
    }
    return m;
  }, [data, doc]);

  const stats = useMemo(
    () => (data && doc ? computeZoneStats(features.map((f) => f.properties), doc, zoneList.map((z) => z.zone)) : {}),
    [data, doc, zoneList],
  );

  // ---------- map sources with derived display properties ----------
  const plotsFC = useMemo<FeatureCollection>(() => {
    if (!data || !doc) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: features.map((f): Feature => {
        const r = resolveFeature(f.properties, doc.reviews);
        const props = { id: f.properties.id, kind: f.properties.kind } as Record<string, unknown>;
        if (r.kind === 'plot') Object.assign(props, { _status: getRecord(doc, r.plotNumber).status, _label: r.plotNumber, _res: r.fromReview ? 'plot' : 'none' });
        else if (r.kind === 'unresolved') Object.assign(props, { _status: 'no_data', _label: t.review.title, _res: 'unresolved' });
        else Object.assign(props, { _status: 'no_data', _label: '', _res: 'not_plot' });
        return { type: 'Feature', geometry: f.geometry, properties: props };
      }),
    };
  }, [data, doc]);

  const zonesFC = useMemo<FeatureCollection>(() => {
    if (!data) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: data.zones.features.map((f): Feature => {
        const s = stats[f.properties.zone];
        const pct = s ? (calcMode === 'area' ? s.pctArea : s.pctCount) : null;
        const label = viewMode === 'zones' ? `${f.properties.zone}\n${fmtPct(pct)}` : f.properties.zone;
        return { type: 'Feature', geometry: f.geometry, properties: { ...f.properties, _band: zoneBand(pct), _label: label } };
      }),
    };
  }, [data, stats, calcMode, viewMode]);

  const initialBounds = useMemo<BBox | null>(() => (data ? bboxOf(data.boundary.features.map((f) => f.geometry)) : null), [data]);

  // ---------- navigation ----------
  const fit = useCallback(
    (geoms: PlotGeometry[], maxZoom = 19) => {
      if (!map) return;
      const b = bboxOf(geoms);
      map.fitBounds(b, {
        padding: { top: 110, bottom: 60, left: leftOpen ? 360 : 60, right: rightOpen ? 360 : 60 },
        maxZoom,
        duration: 900,
      });
    },
    [map, leftOpen, rightOpen],
  );

  const openFeature = useCallback(
    (featureId: string, fly: boolean) => {
      const f = featureById.get(featureId);
      if (!f) return;
      if (fly) fit([f.geometry]);
      setPopup({ type: 'feature', featureId, lngLat: interiorPoint(f.geometry) });
    },
    [featureById, fit],
  );

  const openPlotNumber = useCallback(
    (pn: string) => {
      const ids = plotIndex.get(pn) ?? [];
      const feats = ids.map((id) => featureById.get(id)!).filter(Boolean);
      if (!feats.length) return;
      fit(feats.map((f) => f.geometry));
      const main = feats.find((f) => f.properties.kind === 'plot') ?? feats[0];
      setPopup({ type: 'feature', featureId: main.properties.id, lngLat: interiorPoint(main.geometry) });
    },
    [plotIndex, featureById, fit],
  );

  const openZone = useCallback(
    (zone: string, fly = true) => {
      const z = zoneByName.get(zone);
      if (!z) return;
      if (fly) fit([z.geometry], 18);
      setPopup({ type: 'zone', zone, lngLat: interiorPoint(z.geometry) });
    },
    [zoneByName, fit],
  );

  // ---------- search ----------
  const searchItems = useMemo<SearchItem[]>(() => {
    if (!data || !doc) return [];
    const items: SearchItem[] = [];
    for (const pn of [...plotIndex.keys()].sort(sortPlotNumbers)) {
      const rec = getRecord(doc, pn);
      const owners = rec.owners.map((o) => o.name).filter(Boolean);
      items.push({
        key: `p:${pn}`,
        label: pn,
        sub: [t.search.plot, t.status[rec.status], owners.join(', ')].filter(Boolean).join(' · '),
        haystack: `${pn} ${owners.join(' ')}`,
        target: { type: 'plot', plotNumber: pn },
      });
    }
    for (const f of features) {
      const p = f.properties;
      if (p.kind !== 'review' || doc.reviews[p.id]) continue;
      items.push({
        key: `r:${p.id}`,
        label: p.id,
        sub: `${t.search.needsReview}${p.candidates.length ? ` · ${t.search.candidates} ${p.candidates.join(', ')}` : ''}`,
        haystack: `${p.id} ${p.candidates.join(' ')}`,
        target: { type: 'review', featureId: p.id },
      });
    }
    return items;
  }, [data, doc, plotIndex]);

  // ---------- popup content ----------
  const plotSummary = (pn: string): PlotSummary => {
    const zones = new Map<string, number>();
    let area = 0;
    let areaInUpu = 0;
    const reviewIds: string[] = [];
    // the cadastre figures apply only while the plot is exactly its official parcel
    const ids = plotIndex.get(pn) ?? [];
    const only = ids.length === 1 ? featureById.get(ids[0])!.properties : null;
    const official = only && only.plot_number === pn && !doc?.edits[only.id] ? only : null;
    for (const id of ids) {
      const p = featureById.get(id)!.properties;
      area += p.area_m2;
      areaInUpu += p.area_in_upu_m2;
      if (p.kind === 'review') reviewIds.push(id);
      for (const z of p.zones) zones.set(z.zone, (zones.get(z.zone) ?? 0) + z.overlap_m2);
    }
    return {
      plotNumber: pn,
      area,
      areaInUpu,
      reviewIds,
      zones: [...zones].map(([zone, overlap]) => ({ zone, overlap })),
      registeredArea: official?.registered_area_m2 ?? null,
      municipality: official?.municipality ?? null,
    };
  };

  // ---------- shape edits: plot number and boundary ----------
  const now = () => new Date().toISOString();
  const plotNumberOf = (p: PlotProps) => {
    const r = resolveFeature(p, doc?.reviews ?? {});
    return r.kind === 'plot' ? r.plotNumber : null;
  };
  const checkNumber = (featureId: string, from: string) => (to: string) =>
    checkRename(features.map((f) => f.properties), doc!, featureId, from, to, plotNumberOf);

  /** Changes the plot number of one shape. Returns false if refused. */
  const renameShape = (featureId: string, from: string, to: string): boolean => {
    if (!doc || from === to) return true;
    const chk = checkNumber(featureId, from)(to);
    if (!chk.ok) return false;
    const move = chk.moveRecord ? { from, to } : null;
    const p = featureById.get(featureId)!.properties;
    if (p.kind === 'review') {
      own.setResolution(featureId, { type: 'plot', plotNumber: to, resolvedAt: now() });
      if (move) own.saveFeatureEdits({}, move);
    } else {
      const original = sourceById.get(featureId)!.properties.plot_number;
      const next: FeatureEdit = { ...doc.edits[featureId], editedAt: now() };
      if (to === original) delete next.plotNumber;
      else next.plotNumber = to;
      own.saveFeatureEdits({ [featureId]: next.plotNumber || next.geometry ? next : null }, move);
    }
    return true;
  };

  const savePlotForm = (featureId: string, from: string, rec: PlotRecord, to: string) => {
    if (!doc) return;
    const chk = checkNumber(featureId, from)(to);
    if (!chk.ok) return;
    const keepExisting = to !== from && !chk.moveRecord && !!doc.plots[to]; // merging into a plot that has data: keep its data
    if (!renameShape(featureId, from, to)) return;
    if (!keepExisting) own.updatePlot(to, rec);
  };

  const saveBoundaries = (changes: Record<string, Polygon>) => {
    if (!doc || !areaCtx) return;
    const out: Record<string, FeatureEdit> = {};
    for (const [id, g] of Object.entries(changes)) out[id] = { ...doc.edits[id], geometry: g, ...measure(g, areaCtx), editedAt: now() };
    if (Object.keys(out).length) own.saveFeatureEdits(out);
    setEditingId(null);
  };

  const resetBoundary = (id: string) => {
    const prev = doc?.edits[id];
    if (!prev) return;
    const rest: FeatureEdit = { editedAt: now() };
    if (prev.plotNumber) rest.plotNumber = prev.plotNumber;
    own.saveFeatureEdits({ [id]: rest.plotNumber ? rest : null });
  };

  const startBoundaryEdit = (id: string) => {
    const ids = [id, ...cornerNeighbours(id, features.map((f) => ({ id: f.properties.id, geometry: f.geometry })))];
    if (map) {
      const b = bboxOf(ids.map((x) => featureById.get(x)!.geometry));
      map.fitBounds(b, { padding: { top: 230, bottom: 50, left: leftOpen ? 360 : 60, right: rightOpen ? 360 : 60 }, maxZoom: 19.5, duration: 700 });
    }
    setEditingId(id);
  };

  const shapeInfo = (id: string) => {
    const src = sourceById.get(id)!.properties;
    const e = doc?.edits[id];
    return {
      originalNumber: src.plot_number,
      numberEdited: !!e?.plotNumber,
      boundaryEditedAt: e?.geometry ? e.editedAt : null,
      originalArea: src.area_m2,
    };
  };

  let popupContent: JSX.Element | null = null;
  let selectedFeatureIds: string[] = [];
  let selectedZone: string | null = null;
  if (popup && data && doc && !editingId) {
    if (popup.type === 'zone') {
      selectedZone = popup.zone;
      const z = zoneByName.get(popup.zone);
      const s = stats[popup.zone];
      if (z && s) popupContent = <ZonePopup zone={z.properties as ZoneProps} stats={s} onPlotClick={openPlotNumber} onReviewClick={(id) => openFeature(id, true)} />;
    } else {
      const f = featureById.get(popup.featureId);
      if (f) {
        const p: PlotProps = f.properties;
        const r = resolveFeature(p, doc.reviews);
        if (r.kind === 'plot') {
          selectedFeatureIds = plotIndex.get(r.plotNumber) ?? [p.id];
          popupContent = (
            <PlotPopup
              key={`${p.id}:${r.plotNumber}`}
              plot={plotSummary(r.plotNumber)}
              record={getRecord(doc, r.plotNumber)}
              shape={shapeInfo(p.id)}
              openedFromReview={r.fromReview ? p.id : undefined}
              onUndoReview={r.fromReview ? () => own.setResolution(p.id, null) : undefined}
              checkNumber={checkNumber(p.id, r.plotNumber)}
              onSave={(rec, to) => savePlotForm(p.id, r.plotNumber, rec, to)}
              onZoneClick={(z) => openZone(z)}
              onEditBoundary={() => startBoundaryEdit(p.id)}
              onResetBoundary={() => resetBoundary(p.id)}
              onResetNumber={() => {
                const orig = sourceById.get(p.id)!.properties.plot_number;
                if (orig) renameShape(p.id, r.plotNumber, orig);
              }}
            />
          );
        } else {
          selectedFeatureIds = [p.id];
          popupContent = (
            <ReviewPopup
              key={p.id}
              feature={p}
              resolution={doc.reviews[p.id]}
              mapPlotNumbers={mapPlotNumbers}
              onResolve={(res) => own.setResolution(p.id, res)}
              onZoneClick={(z) => openZone(z)}
              onEditBoundary={() => startBoundaryEdit(p.id)}
              boundaryEditedAt={shapeInfo(p.id).boundaryEditedAt}
              onResetBoundary={() => resetBoundary(p.id)}
            />
          );
        }
      }
    }
  }

  const hiddenFeatureIds = useMemo(
    () => (editingId ? [editingId, ...cornerNeighbours(editingId, features.map((f) => ({ id: f.properties.id, geometry: f.geometry })))] : []),
    [editingId, features],
  );

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { owned: 0, negotiating: 0, not_owned: 0, no_data: 0 };
    if (doc) for (const pn of plotIndex.keys()) c[getRecord(doc, pn).status]++;
    return c;
  }, [doc, plotIndex]);
  const reviewOpen = useMemo(
    () => (data && doc ? features.filter((f) => f.properties.kind === 'review' && !doc.reviews[f.properties.id]).length : 0),
    [data, doc],
  );

  // ---------- import ----------
  const onImportFile = async (file: File) => {
    if (!doc) return;
    try {
      const res = await readImportFile(file);
      if (res.kind === 'json') setPending({ kind: 'json', fileName: file.name, doc: normalizeDoc(res.data) });
      else setPending({ kind: 'rows', fileName: file.name, report: buildImport(res.rows, new Set(plotIndex.keys()), doc) });
    } catch (e) {
      setPending({ kind: 'error', fileName: file.name, message: e instanceof Error ? e.message : String(e) });
    }
  };
  const applyImport = () => {
    if (pending?.kind === 'rows') own.mergePlots(pending.report.records);
    if (pending?.kind === 'json') own.replaceAll(pending.doc);
    setPending(null);
  };

  if (loadError) return <div className="splash error">{`${t.app.loadError}: ${loadError}`}</div>;
  if (!data || !doc || !initialBounds) return <div className="splash">{t.app.loading}</div>;

  return (
    <div className="app">
      <MapView
        plots={plotsFC}
        zones={zonesFC}
        boundary={data.boundary}
        roads={data.roads}
        hiddenFeatureIds={hiddenFeatureIds}
        initialBounds={initialBounds}
        layers={layers}
        basemap={basemap}
        viewMode={viewMode}
        selectedFeatureIds={selectedFeatureIds}
        selectedZone={selectedZone}
        onPlotClick={(id, ll) => !editingId && setPopup({ type: 'feature', featureId: id, lngLat: [ll.lng, ll.lat] })}
        onZoneClick={(z, ll) => !editingId && setPopup({ type: 'zone', zone: z, lngLat: [ll.lng, ll.lat] })}
        onBackgroundClick={() => !editingId && setPopup(null)}
        onReady={(m) => {
          setMap(m);
          if (import.meta.env.DEV) (window as unknown as { __map: maplibregl.Map }).__map = m; // for automated UI checks
        }}
      />

      <SearchBar
        items={searchItems}
        onSelect={(i) => (i.target.type === 'plot' ? openPlotNumber(i.target.plotNumber) : openFeature(i.target.featureId, true))}
      />

      <LayersPanel
        open={leftOpen}
        onToggleOpen={() => setLeftOpen(!leftOpen)}
        layers={layers}
        onLayers={setLayers}
        basemap={basemap}
        onBasemap={setBasemap}
        viewMode={viewMode}
        onViewMode={setViewMode}
        statusCounts={statusCounts}
        reviewOpen={reviewOpen}
        hasReview={features.some((f) => f.properties.kind === 'review')}
        persistence={own.persistence}
        saveError={own.error}
        onExportJson={() => exportJson(doc)}
        onExportGeojson={() => exportGeojson(features, doc)}
        onExportExcel={() =>
          exportExcel(
            doc,
            features.map((f) => f.properties),
            zoneList.map((z) => stats[z.zone]).filter(Boolean),
            Object.fromEntries(zoneList.map((z) => [z.zone, t.landuse[z.landuse_code] ?? z.landuse_code])),
          )
        }
        onImportFile={onImportFile}
      />

      <ZoneSummaryPanel
        open={rightOpen}
        onToggleOpen={() => setRightOpen(!rightOpen)}
        zones={zoneList}
        stats={stats}
        calcMode={calcMode}
        onCalcMode={setCalcMode}
        selectedZone={selectedZone}
        onZoneClick={(z) => openZone(z)}
      />

      {own.notice && (
        <div className="toast" onClick={own.dismissNotice}>
          {own.notice}
        </div>
      )}

      {map && popup && popupContent && (
        <MapPopup map={map} lngLat={popup.lngLat} onClose={() => setPopup(null)}>
          {popupContent}
        </MapPopup>
      )}

      {map && editingId && featureById.get(editingId) && (
        <BoundaryEditor
          key={editingId}
          map={map}
          targetId={editingId}
          label={plotNumberOf(featureById.get(editingId)!.properties) ?? editingId}
          features={features.map((f) => ({ id: f.properties.id, geometry: f.geometry as Polygon }))}
          areaOf={areaOf}
          originalArea={sourceById.get(editingId)!.properties.area_m2}
          onSave={saveBoundaries}
          onCancel={() => setEditingId(null)}
        />
      )}

      {pending && <ImportDialog pending={pending} onApply={applyImport} onClose={() => setPending(null)} />}
    </div>
  );
}
