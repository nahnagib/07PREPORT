'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, TextInput, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import {
  adminApi,
  ApiError,
  DimOption,
  SalespersonAdminRow,
  fetchBusinessUnits,
  fetchCustomerGroups,
  fetchDistributionChannels,
  fetchBranches,
} from '../../../lib/api';

/** UPDATED (Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09) -- see
 * backend/src/services/salespersonAdminService.ts's header comment for the full mechanism: these
 * fields now reclassify this salesperson's revenue/target on every dashboard and report, not just
 * this admin record. */
const OVERLAY_CAVEAT =
  'Editing Team Related, Customer Group, Distribution Channel, or Target here reclassifies this ' +
  "salesperson's revenue and target on every dashboard and report -- including team, segment, " +
  'and company totals they roll up into. Changes take effect immediately.';

/** Company Link + Cascading Filter Bar, 2026-09 -- deliberately NOT part of OVERLAY_CAVEAT above:
 * unlike Team Related/Customer Group/Distribution Channel/Target, Company never reclassifies
 * report totals (see backend/src/services/salespersonAdminService.ts's header). It only labels
 * this salesperson organizationally and narrows the report Filter Bar's dropdown options. */
const COMPANY_CAVEAT = 'Organizational label only -- narrows Filter Bar dropdown options, does not affect report totals.';

