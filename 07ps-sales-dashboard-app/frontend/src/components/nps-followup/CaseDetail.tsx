'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Button, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { ApiError } from '../../lib/api';
import {
  EDITABLE_STATUSES,
  FIELD_LABEL,
  STATUS_LABEL,
  followupApi,
  fromInput,
  historyValue,
  toInput,
  type CaseEdit,
  type FollowupCase,
  type FollowupDetail,
  type FollowupOptions,
  type FollowupStatus,
} from '../../lib/nps/followup';
import { StatusPill, TimeOpen } from './FollowupBits';
import { OdooLink } from '../nps/OdooLink';

interface Form {
  status: FollowupStatus;
  reasonId: string;
  ownerUserId: string;
  contactedAt: string;
  solvedAt: string;
  rootCause: string;
  actionTaken: string;
  notes: string;
}

const formOf = (c: FollowupCase): Form => ({
  status: c.status,
  reasonId: c.reasonId ? String(c.reasonId) : '',
  ownerUserId: c.ownerUserId ? String(c.ownerUserId) : '',
  contactedAt: toInput(c.contactedAt),
  solvedAt: toInput(c.solvedAt),
  rootCause: c.rootCause ?? '',
  actionTaken: c.actionTaken ?? '',
  notes: c.notes ?? '',
});

/** Only the fields that changed, plus the version the edit was made on. */
export function editOf(c: FollowupCase, f: Form): CaseEdit {
  const edit: CaseEdit = { version: c.version };
  const before = formOf(c);
  if (f.status !== before.status) edit.status = f.status;
  if (f.reasonId !== before.reasonId) edit.reasonId = f.reasonId ? Number(f.reasonId) : null;
  if (f.ownerUserId !== before.ownerUserId) edit.ownerUserId = f.ownerUserId ? Number(f.ownerUserId) : null;
  if (f.contactedAt !== before.contactedAt) edit.contactedAt = fromInput(f.contactedAt);
  if (f.solvedAt !== before.solvedAt) edit.solvedAt = fromInput(f.solvedAt);
  if (f.rootCause !== before.rootCause) edit.rootCause = f.rootCause;
  if (f.actionTaken !== before.actionTaken) edit.actionTaken = f.actionTaken;
  if (f.notes !== before.notes) edit.notes = f.notes;
  return edit;
}

/**
 * A case, opened from the board or the list: the rating's facts (read-only, from the NPS source), the customer's
 * comment (only with View on nps_comments), the editable follow-up fields (only with Edit on nps_followup) and the
 * history of every change. Saving sends only the changed fields with the version they were made on; if someone else
 * saved in between, the server refuses (409) and the dialog shows their version.
 */
