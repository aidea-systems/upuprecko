import { useCallback, useMemo, useRef, useState } from 'react';
import type { OwnershipDoc, PlotRecord } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { getRecord } from '../lib/ownership';
import type { OssParcelResult } from '../lib/ossParcel';
import { applyDiff, diffPlot, type PlotDiff } from '../lib/registryRefresh';
import { fetchParcelFromApi, runRefresh, type RefreshTarget } from '../lib/refreshRun';
import type { Persistence } from '../storage/repository';

type Outcome = { kind: 'ok'; result: OssParcelResult; checkedAt: string } | { kind: 'failed'; message: string };
type Phase = 'token' | 'running' | 'review' | 'done';

const readToken = () => {
  try {
    return localStorage.getItem(config.refreshTokenKey) ?? '';
  } catch {
    return '';
  }
};
const writeToken = (v: string | null) => {
  try {
    if (v) localStorage.setItem(config.refreshTokenKey, v);
    else localStorage.removeItem(config.refreshTokenKey);
  } catch {
    /* storage unavailable: the token is used for this run only */
  }
};

/**
 * State of one "Refresh ownership" run: token → running → review → done.
 * Runs are started from click handlers only (never from an effect), so a run cannot start twice.
 */
export function useRefresh() {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [targets, setTargets] = useState<RefreshTarget[]>([]);
  const [uncheckable, setUncheckable] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [progress, setProgress] = useState({ index: 0, total: 0, current: null as string | null });
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [applied, setApplied] = useState<{ changes: number; unchanged: number } | null>(null);
  const run = useRef<AbortController | null>(null);
  /** what to ask about once a token has been entered */
  const pending = useRef<RefreshTarget[]>([]);
  const outcomeCount = useRef(0);

  const start = useCallback((list: RefreshTarget[], token: string) => {
    const ctl = new AbortController();
    run.current = ctl;
    let answered = 0;
    setPhase('running');
    setStopNote(null);
    setTokenError(null);
    setProgress({ index: 0, total: list.length, current: null });
    void runRefresh(list, {
      fetchOne: (target, signal) => fetchParcelFromApi(target.parcelId, token, signal),
      pauseMs: config.refreshPauseMs,
      signal: ctl.signal,
      onStart: (i, target) => setProgress({ index: i + 1, total: list.length, current: target.plotNumber }),
      onResult: (target, o) => {
        answered++;
        outcomeCount.current++;
        const stamped: Outcome = o.kind === 'ok' ? { ...o, checkedAt: new Date().toISOString() } : o;
        setOutcomes((prev) => ({ ...prev, [target.plotNumber]: stamped }));
      },
    }).then((end) => {
      if (run.current !== ctl) return; // closed, or another run was started
      run.current = null;
      if (end.ended === 'fatal' && end.reason === 'unauthorized') {
        writeToken(null);
        pending.current = list.slice(answered);
        setTokenError(t.refresh.tokenRejected);
        setPhase('token');
        return;
      }
      if (end.ended === 'cancelled') setStopNote(t.refresh.stopCancelled);
      if (end.ended === 'fatal') setStopNote(end.reason === 'not_configured' ? t.refresh.stopNotConfigured : t.refresh.stopUnavailable);
      setPhase('review');
    });
  }, []);

  /** The button: opens the dialog and starts the run (or asks for the token first). */
  const begin = useCallback(
    (list: RefreshTarget[], cannotCheck: string[]) => {
      if (phase !== null) return; // already open
      setTargets(list);
      setUncheckable(cannotCheck);
      setOutcomes({});
      outcomeCount.current = 0;
      setTicks({});
      setApplied(null);
      setStopNote(null);
      setTokenError(null);
      const token = readToken();
      if (token) start(list, token);
      else {
        pending.current = list;
        setPhase('token');
      }
    },
    [phase, start],
  );

  const submitToken = useCallback(
    (token: string) => {
      writeToken(token);
      start(pending.current, token);
    },
    [start],
  );

  const close = useCallback(() => {
    run.current?.abort();
    run.current = null;
    setPhase(null);
  }, []);

  /** Cancel while running: stop and show what there is. Cancel at the token prompt: the same, or close if there is nothing. */
  const cancel = useCallback(() => {
    if (run.current) return run.current.abort(); // the run ends as "cancelled" and opens the review
    if (outcomeCount.current === 0) return close();
    setStopNote(t.refresh.stopCancelled);
    setPhase('review');
  }, [close]);

  const retryFailed = useCallback(() => {
    const failed = targets.filter((x) => outcomes[x.plotNumber]?.kind === 'failed');
    const token = readToken();
    if (!failed.length) return;
    if (token) start(failed, token);
    else {
      pending.current = failed;
      setPhase('token');
    }
  }, [targets, outcomes, start]);

  const setTick = useCallback((pn: string, on: boolean) => setTicks((prev) => ({ ...prev, [pn]: on })), []);
  const finish = useCallback((changes: number, unchanged: number) => {
    setApplied({ changes, unchanged });
    setPhase('done');
  }, []);

  return { phase, busy: phase !== null, targets, uncheckable, outcomes, progress, tokenError, stopNote, ticks, applied, begin, submitToken, cancel, close, retryFailed, setTick, finish };
}

