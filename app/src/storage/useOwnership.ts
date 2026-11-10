import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeatureEdit, OwnershipDoc, PlotRecord, Resolution } from '../types';
import type { OwnershipRepository, Persistence } from './repository';

export function useOwnership(repo: OwnershipRepository) {
  const [doc, setDoc] = useState<OwnershipDoc | null>(null);
  const [persistence, setPersistence] = useState<Persistence | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<OwnershipDoc | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    repo
      .load()
      .then((r) => {
        docRef.current = r.doc;
        setDoc(r.doc);
        setPersistence(r.persistence);
        if (r.notice) setNotice(r.notice);
      })
      .catch((e) => setError(String(e)));
  }, [repo]);

  /** Applies a change locally right away, then saves; saves run one after another. */
  const commit = useCallback((change: (d: OwnershipDoc) => OwnershipDoc, save: (d: OwnershipDoc) => Promise<Persistence>) => {
    const cur = docRef.current;
    if (!cur) return;
    const next = { ...change(cur), savedAt: new Date().toISOString() };
    docRef.current = next;
    setDoc(next);
    queue.current = queue.current
      .then(() => save(next))
      .then((p) => {
        setPersistence(p);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const updatePlot = useCallback(
    (plotNumber: string, rec: PlotRecord) => {
      const stamped = { ...rec, updatedAt: new Date().toISOString() };
      commit((d) => ({ ...d, plots: { ...d.plots, [plotNumber]: stamped } }), (d) => repo.savePlot(plotNumber, stamped, d));
    },
    [commit, repo],
  );

  const setResolution = useCallback(
    (reviewId: string, res: Resolution | null) => {
      commit(
        (d) => {
          const reviews = { ...d.reviews };
          if (res) reviews[reviewId] = res;
          else delete reviews[reviewId];
          return { ...d, reviews };
        },
        (d) => repo.saveResolution(reviewId, res, d),
      );
    },
    [commit, repo],
  );

  /** Merges shape edits (null = remove that edit entirely) and optionally moves an ownership record. */
  const saveFeatureEdits = useCallback(
    (changes: Record<string, FeatureEdit | null>, recordMove: { from: string; to: string } | null = null) => {
      commit(
        (d) => {
          const edits = { ...d.edits };
          for (const [id, e] of Object.entries(changes)) {
            if (e) edits[id] = e;
            else delete edits[id];
          }
          let plots = d.plots;
          if (recordMove && d.plots[recordMove.from]) {
            plots = { ...d.plots, [recordMove.to]: d.plots[recordMove.from] };
            delete plots[recordMove.from];
          }
          return { ...d, edits, plots };
        },
        (d) => repo.saveFeatureEdits(changes, recordMove, d),
      );
    },
    [commit, repo],
  );

  const mergePlots = useCallback(
    (records: Record<string, PlotRecord>) => commit((d) => ({ ...d, plots: { ...d.plots, ...records } }), (d) => repo.replaceAll(d)),
    [commit, repo],
  );

  const replaceAll = useCallback((nd: OwnershipDoc) => commit(() => nd, (d) => repo.replaceAll(d)), [commit, repo]);

  return {
    doc, persistence, notice, error,
    updatePlot, setResolution, saveFeatureEdits, mergePlots, replaceAll,
    dismissNotice: () => setNotice(null),
  };
}
