import { useRef } from 'react';
import { DISPLAY_STATUSES } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { fmtPct, lastUpdatedLabel } from '../lib/format';
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
  /** false when the map has no "needs review" shapes at all (then the toggle and legend entry are hidden) */
  hasReview: boolean;
  persistence: Persistence | null;
  saveError: string | null;
  onExportJson: () => void;
  onExportGeojson: () => void;
  onExportExcel: () => void;
  onImportFile: (f: File) => void;
  onRefreshOwnership: () => void;
  /** true while a refresh is open or running - the button cannot be pressed again */
  refreshBusy: boolean;
  /** OwnershipDoc.registryCheckedAt: when Update last went through every plot */
  registryCheckedAt: string | undefined;
  /**
   * Deployed site: how many records / shapes in this browser differ from the published data
   * (0 = nothing to say). null where that is not known (dev server).
   */
  unpublished: number | null;
}

const LANDUSE_LEGEND = ['M1', 'M2', 'D4', 'Z1', 'IS'];

/**
 * The menu: what the colours mean and the Update button are always in view;
 * the map layers and the export / import buttons are folded away until needed.
 */
export function LayersPanel(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const th = config.zoneThresholds;
  const bandLabels = t.layers.zoneBands(fmtPct(th.green), fmtPct(th.yellow));

  if (!p.open)
    return (
      <button className="panel-tab left" onClick={p.onToggleOpen} title={t.layers.expand}>
        ☰ {t.layers.menu}
      </button>
    );

  // one line about where the data is - and nothing at all when the browser holds what is published
  const saveState = p.saveError
    ? `${t.data.saveFailed}: ${p.saveError}`
    : p.persistence === 'file'
      ? t.data.savedFile
      : p.persistence !== 'browser'
        ? ''
        : p.unpublished === null
          ? t.data.savedBrowser
          : p.unpublished > 0
            ? t.data.unpublished(p.unpublished)
            : '';
  const toggle = (k: keyof LayerVisibility) => p.onLayers({ ...p.layers, [k]: !p.layers[k] });

  return (
    <aside className="panel left-panel">
      <header>
        <div>
          <div className="app-title">{t.app.title}</div>
          <div className="muted small">{t.app.subtitle}</div>
        </div>
        <button className="icon panel-close" onClick={p.onToggleOpen} title={t.layers.collapse} aria-label={t.layers.collapse}>
          <span className="when-wide">‹</span>
          <span className="when-compact">×</span>
        </button>
      </header>

      <section aria-label={t.layers.colourBy}>
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
        {p.viewMode === 'plots' &&
          DISPLAY_STATUSES.map((s) => (
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
        {p.hasReview && (
          <div className="legend-row">
            <i className="hatch" />
            {t.layers.review}
          </div>
        )}
      </section>

      <section aria-label={t.data.title}>
        <div className="update-row">
          <button className="btn primary" onClick={p.onRefreshOwnership} disabled={p.refreshBusy} title={t.refresh.buttonHint}>
            {p.refreshBusy ? t.refresh.buttonBusy : t.refresh.button}
          </button>
          <span className="muted small last-updated">{lastUpdatedLabel(p.registryCheckedAt)}</span>
        </div>
        {saveState && <div className={`save-state ${p.saveError ? 'error' : p.persistence ?? ''}`}>{saveState}</div>}
      </section>

      <details className="fold">
        <summary>{t.layers.title}</summary>
        <div className="fold-body">
          {(
            [
              ['plots', t.layers.plots],
              ['zones', t.layers.zones],
              ['roads', t.layers.roads],
              ['boundary', t.layers.boundary],
              ['focus', t.layers.focus],
              ...(p.hasReview ? [['review', `${t.layers.review} (${p.reviewOpen})`]] : []),
            ] as [keyof LayerVisibility, string][]
          ).map(([k, label]) => (
            <label className="toggle" key={k}>
              <input type="checkbox" checked={p.layers[k]} onChange={() => toggle(k)} />
              <span className="switch" />
              {label}
            </label>
          ))}
          <h2>{t.layers.basemap}</h2>
          <div className="segmented">
            {(['satellite', 'dark'] as Basemap[]).map((b) => (
              <button key={b} className={p.basemap === b ? 'on' : ''} onClick={() => p.onBasemap(b)}>
                {t.layers[b]}
              </button>
            ))}
          </div>
          <h2>{t.layers.lines}</h2>
          <div className="legend-row">
            <i className="line zone" style={{ background: config.zoneLineColor }} />
            {t.layers.zoneBorder}
          </div>
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
        </div>
      </details>

      <details className="fold">
        <summary>{t.data.exportImport}</summary>
        <div className="fold-body btn-col">
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
      </details>
    </aside>
  );
}