export type RefreshState = ReturnType<typeof useRefresh>;

interface Props {
  r: RefreshState;
  /** the current data - the comparison is always made against what is stored now */
  doc: OwnershipDoc;
  persistence: Persistence | null;
  saveError: string | null;
  onApply: (records: Record<string, PlotRecord>) => void;
}

interface Row {
  plotNumber: string;
  diff: PlotDiff;
}

const isProtected = (pn: string) => config.protectedPlots.includes(pn);

function Notes({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="muted small">
      {items.map((n, i) => (
        <div key={i}>{n}</div>
      ))}
    </div>
  );
}

function ByHand({ plotNumber }: { plotNumber: string }) {
  if (!isProtected(plotNumber)) return null;
  return (
    <span className="chip hand" title={t.refresh.byHandHint}>
      {t.refresh.byHand}
    </span>
  );
}

export function RefreshDialog({ r, doc, persistence, saveError, onApply }: Props) {
  const [tokenInput, setTokenInput] = useState('');

  const rows = useMemo(() => {
    const changed: Row[] = [];
    const flagged: Row[] = [];
    const unchanged: Row[] = [];
    const failed: { plotNumber: string; message: string }[] = [];
    const oibs = new Map<string, string>();
    for (const target of r.targets) {
      const o = r.outcomes[target.plotNumber];
      if (!o) continue;
      if (o.kind === 'failed') {
        failed.push({ plotNumber: target.plotNumber, message: o.message });
        continue;
      }
      const diff = diffPlot(getRecord(doc, target.plotNumber), o.result, target.identity, o.checkedAt);
      for (const u of diff.unlistedOibs) oibs.set(u.oib, u.name);
      (diff.kind === 'changed' ? changed : diff.kind === 'flagged' ? flagged : unchanged).push({ plotNumber: target.plotNumber, diff });
    }
    const checked = changed.length + flagged.length + unchanged.length;
    return { changed, flagged, unchanged, failed, checked, notChecked: r.targets.length - checked - failed.length, oibs: [...oibs] };
  }, [r.targets, r.outcomes, doc]);

  if (r.phase === null) return null;

  if (r.phase === 'running') {
    const { index, total, current } = r.progress;
    const failedSoFar = Object.values(r.outcomes).filter((o) => o.kind === 'failed').length;
    return (
      <div className="refresh-progress" role="status">
        <div className="refresh-progress-head">
          <b>{t.refresh.title}</b>
          <span className="pct">{t.refresh.progress(index, total)}</span>
        </div>
        <div className="bar">
          <div style={{ width: `${total ? Math.round((Math.max(index - 1, 0) / total) * 100) : 0}%`, background: 'var(--accent)' }} />
        </div>
        <div className="refresh-progress-foot">
          <span className="muted small">
            {current ? t.refresh.current(current) : t.refresh.waiting}
            {failedSoFar > 0 && ` · ${t.refresh.failedSoFar(failedSoFar)}`}
          </span>
          <button className="btn small" onClick={r.cancel}>
            {t.refresh.cancel}
          </button>
        </div>
      </div>
    );
  }

  if (r.phase === 'token') {
    const n = r.targets.length;
    const minutes = Math.max(1, Math.ceil((n * (config.refreshPauseMs + 700)) / 60000));
    return (
      <div className="modal-backdrop">
        <form
          className="modal refresh"
          onSubmit={(e) => {
            e.preventDefault();
            const v = tokenInput.trim();
            if (!v) return;
            setTokenInput('');
            r.submitToken(v);
          }}
        >
          <h3>{t.refresh.title}</h3>
          <div className="modal-body">
            <p>{t.refresh.tokenIntro(n, minutes)}</p>
            {r.tokenError && <div className="note error">{r.tokenError}</div>}
            <label className="field">
              {t.refresh.tokenLabel}
              <input type="password" autoFocus autoComplete="off" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
            </label>
            <div className="muted small">{t.refresh.tokenHint}</div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={r.cancel}>
              {t.refresh.cancel}
            </button>
            <button type="submit" className="btn primary" disabled={!tokenInput.trim()}>
              {t.refresh.start}
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (r.phase === 'done') {
    return (
      <div className="modal-backdrop">
        <div className="modal refresh">
          <h3>{t.refresh.title}</h3>
          <div className="modal-body">
            <p>{t.refresh.applied(r.applied?.changes ?? 0, r.applied?.unchanged ?? 0)}</p>
            {saveError ? (
              <div className="note error">{`${t.data.saveFailed}: ${saveError}`}</div>
            ) : (
              <div className="note warn">{persistence === 'file' ? t.refresh.remindFile : t.refresh.remindBrowser}</div>
            )}
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={r.close}>
              {t.refresh.close}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- review ----------
  const ticked = (pn: string) => r.ticks[pn] ?? !isProtected(pn);
  const toApply = rows.changed.filter((x) => ticked(x.plotNumber));
  const canApply = toApply.length + rows.unchanged.length > 0;
  const apply = () => {
    const now = new Date().toISOString();
    const records: Record<string, PlotRecord> = {};
    for (const x of [...toApply, ...rows.unchanged]) {
      const next = applyDiff(getRecord(doc, x.plotNumber), x.diff, now);
      if (next) records[x.plotNumber] = next;
    }
    onApply(records);
    r.finish(toApply.length, rows.unchanged.length);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal wide refresh">
        <h3>{t.refresh.title}</h3>
        <div className="modal-body">
          {r.stopNote && <div className="note warn">{r.stopNote}</div>}
          <p>
            {t.refresh.summary(rows.checked)}
            {rows.notChecked > 0 && ` ${t.refresh.notChecked(rows.notChecked)}`}
          </p>
          {rows.oibs.length > 0 && (
            <div className="note info">
              {t.refresh.unlistedOibs}
              {rows.oibs.map(([oib, name]) => (
                <div key={oib}>
                  {name} – {oib}
                </div>
              ))}
            </div>
          )}

          <div className="refresh-group">
            <h4>
              {t.refresh.changed} ({rows.changed.length})
            </h4>
            <ul>
              {rows.changed.map(({ plotNumber, diff }) => (
                <li key={plotNumber}>
                  <label className="refresh-pick">
                    <input type="checkbox" checked={ticked(plotNumber)} onChange={(e) => r.setTick(plotNumber, e.target.checked)} />
                    <b>{plotNumber}</b>
                    <ByHand plotNumber={plotNumber} />
                  </label>
                  <ul className="refresh-diff">{diff.kind === 'changed' && diff.differences.map((d, i) => <li key={i}>{d}</li>)}</ul>
                  <Notes items={diff.notes} />
                </li>
              ))}
            </ul>
          </div>

          <div className="refresh-group warn">
            <h4>
              {t.refresh.flagged} ({rows.flagged.length + r.uncheckable.length})
            </h4>
            <ul>
              {rows.flagged.map(({ plotNumber, diff }) => (
                <li key={plotNumber}>
                  <b>{plotNumber}</b> <ByHand plotNumber={plotNumber} />
                  <ul className="refresh-diff">{diff.kind === 'flagged' && diff.reasons.map((d, i) => <li key={i}>{d}</li>)}</ul>
                  <Notes items={diff.notes} />
                </li>
              ))}
              {r.uncheckable.map((pn) => (
                <li key={pn}>
                  <b>{pn}</b>
                  <ul className="refresh-diff">
                    <li>{t.refresh.notOnePlot}</li>
                  </ul>
                </li>
              ))}
            </ul>
          </div>

          <div className="refresh-group error">
            <h4>
              {t.refresh.failed} ({rows.failed.length}){' '}
              {rows.failed.length > 0 && (
                <button className="btn small" onClick={r.retryFailed}>
                  {t.refresh.retryFailed}
                </button>
              )}
            </h4>
            <ul>
              {rows.failed.map((f) => (
                <li key={f.plotNumber}>
                  <b>{f.plotNumber}</b> <span className="muted">{f.message}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="refresh-group">
            <h4>
              {t.refresh.unchanged} ({rows.unchanged.length})
            </h4>
            {rows.unchanged.length > 0 && <div className="muted small">{t.refresh.unchangedInfo(rows.unchanged.length)}</div>}
          </div>
        </div>
        <div className="form-actions">
          {!canApply && <span className="muted small refresh-nothing">{t.refresh.nothingToApply}</span>}
          <button className="btn ghost" onClick={r.close}>
            {canApply ? t.refresh.discard : t.refresh.close}
          </button>
          {canApply && (
            <button className="btn primary" onClick={apply}>
              {t.refresh.apply(toApply.length, rows.unchanged.length)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
