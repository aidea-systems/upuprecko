import { strings as t } from '../i18n/strings';
import type { ImportIssue, ImportReport } from '../lib/importRows';
import type { OwnershipDoc } from '../types';

export type PendingImport =
  | { kind: 'rows'; fileName: string; report: ImportReport }
  | { kind: 'json'; fileName: string; doc: OwnershipDoc }
  | { kind: 'error'; fileName: string; message: string };

function Issues({ title, items, cls }: { title: string; items: ImportIssue[]; cls: string }) {
  if (!items.length) return null;
  return (
    <div className={`issues ${cls}`}>
      <h4>
        {title} ({items.length})
      </h4>
      <ul>
        {items.map((i, k) => (
          <li key={k}>
            {t.import.row} {i.row}
            {i.plotNumber && i.message !== i.plotNumber ? ` · ${i.plotNumber}` : ''}: {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ImportDialog({ pending, onApply, onClose }: { pending: PendingImport; onApply: () => void; onClose: () => void }) {
  let body: JSX.Element;
  let canApply = false;
  let applyLabel = '';
  if (pending.kind === 'error') {
    body = <div className="note error">{`${t.import.readError}: ${pending.message}`}</div>;
  } else if (pending.kind === 'json') {
    canApply = true;
    applyLabel = t.import.replace;
    const d = pending.doc;
    body = <div className="note warn">{t.import.jsonReplace(Object.keys(d.plots).length, Object.keys(d.reviews).length, Object.keys(d.edits).length)}</div>;
  } else {
    const r = pending.report;
    const n = Object.keys(r.records).length;
    canApply = n > 0 && !r.fatal;
    applyLabel = t.import.apply(n);
    body = r.fatal ? (
      <div className="note error">{r.fatal}</div>
    ) : (
      <>
        <p>
          {t.import.rowsRead(r.rowCount)} {n ? t.import.toApply(n) : t.import.nothing}
        </p>
        <Issues title={t.import.unknownPlots} items={r.unknownPlots} cls="error" />
        <Issues title={t.import.errors} items={r.errors} cls="error" />
        <Issues title={t.import.warnings} items={r.warnings} cls="warn" />
      </>
    );
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {t.import.title}: <span className="muted">{pending.fileName}</span>
        </h3>
        <div className="modal-body">{body}</div>
        <div className="form-actions">
          <button className="btn ghost" onClick={onClose}>
            {canApply ? t.import.cancel : t.plot.cancel}
          </button>
          {canApply && (
            <button className="btn primary" onClick={onApply}>
              {applyLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
