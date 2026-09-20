'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, TextInput, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi, ApiError, ClosureRow } from '../../../lib/api';

/** Feeds backend/src/measures/criticalNumber.ts's Forced Closures YTD card on the Critical Number
 * page (see data/warehouse/migrations/0020_holidays_closures_admin.sql) -- edits here take effect
 * on that page's very next load, no ETL run required. Forced closures are single-branch incidents
 * and are NOT subtracted from the enterprise-wide Working Days count (see criticalNumber.ts's
 * module docstring). */
const SCOPE_NOTE =
  'Feeds the Critical Number page’s Forced Closures card. A closure spanning multiple days counts ' +
  'as one row here (set Duration) but appears as one branch-day per covered day on the dashboard.';

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: 8,
  border: '1px solid var(--ps-color-border)',
  background: 'var(--ps-color-surface)',
  color: 'var(--ps-color-text)',
  fontSize: 13,
  boxSizing: 'border-box',
};

export default function AdminClosuresPage() {
  return (
    <PermissionGuard pageKey="admin_closures">
      <AdminLayout title="Forced Closures">
        <ClosuresPageBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function ClosuresPageBody() {
  const { token } = useAuth();
  const [rows, setRows] = useState<ClosureRow[]>([]);
  const [total, setTotal] = useState(0);
  const [branchOptions, setBranchOptions] = useState<{ branch_key: string; branch_name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    Promise.all([
      adminApi.listClosures(token, { search: search || undefined, isActive: showInactive ? undefined : true, pageSize: 200 }),
      branchOptions.length ? Promise.resolve(branchOptions) : adminApi.getClosureBranchOptions(token),
    ])
      .then(([listRes, options]) => {
        setRows(listRes.rows);
        setTotal(listRes.total);
        setBranchOptions(options);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load closures.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggleActive(row: ClosureRow) {
    if (!token) return;
    setActionBusy(row.closure_id);
    setActionError(null);
    try {
      await adminApi.updateClosure(token, row.closure_id, { isActive: !row.is_active });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update status.');
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDelete(row: ClosureRow) {
    if (!token) return;
    if (!window.confirm(`Permanently delete this closure for "${row.branch_name ?? row.branch_key}"? This cannot be undone.`)) return;
    setActionBusy(row.closure_id);
    setActionError(null);
    try {
      await adminApi.deleteClosure(token, row.closure_id);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to delete.');
    } finally {
      setActionBusy(null);
    }
  }

  const columns: Column<ClosureRow>[] = [
    { key: 'branch_name', header: 'Branch', render: (r) => r.branch_name ?? r.branch_key },
    { key: 'closure_date', header: 'Start Date' },
    { key: 'duration_days', header: 'Duration', render: (r) => `${r.duration_days} day${r.duration_days === 1 ? '' : 's'}` },
    { key: 'reason', header: 'Reason', render: (r) => r.reason ?? '—' },
    { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? 'Active' : 'Inactive') },
    {
      key: 'closure_id',
      header: 'Actions',
      render: (r) => {
        const busy = actionBusy === r.closure_id;
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button variant="secondary" disabled={busy} onClick={() => setEditingId(editingId === r.closure_id ? null : r.closure_id)} style={{ padding: '4px 8px', fontSize: 12 }}>
              {editingId === r.closure_id ? 'Cancel' : 'Edit'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => handleToggleActive(r)} style={{ padding: '4px 8px', fontSize: 12 }}>
              {r.is_active ? 'Deactivate' : 'Reactivate'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => handleDelete(r)} style={{ padding: '4px 8px', fontSize: 12, color: 'var(--ps-color-alert)' }}>
              Delete
            </Button>
          </div>
        );
      },
    },
  ];

  const editingRow = rows.find((r) => r.closure_id === editingId) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ padding: 12, borderRadius: 8, background: 'var(--ps-color-watch-bg, var(--ps-color-surface))', border: '1px solid var(--ps-color-watch-border, var(--ps-color-border))', fontSize: 13 }}>
        {SCOPE_NOTE}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 200 }}>
            <TextInput label="Search" placeholder="Reason or company" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, paddingBottom: 8 }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>
        <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? 'Cancel' : '+ Add Closure'}</Button>
      </div>

      {actionError && <ErrorState message={actionError} onRetry={() => setActionError(null)} />}

      {showCreate && (
        <CreatePanel
          branchOptions={branchOptions}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {editingRow && (
        <EditPanel
          row={editingRow}
          branchOptions={branchOptions}
          onSaved={() => {
            setEditingId(null);
            load();
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      <Card>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{total} closure{total === 1 ? '' : 's'}</div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No closures match these filters." />
        ) : (
          <DataTable columns={columns} rows={rows} getRowId={(r) => String(r.closure_id)} />
        )}
      </Card>
    </div>
  );
}

function CreatePanel({
  branchOptions,
  onCreated,
}: {
  branchOptions: { branch_key: string; branch_name: string }[];
  onCreated: () => void;
}) {
  const { token } = useAuth();
  const [branchKey, setBranchKey] = useState('');
  const [closureDate, setClosureDate] = useState('');
  const [durationDays, setDurationDays] = useState('1');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminApi.createClosure(token, {
        branchKey,
        closureDate,
        durationDays: durationDays === '' ? 1 : Number(durationDays),
        reason: reason === '' ? null : reason,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create closure.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Add Closure</h2>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>Branch</label>
          <select value={branchKey} onChange={(e) => setBranchKey(e.target.value)} disabled={submitting} required style={selectStyle}>
            <option value="" disabled>
              Select a branch
            </option>
            {branchOptions.map((o) => (
              <option key={o.branch_key} value={o.branch_key}>
                {o.branch_name}
              </option>
            ))}
          </select>
        </div>
        <TextInput label="Start Date" type="date" value={closureDate} onChange={(e) => setClosureDate(e.target.value)} required disabled={submitting} />
        <TextInput label="Duration (days)" type="number" value={durationDays} onChange={(e) => setDurationDays(e.target.value)} disabled={submitting} />
        <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} disabled={submitting} />
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Adding...' : 'Add'}
          </Button>
        </div>
      </form>
      {error && <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: 8 }}>{error}</p>}
    </Card>
  );
}

