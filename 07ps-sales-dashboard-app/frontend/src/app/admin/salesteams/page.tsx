'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, TextInput, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi, ApiError, DimOption, SalesTeamAdminRow, fetchBusinessUnits, fetchCustomerGroups } from '../../../lib/api';

/** UPDATED (Reports/Dashboards Honor Admin Salesperson Overrides, 2026-09) -- see
 * backend/src/services/salesTeamAdminService.ts's header comment. Only Customer Group
 * (segment_key_override) now reclassifies live dashboards, and only for salespeople whose own
 * effective sales-team resolves to this team. Name/Code stay purely administrative (Name is used
 * as this team's display label wherever it's shown; Code has no dashboard meaning at all). This
 * page's own Target field is NOT fed into any dashboard -- a team's rolled-up target comes
 * entirely from summing its salespeople's own target_override_amount (set on the Salesperson
 * page), not from a separate team-level figure. */
const OVERLAY_CAVEAT =
  'Customer Group reclassifies every salesperson on this team into that segment for live ' +
  "dashboards and reports. Name is this team's display label everywhere; Code is purely " +
  "administrative. This page's Target field is reference-only -- the team's real rolled-up " +
  "target comes from summing its salespeople's own targets, set on the Salesperson page.";

/** Company Link + Cascading Filter Bar, 2026-09 -- deliberately NOT part of OVERLAY_CAVEAT above:
 * unlike Customer Group, Company never reclassifies report totals (see
 * backend/src/services/salesTeamAdminService.ts's header). It only labels this team
 * organizationally and narrows the report Filter Bar's dropdown options. */
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

export default function AdminSalesTeamsPage() {
  return (
    <PermissionGuard pageKey="admin_salesteams">
      <AdminLayout title="Sales Team Management">
        <SalesTeamsPageBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function SalesTeamsPageBody() {
  const { token } = useAuth();
  const [rows, setRows] = useState<SalesTeamAdminRow[]>([]);
  const [total, setTotal] = useState(0);
  const [segments, setSegments] = useState<DimOption[]>([]);
  const [companies, setCompanies] = useState<DimOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [segmentFilter, setSegmentFilter] = useState<number | ''>('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    Promise.all([
      adminApi.listSalesTeams(token, {
        search: search || undefined,
        segmentKey: segmentFilter === '' ? undefined : segmentFilter,
        pageSize: 200,
      }),
      segments.length ? Promise.resolve(segments) : fetchCustomerGroups(token),
      companies.length ? Promise.resolve(companies) : fetchBusinessUnits(token),
    ])
      .then(([listRes, segmentsRes, companiesRes]) => {
        setRows(listRes.rows);
        setTotal(listRes.total);
        setSegments(segmentsRes);
        setCompanies(companiesRes);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load sales teams.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, segmentFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Bulk is deliberately Customer Group only -- "No bulk Name/Code edit (too risky)" per the
  // approved feedback. Also enforced server-side (backend/src/routes/admin/salesteams.ts).
  async function applyBulkSegment(segmentKeyOverride: number | null) {
    if (!token || selected.size === 0) return;
    setActionError(null);
    try {
      const { results } = await adminApi.bulkUpdateSalesTeamSegment(token, Array.from(selected), segmentKeyOverride);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setActionError(`${failed.length} of ${results.length} update(s) failed: ${failed.map((f) => `${f.salesTeamKey} (${f.error})`).join(', ')}`);
      }
      setSelected(new Set());
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Bulk update failed.');
    }
  }

  /** Company Link + Cascading Filter Bar, 2026-09 -- separate bulk call, hitting the new
   * POST /admin/salesteams/bulk-company route (distinct from applyBulkSegment's POST /bulk), same
   * "server-side restricted to one field" rationale as the segment bulk path. */
  async function applyBulkCompany(companyKeyOverride: number | null) {
    if (!token || selected.size === 0) return;
    setActionError(null);
    try {
      const { results } = await adminApi.bulkUpdateSalesTeamCompany(token, Array.from(selected), companyKeyOverride);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setActionError(`${failed.length} of ${results.length} update(s) failed: ${failed.map((f) => `${f.salesTeamKey} (${f.error})`).join(', ')}`);
      }
      setSelected(new Set());
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Bulk update failed.');
    }
  }

  const columns: Column<SalesTeamAdminRow>[] = [
    {
      key: 'sales_team_name',
      header: 'Name',
      render: (r) => (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={selected.has(r.sales_team_key)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(r.sales_team_key);
              else next.delete(r.sales_team_key);
              setSelected(next);
            }}
          />
          {r.sales_team_name}
        </label>
      ),
    },
    { key: 'team_code', header: 'Code', render: (r) => r.team_code ?? '—' },
    { key: 'company_name_override', header: 'Company', render: (r) => r.company_name_override ?? '—' },
    {
      key: 'target_override_amount',
      header: 'Target',
      align: 'right',
      render: (r) => (r.target_override_amount === null ? '—' : fmtCurrency(r.target_override_amount)),
    },
    { key: 'segment_name_override', header: 'Customer Group', render: (r) => r.segment_name_override ?? '—' },
    {
      key: 'sales_team_key',
      header: 'Actions',
      render: (r) => (
        <Button
          variant="secondary"
          onClick={() => setEditingKey(editingKey === r.sales_team_key ? null : r.sales_team_key)}
          style={{ padding: '4px 8px', fontSize: 12 }}
        >
          {editingKey === r.sales_team_key ? 'Cancel' : 'Edit'}
        </Button>
      ),
    },
  ];

  const editingRow = rows.find((r) => r.sales_team_key === editingKey) ?? null;

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
          <TextInput label="Search" placeholder="Team name" value={search} onChange={(e) => setSearch(e.target.value)} />
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
      </div>

      {selected.size > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <BulkSegmentBar count={selected.size} segments={segments} onApply={applyBulkSegment} onClear={() => setSelected(new Set())} />
          <BulkCompanyBar count={selected.size} companies={companies} onApply={applyBulkCompany} onClear={() => setSelected(new Set())} />
        </div>
      )}

      {actionError && <ErrorState message={actionError} onRetry={() => setActionError(null)} />}

      {editingRow && (
        <EditPanel
          row={editingRow}
          segments={segments}
          companies={companies}
          onSaved={() => {
            setEditingKey(null);
            load();
          }}
          onCancel={() => setEditingKey(null)}
        />
      )}

      <Card>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{total} sales team(s)</div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No sales teams match these filters." />
        ) : (
          <DataTable columns={columns} rows={rows} getRowId={(r) => r.sales_team_key} />
        )}
      </Card>
    </div>
  );
}

