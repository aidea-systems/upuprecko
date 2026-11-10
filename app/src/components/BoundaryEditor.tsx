import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent, type MapMouseEvent } from 'maplibre-gl';
import type { Feature, FeatureCollection, Polygon, Position } from 'geojson';
import { strings as t } from '../i18n/strings';
import { closeRing, ringSelfIntersects } from '../lib/area';
import { fmtArea } from '../lib/format';

/** A corner. Rings that share a corner hold the same object, so moving it moves every ring. */
interface V {
  p: [number, number];
}

interface Props {
  map: maplibregl.Map;
  targetId: string;
  label: string;
  /** all shapes as currently shown (edits applied) */
  features: { id: string; geometry: Polygon }[];
  areaOf: (g: Polygon) => number;
  originalArea: number;
  onSave: (changes: Record<string, Polygon>) => void;
  onCancel: () => void;
}

const key = (p: Position) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
const round7 = (v: number) => Math.round(v * 1e7) / 1e7;
const SNAP_PX = 10;
const SRC = 'edit-src';
const LAYERS = ['edit-fill', 'edit-line', 'edit-neighbour-line', 'edit-mid', 'edit-vertices'];

export function BoundaryEditor(p: Props) {
  const [snap, setSnap] = useState(true);
  const [linked, setLinked] = useState(true);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const opts = useRef({ snap, linked });
  opts.current = { snap, linked };

  // ---- build rings with shared corner objects
  const model = useMemo(() => {
    const target = p.features.find((f) => f.id === p.targetId)!;
    const tRing = target.geometry.coordinates[0].slice(0, -1);
    const byKey = new Map<string, V>();
    const tVerts = tRing.map((c) => {
      const v: V = { p: [c[0], c[1]] };
      byKey.set(key(c), v);
      return v;
    });
    const rings = new Map<string, V[]>([[p.targetId, tVerts]]);
    const holes = new Map<string, Position[][]>([[p.targetId, target.geometry.coordinates.slice(1)]]);
    const original = new Map<string, string>([[p.targetId, JSON.stringify(tRing)]]);
    for (const f of p.features) {
      if (f.id === p.targetId) continue;
      const ring = f.geometry.coordinates[0].slice(0, -1);
      if (!ring.some((c) => byKey.has(key(c)))) continue;
      rings.set(f.id, ring.map((c) => byKey.get(key(c)) ?? { p: [c[0], c[1]] }));
      holes.set(f.id, f.geometry.coordinates.slice(1));
      original.set(f.id, JSON.stringify(ring));
    }
    return { rings, holes, original };
  }, [p.features, p.targetId]);

  const history = useRef<{ rings: Map<string, V[]>; pos: Map<V, [number, number]> }[]>([]);
  const dragging = useRef<V | null>(null);

  const snapshot = () => {
    const pos = new Map<V, [number, number]>();
    for (const r of model.rings.values()) for (const v of r) pos.set(v, [v.p[0], v.p[1]]);
    history.current.push({ rings: new Map([...model.rings].map(([k, r]) => [k, [...r]])), pos });
    if (history.current.length > 100) history.current.shift();
  };
  const undo = () => {
    const h = history.current.pop();
    if (!h) return;
    model.rings.clear();
    for (const [k, r] of h.rings) model.rings.set(k, r);
    for (const [v, xy] of h.pos) v.p = xy;
    render();
  };

  const target = () => model.rings.get(p.targetId)!;
  const isShared = (v: V) => [...model.rings].some(([id, r]) => id !== p.targetId && r.includes(v));
  const neighbourIds = [...model.rings.keys()].filter((id) => id !== p.targetId);

  const toPolygon = (id: string): Polygon => ({
    type: 'Polygon',
    coordinates: [closeRing(model.rings.get(id)!.map((v) => [v.p[0], v.p[1]])), ...(model.holes.get(id) ?? [])],
  });

  // snap candidates: corners of every shape not being edited, plus neighbours' own corners
  const snapCandidates = (moving: V): Position[] => {
    const inEdit = new Set([...model.rings.keys()]);
    const out: Position[] = [];
    for (const f of p.features) if (!inEdit.has(f.id)) for (const c of f.geometry.coordinates[0]) out.push(c);
    for (const r of model.rings.values()) for (const v of r) if (v !== moving) out.push(v.p);
    return out;
  };

  const render = () => {
    const src = p.map.getSource(SRC) as GeoJSONSource | undefined;
    if (!src) return;
    const feats: Feature[] = [];
    for (const id of model.rings.keys())
      feats.push({ type: 'Feature', properties: { role: id === p.targetId ? 'target' : 'neighbour' }, geometry: toPolygon(id) });
    const ring = target();
    ring.forEach((v, i) => {
      feats.push({ type: 'Feature', properties: { role: 'vertex', i, shared: isShared(v) }, geometry: { type: 'Point', coordinates: v.p } });
      const w = ring[(i + 1) % ring.length];
      feats.push({
        type: 'Feature',
        properties: { role: 'mid', i },
        geometry: { type: 'Point', coordinates: [(v.p[0] + w.p[0]) / 2, (v.p[1] + w.p[1]) / 2] },
      });
    });
    src.setData({ type: 'FeatureCollection', features: feats } as FeatureCollection);
    setTick((x) => x + 1);
  };

  useEffect(() => {
    const map = p.map;
    map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'edit-fill', type: 'fill', source: SRC, filter: ['==', ['get', 'role'], 'target'], paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'edit-neighbour-line', type: 'line', source: SRC, filter: ['==', ['get', 'role'], 'neighbour'], paint: { 'line-color': '#f0abfc', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: 'edit-line', type: 'line', source: SRC, filter: ['==', ['get', 'role'], 'target'], paint: { 'line-color': '#22d3ee', 'line-width': 2.5 } });
    map.addLayer({
      id: 'edit-mid', type: 'circle', source: SRC, filter: ['==', ['get', 'role'], 'mid'],
      paint: { 'circle-radius': 4.5, 'circle-color': '#0f172a', 'circle-stroke-color': '#22d3ee', 'circle-stroke-width': 1.5, 'circle-opacity': 0.85 },
    });
    map.addLayer({
      id: 'edit-vertices', type: 'circle', source: SRC, filter: ['==', ['get', 'role'], 'vertex'],
      paint: {
        'circle-radius': 6.5,
        'circle-color': ['case', ['get', 'shared'], '#f0abfc', '#ffffff'],
        'circle-stroke-color': '#0e7490', 'circle-stroke-width': 2,
      },
    });
    map.doubleClickZoom.disable();
    render();

    const onDown = (e: MapLayerMouseEvent) => {
      const i = e.features?.[0]?.properties?.i;
      if (typeof i !== 'number' || e.originalEvent.button !== 0) return;
      e.preventDefault();
      map.dragPan.disable();
      snapshot();
      const ring = target();
      let v = ring[i];
      if (!opts.current.linked && isShared(v)) {
        v = { p: [v.p[0], v.p[1]] }; // detach from neighbours
        ring[i] = v;
      }
      dragging.current = v;
      map.getCanvas().style.cursor = 'grabbing';
    };
    const onMove = (e: MapMouseEvent) => {
      const v = dragging.current;
      if (!v) return;
      let pos: [number, number] = [round7(e.lngLat.lng), round7(e.lngLat.lat)];
      if (opts.current.snap && !e.originalEvent.altKey) {
        let best = SNAP_PX;
        for (const c of snapCandidates(v)) {
          const s = map.project([c[0], c[1]]);
          const d = Math.hypot(s.x - e.point.x, s.y - e.point.y);
          if (d < best) [best, pos] = [d, [c[0], c[1]]];
        }
      }
      v.p = pos;
      render();
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
      setError(null);
    };
    const onMid = (e: MapLayerMouseEvent) => {
      const i = e.features?.[0]?.properties?.i;
      if (typeof i !== 'number') return;
      snapshot();
      const ring = target();
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const nv: V = { p: [round7((a.p[0] + b.p[0]) / 2), round7((a.p[1] + b.p[1]) / 2)] };
      ring.splice(i + 1, 0, nv);
      if (opts.current.linked)
        for (const [id, r] of model.rings) {
          if (id === p.targetId) continue;
          const ia = r.indexOf(a), ib = r.indexOf(b);
          if (ia < 0 || ib < 0) continue;
          if ((ia + 1) % r.length === ib) r.splice(ia + 1, 0, nv);
          else if ((ib + 1) % r.length === ia) r.splice(ib + 1, 0, nv);
        }
      render();
    };
    const onDelete = (e: MapLayerMouseEvent) => {
      e.preventDefault();
      const i = e.features?.[0]?.properties?.i;
      if (typeof i !== 'number') return;
      const ring = target();
      if (ring.length <= 3) return setError(t.editor.tooFew);
      const v = ring[i];
      const touched = opts.current.linked ? [...model.rings.values()].filter((r) => r.includes(v)) : [ring];
      if (touched.some((r) => r.length <= 3)) return setError(t.editor.tooFew);
      snapshot();
      for (const r of touched) r.splice(r.indexOf(v), 1);
      render();
    };
    const enter = () => !dragging.current && (map.getCanvas().style.cursor = 'move');
    const leave = () => !dragging.current && (map.getCanvas().style.cursor = '');
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    };

    map.on('mousedown', 'edit-vertices', onDown);
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    map.on('click', 'edit-mid', onMid);
    map.on('contextmenu', 'edit-vertices', onDelete);
    map.on('mouseenter', 'edit-vertices', enter);
    map.on('mouseleave', 'edit-vertices', leave);
    map.on('mouseenter', 'edit-mid', enter);
    map.on('mouseleave', 'edit-mid', leave);
    window.addEventListener('keydown', onKey);
    return () => {
      map.off('mousedown', 'edit-vertices', onDown);
      map.off('mousemove', onMove);
      map.off('mouseup', onUp);
      map.off('click', 'edit-mid', onMid);
      map.off('contextmenu', 'edit-vertices', onDelete);
      map.off('mouseenter', 'edit-vertices', enter);
      map.off('mouseleave', 'edit-vertices', leave);
      map.off('mouseenter', 'edit-mid', enter);
      map.off('mouseleave', 'edit-mid', leave);
      window.removeEventListener('keydown', onKey);
      map.doubleClickZoom.enable();
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
      for (const l of LAYERS) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(SRC)) map.removeSource(SRC);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.map, model]);

  const changedIds = () =>
    [...model.rings.keys()].filter((id) => JSON.stringify(model.rings.get(id)!.map((v) => v.p)) !== model.original.get(id));

  const save = () => {
    const changes: Record<string, Polygon> = {};
    for (const id of changedIds()) {
      const g = toPolygon(id);
      if (g.coordinates[0].length < 4) return setError(t.editor.tooFew);
      if (ringSelfIntersects(g.coordinates[0])) return setError(t.editor.selfIntersects(id));
      changes[id] = g;
    }
    p.onSave(changes);
  };

  const area = p.areaOf(toPolygon(p.targetId));
  const others = changedIds().filter((id) => id !== p.targetId);

  return (
    <div className="editor-bar">
      <div className="editor-head">
        <b>{t.editor.title(p.label)}</b>
        <span className="muted">
          {t.editor.area}: <b className="area">{fmtArea(area)}</b> ({t.editor.was} {fmtArea(p.originalArea)})
        </span>
      </div>
      <div className="muted small">{t.editor.help}</div>
      <div className="editor-opts">
        <label>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> {t.editor.snap}
        </label>
        <label>
          <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} /> {t.editor.linked}
        </label>
        {neighbourIds.length > 0 && (
          <span className="muted small">
            <i className="dot shared" /> {t.editor.linkedInfo(neighbourIds.length)}
          </span>
        )}
      </div>
      {others.length > 0 && <div className="muted small">{t.editor.alsoChanges(others.join(', '))}</div>}
      {error && <div className="note error">{error}</div>}
      <div className="form-actions">
        <button className="btn ghost" onClick={undo} disabled={!history.current.length}>
          {t.editor.undo}
        </button>
        <button className="btn ghost" onClick={p.onCancel}>
          {t.editor.cancel}
        </button>
        <button className="btn primary" onClick={save}>
          {t.editor.save}
        </button>
      </div>
    </div>
  );
}
