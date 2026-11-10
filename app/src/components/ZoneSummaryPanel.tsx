import type { ZoneProps } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { fmtArea, fmtPct } from '../lib/format';
import { computeOverall, type ZoneStats } from '../lib/zoneStats';
import { ProgressBar } from './ZonePopup';

export type CalcMode = 'area' | 'count';

interface Props {
  open: boolean;
  onToggleOpen: () => void;
  zones: ZoneProps[];
  stats: Record<string, ZoneStats>;
  calcMode: CalcMode;
  onCalcMode: (m: CalcMode) => void;
  selectedZone: string | null;
  onZoneClick: (zone: string) => void;
}

export function ZoneSummaryPanel(p: Props) {
  if (!p.open)
    return (
      <button className="panel-tab right" onClick={p.onToggleOpen} title={t.layers.expand}>
        {t.summary.title} ☰
      </button>
    );
  const pick = (s: { pctArea: number | null; pctCount: number | null }) => (p.calcMode === 'area' ? s.pctArea : s.pctCount);
  const all = computeOverall(Object.values(p.stats));

  return (
    <aside className="panel right-panel">
      <header>
        <h2 className="panel-title">{t.summary.title}</h2>
        <button className="icon" onClick={p.onToggleOpen} title={t.layers.collapse}>
          ›
        </button>
      </header>
      <div className="segmented">
        {(['area', 'count'] as CalcMode[]).map((m) => (
          <button key={m} className={p.calcMode === m ? 'on' : ''} onClick={() => p.onCalcMode(m)}>
            {m === 'area' ? t.summary.byArea : t.summary.byCount}
          </button>
        ))}
      </div>

      <div className="zone-row total">
        <div className="zone-row-head">
          <b>{t.summary.whole}</b>
          <span className="pct">{fmtPct(pick(all))}</span>
        </div>
        <ProgressBar pct={pick(all)} />
        <div className="muted small">
          {t.summary.plots(all.plotCount)}
          {all.excludedReviewArea > 0 && <> · {t.summary.excluded(fmtArea(all.excludedReviewArea))}</>}
        </div>
      </div>

      <ul className="zone-list">
        {p.zones.map((z) => {
          const s = p.stats[z.zone];
          return (
            <li key={z.zone}>
              <button className={`zone-row ${p.selectedZone === z.zone ? 'selected' : ''}`} onClick={() => p.onZoneClick(z.zone)}>
                <div className="zone-row-head">
                  <span>
                    <span className="swatch" style={{ background: config.landuseColors[z.landuse_code] }} />
                    <b>{z.zone}</b> <span className="muted small">{t.summary.plots(s?.plotCount ?? 0)}</span>
                  </span>
                  <span className="pct">{fmtPct(s ? pick(s) : null)}</span>
                </div>
                <ProgressBar pct={s ? pick(s) : null} />
                {s && s.excludedReview.area > 0 && <div className="excluded small">{t.summary.excluded(fmtArea(s.excludedReview.area))}</div>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