function EditPanel({
  row,
  segments,
  companies,
  onSaved,
  onCancel,
}: {
  row: SalesTeamAdminRow;
  segments: DimOption[];
  companies: DimOption[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { token } = useAuth();
  const [name, setName] = useState(row.sales_team_name);
  // Defaults to the live sales_team_key so a first save never trips the NOT NULL/UNIQUE
  // constraint on team_code -- see 0016_admin_salesperson_profile.sql's comment on that column.
  const [teamCode, setTeamCode] = useState(row.team_code ?? row.sales_team_key);
  const [targetOverride, setTargetOverride] = useState<string>(row.target_override_amount === null ? '' : String(row.target_override_amount));
  const [segmentKey, setSegmentKey] = useState<string>(row.segment_key_override === null ? '' : String(row.segment_key_override));
  const [companyKey, setCompanyKey] = useState<string>(row.company_key_override === null ? '' : String(row.company_key_override));
  const [note, setNote] = useState<string>(row.note ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!token) return;
    if (!name.trim()) {
      setError('Name cannot be empty.');
      return;
    }
    if (!teamCode.trim()) {
      setError('Code is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // All fields save in one PATCH call, same convention as the Salesperson page.
      await adminApi.updateSalesTeamProfile(token, row.sales_team_key, {
        teamNameOverride: name,
        teamCode,
        targetOverrideAmount: targetOverride === '' ? null : Number(targetOverride),
        segmentKeyOverride: segmentKey === '' ? null : Number(segmentKey),
        companyKeyOverride: companyKey === '' ? null : Number(companyKey),
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
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>Edit {row.sales_team_name}</h2>
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
          <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} required />
        </div>
        <div title={OVERLAY_CAVEAT}>
          <TextInput label="Code" value={teamCode} onChange={(e) => setTeamCode(e.target.value)} disabled={submitting} required helperText="Must be unique across teams." />
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

function BulkSegmentBar({
  count,
  segments,
  onApply,
  onClear,
}: {
  count: number;
  segments: DimOption[];
  onApply: (segmentKeyOverride: number | null) => void;
  onClear: () => void;
}) {
  const [segmentKey, setSegmentKey] = useState('');

  return (
    <Card>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <strong style={{ fontSize: 13 }}>{count} selected</strong>
        <div style={{ minWidth: 200 }}>
          <select value={segmentKey} onChange={(e) => setSegmentKey(e.target.value)} style={selectStyle}>
            <option value="">Set Customer Group to…</option>
            {segments.map((s) => (
              <option key={String(s.segment_key)} value={String(s.segment_key)}>
                {String(s.segment_name)}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={() => onApply(segmentKey === '' ? null : Number(segmentKey))} disabled={!segmentKey}>
          Apply to {count} selected
        </Button>
        <Button variant="secondary" onClick={onClear}>
          Clear selection
        </Button>
      </div>
    </Card>
  );
}

/** Company Link + Cascading Filter Bar, 2026-09 -- mirrors BulkSegmentBar exactly, hitting the
 * separate POST /admin/salesteams/bulk-company route instead. */
function BulkCompanyBar({
  count,
  companies,
  onApply,
  onClear,
}: {
  count: number;
  companies: DimOption[];
  onApply: (companyKeyOverride: number | null) => void;
  onClear: () => void;
}) {
  const [companyKey, setCompanyKey] = useState('');

  return (
    <Card>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} title={COMPANY_CAVEAT}>
        <strong style={{ fontSize: 13 }}>{count} selected</strong>
        <div style={{ minWidth: 200 }}>
          <select value={companyKey} onChange={(e) => setCompanyKey(e.target.value)} style={selectStyle}>
            <option value="">Set Company to…</option>
            {companies.map((c) => (
              <option key={String(c.company_key)} value={String(c.company_key)}>
                {String(c.company_name)}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={() => onApply(companyKey === '' ? null : Number(companyKey))} disabled={!companyKey}>
          Apply to {count} selected
        </Button>
        <Button variant="secondary" onClick={onClear}>
          Clear selection
        </Button>
      </div>
    </Card>
  );
}
