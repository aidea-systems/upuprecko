import { useState } from 'react';
import type { PlotProps, Resolution } from '../types';
import { strings as t } from '../i18n/strings';
import { fmtArea, fmtDate } from '../lib/format';

interface Props {
  feature: PlotProps;
  resolution: Resolution | undefined;
  /** plot numbers that exist on the map as plot features */
  mapPlotNumbers: Set<string>;
  onResolve: (res: Resolution | null) => void;
  onZoneClick: (zone: string) => void;
  onEditBoundary: () => void;
  boundaryEditedAt: string | null;
  onResetBoundary: () => void;
}

export function ReviewPopup({ feature, resolution, mapPlotNumbers, onResolve, onZoneClick, onEditBoundary, boundaryEditedAt, onResetBoundary }: Props) {
  const [other, setOther] = useState('');
  const now = () => new Date().toISOString();
  const assign = (n: string) => n.trim() && onResolve({ type: 'plot', plotNumber: n.trim(), resolvedAt: now() });

  return (
    <div className="popup">
      <div className="popup-head">
        <h3 className="review-title">{t.review.title}</h3>
      </div>
      <dl className="rows">
        <dt>{t.review.shape}</dt>
        <dd className="strong">{feature.id}</dd>
        <dt>{t.review.zone}</dt>
        <dd>
          {feature.zones.length === 0
            ? t.plot.noZone
            : feature.zones.map((z) => (
                <button key={z.zone} className="link block" onClick={() => onZoneClick(z.zone)}>
                  {z.zone} <span className="muted">({fmtArea(z.overlap_m2)})</span>
                </button>
              ))}
        </dd>
        <dt>{t.review.area}</dt>
        <dd>{fmtArea(feature.area_m2)}</dd>
        <dt>{t.review.candidates}</dt>
        <dd>
          {feature.candidates.length === 0
            ? <span className="muted">{t.review.noCandidates}</span>
            : feature.candidates.map((c) => (
                <div key={c}>
                  {c} <span className="muted small">({mapPlotNumbers.has(c) ? t.review.onMap : t.review.notOnMap})</span>
                </div>
              ))}
        </dd>
        <dt>{t.review.reason}</dt>
        <dd>{feature.reason}</dd>
        <dt>{t.plot.boundary}</dt>
        <dd>
          <button className="btn small" onClick={onEditBoundary}>
            ✎ {t.plot.editBoundary}
          </button>
          {boundaryEditedAt && (
            <div className="muted small">
              {t.plot.boundaryEdited(fmtDate(boundaryEditedAt))} ·{' '}
              <button className="link" onClick={onResetBoundary}>
                {t.plot.resetBoundary}
              </button>
            </div>
          )}
        </dd>
      </dl>

      {resolution?.type === 'not_plot' ? (
        <div className="note info">
          {t.review.resolvedNotPlot}{' '}
          <button className="link" onClick={() => onResolve(null)}>
            {t.review.undo}
          </button>
        </div>
      ) : (
        <div className="resolve">
          <div className="note warn">{t.review.excluded}</div>
          <h4>{t.review.assignTitle}</h4>
          <div className="btn-row">
            {feature.candidates.map((c) => (
              <button key={c} className="btn" onClick={() => assign(c)}>
                {t.review.assignTo(c)}
              </button>
            ))}
          </div>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              assign(other);
            }}
          >
            <input placeholder={t.review.otherNumber} value={other} onChange={(e) => setOther(e.target.value)} />
            <button className="btn" type="submit" disabled={!other.trim()}>
              {t.review.assign}
            </button>
          </form>
          {other.trim() && !mapPlotNumbers.has(other.trim()) && <div className="muted small">{other.trim()}: {t.review.notOnMap}</div>}
          <button className="btn ghost wide" onClick={() => onResolve({ type: 'not_plot', resolvedAt: now() })}>
            {t.review.notPlot}
          </button>
        </div>
      )}
    </div>
  );
}
