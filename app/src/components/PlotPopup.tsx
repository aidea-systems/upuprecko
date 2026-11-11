import { useState } from 'react';
import type { Owner, PlotRecord, Status } from '../types';
import { STATUSES } from '../types';
import { config } from '../config';
import { strings as t } from '../i18n/strings';
import { checkOwnerShares, effectiveShare, mergeOwners, ourShareFromOwners, type RenameCheck } from '../lib/ownership';
import { fmtArea, fmtDate, fmtPct } from '../lib/format';

export interface PlotSummary {
  plotNumber: string;
  zones: { zone: string; overlap: number }[];
  area: number;
  areaInUpu: number;
  /** review feature ids that were assigned to this plot number */
  reviewIds: string[];
  /** area registered in the cadastre; null when the shape is no longer exactly the official parcel */
  registeredArea: number | null;
  /** cadastral municipality (k.o.) */
  municipality: string | null;
}

export interface ShapeInfo {
  /** plot number in the source data (null for review shapes) */
  originalNumber: string | null;
  numberEdited: boolean;
  boundaryEditedAt: string | null;
  originalArea: number;
}

interface Props {
  plot: PlotSummary;
  record: PlotRecord;
  shape: ShapeInfo;
  /** set when the popup was opened from a resolved review shape */
  openedFromReview?: string;
  checkNumber: (to: string) => RenameCheck;
  onSave: (rec: PlotRecord, plotNumber: string) => void;
  onZoneClick: (zone: string) => void;
  onEditBoundary: () => void;
  onResetBoundary: () => void;
  onResetNumber: () => void;
  onUndoReview?: () => void;
}

export function StatusChip({ status }: { status: Status }) {
  return (
    <span className="chip" style={{ background: config.statusColors[status] + '33', borderColor: config.statusColors[status] }}>
      <i style={{ background: config.statusColors[status] }} />
      {t.status[status]}
    </span>
  );
}