function EditPanel({
  row,
  branchOptions,
  onSaved,
  onCancel,
}: {
  row: ClosureRow;
  branchOptions: { branch_key: string; branch_name: string }[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { token } = useAuth();
  const [branchKey, setBranchKey] = useState(row.branch_key);
  const [closureDate, setClosureDate] = useState(row.closure_date);
  const [durationDays, setDurationDays] = useState(String(row.duration_days));
  const [reason, setReason] = useState(row.reason ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminApi.updateClosure(token, row.closure_id, {
        branchKey,
        closureDate,
        durationDays: Number(durationDays),
        reason: reason === '' ? null : reason,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Edit closure -- {row.branch_name ?? row.branch_key}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>Branch</label>
          <select value={branchKey} onChange={(e) => setBranchKey(e.target.value)} disabled={submitting} style={selectStyle}>
            {branchOptions.map((o) => (
              <option key={o.branch_key} value={o.branch_key}>
                {o.branch_name}
              </option>
            ))}
          </select>
        </div>
        <TextInput label="Start Date" type="date" value={closureDate} onChange={(e) => setClosureDate(e.target.value)} disabled={submitting} required />
        <TextInput label="Duration (days)" type="number" value={durationDays} onChange={(e) => setDurationDays(e.target.value)} disabled={submitting} />
        <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} disabled={submitting} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button onClick={handleSave} disabled={submitting}>
          {submitting ? 'Saving...' : 'Save'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
      {error && <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: 8 }}>{error}</p>}
    </Card>
  );
}
