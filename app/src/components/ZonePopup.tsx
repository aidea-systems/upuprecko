import type { ZoneProps } from '../types';
import { STATUSES } from '../types';
import { config, zoneBand } from '../config';
import { strings as t } from '../i18n/strings';
import { fmtArea, fmtPct } from '../lib/format';
import type { ZonePlotEntry, ZoneStats } from '../lib/zoneStats';
import { StatusChip } from './PlotPopup';

interface Props {
  zone: ZoneProps;
  stats: ZoneStats;
  onPlotClick: (plotNumber: string) => void;
  onReviewClick: (featureId: string) => void;
}

export function ProgressBar({ pct }: { pct: number | null }) {
  const band = zoneBand(pct);
  return (
    <div className="bar">
      <div style={{ width: `${Math.round((pct ?? 0) * 100)}%`, background: config.zoneBandColors[band] }} />
    </div>
  );
}

function PlotList({ items, onPlotClick }: { items: ZonePlotEntry[]; onPlotClick: (pn: string) => void }) {
  return (
    <ul className="plot-list">
      {items.map((p) => (
        <li key={p.plotNumber}>
          <button className="plot-item" onClick={() => onPlotClick(p.plotNumber)}>
            <span className="pn">{p.plotNumber}</span>
            <StatusChip status={p.status} />
            <span className="muted">{fmtArea(p.overlap)}</span>
            <span className="share">{p.share.value > 0 ? fmtPct(p.share.value) : ''}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ZonePopup({ zone, stats, onPlotClick, onReviewClick }: Props) {
  return (
    <div className="popup zone-popup">
      <div className="popup-head">
        <h3>
          {t.zone.title} {zone.zone}
        </h3>
      </div>
      <dl className="rows">
        <dt>{t.zone.landuse}</dt>
        <dd>
          <span className="swatch" style={{ background: config.landuseColors[zone.landuse_code] }} />
          {t.landuse[zone.landuse_code] ?? zone.landuse_code}
        </dd>
        {zone.playground && (
          <>
            <dt>{t.zone.playground}</dt>
            <dd>{zone.playground}</dd>
          </>
        )}
        <dt>{t.zone.area}</dt>
        <dd>{fmtArea(zone.area_m2)}</dd>
        <dt>{t.zone.pctByArea}</dt>
        <dd>
          <strong>{fmtPct(stats.pctArea)}</strong>
          <ProgressBar pct={stats.pctArea} />
        </dd>
        <dt>{t.zone.pctByCount}</dt>
        <dd>
          <strong>{fmtPct(stats.pctCount)}</strong>
          <ProgressBar pct={stats.pctCount} />
        </dd>
        <dt>{t.zone.perStatus}</dt>
        <dd className="status-counts">
          {STATUSES.map((s) => (
            <span key={s} title={t.status[s]}>
              <i style={{ background: config.statusColors[s] }} /> {t.status[s]}: <b>{stats.statusCounts[s]}</b>
            </span>
          ))}
        </dd>
      </dl>
      {stats.excludedReview.area > 0 && (
        <div className="note warn">
          {t.zone.excluded(fmtArea(stats.excludedReview.area), stats.excludedReview.featureIds.length)}:{' '}
          {stats.excludedReview.featureIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <button className="link" onClick={() => onReviewClick(id)}>
                {id}
              </button>
            </span>
          ))}
        </div>
      )}
      {stats.notPlotArea > 0 && <div className="muted small">{t.zone.notPlot(fmtArea(stats.notPlotArea))}</div>}

      <h4>
        {t.zone.notOwned} ({stats.notOwned.length})
      </h4>
      {stats.notOwned.length ? <PlotList items={stats.notOwned} onPlotClick={onPlotClick} /> : <div className="muted">{t.zone.none}</div>}

      <h4>
        {t.zone.allPlots} ({stats.plots.length})
      </h4>
      {stats.plots.length ? <PlotList items={stats.plots} onPlotClick={onPlotClick} /> : <div className="muted">{t.zone.noPlots}</div>}
    </div>
  );
}