export function PlotPopup(props: Props) {
  const { plot, record, shape, openedFromReview } = props;
  const [editing, setEditing] = useState(false);
  const share = effectiveShare(record);
  const shareCheck = checkOwnerShares(record.owners);

  return (
    <div className="popup">
      <div className="popup-head">
        <h3>{t.plot.title}</h3>
        {!editing && (
          <button className="btn small" onClick={() => setEditing(true)}>
            {t.plot.edit}
          </button>
        )}
      </div>
      {openedFromReview && (
        <div className="note info">
          {t.plot.resolvedFrom(openedFromReview)}{' '}
          {props.onUndoReview && (
            <button className="link" onClick={props.onUndoReview}>
              {t.plot.undoAssignment}
            </button>
          )}
        </div>
      )}
      {editing ? (
        <PlotForm
          plotNumber={plot.plotNumber}
          record={record}
          checkNumber={props.checkNumber}
          onEditBoundary={props.onEditBoundary}
          onCancel={() => setEditing(false)}
          onSave={(r, n) => {
            props.onSave(r, n);
            setEditing(false);
          }}
        />
      ) : (
        <dl className="rows">
          <dt>{t.plot.plotNumber}</dt>
          <dd className="strong">
            {plot.plotNumber}
            {plot.municipality && <div className="muted small">{t.plot.municipality(plot.municipality)}</div>}
            {shape.numberEdited && shape.originalNumber && (
              <div className="muted small">
                {t.plot.numberOriginal(shape.originalNumber)} ·{' '}
                <button className="link" onClick={props.onResetNumber}>
                  {t.plot.resetNumber}
                </button>
              </div>
            )}
          </dd>
          <dt>{t.plot.zone}</dt>
          <dd>
            {plot.zones.length === 0
              ? plot.areaInUpu < 0.5 ? t.plot.outsideUpu : t.plot.noZone
              : plot.zones.map((z) => (
                  <button key={z.zone} className="link block" onClick={() => props.onZoneClick(z.zone)}>
                    {z.zone} <span className="muted">({fmtArea(z.overlap)})</span>
                  </button>
                ))}
          </dd>
          <dt>{t.plot.area}</dt>
          <dd>
            {plot.registeredArea !== null ? (
              <>
                {fmtArea(plot.registeredArea)} <span className="muted">{t.plot.registered}</span>
                <div className="muted small">
                  {t.plot.fromBorders} {fmtArea(plot.area)}
                  {Math.abs(plot.area - plot.areaInUpu) > 0.05 && ` · ${t.plot.inUpu} ${fmtArea(plot.areaInUpu)}`}
                </div>
              </>
            ) : (
              <>
                {fmtArea(plot.area)}
                {Math.abs(plot.area - plot.areaInUpu) > 0.05 && (
                  <span className="muted"> · {t.plot.inUpu} {fmtArea(plot.areaInUpu)}</span>
                )}
              </>
            )}
            {shape.boundaryEditedAt && (
              <div className="note info">
                {t.plot.boundaryEdited(fmtDate(shape.boundaryEditedAt))} ({t.plot.originalArea(fmtArea(shape.originalArea))}).{' '}
                <button className="link" onClick={props.onResetBoundary}>
                  {t.plot.resetBoundary}
                </button>
              </div>
            )}
          </dd>
          <dt>{t.plot.status}</dt>
          <dd>
            <StatusChip status={record.status} />
          </dd>
          <dt>{t.plot.owners}</dt>
          <dd>
            {record.owners.length === 0
              ? t.plot.empty
              : record.owners.map((o, i) => (
                  <div key={i}>
                    {o.name || '—'} <span className="muted">{o.share}</span>
                  </div>
                ))}
            {!shareCheck.ok && (
              <div className="note warn">
                {shareCheck.invalid.length ? t.plot.invalidShare(shareCheck.invalid[0]) : t.plot.sharesSum(shareCheck.sumText)}
              </div>
            )}
          </dd>
          <dt>{t.plot.ourShare}</dt>
          <dd>
            {share.source === 'none' ? t.plot.empty : fmtPct(share.value)}
            {share.source === 'explicit' && record.ourShare !== '1' && <span className="muted"> ({record.ourShare})</span>}
            {share.source === 'status' && <div className="muted small">{t.plot.shareFromStatus}</div>}
            {share.source === 'invalid' && <div className="note warn">{t.plot.ourShareInvalid}</div>}
          </dd>
          <dt>{t.plot.contact}</dt>
          <dd className="pre">{record.contact || t.plot.empty}</dd>
          <dt>{t.plot.notes}</dt>
          <dd className="pre">{record.notes || t.plot.empty}</dd>
          <dt>{t.plot.lastUpdated}</dt>
          <dd>{fmtDate(record.updatedAt)}</dd>
        </dl>
      )}
      {plot.reviewIds.length > 0 && !openedFromReview && <div className="muted small">{t.plot.includesReview(plot.reviewIds.join(', '))}</div>}
    </div>
  );
}