export function CaseDetail({ caseId, options, onClose, onSaved }: {
  caseId: number;
  options: FollowupOptions | null;
  onClose: () => void;
  onSaved: (c: FollowupCase) => void;
}) {
  const { token, canEdit } = useAuth();
  const editable = canEdit('nps_followup');
  const [detail, setDetail] = useState<FollowupDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [conflict, setConflict] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError(null);
    try {
      const { case: c } = await followupApi.getCase(token, caseId);
      setDetail(c);
      setForm(formOf(c));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the case.');
    }
  }, [token, caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !detail || !form) return;
    const edit = editOf(detail, form);
    if (Object.keys(edit).length === 1) return;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const { case: saved } = await followupApi.updateCase(token, caseId, edit);
      onSaved(saved);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        await load();
      } else if (err instanceof ApiError) {
        const body = err.body as { field?: string } | undefined;
        setError({ message: err.message, field: body?.field });
      } else {
        setError({ message: 'Saving failed.' });
      }
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const invalid = (field: string) => (error?.field === field ? { 'aria-invalid': true as const } : {});
  const reasons = (options?.reasons ?? []).filter((r) => r.isActive || String(r.reasonId) === form?.reasonId);
  const fact = (label: string, value: React.ReactNode, wide = false) => (
    <div className={wide ? 'ps-kaizen-full' : undefined} style={{ minWidth: 0 }}>
      <div className="ps-fu-label">{label}</div>
      <div dir="auto" className="ps-fu-value">{value === null || value === undefined || value === '' ? '—' : value}</div>
    </div>
  );

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="fu-case-title" className="ps-fu-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ps-fu-dialog" data-testid="fu-detail">
        <div className="ps-fu-dialog-head">
          <h2 id="fu-case-title" style={{ margin: 0, fontSize: 18 }}>
            Case #{caseId}{detail?.orderRef ? ` · ${detail.orderRef}` : ''}
          </h2>
          <button type="button" className="ps-fu-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : !detail || !form ? (
          <LoadingSkeleton variant="chart" />
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <StatusPill status={detail.status} />
              <TimeOpen c={detail} />
              {detail.updatedAt && <span className="ps-fu-muted">Last change {detail.updatedAt.slice(0, 16)}{detail.updatedByName ? ` by ${detail.updatedByName}` : ''}</span>}
            </div>
            {detail.sourceChanged && (
              <div className="ps-fu-banner" role="status">
                <AlertTriangle size={16} /> The NPS source changed: {detail.sourceChangeReason ?? 'see history'} (noticed {detail.sourceChangedAt?.slice(0, 16)}). The case and its follow-up are kept.
              </div>
            )}

            <section aria-label="Rating">
              <h3 className="ps-fu-h3">Rating (from the NPS source, read-only)</h3>
              <div className="ps-kaizen-form">
                {fact('Rated at (Tripoli)', detail.ratedAt?.slice(0, 16))}
                {fact('Company', detail.company)}
                {fact('Customer', detail.customer, true)}
                {fact('Order', detail.orderRef ? <OdooLink href={detail.orderUrl}>{detail.orderRef}</OdooLink> : null)}
                {fact('Delivery', detail.deliveryCode ? <OdooLink href={detail.deliveryUrl}>{detail.deliveryCode}</OdooLink> : null)}
                {fact('Branch', detail.teamBranch ?? detail.salesTeam)}
                {fact('Salesperson', detail.salesperson)}
                {detail.comment !== null && fact("Customer's comment", detail.comment, true)}
              </div>
            </section>

            <form onSubmit={save} aria-label="Follow-up">
              <h3 className="ps-fu-h3">Follow-up</h3>
              {conflict && (
                <div className="ps-fu-banner" role="alert">Someone else changed this case while you were editing. Their version is shown below; make your change again.</div>
              )}
              <fieldset disabled={!editable || busy} className="ps-kaizen-form" style={{ border: 0, padding: 0, margin: 0 }}>
                <label className="ps-kaizen-field">
                  <span>Status</span>
                  <select className="ps-kaizen-input" value={form.status} onChange={(e) => set('status', e.target.value as FollowupStatus)} {...invalid('status')}>
                    {form.status === 'HISTORICAL' && <option value="HISTORICAL">Historical (before the cut-over)</option>}
                    {EDITABLE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </label>
                <label className="ps-kaizen-field">
                  <span>Reason{form.status === 'SOLVED' ? ' (required to solve)' : ''}</span>
                  <select className="ps-kaizen-input" value={form.reasonId} onChange={(e) => set('reasonId', e.target.value)} {...invalid('reasonId')}>
                    <option value="">Not classified yet</option>
                    {reasons.map((r) => <option key={r.reasonId} value={r.reasonId}>{r.nameEn} · {r.nameAr}</option>)}
                  </select>
                </label>
                <label className="ps-kaizen-field">
                  <span>Owner</span>
                  <select className="ps-kaizen-input" value={form.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)} {...invalid('ownerUserId')}>
                    <option value="">No owner</option>
                    {(options?.owners ?? []).map((o) => <option key={o.userId} value={o.userId}>{o.name}</option>)}
                  </select>
                </label>
                <label className="ps-kaizen-field">
                  <span>Contacted at (Tripoli)</span>
                  <input type="datetime-local" className="ps-kaizen-input" value={form.contactedAt} onChange={(e) => set('contactedAt', e.target.value)} {...invalid('contactedAt')} />
                </label>
                {form.status === 'SOLVED' && (
                  <label className="ps-kaizen-field">
                    <span>Solved at (Tripoli; empty = now)</span>
                    <input type="datetime-local" className="ps-kaizen-input" value={form.solvedAt} onChange={(e) => set('solvedAt', e.target.value)} {...invalid('solvedAt')} />
                  </label>
                )}
                <label className="ps-kaizen-field ps-kaizen-full">
                  <span>Root cause</span>
                  <textarea dir="auto" className="ps-kaizen-input" maxLength={2000} value={form.rootCause} onChange={(e) => set('rootCause', e.target.value)} {...invalid('rootCause')} />
                </label>
                <label className="ps-kaizen-field ps-kaizen-full">
                  <span>Action taken</span>
                  <textarea dir="auto" className="ps-kaizen-input" maxLength={2000} value={form.actionTaken} onChange={(e) => set('actionTaken', e.target.value)} {...invalid('actionTaken')} />
                </label>
                <label className="ps-kaizen-field ps-kaizen-full">
                  <span>Notes{form.status === 'CANCELLED' ? ' (say why it is cancelled)' : ''}</span>
                  <textarea dir="auto" className="ps-kaizen-input" maxLength={2000} value={form.notes} onChange={(e) => set('notes', e.target.value)} {...invalid('notes')} />
                </label>
              </fieldset>
              {error && <p role="alert" className="ps-fu-error">{error.message}</p>}
              {editable && (
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                  <Button type="button" variant="secondary" onClick={() => { setForm(formOf(detail)); setError(null); }} disabled={busy}>Undo changes</Button>
                  <Button type="submit" disabled={busy || Object.keys(editOf(detail, form)).length === 1}>{busy ? 'Saving…' : 'Save'}</Button>
                </div>
              )}
            </form>

            <section aria-label="History">
              <h3 className="ps-fu-h3">History</h3>
              {detail.history.length === 0 ? (
                <p className="ps-fu-muted" style={{ margin: 0 }}>No change yet. Created by the nightly NPS refresh.</p>
              ) : (
                <ol className="ps-fu-history" data-testid="fu-history">
                  {detail.history.map((h, i) => (
                    <li key={i}>
                      <span className="ps-fu-muted">{h.changedAt.slice(0, 16)} · {h.changedBy}</span>
                      <span dir="auto"><strong>{FIELD_LABEL[h.field] ?? h.field}</strong>: {historyValue(h.field, h.oldValue)} → {historyValue(h.field, h.newValue)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
