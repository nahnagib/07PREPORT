'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, TextInput, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi, ApiError, HolidayRow } from '../../../lib/api';

/** Feeds backend/src/measures/criticalNumber.ts's Working Days / Official Holidays YTD / Missing
 * Value/Days measures on the Critical Number page (see
 * data/warehouse/migrations/0020_holidays_closures_admin.sql) -- edits here take effect on that
 * page's very next load, no ETL run required. */
const SCOPE_NOTE =
  'Feeds the Critical Number page’s Working Days calculation. A recurring holiday applies every ' +
  'year on the same month/day; a company left blank applies country-wide.';

export default function AdminHolidaysPage() {
  return (
    <PermissionGuard pageKey="admin_holidays">
      <AdminLayout title="Official Holidays">
        <HolidaysPageBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function HolidaysPageBody() {
  const { token, canCreate, canEdit, canDelete } = useAuth();
  const mayCreate = canCreate('admin_holidays');
  const mayEdit = canEdit('admin_holidays');
  const mayDelete = canDelete('admin_holidays');
  const [rows, setRows] = useState<HolidayRow[]>([]);
  const [total, setTotal] = useState(0);
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
    adminApi
      .listHolidays(token, { search: search || undefined, isActive: showInactive ? undefined : true, pageSize: 200 })
      .then((res) => {
        setRows(res.rows);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load holidays.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggleActive(row: HolidayRow) {
    if (!token) return;
    setActionBusy(row.holiday_id);
    setActionError(null);
    try {
      await adminApi.updateHoliday(token, row.holiday_id, { isActive: !row.is_active });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update status.');
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDelete(row: HolidayRow) {
    if (!token) return;
    if (!window.confirm(`Permanently delete "${row.holiday_name}"? This cannot be undone.`)) return;
    setActionBusy(row.holiday_id);
    setActionError(null);
    try {
      await adminApi.deleteHoliday(token, row.holiday_id);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to delete.');
    } finally {
      setActionBusy(null);
    }
  }

  const columns: Column<HolidayRow>[] = [
    { key: 'holiday_name', header: 'Name' },
    { key: 'holiday_date', header: 'Date' },
    { key: 'recurring', header: 'Recurring', render: (r) => (r.recurring ? 'Every year' : 'One-time') },
    { key: 'company', header: 'Company', render: (r) => r.company ?? 'Country-wide' },
    { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? 'Active' : 'Inactive') },
    {
      key: 'holiday_id',
      header: 'Actions',
      render: (r) => {
        const busy = actionBusy === r.holiday_id;
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mayEdit && (
            <Button variant="secondary" disabled={busy} onClick={() => setEditingId(editingId === r.holiday_id ? null : r.holiday_id)} style={{ padding: '4px 8px', fontSize: 12 }}>
              {editingId === r.holiday_id ? 'Cancel' : 'Edit'}
            </Button>
            )}
            {mayEdit && (
            <Button variant="secondary" disabled={busy} onClick={() => handleToggleActive(r)} style={{ padding: '4px 8px', fontSize: 12 }}>
              {r.is_active ? 'Deactivate' : 'Reactivate'}
            </Button>
            )}
            {mayDelete && (
            <Button variant="secondary" disabled={busy} onClick={() => handleDelete(r)} style={{ padding: '4px 8px', fontSize: 12, color: 'var(--ps-color-alert)' }}>
              Delete
            </Button>
            )}
          </div>
        );
      },
    },
  ];

  const editingRow = rows.find((r) => r.holiday_id === editingId) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ padding: 12, borderRadius: 8, background: 'var(--ps-color-watch-bg, var(--ps-color-surface))', border: '1px solid var(--ps-color-watch-border, var(--ps-color-border))', fontSize: 13 }}>
        {SCOPE_NOTE}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 200 }}>
            <TextInput label="Search" placeholder="Name or company" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, paddingBottom: 8 }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>
        {mayCreate && <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? 'Cancel' : '+ Add Holiday'}</Button>}
      </div>

      {actionError && <ErrorState message={actionError} onRetry={() => setActionError(null)} />}

      {mayCreate && showCreate && (
        <CreatePanel
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {editingRow && (
        <EditPanel
          row={editingRow}
          onSaved={() => {
            setEditingId(null);
            load();
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      <Card>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{total} holiday{total === 1 ? '' : 's'}</div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No holidays match these filters." />
        ) : (
          <DataTable columns={columns} rows={rows} getRowId={(r) => String(r.holiday_id)} />
        )}
      </Card>
    </div>
  );
}

function CreatePanel({ onCreated }: { onCreated: () => void }) {
  const { token } = useAuth();
  const [holidayName, setHolidayName] = useState('');
  const [holidayDate, setHolidayDate] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [company, setCompany] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminApi.createHoliday(token, {
        holidayName,
        holidayDate,
        recurring,
        company: company === '' ? null : company,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create holiday.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Add Holiday</h2>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <TextInput label="Holiday Name" value={holidayName} onChange={(e) => setHolidayName(e.target.value)} required disabled={submitting} />
        <TextInput label="Date" type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} required disabled={submitting} />
        <TextInput label="Company (blank = country-wide)" value={company} onChange={(e) => setCompany(e.target.value)} disabled={submitting} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, paddingBottom: 8 }}>
          <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} disabled={submitting} />
          Repeats every year
        </label>
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

function EditPanel({ row, onSaved, onCancel }: { row: HolidayRow; onSaved: () => void; onCancel: () => void }) {
  const { token } = useAuth();
  const [holidayName, setHolidayName] = useState(row.holiday_name);
  const [holidayDate, setHolidayDate] = useState(row.holiday_date);
  const [recurring, setRecurring] = useState(row.recurring);
  const [company, setCompany] = useState(row.company ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!token) return;
    if (!holidayName.trim()) {
      setError('Holiday name cannot be empty.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminApi.updateHoliday(token, row.holiday_id, {
        holidayName,
        holidayDate,
        recurring,
        company: company === '' ? null : company,
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
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Edit {row.holiday_name}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <TextInput label="Holiday Name" value={holidayName} onChange={(e) => setHolidayName(e.target.value)} disabled={submitting} required />
        <TextInput label="Date" type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} disabled={submitting} required />
        <TextInput label="Company (blank = country-wide)" value={company} onChange={(e) => setCompany(e.target.value)} disabled={submitting} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, paddingBottom: 8 }}>
          <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} disabled={submitting} />
          Repeats every year
        </label>
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