function PlotForm(props: {
  plotNumber: string;
  record: PlotRecord;
  checkNumber: (to: string) => RenameCheck;
  onEditBoundary: () => void;
  onSave: (r: PlotRecord, plotNumber: string) => void;
  onCancel: () => void;
}) {
  const [number, setNumber] = useState(props.plotNumber);
  const [status, setStatus] = useState<Status>(props.record.status);
  const [owners, setOwners] = useState<Owner[]>(props.record.owners);
  const [ourShare, setOurShare] = useState(props.record.ourShare);
  const [contact, setContact] = useState(props.record.contact);
  const [notes, setNotes] = useState(props.record.notes);

  // same owner written in different case = one owner (shares added)
  const cleanOwners = mergeOwners(
    owners.filter((o) => o.name.trim() || o.share.trim()).map((o) => ({ name: o.name.trim(), share: o.share.trim() })),
  );
  const check = checkOwnerShares(cleanOwners);
  const computedOurShare = ourShareFromOwners(cleanOwners);
  const shareState = effectiveShare({ ...props.record, ourShare });
  const ourShareBad = ourShare.trim() !== '' && shareState.source === 'invalid';
  const numberCheck = props.checkNumber(number.trim());
  const blocked = ourShareBad || check.invalid.length > 0 || !numberCheck.ok;

  const setOwner = (i: number, patch: Partial<Owner>) => setOwners(owners.map((o, k) => (k === i ? { ...o, ...patch } : o)));

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        props.onSave(
          { ...props.record, status, owners: cleanOwners, ourShare: ourShare.trim(), contact: contact.trim(), notes: notes.trim() },
          number.trim(),
        );
      }}
    >
      <label htmlFor="f-number">{t.plot.plotNumber}</label>
      <div>
        <input id="f-number" value={number} onChange={(e) => setNumber(e.target.value)} />
        {!numberCheck.ok && <div className="note error">{numberCheck.error}</div>}
        {numberCheck.ok && numberCheck.merge && <div className="note warn">{t.plot.numberMerge(number.trim())}</div>}
        {numberCheck.ok && numberCheck.moveRecord && <div className="muted small">{t.plot.numberMoves(props.plotNumber, number.trim())}</div>}
      </div>

      <label>{t.plot.boundary}</label>
      <div>
        <button type="button" className="btn small" onClick={props.onEditBoundary}>
          ✎ {t.plot.editBoundary}
        </button>
      </div>

      <label htmlFor="f-status">{t.plot.status}</label>
      <select
        id="f-status"
        value={status}
        onChange={(e) => {
          const s = e.target.value as Status;
          setStatus(s);
          if (s === 'owned' && !ourShare.trim()) setOurShare('1');
        }}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {t.status[s]}
          </option>
        ))}
      </select>

      <label>{t.plot.owners}</label>
      <div className="owners">
        {owners.map((o, i) => (
          <div className="owner-row" key={i}>
            <input placeholder={t.plot.ownerName} value={o.name} onChange={(e) => setOwner(i, { name: e.target.value })} />
            <input className="share" placeholder="1/2" value={o.share} onChange={(e) => setOwner(i, { share: e.target.value })} />
            <button type="button" className="icon" title={t.plot.remove} onClick={() => setOwners(owners.filter((_, k) => k !== i))}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="link" onClick={() => setOwners([...owners, { name: '', share: '' }])}>
          {t.plot.addOwner}
        </button>
        <div className="muted small">{t.plot.shareHint}</div>
        {check.invalid.length > 0 && <div className="note error">{t.plot.invalidShare(check.invalid[0])}</div>}
        {!check.ok && !check.invalid.length && <div className="note warn">{t.plot.sharesSum(check.sumText)}</div>}
      </div>

      <label htmlFor="f-our">{t.plot.ourShare}</label>
      <div>
        <input id="f-our" value={ourShare} placeholder="1/2" onChange={(e) => setOurShare(e.target.value)} />
        <div className="muted small">
          {t.plot.ourShareHint} {shareState.source === 'explicit' && `= ${fmtPct(shareState.value)}`}
        </div>
        {ourShareBad && <div className="note error">{t.plot.ourShareInvalid}</div>}
        {computedOurShare !== null && cleanOwners.length > 0 && computedOurShare !== ourShare.trim() && (
          <div className="muted small">
            {t.plot.fromOwners(computedOurShare)}{' '}
            <button type="button" className="link" onClick={() => setOurShare(computedOurShare)}>
              {t.plot.useFromOwners}
            </button>
          </div>
        )}
      </div>

      <label htmlFor="f-contact">{t.plot.contact}</label>
      <textarea id="f-contact" rows={2} value={contact} onChange={(e) => setContact(e.target.value)} />

      <label htmlFor="f-notes">{t.plot.notes}</label>
      <textarea id="f-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />

      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={props.onCancel}>
          {t.plot.cancel}
        </button>
        <button type="submit" className="btn primary" disabled={blocked}>
          {t.plot.save}
        </button>
      </div>
    </form>
  );
}
