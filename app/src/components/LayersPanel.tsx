import { useRef } from 'react';
import { STATUSES } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { fmtPct } from '../lib/format';
import type { Basemap, LayerVisibility, ViewMode } from './MapView';
import type { Persistence } from '../storage/repository';

interface Props {
  open: boolean;
  onToggleOpen: () => void;
  layers: LayerVisibility;
  onLayers: (l: LayerVisibility) => void;
  basemap: Basemap;
  onBasemap: (b: Basemap) => void;
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;
  statusCounts: Record<string, number>;
  reviewOpen: number;
  persistence: Persistence | null;
  saveError: string | null;
  onExportJson: () => void;
  onExportGeojson: () => void;
  onExportExcel: () => void;
  onImportFile: (f: File) => void;
}

const LANDUSE_LEGEND = ['M1', 'M2', 'D4', 'Z1', 'IS'];

export function LayersPanel(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const th = config.zoneThresholds;
  const bandLabels = t.layers.zoneBands(fmtPct(th.green), fmtPct(th.yellow));

  if (!p.open)
    return (
      <button className="panel-tab left" onClick={p.onToggleOpen} title={t.layers.expand}>
        ☰ {t.layers.title}
      </button>
    );

  const toggle = (k: keyof LayerVisibility) => p.onLayers({ ...p.layers, [k]: !p.layers[k] });

  return (
    <aside className="panel left-panel">
      <header>
        <div>
          <div className="app-title">{t.app.title}</div>
          <div className="muted small">{t.app.subtitle}</div>
        </div>
        <button className="icon" onClick={p.onToggleOpen} title={t.layers.collapse}>
          ‹
        </button>
      </header>

      <section>
        <h2>{t.layers.title}</h2>
        {(
          [
            ['plots', t.layers.plots],
            ['zones', t.layers.zones],
            ['roads', t.layers.roads],
            ['boundary', t.layers.boundary],
            ['review', `${t.layers.review} (${p.reviewOpen})`],
          ] as [keyof LayerVisibility, string][]
        ).map(([k, label]) => (
          <label className="toggle" key={k}>
            <input type="checkbox" checked={p.layers[k]} onChange={() => toggle(k)} />
            <span className="switch" />
            {label}
          </label>
        ))}
      </section>

      <section>
        <h2>{t.layers.basemap}</h2>
        <div className="segmented">
          {(['satellite', 'dark'] as Basemap[]).map((b) => (
            <button key={b} className={p.basemap === b ? 'on' : ''} onClick={() => p.onBasemap(b)}>
              {t.layers[b]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>{t.layers.colourBy}</h2>
        <div className="segmented three">
          {(
            [
              ['plots', t.layers.viewPlots],
              ['zones', t.layers.viewZones],
              ['landuse', t.layers.viewLanduse],
            ] as [ViewMode, string][]
          ).map(([v, label]) => (
            <button key={v} className={p.viewMode === v ? 'on' : ''} onClick={() => p.onViewMode(v)}>
              {label}
            </button>
          ))}
        </div>
        <div className="muted small hint">{p.viewMode === 'plots' ? t.layers.hintPlots : t.layers.hintZones}</div>
      </section>

      <section>
        <h2>{t.layers.legend}</h2>
        {p.viewMode === 'plots' &&
          STATUSES.map((s) => (
            <div className="legend-row" key={s}>
              <i style={{ background: config.statusColors[s] }} />
              {t.status[s]} <span className="muted">{p.statusCounts[s] ?? 0}</span>
            </div>
          ))}
        {p.viewMode === 'zones' &&
          (['green', 'yellow', 'red', 'none'] as const).map((b, i) => (
            <div className="legend-row" key={b}>
              <i style={{ background: config.zoneBandColors[b] }} />
              {bandLabels[i]}
            </div>
          ))}
        {p.viewMode === 'landuse' &&
          LANDUSE_LEGEND.map((c) => (
            <div className="legend-row" key={c}>
              <i style={{ background: config.landuseColors[c] }} />
              <b>{c}</b>&nbsp;{t.landuse[c]}
            </div>
          ))}
        <div className="legend-row">
          <i className="hatch" />
          {t.layers.review}
        </div>
        {p.layers.roads && (
          <>
            <div className="legend-row">
              <i style={{ background: '#1e1b2e' }} />
              {t.layers.roadArea}
            </div>
            <div className="legend-row">
              <i className="line" style={{ background: '#ff4d4d' }} />
              {t.layers.roadCarriageway}
            </div>
            <div className="legend-row">
              <i className="line" style={{ background: '#f8fafc' }} />
              {t.layers.roadEdge}
            </div>
          </>
        )}
      </section>

      <section>
        <h2>{t.data.title}</h2>
        <div className="btn-col">
          <button className="btn" onClick={p.onExportJson}>
            {t.data.exportJson}
          </button>
          <button className="btn" onClick={p.onExportExcel}>
            {t.data.exportExcel}
          </button>
          <button className="btn" onClick={p.onExportGeojson}>
            {t.data.exportGeojson}
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()}>
            {t.data.import}
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".xlsx,.xls,.csv,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onImportFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <div className={`save-state ${p.saveError ? 'error' : p.persistence ?? ''}`}>
          {p.saveError ? `${t.data.saveFailed}: ${p.saveError}` : p.persistence === 'file' ? t.data.savedFile : p.persistence === 'browser' ? t.data.savedBrowser : ''}
        </div>
      </section>
    </aside>
  );
}
