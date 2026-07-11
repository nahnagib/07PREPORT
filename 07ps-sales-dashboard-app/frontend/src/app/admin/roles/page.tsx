'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Card, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi, ApiError, RolePermissionMatrix } from '../../../lib/api';

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
  const { token } = useAuth();
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
        </Card>
      ))}
    </div>
  );
}
