'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Card, EmptyState, ErrorState, LoadingSkeleton, Select } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { useFilterOptions } from '../../../lib/hooks';
import { adminApi, ApiError, DataScopeRule, DimOption, RoleMatrixRow, RolePermissionMatrix } from '../../../lib/api';

/** Which useFilterOptions() field + DimOption key/label fields back each data-scope dimension's
 * value picker -- same 5 value-list endpoints FilterBar already uses, so the picker only ever
 * offers real, existing values (no separate value-list logic invented here). */
const DIMENSION_OPTION_FIELDS: Record<string, { key: string; label: string }> = {
  companyKeys: { key: 'company_key', label: 'company_name' },
  segmentKeys: { key: 'segment_key', label: 'segment_name' },
  channelKeys: { key: 'channel_key', label: 'channel_name' },
  salesTeamKeys: { key: 'sales_team_key', label: 'sales_team_name' },
  salespersonKeys: { key: 'salesperson_key', label: 'salesperson_name' },
};

export default function AdminRolesPage() {
  return (
    <PermissionGuard pageKey="admin_roles">
      <AdminLayout title="Role & Permission Management">
        <RolesBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function RolesBody() {
  const { token, error: authError, retryAuth } = useAuth();
  const filterOptions = useFilterOptions(token, authError, retryAuth);
  const dimensionOptions: Record<string, DimOption[]> = {
    companyKeys: filterOptions.businessUnits.data ?? [],
    segmentKeys: filterOptions.customerGroups.data ?? [],
    channelKeys: filterOptions.distributionChannels.data ?? [],
    salesTeamKeys: filterOptions.branches.data ?? [],
    salespersonKeys: filterOptions.salespersons.data ?? [],
  };
  const [matrix, setMatrix] = useState<RolePermissionMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    adminApi
      .getRoleMatrix(token)
      .then(setMatrix)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load roles.'))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(roleId: number, pageKey: string, action: 'view' | 'export', nextAllowed: boolean) {
    if (!token) return;
    const cellKey = `${roleId}-${pageKey}-${action}`;
    setBusyKey(cellKey);
    setError(null);
    try {
      const updated = await adminApi.setRolePermission(token, roleId, pageKey, action, nextAllowed);
      setMatrix(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update permission.');
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) return <LoadingSkeleton variant="kpi" />;
  if (error && !matrix) return <ErrorState message={error} onRetry={load} />;
  if (!matrix) return <EmptyState message="No roles configured." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', margin: 0 }}>
        Default View/Export permissions per role. These are defaults only -- an individual user&apos;s permissions
        can still be overridden on their User Details page.
      </p>
      {error && <ErrorState message={error} onRetry={() => setError(null)} />}

      {matrix.roles.map((role) => (
        <Card key={role.role_id}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>{role.role_label}</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '2px solid var(--ps-color-border)' }}>Page</th>
                  <th style={{ textAlign: 'center', padding: '6px 10px', borderBottom: '2px solid var(--ps-color-border)' }}>View</th>
                  <th style={{ textAlign: 'center', padding: '6px 10px', borderBottom: '2px solid var(--ps-color-border)' }}>Export</th>
                </tr>
              </thead>
              <tbody>
                {matrix.pages.map((page) => {
                  const cell = matrix.matrix[role.role_id]?.[page.page_key] ?? { canView: false, canExport: false };
                  return (
                    <tr key={page.page_id}>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--ps-color-border)' }}>
                        {page.page_label}
                        {page.nav_group === 'Administration' && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--ps-color-muted-text)' }}>(Admin)</span>
                        )}
                      </td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--ps-color-border)', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={cell.canView}
                          disabled={busyKey === `${role.role_id}-${page.page_key}-view`}
                          onChange={(e) => toggle(role.role_id, page.page_key, 'view', e.target.checked)}
                        />
                      </td>
                      <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--ps-color-border)', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={cell.canExport}
                          disabled={busyKey === `${role.role_id}-${page.page_key}-export`}
                          onChange={(e) => toggle(role.role_id, page.page_key, 'export', e.target.checked)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <DataScopeSection
            role={role}
            rules={matrix.dataScope[role.role_id] ?? []}
            dimensions={matrix.dimensions}
            dimensionOptions={dimensionOptions}
            token={token as string}
            onChange={setMatrix}
          />
        </Card>
      ))}
    </div>
  );
}

