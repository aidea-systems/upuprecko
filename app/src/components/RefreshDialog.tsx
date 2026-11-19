import { useCallback, useMemo, useRef, useState } from 'react';
import type { OwnershipDoc, PlotRecord } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { getRecord } from '../lib/ownership';
import type { OssParcelResult } from '../lib/ossParcel';
import { applyDiff, diffPlot, type PlotDiff } from '../lib/registryRefresh';
import { fetchParcelFromApi, runRefresh, type RefreshTarget } from '../lib/refreshRun';
import { publishDoc, unpublishedEdits } from '../lib/publish';
import type { OwnershipRepository, Persistence } from '../storage/repository';

type Outcome = { kind: 'ok'; result: OssParcelResult; checkedAt: string } | { kind: 'failed'; message: string };
type Phase = 'blocked' | 'token' | 'running' | 'review' | 'done';

/** Where publishing stands after Apply (deployed site only). */
export type PublishStep =
  | { state: 'working' }
  | { state: 'ok'; commit: string | null }
  | { state: 'conflict' }
  | { state: 'unauthorized' }
  | { state: 'unavailable' }
  | { state: 'error'; message: string };

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
 * State of one "Update" run: (blocked →) token → running → review → done.
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
  /** when the last run that reached its end did so */
  const [finishedAt, setFinishedAt] = useState<string | null>(null);
  const [publish, setPublish] = useState<PublishStep | null>(null);
  const run = useRef<AbortController | null>(null);
  /** what to ask about once a token has been entered */
  const pending = useRef<RefreshTarget[]>([]);
  const outcomeCount = useRef(0);
  /** the token in use, also when the browser cannot store it */
  const token = useRef('');

  const start = useCallback((list: RefreshTarget[], tok: string) => {
    const ctl = new AbortController();
    run.current = ctl;
    token.current = tok;
    let answered = 0;
    setPhase('running');
    setStopNote(null);
    setTokenError(null);
    setProgress({ index: 0, total: list.length, current: null });
    void runRefresh(list, {
      fetchOne: (target, signal) => fetchParcelFromApi(target.parcelId, tok, signal),
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
        token.current = '';
        pending.current = list.slice(answered);
        setTokenError(t.refresh.tokenRejected);
        setPhase('token');
        return;
      }
      if (end.ended === 'done') setFinishedAt(new Date().toISOString());
      if (end.ended === 'cancelled') setStopNote(t.refresh.stopCancelled);
      if (end.ended === 'fatal') setStopNote(end.reason === 'not_configured' ? t.refresh.stopNotConfigured : t.refresh.stopUnavailable);
      setPhase('review');
    });
  }, []);

  /**
   * The button: opens the dialog and starts the run (or asks for the token first).
   * `blocked`: the published data has moved on since this browser's copy was made - a run could not be published.
   */
  const begin = useCallback(
    (list: RefreshTarget[], cannotCheck: string[], blocked = false) => {
      if (phase !== null) return; // already open
      setTargets(list);
      setUncheckable(cannotCheck);
      setOutcomes({});
      outcomeCount.current = 0;
      setTicks({});
      setApplied(null);
      setFinishedAt(null);
      setPublish(null);
      setStopNote(null);
      setTokenError(null);
      if (blocked) return setPhase('blocked');
      const tok = readToken();
      if (tok) start(list, tok);
      else {
        pending.current = list;
        setPhase('token');
      }
    },
    [phase, start],
  );

  const submitToken = useCallback(
    (tok: string) => {
      writeToken(tok);
      start(pending.current, tok);
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
    const tok = token.current || readToken();
    if (!failed.length) return;
    if (tok) start(failed, tok);
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
  const getToken = useCallback(() => token.current || readToken(), []);
  const rememberToken = useCallback((tok: string) => {
    token.current = tok;
    writeToken(tok);
  }, []);
  const dropToken = useCallback(() => {
    token.current = '';
    writeToken(null);
  }, []);

  return {
    phase, busy: phase !== null, targets, uncheckable, outcomes, progress, tokenError, stopNote, ticks, applied, finishedAt, publish,
    begin, submitToken, cancel, close, retryFailed, setTick, finish, setPublish, getToken, rememberToken, dropToken,
  };
}

export type RefreshState = ReturnType<typeof useRefresh>;

interface Props {
  r: RefreshState;
  /** the current data - the comparison is always made against what is stored now */
  doc: OwnershipDoc;
  persistence: Persistence | null;
  saveError: string | null;
  /** knows whether this site publishes, and which published version the data was made from */
  repo: Pick<OwnershipRepository, 'publishState' | 'markPublished' | 'markConflict' | 'discardLocal'>;
  /** Saves the records and, when given, the date of the check; returns the document as saved. */
  onApply: (records: Record<string, PlotRecord>, registryCheckedAt: string | null) => OwnershipDoc | null;
  /** reloads the page (after the browser copy was discarded) */
  onReload?: () => void;
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

export function RefreshDialog({ r, doc, persistence, saveError, repo, onApply, onReload = () => window.location.reload() }: Props) {
  const [tokenInput, setTokenInput] = useState('');
  /** the document Apply saved - the one that is published, also on Retry */
  const saved = useRef<OwnershipDoc | null>(null);

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

  const loadPublished = () => {
    repo.discardLocal();
    onReload();
  };

  /** Sends the saved document to /api/publish and records how it went. */
  const publishSaved = async () => {
    const toPublish = saved.current;
    if (!toPublish) return;
    r.setPublish({ state: 'working' });
    const out = await publishDoc(toPublish, repo.publishState().baseSavedAt, r.getToken());
    if (out.kind === 'ok') {
      repo.markPublished(toPublish);
      r.setPublish({ state: 'ok', commit: out.commit });
    } else if (out.kind === 'conflict') {
      repo.markConflict();
      r.setPublish({ state: 'conflict' });
    } else if (out.kind === 'unauthorized') {
      r.dropToken();
      r.setPublish({ state: 'unauthorized' });
    } else if (out.kind === 'unavailable') r.setPublish({ state: 'unavailable' });
    else r.setPublish({ state: 'error', message: out.message });
  };

  if (r.phase === 'blocked') {
    return (
      <div className="modal-backdrop">
        <div className="modal refresh">
          <h3>{t.refresh.title}</h3>
          <div className="modal-body">
            <div className="note warn">{t.publish.blocked}</div>
          </div>
          <div className="form-actions">
            <button className="btn ghost" onClick={r.close}>
              {t.refresh.cancel}
            </button>
            <button className="btn primary" onClick={loadPublished}>
              {t.publish.loadPublished}
            </button>
          </div>
        </div>
      </div>
    );
  }

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
    const p = r.publish;
    return (
      <div className="modal-backdrop">
        <div className="modal refresh">
          <h3>{t.refresh.title}</h3>
          <div className="modal-body">
            <p>{t.refresh.applied(r.applied?.changes ?? 0, r.applied?.unchanged ?? 0)}</p>
            {saveError && <div className="note error">{`${t.data.saveFailed}: ${saveError}`}</div>}
            {/* dev server: the file was written, nothing is published from here */}
            {!p && !saveError && <div className="note warn">{persistence === 'file' ? t.refresh.remindFile : t.refresh.remindBrowser}</div>}
            {p?.state === 'working' && (
              <div className="note info" role="status">
                {t.publish.working}
              </div>
            )}
            {p?.state === 'ok' && (
              <div className="note ok" role="status">
                {t.publish.done}
                {p.commit && <div className="muted small">{t.publish.commit(p.commit.slice(0, 7))}</div>}
              </div>
            )}
            {p?.state === 'conflict' && (
              <div className="note error" role="alert">
                {t.publish.conflict}
                <div>
                  <button className="btn small" onClick={loadPublished}>
                    {t.publish.loadPublished}
                  </button>
                </div>
              </div>
            )}
            {p?.state === 'error' && (
              <div className="note error" role="alert">
                {p.message}
                <div>
                  <button className="btn small" onClick={() => void publishSaved()}>
                    {t.publish.retry}
                  </button>
                </div>
              </div>
            )}
            {p?.state === 'unavailable' && (
              <>
                <div className="note error" role="alert">
                  {t.publish.unavailable}
                </div>
                <div className="note warn">{t.refresh.remindBrowser}</div>
              </>
            )}
            {p?.state === 'unauthorized' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = tokenInput.trim();
                  if (!v) return;
                  setTokenInput('');
                  r.rememberToken(v);
                  void publishSaved();
                }}
              >
                <div className="note error" role="alert">
                  {t.publish.unauthorized}
                </div>
                <label className="field">
                  {t.refresh.tokenLabel}
                  <input type="password" autoFocus autoComplete="off" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
                </label>
                <button type="submit" className="btn small" disabled={!tokenInput.trim()}>
                  {t.publish.publishNow}
                </button>
              </form>
            )}
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={r.close} disabled={p?.state === 'working'}>
              {t.refresh.close}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- review ----------
  const pub = repo.publishState();
  const ticked = (pn: string) => r.ticks[pn] ?? !isProtected(pn);
  const toApply = rows.changed.filter((x) => ticked(x.plotNumber));
  /** every plot was asked about (a failed plot was asked too): the run reached its end */
  const complete = r.targets.length > 0 && rows.notChecked === 0;
  const canApply = complete || toApply.length + rows.unchanged.length > 0;
  const notPublished = pub.canPublish ? unpublishedEdits(doc, pub.published) : { plots: [], shapes: 0 };
  const apply = () => {
    const now = new Date().toISOString();
    const records: Record<string, PlotRecord> = {};
    for (const x of [...toApply, ...rows.unchanged]) {
      const next = applyDiff(getRecord(doc, x.plotNumber), x.diff, now);
      if (next) records[x.plotNumber] = next;
    }
    saved.current = onApply(records, complete ? r.finishedAt ?? now : null);
    r.finish(toApply.length, rows.unchanged.length);
    if (pub.canPublish && saved.current) void publishSaved();
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
            {!complete && ` ${t.refresh.notComplete}`}
          </p>
          {notPublished.plots.length + notPublished.shapes > 0 && (
            <div className="note warn unpublished">
              {t.publish.unpublished(
                notPublished.plots.length,
                notPublished.plots.slice(0, 12).join(', ') + (notPublished.plots.length > 12 ? ', …' : ''),
                notPublished.shapes,
              )}
            </div>
          )}
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
          <span className="muted small refresh-nothing">{!canApply ? t.refresh.nothingToApply : pub.canPublish ? t.refresh.willPublish : ''}</span>
          <button className="btn ghost" onClick={r.close}>
            {canApply ? t.refresh.discard : t.refresh.close}
          </button>
          {canApply && (
            <button className="btn primary" onClick={apply}>
              {t.refresh.apply(toApply.length, pub.canPublish)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
