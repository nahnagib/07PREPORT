'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, TextInput, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi, ApiError, CompanyRow } from '../../../lib/api';

/** Curates the report Filter Bar's Business Unit dropdown (GET /filters/business-units) -- see
 * backend/src/routes/filters.ts and data/warehouse/migrations/0018_reference_data_admin.sql. Same
 * reference-only scope as /admin/customer-groups: never changes how a report measure computes
 * data, and is unrelated to app_user.company_scope (a separate, pre-existing ALL/MAJAAL/TIKA
 * access-scope setting on user accounts -- this page only affects the report filter dropdown). */
const SCOPE_NOTE =
  'Controls the Business Unit filter dropdown on report pages. Does not change how any report ' +
  "measure computes data, and is separate from a user's company access scope. A company with no " +
  "ETL link below won't appear as a report filter option, since there's no live data for it to filter.";

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

export default function AdminCompaniesPage() {
  return (
    <PermissionGuard pageKey="admin_companies">
      <AdminLayout title="Companies">
        <CompaniesPageBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function CompaniesPageBody() {
  const { token, canCreate, canEdit, canDelete } = useAuth();
  const mayCreate = canCreate('admin_companies');
  const mayEdit = canEdit('admin_companies');
  const mayDelete = canDelete('admin_companies');
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [etlOptions, setEtlOptions] = useState<{ company_key: number; company_name: string }[]>([]);
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
      adminApi.listCompanies(token, { search: search || undefined, isActive: showInactive ? undefined : true, pageSize: 200 }),
      etlOptions.length ? Promise.resolve(etlOptions) : adminApi.getCompanyEtlOptions(token),
    ])
      .then(([listRes, optionsRes]) => {
        setRows(listRes.rows);
        setTotal(listRes.total);
        setEtlOptions(optionsRes);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load companies.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggleActive(row: CompanyRow) {
    if (!token) return;
    setActionBusy(row.company_id);
    setActionError(null);
    try {
      await adminApi.updateCompany(token, row.company_id, { isActive: !row.is_active });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update status.');
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDelete(row: CompanyRow) {
    if (!token) return;
    if (!window.confirm(`Permanently delete "${row.name}"? This cannot be undone.`)) return;
    setActionBusy(row.company_id);
    setActionError(null);
    try {
      await adminApi.deleteCompany(token, row.company_id);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to delete.');
    } finally {
      setActionBusy(null);
    }
  }

  const columns: Column<CompanyRow>[] = [
    { key: 'name', header: 'Name' },
    { key: 'definition', header: 'Definition', render: (r) => r.definition ?? '—' },
    { key: 'etl_company_name', header: 'ETL Relation', render: (r) => (r.etl_company_key !== null ? `${r.etl_company_name} (ETL)` : '—') },
    { key: 'display_order', header: 'Order', align: 'right' },
    { key: 'critical_number_pct', header: 'Critical Number %', align: 'right', render: (r) => `${r.critical_number_pct.toFixed(2)}%` },
    { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? 'Active' : 'Inactive') },
    {
      key: 'company_id',
      header: 'Actions',
      render: (r) => {
        const busy = actionBusy === r.company_id;
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mayEdit && (
            <Button variant="secondary" disabled={busy} onClick={() => setEditingId(editingId === r.company_id ? null : r.company_id)} style={{ padding: '4px 8px', fontSize: 12 }}>
              {editingId === r.company_id ? 'Cancel' : 'Edit'}
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

  const editingRow = rows.find((r) => r.company_id === editingId) ?? null;

  const activePctTotal = rows.filter((r) => r.is_active).reduce((sum, r) => sum + r.critical_number_pct, 0);
  const pctTotalOffBy100 = Math.abs(activePctTotal - 100) > 0.01;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ padding: 12, borderRadius: 8, background: 'var(--ps-color-watch-bg, var(--ps-color-surface))', border: '1px solid var(--ps-color-watch-border, var(--ps-color-border))', fontSize: 13 }}>
        {SCOPE_NOTE} The Critical Number % column sets each company's share of the Daily Critical
        Number when it's the only Company filter selected (Admin Panel &gt; Companies) -- see
        Critical Number page.
      </div>

      {!loading && !error && pctTotalOffBy100 && (
        <div
          role="alert"
          style={{ padding: 12, borderRadius: 8, background: 'var(--ps-color-alert-bg, var(--ps-color-surface))', border: '1px solid var(--ps-color-alert)', fontSize: 13, color: 'var(--ps-color-alert)' }}
        >
          Active companies' Critical Number % sums to {activePctTotal.toFixed(2)}%, not 100%. This is allowed, but
          filtering by every active company won't reproduce the full base Daily Critical Number until it's corrected.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 200 }}>
            <TextInput label="Search" placeholder="Name or definition" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, paddingBottom: 8 }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>
        {mayCreate && <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? 'Cancel' : '+ Create Company'}</Button>}
      </div>

      {actionError && <ErrorState message={actionError} onRetry={() => setActionError(null)} />}

      {mayCreate && showCreate && (
        <CreatePanel
          etlOptions={etlOptions}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {editingRow && (
        <EditPanel
          row={editingRow}
          etlOptions={etlOptions}
          onSaved={() => {
            setEditingId(null);
            load();
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      <Card>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{total} compan{total === 1 ? 'y' : 'ies'}</div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No companies match these filters." />
        ) : (
          <DataTable columns={columns} rows={rows} getRowId={(r) => String(r.company_id)} />
        )}
      </Card>
    </div>
  );
}

function CreatePanel({ etlOptions, onCreated }: { etlOptions: { company_key: number; company_name: string }[]; onCreated: () => void }) {
  const { token } = useAuth();
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [etlCompanyKey, setEtlCompanyKey] = useState('');
  const [displayOrder, setDisplayOrder] = useState('0');
  const [criticalNumberPct, setCriticalNumberPct] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminApi.createCompany(token, {
        name,
        definition: definition === '' ? null : definition,
        etlCompanyKey: etlCompanyKey === '' ? null : Number(etlCompanyKey),
        displayOrder: displayOrder === '' ? 0 : Number(displayOrder),
        criticalNumberPct: criticalNumberPct === '' ? 0 : Number(criticalNumberPct),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create company.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Create Company</h2>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} required disabled={submitting} />
        <TextInput label="Definition" value={definition} onChange={(e) => setDefinition(e.target.value)} disabled={submitting} />
        <div>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>ETL Relation</label>
          <select value={etlCompanyKey} onChange={(e) => setEtlCompanyKey(e.target.value)} disabled={submitting} style={selectStyle}>
            <option value="">None (custom)</option>
            {etlOptions.map((o) => (
              <option key={o.company_key} value={o.company_key}>
                {o.company_key} = {o.company_name}
              </option>
            ))}
          </select>
        </div>
        <TextInput label="Display Order" type="number" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} disabled={submitting} />
        <TextInput
          label="Critical Number %"
          type="number"
          min={0}
          max={100}
          step="0.01"
          value={criticalNumberPct}
          onChange={(e) => setCriticalNumberPct(e.target.value)}
          disabled={submitting}
        />
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </form>
      {error && <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: 8 }}>{error}</p>}
    </Card>
  );
}

function EditPanel({
  row,
  etlOptions,
  onSaved,
  onCancel,
}: {
  row: CompanyRow;
  etlOptions: { company_key: number; company_name: string }[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { token } = useAuth();
  const [name, setName] = useState(row.name);
  const [definition, setDefinition] = useState(row.definition ?? '');
  const [etlCompanyKey, setEtlCompanyKey] = useState<string>(row.etl_company_key === null ? '' : String(row.etl_company_key));
  const [displayOrder, setDisplayOrder] = useState(String(row.display_order));
  const [criticalNumberPct, setCriticalNumberPct] = useState(String(row.critical_number_pct));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!token) return;
    if (!name.trim()) {
      setError('Name cannot be empty.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminApi.updateCompany(token, row.company_id, {
        name,
        definition: definition === '' ? null : definition,
        etlCompanyKey: etlCompanyKey === '' ? null : Number(etlCompanyKey),
        displayOrder: Number(displayOrder),
        criticalNumberPct: criticalNumberPct === '' ? 0 : Number(criticalNumberPct),
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
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Edit {row.name}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} required />
        <TextInput label="Definition" value={definition} onChange={(e) => setDefinition(e.target.value)} disabled={submitting} />
        <div>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>ETL Relation</label>
          <select value={etlCompanyKey} onChange={(e) => setEtlCompanyKey(e.target.value)} disabled={submitting} style={selectStyle}>
            <option value="">None (custom)</option>
            {etlOptions.map((o) => (
              <option key={o.company_key} value={o.company_key}>
                {o.company_key} = {o.company_name}
              </option>
            ))}
          </select>
        </div>
        <TextInput label="Display Order" type="number" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} disabled={submitting} />
        <TextInput
          label="Critical Number %"
          type="number"
          min={0}
          max={100}
          step="0.01"
          value={criticalNumberPct}
          onChange={(e) => setCriticalNumberPct(e.target.value)}
          disabled={submitting}
        />
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
