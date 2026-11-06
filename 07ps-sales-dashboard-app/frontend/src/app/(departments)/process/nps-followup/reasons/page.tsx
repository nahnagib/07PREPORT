'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { PermissionGuard } from '../../../../../components/AuthGuard';
import { FollowupShell } from '../../../../../components/nps-followup/FollowupBits';
import { useAuth } from '../../../../../lib/AuthProvider';
import { ApiError } from '../../../../../lib/api';
import { followupApi, groupReasons, type FollowupReason, type ReasonInput } from '../../../../../lib/nps/followup';

/**
 * The follow-up's reasons in two levels (dim_nps_reason, migration 0067): categories, each with its sub-reasons
 * (English + Arabic), permission page nps_followup_reasons (Admin and the Excellence Manager). People pick a sub-reason
 * on a case (or Other, with a note). A category's own row is its "Not specified" (cases moved by the migration without
 * a known sub-reason). A row in use can't be deleted, only deactivated: it then leaves the case form but stays on the
 * cases that have it; a deactivated category hides all its sub-reasons.
 */
export default function FollowupReasonsPage() {
  return (
    <PermissionGuard pageKey="nps_followup_reasons">
      <ReasonsBody />
    </PermissionGuard>
  );
}

interface Draft {
  en: string;
  ar: string;
  sortOrder: string;
}

const EMPTY: Draft = { en: '', ar: '', sortOrder: '' };
const sortOf = (d: Draft) => (d.sortOrder === '' ? undefined : Number(d.sortOrder));

