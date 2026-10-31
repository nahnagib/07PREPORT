'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { PermissionGuard } from '../../../../../components/AuthGuard';
import { FollowupShell } from '../../../../../components/nps-followup/FollowupBits';
import { useAuth } from '../../../../../lib/AuthProvider';
import { ApiError } from '../../../../../lib/api';
import { followupApi, type FollowupReason } from '../../../../../lib/nps/followup';

/**
 * The follow-up's reason list (English + Arabic), permission page nps_followup_reasons (Admin and the Excellence
 * Manager). A reason used by a case can't be deleted, only deactivated: it then disappears from the case form but
 * stays on the cases that have it.
 */
export default function FollowupReasonsPage() {
  return (
    <PermissionGuard pageKey="nps_followup_reasons">
      <ReasonsBody />
    </PermissionGuard>
  );
}

interface Draft {
  nameEn: string;
  nameAr: string;
  sortOrder: string;
}

function ReasonsBody() {
  const { token, canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState<FollowupReason[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>({ nameEn: '', nameAr: '', sortOrder: '' });
  const [adding, setAdding] = useState<Draft>({ nameEn: '', nameAr: '', sortOrder: '' });
  const [busy, setBusy] = useState(false);

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

  return (
    <FollowupShell view="reasons">
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !rows ? (
        <LoadingSkeleton variant="table" />
      ) : (
        <section aria-label="Reasons" className="ps-fu-list-wrap">
          <p className="ps-fu-muted" style={{ marginTop: 0 }}>The reasons people choose on a case. A reason in use can be renamed or deactivated, not deleted.</p>
          {message && <p role="status" className="ps-fu-muted">{message}</p>}
          <div className="ps-fu-table-scroll">
            <table className="ps-fu-table">
              <thead><tr><th>Order</th><th>English</th><th>Arabic</th><th>Active</th><th>Cases</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (editing === r.reasonId ? (
                  <tr key={r.reasonId}>
                    <td>{input(draft, setDraft, 'sortOrder', 'Order')}</td>
                    <td>{input(draft, setDraft, 'nameEn', 'English name')}</td>
                    <td>{input(draft, setDraft, 'nameAr', 'Arabic name', 'rtl')}</td>
                    <td>{r.isActive ? 'Yes' : 'No'}</td>
                    <td>{r.usageCount}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Button disabled={busy} onClick={async () => (await run(() => followupApi.updateReason(token as string, r.reasonId,
                        { nameEn: draft.nameEn, nameAr: draft.nameAr, sortOrder: draft.sortOrder === '' ? undefined : Number(draft.sortOrder) }), 'Saved.')) && setEditing(null)}>Save</Button>{' '}
                      <Button variant="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.reasonId} style={{ opacity: r.isActive ? 1 : 0.55 }}>
                    <td>{r.sortOrder}</td>
                    <td>{r.nameEn}</td>
                    <td dir="rtl" style={{ textAlign: 'start' }}>{r.nameAr}</td>
                    <td>{r.isActive ? 'Yes' : 'No'}</td>
                    <td>{r.usageCount}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canEdit('nps_followup_reasons') && (
                        <>
                          <Button variant="secondary" disabled={busy} onClick={() => { setEditing(r.reasonId); setDraft({ nameEn: r.nameEn, nameAr: r.nameAr, sortOrder: String(r.sortOrder) }); }}>Edit</Button>{' '}
                          <Button variant="secondary" disabled={busy} onClick={() => void run(() => followupApi.updateReason(token as string, r.reasonId, { isActive: !r.isActive }),
                            r.isActive ? `"${r.nameEn}" deactivated.` : `"${r.nameEn}" activated.`)}>{r.isActive ? 'Deactivate' : 'Activate'}</Button>{' '}
                        </>
                      )}
                      {canDelete('nps_followup_reasons') && r.usageCount === 0 && (
                        <Button variant="secondary" disabled={busy} onClick={() => void run(() => followupApi.deleteReason(token as string, r.reasonId), `"${r.nameEn}" deleted.`)}>Delete</Button>
                      )}
                    </td>
                  </tr>
                )))}
                {canCreate('nps_followup_reasons') && (
                  <tr>
                    <td>{input(adding, setAdding, 'sortOrder', 'Order')}</td>
                    <td>{input(adding, setAdding, 'nameEn', 'English name')}</td>
                    <td>{input(adding, setAdding, 'nameAr', 'Arabic name', 'rtl')}</td>
                    <td colSpan={2} />
                    <td>
                      <Button disabled={busy || !adding.nameEn.trim() || !adding.nameAr.trim()} onClick={async () => (await run(() => followupApi.createReason(token as string,
                        { nameEn: adding.nameEn, nameAr: adding.nameAr, sortOrder: adding.sortOrder === '' ? undefined : Number(adding.sortOrder) }), 'Added.'))
                        && setAdding({ nameEn: '', nameAr: '', sortOrder: '' })}>Add reason</Button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </FollowupShell>
  );
}
