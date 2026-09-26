'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, TextInput, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi, ApiError, DistributionChannelRow } from '../../../lib/api';

/** Curates the report Filter Bar's Distribution Channel dropdown (GET /filters/distribution-channels)
 * -- see backend/src/routes/filters.ts and data/warehouse/migrations/0018_reference_data_admin.sql.
 * Same reference-only scope note as /admin/customer-groups: this never changes how a report
 * measure computes or groups data. */
const SCOPE_NOTE =
  'Controls the Distribution Channel filter dropdown on report pages. Does not change how any ' +
  'report measure computes or groups data -- that still comes from the live ETL channel. A ' +
  "channel with no ETL link below won't appear as a report filter option, since there's no live data for it to filter.";

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

export default function AdminDistributionChannelsPage() {
  return (
    <PermissionGuard pageKey="admin_distribution_channels">
      <AdminLayout title="Distribution Channels">
        <DistributionChannelsPageBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function DistributionChannelsPageBody() {
  const { token, canCreate, canEdit, canDelete } = useAuth();
  const mayCreate = canCreate('admin_distribution_channels');
  const mayEdit = canEdit('admin_distribution_channels');
  const mayDelete = canDelete('admin_distribution_channels');
  const [rows, setRows] = useState<DistributionChannelRow[]>([]);
  const [total, setTotal] = useState(0);
  const [etlOptions, setEtlOptions] = useState<{ channel_key: number; channel_name: string }[]>([]);
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
      adminApi.listDistributionChannels(token, { search: search || undefined, isActive: showInactive ? undefined : true, pageSize: 200 }),
      etlOptions.length ? Promise.resolve(etlOptions) : adminApi.getDistributionChannelEtlOptions(token),
    ])
      .then(([listRes, optionsRes]) => {
        setRows(listRes.rows);
        setTotal(listRes.total);
        setEtlOptions(optionsRes);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load distribution channels.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggleActive(row: DistributionChannelRow) {
    if (!token) return;
    setActionBusy(row.distribution_channel_id);
    setActionError(null);
    try {
      await adminApi.updateDistributionChannel(token, row.distribution_channel_id, { isActive: !row.is_active });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update status.');
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDelete(row: DistributionChannelRow) {
    if (!token) return;
    if (!window.confirm(`Permanently delete "${row.name}"? This cannot be undone.`)) return;
    setActionBusy(row.distribution_channel_id);
    setActionError(null);
    try {
      await adminApi.deleteDistributionChannel(token, row.distribution_channel_id);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to delete.');
    } finally {
      setActionBusy(null);
    }
  }

  const columns: Column<DistributionChannelRow>[] = [
    { key: 'name', header: 'Name' },
    { key: 'definition', header: 'Definition', render: (r) => r.definition ?? '—' },
    { key: 'etl_channel_name', header: 'ETL Relation', render: (r) => (r.etl_channel_key !== null ? `${r.etl_channel_name} (ETL)` : '—') },
    { key: 'display_order', header: 'Order', align: 'right' },
    { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? 'Active' : 'Inactive') },
    {
      key: 'distribution_channel_id',
      header: 'Actions',
      render: (r) => {
        const busy = actionBusy === r.distribution_channel_id;
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mayEdit && (
            <Button variant="secondary" disabled={busy} onClick={() => setEditingId(editingId === r.distribution_channel_id ? null : r.distribution_channel_id)} style={{ padding: '4px 8px', fontSize: 12 }}>
              {editingId === r.distribution_channel_id ? 'Cancel' : 'Edit'}
            </Button>
            )}
            {mayEdit && (
            <Button variant="secondary" disabled={busy} onClick={() => handleToggleActive(r)} style={{ padding: '4px 8px', fontSize: 12 }}>
              {r.is_active ? 'Deactivate' : 'Reactivate'}
            </Button>
            )}
            {mayDelete && r.usage_count === 0 && (
              <Button variant="secondary" disabled={busy} onClick={() => handleDelete(r)} style={{ padding: '4px 8px', fontSize: 12, color: 'var(--ps-color-alert)' }}>
                Delete
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const editingRow = rows.find((r) => r.distribution_channel_id === editingId) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ padding: 12, borderRadius: 8, background: 'var(--ps-color-watch-bg, var(--ps-color-surface))', border: '1px solid var(--ps-color-watch-border, var(--ps-color-border))', fontSize: 13 }}>
        {SCOPE_NOTE}
      </div>

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
        {mayCreate && <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? 'Cancel' : '+ Create Distribution Channel'}</Button>}
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
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{total} distribution channel(s)</div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No distribution channels match these filters." />
        ) : (
          <DataTable columns={columns} rows={rows} getRowId={(r) => String(r.distribution_channel_id)} />
        )}
      </Card>
    </div>
  );
}

function CreatePanel({ etlOptions, onCreated }: { etlOptions: { channel_key: number; channel_name: string }[]; onCreated: () => void }) {
  const { token } = useAuth();
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [etlChannelKey, setEtlChannelKey] = useState('');
  const [displayOrder, setDisplayOrder] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminApi.createDistributionChannel(token, {
        name,
        definition: definition === '' ? null : definition,
        etlChannelKey: etlChannelKey === '' ? null : Number(etlChannelKey),
        displayOrder: displayOrder === '' ? 0 : Number(displayOrder),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create distribution channel.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Create Distribution Channel</h2>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} required disabled={submitting} />
        <TextInput label="Definition" value={definition} onChange={(e) => setDefinition(e.target.value)} disabled={submitting} />
        <div>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>ETL Relation</label>
          <select value={etlChannelKey} onChange={(e) => setEtlChannelKey(e.target.value)} disabled={submitting} style={selectStyle}>
            <option value="">None (custom)</option>
            {etlOptions.map((o) => (
              <option key={o.channel_key} value={o.channel_key}>
                {o.channel_key} = {o.channel_name}
              </option>
            ))}
          </select>
        </div>
        <TextInput label="Display Order" type="number" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} disabled={submitting} />
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
  row: DistributionChannelRow;
  etlOptions: { channel_key: number; channel_name: string }[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { token } = useAuth();
  const [name, setName] = useState(row.name);
  const [definition, setDefinition] = useState(row.definition ?? '');
  const [etlChannelKey, setEtlChannelKey] = useState<string>(row.etl_channel_key === null ? '' : String(row.etl_channel_key));
  const [displayOrder, setDisplayOrder] = useState(String(row.display_order));
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
      await adminApi.updateDistributionChannel(token, row.distribution_channel_id, {
        name,
        definition: definition === '' ? null : definition,
        etlChannelKey: etlChannelKey === '' ? null : Number(etlChannelKey),
        displayOrder: Number(displayOrder),
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
          <select value={etlChannelKey} onChange={(e) => setEtlChannelKey(e.target.value)} disabled={submitting} style={selectStyle}>
            <option value="">None (custom)</option>
            {etlOptions.map((o) => (
              <option key={o.channel_key} value={o.channel_key}>
                {o.channel_key} = {o.channel_name}
              </option>
            ))}
          </select>
        </div>
        <TextInput label="Display Order" type="number" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} disabled={submitting} />
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