function ReasonsBody() {
  const { token, canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState<FollowupReason[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  /** new sub-reason per category key; '' = the new category row */
  const [adding, setAdding] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const categories = useMemo(() => groupReasons(rows ?? []), [rows]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setRows((await followupApi.reasons(token)).rows);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the reasons.');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      await load();
      return true;
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const input = (d: Draft, set: (d: Draft) => void, k: keyof Draft, label: string, dir?: 'rtl') => (
    <input className="ps-kaizen-input" aria-label={label} placeholder={label} dir={dir} value={d[k]} onChange={(e) => set({ ...d, [k]: e.target.value })}
      inputMode={k === 'sortOrder' ? 'numeric' : undefined} style={k === 'sortOrder' ? { width: 70 } : undefined} />
  );
  const addDraft = (key: string) => adding[key] ?? EMPTY;
  const setAdd = (key: string) => (d: Draft) => setAdding((a) => ({ ...a, [key]: d }));

  /** A category row or a sub-reason row: view, or edit in place. */
  const row = (r: FollowupReason, isCategory: boolean) => {
    const en = isCategory ? r.categoryEn : (r.subReasonEn ?? '');
    const ar = isCategory ? r.categoryAr : (r.subReasonAr ?? '');
    const order = isCategory ? r.categorySort : r.sortOrder;
    const save = (): ReasonInput => (isCategory
      ? { categoryEn: draft.en, categoryAr: draft.ar, sortOrder: sortOf(draft) }
      : { subReasonEn: draft.en, subReasonAr: draft.ar, sortOrder: sortOf(draft) });
    if (editing === r.reasonId) {
      return (
        <tr key={r.reasonId}>
          <td>{input(draft, setDraft, 'sortOrder', 'Order')}</td>
          <td style={isCategory ? undefined : { paddingInlineStart: 24 }}>{input(draft, setDraft, 'en', 'English name')}</td>
          <td>{input(draft, setDraft, 'ar', 'Arabic name', 'rtl')}</td>
          <td>{r.isActive ? 'Yes' : 'No'}</td>
          <td>{r.usageCount}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            <Button disabled={busy} onClick={async () => (await run(() => followupApi.updateReason(token as string, r.reasonId, save()), 'Saved.')) && setEditing(null)}>Save</Button>{' '}
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
          </td>
        </tr>
      );
    }
    const label = isCategory ? r.categoryEn : `${r.categoryEn} › ${r.subReasonEn}`;
    const subCount = categories.find((c) => c.categoryKey === r.categoryKey)?.subReasons.length ?? 0;
    return (
      <tr key={r.reasonId} style={{ opacity: r.isActive && (isCategory || r.categoryActive) ? 1 : 0.55 }}>
        <td>{order}</td>
        <td style={isCategory ? { fontWeight: 700 } : { paddingInlineStart: 24 }}>
          {en}
          {isCategory && (
            <span className="ps-fu-muted" style={{ fontWeight: 400 }}>
              {r.requiresNote ? ' · chosen with a short note' : ' · its own cases = Not specified'}
            </span>
          )}
        </td>
        <td dir="rtl" style={{ textAlign: 'start', fontWeight: isCategory ? 700 : undefined }}>{ar}</td>
        <td>{r.isActive ? 'Yes' : 'No'}</td>
        <td>{r.usageCount}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {canEdit('nps_followup_reasons') && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => { setEditing(r.reasonId); setDraft({ en, ar, sortOrder: String(order) }); }}>Edit</Button>{' '}
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => followupApi.updateReason(token as string, r.reasonId, { isActive: !r.isActive }),
                r.isActive ? `"${label}" deactivated.` : `"${label}" activated.`)}>{r.isActive ? 'Deactivate' : 'Activate'}</Button>{' '}
            </>
          )}
          {canDelete('nps_followup_reasons') && r.usageCount === 0 && (!isCategory || subCount === 0) && (
            <Button variant="secondary" disabled={busy} onClick={() => void run(() => followupApi.deleteReason(token as string, r.reasonId), `"${label}" deleted.`)}>Delete</Button>
          )}
        </td>
      </tr>
    );
  };

  const addRow = (key: string, placeholder: string, payload: (d: Draft) => ReasonInput, button: string, indent: boolean) => {
    const d = addDraft(key);
    return (
      <tr key={`add-${key}`}>
        <td>{input(d, setAdd(key), 'sortOrder', 'Order')}</td>
        <td style={indent ? { paddingInlineStart: 24 } : undefined}>{input(d, setAdd(key), 'en', placeholder)}</td>
        <td>{input(d, setAdd(key), 'ar', 'Arabic name', 'rtl')}</td>
        <td colSpan={2} />
        <td>
          <Button variant={indent ? 'secondary' : undefined} disabled={busy || !d.en.trim() || !d.ar.trim()}
            onClick={async () => (await run(() => followupApi.createReason(token as string, payload(d)), 'Added.')) && setAdd(key)(EMPTY)}>{button}</Button>
        </td>
      </tr>
    );
  };

  return (
    <FollowupShell view="reasons">
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !rows ? (
        <LoadingSkeleton variant="table" />
      ) : (
        <section aria-label="Reasons" className="ps-fu-list-wrap">
          <p className="ps-fu-muted" style={{ marginTop: 0 }}>
            Two levels: a category and its sub-reasons. On a case people choose a sub-reason (or Other, with a short note). A reason in use can be renamed or
            deactivated, not deleted.
          </p>
          {message && <p role="status" className="ps-fu-muted">{message}</p>}
          <div className="ps-fu-table-scroll">
            <table className="ps-fu-table" data-testid="fu-reasons">
              <thead><tr><th>Order</th><th>English</th><th>Arabic</th><th>Active</th><th>Cases</th><th /></tr></thead>
              <tbody>
                {categories.map((c) => (
                  <React.Fragment key={c.categoryKey}>
                    {row(c.row, true)}
                    {c.subReasons.map((r) => row(r, false))}
                    {canCreate('nps_followup_reasons') && !c.row.requiresNote && addRow(c.categoryKey, `New sub-reason in ${c.categoryEn}`,
                      (d) => ({ categoryKey: c.categoryKey, subReasonEn: d.en, subReasonAr: d.ar, sortOrder: sortOf(d) }), 'Add sub-reason', true)}
                  </React.Fragment>
                ))}
                {canCreate('nps_followup_reasons') && addRow('', 'New category', (d) => ({ categoryEn: d.en, categoryAr: d.ar, sortOrder: sortOf(d) }), 'Add category', false)}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </FollowupShell>
  );
}
