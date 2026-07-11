'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import {
  adminApi,
  AdminRole,
  AdminUser,
  ApiError,
  EffectivePermissions,
  LoginHistoryRow,
} from '../../../../lib/api';

const PAGE_KEYS = [
  { key: 'tachometer', label: 'Tachometer' },
  { key: 'critical_number', label: 'Critical Number' },
  { key: 'revenue_trend', label: 'Revenue Trend' },
  { key: 'invoices_engine', label: 'Invoices Engine' },
  { key: 'customer_growth', label: 'Customer Growth' },
  { key: 'admin_users', label: 'User Management' },
  { key: 'admin_roles', label: 'Role & Permissions' },
  { key: 'admin_login_history', label: 'Login History' },
];

export default function AdminUserDetailPage() {
  return (
    <PermissionGuard pageKey="admin_users">
      <AdminLayout title="User Details">
        <UserDetailBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function UserDetailBody() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const userId = Number(params.id);
  const { token } = useAuth();

  const [user, setUser] = useState<AdminUser | null>(null);
  const [permissions, setPermissions] = useState<EffectivePermissions>({});
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [history, setHistory] = useState<LoginHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!token || !userId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      adminApi.getUser(token, userId),
      adminApi.listRoles(token),
      adminApi.userLoginHistory(token, userId, 1, 20),
    ])
      .then(([detail, rolesRes, historyRes]) => {
        setUser(detail.user);
        setPermissions(detail.permissions);
        setRoles(rolesRes);
        setHistory(historyRes.rows);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load user.'))
      .finally(() => setLoading(false));
  }, [token, userId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleChangeRole(nextRoleId: number) {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      await adminApi.changeRole(token, userId, nextRoleId);
      setNotice('Role updated.');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change role.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword() {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await adminApi.resetPassword(token, userId);
      setNotice(`Password reset. Temporary password: ${res.tempPassword} (also emailed if SMTP is configured).`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset password.');
    } finally {
      setBusy(false);
    }
  }

  async function handleForcePasswordChange() {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      await adminApi.forcePasswordChange(token, userId);
      setNotice('User will be required to change their password on next login.');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to set force-password-change.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeSessions() {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      await adminApi.revokeSessions(token, userId);
      setNotice('All active sessions for this user have been revoked.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke sessions.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePermissionToggle(pageKey: string, action: 'view' | 'export', nextAllowed: boolean | null) {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await adminApi.updatePermissions(token, userId, [{ pageKey, action, allowed: nextAllowed }]);
      setPermissions(res.permissions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update permission.');
    } finally {
      setBusy(false);
    }
  }

  const historyColumns: Column<LoginHistoryRow>[] = [
    { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
    { key: 'event_type', header: 'Event' },
    { key: 'ip_address', header: 'IP', render: (r) => r.ip_address ?? '—' },
  ];

  if (loading) return <LoadingSkeleton variant="kpi" />;
  if (error && !user) return <ErrorState message={error} onRetry={load} />;
  if (!user) return <EmptyState message="User not found." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <Link href="/admin/users" style={{ fontSize: 13, color: 'var(--ps-color-accent)' }}>
        ← Back to User Management
      </Link>

      {notice && (
        <div style={{ padding: 12, borderRadius: 8, background: 'var(--ps-color-success-bg)', border: '1px solid var(--ps-color-success-border)', fontSize: 13 }}>
          {notice}
        </div>
      )}
      {error && <ErrorState message={error} onRetry={() => setError(null)} />}

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>{user.display_name}</h2>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{user.email}</p>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
              Status: {user.status} · Must change password: {user.must_change_password ? 'Yes' : 'No'} · Last login:{' '}
              {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'Never'}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
              Created: {new Date(user.created_at).toLocaleString()} · Updated: {new Date(user.updated_at).toLocaleString()}
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
            <label style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--ps-color-muted-text)' }}>Role</label>
            <select
              value={user.role_id ?? ''}
              disabled={busy}
              onChange={(e) => e.target.value && handleChangeRole(Number(e.target.value))}
              style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14 }}
            >
              {roles.map((r) => (
                <option key={r.role_id} value={r.role_id}>
                  {r.role_label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          <Button variant="secondary" disabled={busy} onClick={handleResetPassword}>
            Reset Password
          </Button>
          <Button variant="secondary" disabled={busy} onClick={handleForcePasswordChange}>
            Force Password Change
          </Button>
          <Button variant="secondary" disabled={busy} onClick={handleRevokeSessions}>
            Revoke Sessions
          </Button>
        </div>
      </Card>

      <Card>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Permission Overrides</h3>
        <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '0 0 12px' }}>
          Overrides here take precedence over this user&apos;s role defaults. Use &quot;Reset to role default&quot; to remove an override.
        </p>
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
              {PAGE_KEYS.map((p) => {
                const perm = permissions[p.key] ?? { canView: false, canExport: false };
                return (
                  <tr key={p.key}>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--ps-color-border)' }}>{p.label}</td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--ps-color-border)', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={perm.canView}
                        disabled={busy}
                        onChange={(e) => handlePermissionToggle(p.key, 'view', e.target.checked)}
                      />
                    </td>
                    <td style={{ padding: '6px 10px', borderBottom: '1px solid var(--ps-color-border)', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={perm.canExport}
                        disabled={busy}
                        onChange={(e) => handlePermissionToggle(p.key, 'export', e.target.checked)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Recent Login History</h3>
        {history.length === 0 ? (
          <EmptyState message="No login history for this user yet." />
        ) : (
          <DataTable columns={historyColumns} rows={history} getRowId={(r) => String(r.id)} />
        )}
      </Card>
    </div>
  );
}