function fmtCurrency(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

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

export default function AdminSalespersonsPage() {
  return (
    <PermissionGuard pageKey="admin_salespersons">
      <AdminLayout title="Salesperson Management">
        <SalespersonsPageBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function SalespersonsPageBody() {
  const { token, canEdit } = useAuth();
  const mayEdit = canEdit('admin_salespersons');
  const [rows, setRows] = useState<SalespersonAdminRow[]>([]);
  const [total, setTotal] = useState(0);
  const [channels, setChannels] = useState<DimOption[]>([]);
  const [segments, setSegments] = useState<DimOption[]>([]);
  const [teams, setTeams] = useState<DimOption[]>([]);
  const [companies, setCompanies] = useState<DimOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<number | ''>('');
  const [segmentFilter, setSegmentFilter] = useState<number | ''>('');
  const [teamFilter, setTeamFilter] = useState('');
  const [editingKey, setEditingKey] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    Promise.all([
      adminApi.listSalespersons(token, {
        search: search || undefined,
        channelKey: channelFilter === '' ? undefined : channelFilter,
        segmentKey: segmentFilter === '' ? undefined : segmentFilter,
        salesTeamKey: teamFilter || undefined,
        pageSize: 200,
      }),
      channels.length ? Promise.resolve(channels) : fetchDistributionChannels(token),
      segments.length ? Promise.resolve(segments) : fetchCustomerGroups(token),
      teams.length ? Promise.resolve(teams) : fetchBranches(token),
      companies.length ? Promise.resolve(companies) : fetchBusinessUnits(token),
    ])
      .then(([listRes, channelsRes, segmentsRes, teamsRes, companiesRes]) => {
        setRows(listRes.rows);
        setTotal(listRes.total);
        setChannels(channelsRes);
        setSegments(segmentsRes);
        setTeams(teamsRes);
        setCompanies(companiesRes);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load salespersons.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, channelFilter, segmentFilter, teamFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function applyBulk(patch: Parameters<typeof adminApi.bulkUpdateSalespersonProfiles>[2]) {
    if (!token || selected.size === 0) return;
    setActionError(null);
    try {
      const { results } = await adminApi.bulkUpdateSalespersonProfiles(token, Array.from(selected), patch);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setActionError(`${failed.length} of ${results.length} update(s) failed: ${failed.map((f) => `#${f.salespersonKey} (${f.error})`).join(', ')}`);
      }
      setSelected(new Set());
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Bulk update failed.');
    }
  }

  // Revised column set per approved feedback: Name, Team Related, Customer Group, Distribution
  // Channel, Target only -- YTD Sales/YTD Target/Attainment/Last Modified+History are hidden (not
  // needed for the admin workflow; deferred to v2). The backend still computes/returns them
  // (SalespersonAdminRow keeps those fields) so re-adding the columns later is a frontend-only
  // change, no service/route work required.
  const columns: Column<SalespersonAdminRow>[] = [
    {
      key: 'salesperson_name',
      header: 'ODOO Name',
      render: (r) => (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={selected.has(r.salesperson_key)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(r.salesperson_key);
              else next.delete(r.salesperson_key);
              setSelected(next);
            }}
          />
          {r.salesperson_name}
        </label>
      ),
    },
    {
      key: 'admin_name_override',
      header: 'Admin Name',
      render: (r) => r.admin_name_override ?? '—',
    },
    {
      key: 'company_name_override',
      header: 'Company',
      render: (r) => r.company_name_override ?? '—',
    },
    {
      key: 'sales_team_name_override',
      header: 'Team Related',
      render: (r) => r.sales_team_name_override ?? '—',
    },
    {
      key: 'segment_name_override',
      header: 'Customer Group',
      render: (r) => r.segment_name_override ?? '—',
    },
    {
      key: 'channel_name_override',
      header: 'Distribution Channel',
      render: (r) => r.channel_name_override ?? '—',
    },
    {
      key: 'target_override_amount',
      header: 'Target',
      align: 'right',
      render: (r) => (r.target_override_amount === null ? '—' : fmtCurrency(r.target_override_amount)),
    },
    {
      key: 'linked_user_email',
      header: 'Linked User',
      render: (r) =>
        r.linked_user_email && r.linked_user_id ? (
          <Link href={`/admin/users/${r.linked_user_id}`} style={{ color: 'var(--ps-color-accent)' }}>
            {r.linked_user_email}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'salesperson_key',
      header: 'Actions',
      render: (r) => (
        mayEdit ? (
        <Button
          variant="secondary"
          onClick={() => setEditingKey(editingKey === r.salesperson_key ? null : r.salesperson_key)}
          style={{ padding: '4px 8px', fontSize: 12 }}
        >
          {editingKey === r.salesperson_key ? 'Cancel' : 'Edit'}
        </Button>
        ) : null
      ),
    },
  ];

  const editingRow = rows.find((r) => r.salesperson_key === editingKey) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div
        title={OVERLAY_CAVEAT}
        style={{
          padding: 12,
          borderRadius: 8,
          background: 'var(--ps-color-watch-bg, var(--ps-color-surface))',
          border: '1px solid var(--ps-color-watch-border, var(--ps-color-border))',
          fontSize: 13,
        }}
      >
        {OVERLAY_CAVEAT}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 200 }}>
          <TextInput label="Search" placeholder="Salesperson name" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ minWidth: 180 }}>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Team Related
          </label>
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} style={selectStyle}>
            <option value="">All</option>
            {teams.map((t) => (
              <option key={String(t.sales_team_key)} value={String(t.sales_team_key)}>
                {String(t.sales_team_name)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 180 }}>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Customer Group
          </label>
          <select value={segmentFilter} onChange={(e) => setSegmentFilter(e.target.value ? Number(e.target.value) : '')} style={selectStyle}>
            <option value="">All</option>
            {segments.map((s) => (
              <option key={String(s.segment_key)} value={String(s.segment_key)}>
                {String(s.segment_name)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 180 }}>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Distribution Channel
          </label>
          <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value ? Number(e.target.value) : '')} style={selectStyle}>
            <option value="">All</option>
            {channels.map((c) => (
              <option key={String(c.channel_key)} value={String(c.channel_key)}>
                {String(c.channel_name)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {mayEdit && selected.size > 0 && (
        <BulkActionBar
          count={selected.size}
          channels={channels}
          segments={segments}
          teams={teams}
          companies={companies}
          onApply={applyBulk}
          onClear={() => setSelected(new Set())}
        />
      )}

      {actionError && <ErrorState message={actionError} onRetry={() => setActionError(null)} />}

      {editingRow && (
        <EditPanel
          row={editingRow}
          channels={channels}
          segments={segments}
          teams={teams}
          companies={companies}
          onSaved={() => {
            setEditingKey(null);
            load();
          }}
          onCancel={() => setEditingKey(null)}
        />
      )}

      <Card>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{total} salesperson(s)</div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No salespersons match these filters." />
        ) : (
          <DataTable columns={columns} rows={rows} getRowId={(r) => String(r.salesperson_key)} />
        )}
      </Card>
    </div>
  );
}

function EditPanel({
  row,
  channels,
  segments,
  teams,
  companies,
  onSaved,
  onCancel,
}: {
  row: SalespersonAdminRow;
  channels: DimOption[];
  segments: DimOption[];
  teams: DimOption[];
  companies: DimOption[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { token } = useAuth();
  const [adminNameOverride, setAdminNameOverride] = useState<string>(row.admin_name_override ?? '');
  const [salesTeamKey, setSalesTeamKey] = useState<string>(row.sales_team_key_override ?? '');
  const [segmentKey, setSegmentKey] = useState<string>(row.segment_key_override === null ? '' : String(row.segment_key_override));
  const [channelKey, setChannelKey] = useState<string>(row.channel_key_override === null ? '' : String(row.channel_key_override));
  const [companyKey, setCompanyKey] = useState<string>(row.company_key_override === null ? '' : String(row.company_key_override));
  const [targetOverride, setTargetOverride] = useState<string>(row.target_override_amount === null ? '' : String(row.target_override_amount));
  const [note, setNote] = useState<string>(row.note ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      // All fields save in one PATCH call, per the approved feedback ("Save button persists all
      // changes in one PATCH call").
      await adminApi.updateSalespersonProfile(token, row.salesperson_key, {
        adminNameOverride: adminNameOverride.trim() === '' ? null : adminNameOverride,
        salesTeamKeyOverride: salesTeamKey === '' ? null : salesTeamKey,
        segmentKeyOverride: segmentKey === '' ? null : Number(segmentKey),
        channelKeyOverride: channelKey === '' ? null : Number(channelKey),
        companyKeyOverride: companyKey === '' ? null : Number(companyKey),
        targetOverrideAmount: targetOverride === '' ? null : Number(targetOverride),
        note: note === '' ? null : note,
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
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>Edit {row.admin_name_override ?? row.salesperson_name}</h2>
      <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: '0 0 12px' }}>{OVERLAY_CAVEAT}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <div title={COMPANY_CAVEAT}>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Company
          </label>
          <select value={companyKey} onChange={(e) => setCompanyKey(e.target.value)} disabled={submitting} style={selectStyle}>
            <option value="">Unset</option>
            {companies.map((c) => (
              <option key={String(c.company_key)} value={String(c.company_key)}>
                {String(c.company_name)}
              </option>
            ))}
          </select>
          <p style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', margin: '4px 0 0' }}>{COMPANY_CAVEAT}</p>
        </div>
        <div title={OVERLAY_CAVEAT}>
          <TextInput
            label="Admin Name"
            value={adminNameOverride}
            onChange={(e) => setAdminNameOverride(e.target.value)}
            disabled={submitting}
            helperText={`Leave blank to display the ODOO name (${row.salesperson_name}).`}
          />
        </div>
        <div title={OVERLAY_CAVEAT}>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Team Related
          </label>
          <select value={salesTeamKey} onChange={(e) => setSalesTeamKey(e.target.value)} disabled={submitting} style={selectStyle}>
            <option value="">Unset</option>
            {teams.map((t) => (
              <option key={String(t.sales_team_key)} value={String(t.sales_team_key)}>
                {String(t.sales_team_name)}
              </option>
            ))}
          </select>
        </div>
        <div title={OVERLAY_CAVEAT}>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Customer Group
          </label>
          <select value={segmentKey} onChange={(e) => setSegmentKey(e.target.value)} disabled={submitting} style={selectStyle}>
            <option value="">Unset</option>
            {segments.map((s) => (
              <option key={String(s.segment_key)} value={String(s.segment_key)}>
                {String(s.segment_name)}
              </option>
            ))}
          </select>
        </div>
        <div title={OVERLAY_CAVEAT}>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Distribution Channel
          </label>
          <select value={channelKey} onChange={(e) => setChannelKey(e.target.value)} disabled={submitting} style={selectStyle}>
            <option value="">Unset</option>
            {channels.map((c) => (
              <option key={String(c.channel_key)} value={String(c.channel_key)}>
                {String(c.channel_name)}
              </option>
            ))}
          </select>
        </div>
        <div title={OVERLAY_CAVEAT}>
          <TextInput
            label="Target"
            value={targetOverride}
            onChange={(e) => setTargetOverride(e.target.value)}
            disabled={submitting}
            helperText="Must be > 0. Leave blank to unset."
          />
        </div>
        <TextInput label="Note" value={note} onChange={(e) => setNote(e.target.value)} disabled={submitting} />
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

function BulkActionBar({
  count,
  channels,
  segments,
  teams,
  companies,
  onApply,
  onClear,
}: {
  count: number;
  channels: DimOption[];
  segments: DimOption[];
  teams: DimOption[];
  companies: DimOption[];
  onApply: (patch: {
    channelKeyOverride?: number | null;
    segmentKeyOverride?: number | null;
    salesTeamKeyOverride?: string | null;
    companyKeyOverride?: number | null;
  }) => void;
  onClear: () => void;
}) {
  const [channelKey, setChannelKey] = useState('');
  const [segmentKey, setSegmentKey] = useState('');
  const [salesTeamKey, setSalesTeamKey] = useState('');
  const [companyKey, setCompanyKey] = useState('');

  return (
    <Card>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <strong style={{ fontSize: 13 }}>{count} selected</strong>
        <div style={{ minWidth: 160 }} title={COMPANY_CAVEAT}>
          <select value={companyKey} onChange={(e) => setCompanyKey(e.target.value)} style={selectStyle}>
            <option value="">Set Company to…</option>
            {companies.map((c) => (
              <option key={String(c.company_key)} value={String(c.company_key)}>
                {String(c.company_name)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 160 }}>
          <select value={salesTeamKey} onChange={(e) => setSalesTeamKey(e.target.value)} style={selectStyle}>
            <option value="">Set Team Related to…</option>
            {teams.map((t) => (
              <option key={String(t.sales_team_key)} value={String(t.sales_team_key)}>
                {String(t.sales_team_name)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 160 }}>
          <select value={segmentKey} onChange={(e) => setSegmentKey(e.target.value)} style={selectStyle}>
            <option value="">Set Customer Group to…</option>
            {segments.map((s) => (
              <option key={String(s.segment_key)} value={String(s.segment_key)}>
                {String(s.segment_name)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 160 }}>
          <select value={channelKey} onChange={(e) => setChannelKey(e.target.value)} style={selectStyle}>
            <option value="">Set Distribution Channel to…</option>
            {channels.map((c) => (
              <option key={String(c.channel_key)} value={String(c.channel_key)}>
                {String(c.channel_name)}
              </option>
            ))}
          </select>
        </div>
        <Button
          onClick={() =>
            onApply({
              salesTeamKeyOverride: salesTeamKey === '' ? undefined : salesTeamKey,
              segmentKeyOverride: segmentKey === '' ? undefined : Number(segmentKey),
              channelKeyOverride: channelKey === '' ? undefined : Number(channelKey),
              companyKeyOverride: companyKey === '' ? undefined : Number(companyKey),
            })
          }
          disabled={!channelKey && !segmentKey && !salesTeamKey && !companyKey}
        >
          Apply to {count} selected
        </Button>
        <Button variant="secondary" onClick={onClear}>
          Clear selection
        </Button>
      </div>
    </Card>
  );
}
