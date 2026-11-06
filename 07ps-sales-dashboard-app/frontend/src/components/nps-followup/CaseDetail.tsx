'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Button, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { ApiError } from '../../lib/api';
import {
  EDITABLE_STAGES,
  FIELD_LABEL,
  STAGE_LABEL,
  followupApi,
  fromInput,
  groupReasons,
  historyValue,
  statusOfStage,
  toInput,
  type CaseEdit,
  type FollowupCase,
  type FollowupDetail,
  type FollowupOptions,
  type FollowupReason,
  type FollowupStage,
} from '../../lib/nps/followup';
import { StagePill, StatusBadge, TimeOpen } from './FollowupBits';
import { OdooLink } from '../OdooLink';

/** The form never holds a status: the status follows the stage (the database works it out). */
interface Form {
  stage: FollowupStage;
  /** the picker's first level (not sent: the reason id names its category) */
  category: string;
  reasonId: string;
  reasonNote: string;
  owner: string;
  contactedAt: string;
  resolvedAt: string;
  rootCause: string;
  actionTaken: string;
  notes: string;
}

const formOf = (c: FollowupCase): Form => ({
  stage: c.stage,
  category: c.categoryKey ?? '',
  reasonId: c.reasonId ? String(c.reasonId) : '',
  reasonNote: c.reasonNote ?? '',
  owner: c.ownerName ?? '',
  contactedAt: toInput(c.contactedAt),
  resolvedAt: toInput(c.resolvedAt),
  rootCause: c.rootCause ?? '',
  actionTaken: c.actionTaken ?? '',
  notes: c.notes ?? '',
});

/** Only the fields that changed, plus the version the edit was made on. */
export function editOf(c: FollowupCase, f: Form): CaseEdit {
  const edit: CaseEdit = { version: c.version };
  const before = formOf(c);
  if (f.stage !== before.stage) edit.stage = f.stage;
  if (f.reasonId !== before.reasonId) edit.reasonId = f.reasonId ? Number(f.reasonId) : null;
  if (f.reasonNote.trim() !== before.reasonNote.trim()) edit.reasonNote = f.reasonNote.trim() || null;
  if (f.owner.trim() !== before.owner.trim()) edit.owner = f.owner.trim() || null;
  if (f.contactedAt !== before.contactedAt) edit.contactedAt = fromInput(f.contactedAt);
  if (f.resolvedAt !== before.resolvedAt) edit.resolvedAt = fromInput(f.resolvedAt);
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
  // two levels: a category, then one of its sub-reasons (Other: no sub-reason, a required note). Only pickable rows are
  // offered, plus the case's own reason (a migrated "Not specified" or a since deactivated one) so it is never lost.
  const keep = (r: FollowupReason) => r.pickable || String(r.reasonId) === String(detail?.reasonId ?? '');
  const categories = useMemo(
    () => groupReasons(options?.reasons ?? []).filter((c) => keep(c.row) || c.subReasons.some(keep)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, detail?.reasonId]);
  const category = categories.find((c) => c.categoryKey === form?.category);
  const isOther = !!category && category.row.requiresNote;
  const pickCategory = (key: string) => {
    const next = categories.find((c) => c.categoryKey === key);
    setForm((f) => (f ? { ...f, category: key, reasonId: next?.row.requiresNote ? String(next.row.reasonId) : '' } : f));
  };
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
              <StatusBadge status={detail.status} />
              <StagePill stage={detail.stage} />
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
                {fact('Rated at', detail.ratedAt?.slice(0, 16))}
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
                  <span>Stage</span>
                  <select className="ps-kaizen-input" data-testid="fu-stage-input" value={form.stage} onChange={(e) => set('stage', e.target.value as FollowupStage)} {...invalid('stage')}>
                    {form.stage === 'HISTORICAL' && <option value="HISTORICAL">Historical (before the cut-over)</option>}
                    {EDITABLE_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                  </select>
                </label>
                <div className="ps-kaizen-field">
                  <span>Status (follows the stage)</span>
                  <div className="ps-fu-value" data-testid="fu-status-preview" style={{ minHeight: 32, display: 'flex', alignItems: 'center' }}>
                    {statusOfStage(form.stage) ? <StatusBadge status={statusOfStage(form.stage)} /> : <span className="ps-fu-muted">None (Historical)</span>}
                  </div>
                </div>
                <label className="ps-kaizen-field">
                  <span>Reason category{form.stage === 'RESOLVED' ? ' (required to resolve)' : ''}</span>
                  <select className="ps-kaizen-input" data-testid="fu-category-input" value={form.category} onChange={(e) => pickCategory(e.target.value)} {...invalid('reasonId')}>
                    <option value="">Not classified yet</option>
                    {categories.map((c) => <option key={c.categoryKey} value={c.categoryKey}>{c.categoryEn} · {c.categoryAr}</option>)}
                  </select>
                </label>
                {category && !isOther && (
                  <label className="ps-kaizen-field">
                    <span>Sub-reason</span>
                    <select className="ps-kaizen-input" data-testid="fu-subreason-input" value={form.reasonId} onChange={(e) => set('reasonId', e.target.value)} {...invalid('reasonId')}>
                      <option value="">Choose a sub-reason</option>
                      {keep(category.row) && <option value={category.row.reasonId}>Not specified · غير محدد</option>}
                      {category.subReasons.filter(keep).map((r) => <option key={r.reasonId} value={r.reasonId}>{r.subReasonEn} · {r.subReasonAr}</option>)}
                    </select>
                  </label>
                )}
                {isOther && (
                  <label className="ps-kaizen-field">
                    <span>What is the reason? (required for Other)</span>
                    <input type="text" dir="auto" className="ps-kaizen-input" maxLength={200} value={form.reasonNote}
                      onChange={(e) => set('reasonNote', e.target.value)} {...invalid('reasonNote')} />
                  </label>
                )}
                <label className="ps-kaizen-field">
                  <span>Owner</span>
                  {/* Free text (owners are often people without a login); suggestions = names already used + users. */}
                  <input type="text" className="ps-kaizen-input" value={form.owner} maxLength={120} placeholder="No owner" list="nps-followup-owners"
                    autoComplete="off" onChange={(e) => set('owner', e.target.value)} {...invalid('owner')} />
                  <datalist id="nps-followup-owners">
                    {(options?.owners ?? []).map((o) => <option key={o} value={o} />)}
                  </datalist>
                </label>
                <label className="ps-kaizen-field">
                  <span>Contacted at</span>
                  <input type="datetime-local" className="ps-kaizen-input" value={form.contactedAt} onChange={(e) => set('contactedAt', e.target.value)} {...invalid('contactedAt')} />
                </label>
                {form.stage === 'RESOLVED' && (
                  <label className="ps-kaizen-field">
                    <span>Resolved at (empty = now)</span>
                    <input type="datetime-local" className="ps-kaizen-input" value={form.resolvedAt} onChange={(e) => set('resolvedAt', e.target.value)} {...invalid('resolvedAt')} />
                  </label>
                )}
                {form.stage === 'REJECTED' && detail.stage === 'REJECTED' && detail.rejectedAt && (
                  <div className="ps-kaizen-field">
                    <span>Rejected at</span>
                    <div className="ps-fu-value">{detail.rejectedAt.slice(0, 16)}</div>
                  </div>
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
                  <span>Notes{form.stage === 'REJECTED' ? ' (say why it is rejected)' : ''}</span>
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