/**
 * Per-role row-level data scope: separate from the page View/Export table above. Removable chips
 * for existing rules, plus a dimension+value picker to add more. Empty (no rules) means the role
 * is unrestricted -- today's behavior, unchanged.
 */
function DataScopeSection({
  role,
  rules,
  dimensions,
  dimensionOptions,
  token,
  onChange,
}: {
  role: RoleMatrixRow;
  rules: DataScopeRule[];
  dimensions: RolePermissionMatrix['dimensions'];
  dimensionOptions: Record<string, DimOption[]>;
  token: string;
  onChange: (matrix: RolePermissionMatrix) => void;
}) {
  const [dimension, setDimension] = useState(dimensions[0]?.key ?? '');
  const [value, setValue] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = DIMENSION_OPTION_FIELDS[dimension];
  const valueOptions = (dimensionOptions[dimension] ?? []).map((opt) => ({
    value: String(opt[fields?.key ?? '']),
    label: String(opt[fields?.label ?? '']),
  }));

  async function addRule() {
    if (!dimension || value.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await adminApi.addRoleDataScope(token, role.role_id, dimension, value[0]);
      onChange(updated);
      setValue([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add rule.');
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(scopeId: number) {
    setBusy(true);
    setError(null);
    try {
      const updated = await adminApi.removeRoleDataScope(token, role.role_id, scopeId);
      onChange(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove rule.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--ps-color-border)' }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Data Scope</div>
      <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: '0 0 10px' }}>
        Restricts every page&apos;s data (charts, tables, KPIs, exports) to the rules below, regardless of which page
        is viewed. No rules means this role sees all data.
      </p>

      {rules.length === 0 ? (
        <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '0 0 10px', fontStyle: 'italic' }}>
          No data scope restrictions -- this role sees all data.
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          {rules.map((rule) => {
            const dimLabel = dimensions.find((d) => d.key === rule.dimension)?.label ?? rule.dimension;
            return (
              <span
                key={rule.scopeId}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '3px 8px',
                  borderRadius: 999,
                  border: '1px solid var(--ps-color-border)',
                  background: 'var(--ps-color-muted-bg)',
                  color: 'var(--ps-color-text)',
                }}
              >
                {dimLabel}: {rule.label}
                <button
                  type="button"
                  onClick={() => removeRule(rule.scopeId)}
                  disabled={busy}
                  aria-label={`Remove ${dimLabel}: ${rule.label}`}
                  style={{
                    border: 'none',
                    background: 'none',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    color: 'var(--ps-color-muted-text)',
                    padding: 0,
                    lineHeight: 1,
                    fontSize: 14,
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 180 }}>
          <Select
            label="Dimension"
            options={dimensions.map((d) => ({ value: d.key, label: d.label }))}
            value={dimension ? [dimension] : []}
            onChange={(v) => {
              setDimension(v[0] ?? '');
              setValue([]);
            }}
            placeholder="Choose a dimension"
          />
        </div>
        <div style={{ minWidth: 200 }}>
          <Select
            label="Value"
            options={valueOptions}
            value={value}
            onChange={setValue}
            searchable
            disabled={!dimension}
            placeholder="Choose a value"
          />
        </div>
        <button
          type="button"
          onClick={addRule}
          disabled={busy || value.length === 0}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            padding: '7px 12px',
            borderRadius: 6,
            border: '1px solid var(--ps-color-border)',
            background: value.length === 0 || busy ? 'var(--ps-color-muted-bg)' : 'var(--ps-color-accent-bg)',
            color: value.length === 0 || busy ? 'var(--ps-color-muted-text)' : 'var(--ps-color-accent)',
            cursor: busy || value.length === 0 ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Add rule
        </button>
      </div>
      {error && <p style={{ fontSize: 12, color: 'var(--ps-color-alert)', margin: '8px 0 0' }}>{error}</p>}
    </div>
  );
}
