'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, Select, type Column } from '@07ps/ui';
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
  PermissionAction,
  SalespersonOption,
  UserPermissionOverrides,
} from '../../../../lib/api';

const ACTION_LABEL: Record<PermissionAction, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', export: 'Export' };
const ACTIONS: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'export'];
const FLAG = { view: 'canView', create: 'canCreate', edit: 'canEdit', delete: 'canDelete', export: 'canExport' } as const;

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
  const { token, registry, canEdit } = useAuth();
  const mayEdit = canEdit('admin_users');

  const [user, setUser] = useState<AdminUser | null>(null);
  const [permissions, setPermissions] = useState<EffectivePermissions>({});
  const [overrides, setOverrides] = useState<UserPermissionOverrides>({});
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [primaryRoleId, setPrimaryRoleId] = useState<string>('');
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [history, setHistory] = useState<LoginHistoryRow[]>([]);
  const [salespersonOptions, setSalespersonOptions] = useState<SalespersonOption[]>([]);
  const [salespersonKey, setSalespersonKey] = useState('');
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
        setOverrides(detail.overrides ?? {});
        setRoleIds((detail.user.roles ?? []).map((r) => String(r.role_id)));
        setPrimaryRoleId(detail.user.role_id === null ? '' : String(detail.user.role_id));
        setRoles(rolesRes);
        setHistory(historyRes.rows);
        setSalespersonKey(detail.user.salesperson_key === null ? '' : String(detail.user.salesperson_key));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load user.'))
      .finally(() => setLoading(false));
  }, [token, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const isSalesperson = user?.role_name === 'SALESPERSON';

  // Loaded lazily, same as the Create User panel -- only fetched for a user who actually has (or
  // is being given) the Salesperson role.
  useEffect(() => {
    if (!token || !isSalesperson || salespersonOptions.length > 0) return;
    adminApi.getSalespersonOptions(token).then(setSalespersonOptions).catch(() => setSalespersonOptions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isSalesperson]);

  async function handleSaveSalesperson() {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      await adminApi.updateUser(token, userId, { salespersonKey: salespersonKey === '' ? null : Number(salespersonKey) });
      setNotice('Salesperson link updated.');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update salesperson link.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveRoles() {
    if (!token || roleIds.length === 0) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const primary = roleIds.includes(primaryRoleId) ? Number(primaryRoleId) : Number(roleIds[0]);
      await adminApi.setUserRoles(token, userId, roleIds.map(Number), primary);
      setNotice('Roles updated. The user gets the new permissions on their next page load.');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update roles.');
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

  async function handlePermissionChange(changes: { pageKey: string; action: PermissionAction; allowed: boolean | null }[]) {
    if (!token) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await adminApi.updatePermissions(token, userId, changes);
      setPermissions(res.permissions);
      setOverrides(res.overrides ?? {});
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 260, maxWidth: 360 }}>
            <Select
              label="Roles"
              multiSelect
              options={roles.map((r) => ({ value: String(r.role_id), label: r.role_label }))}
              value={roleIds}
              onChange={setRoleIds}
              disabled={busy || !mayEdit}
              placeholder="Select one or more roles"
            />
            <div>
              <label className="ps-admin-label" htmlFor="primary-role">
                Primary role (data scope)
              </label>
              <select
                id="primary-role"
                className="ps-admin-select"
                value={roleIds.includes(primaryRoleId) ? primaryRoleId : roleIds[0] ?? ''}
                onChange={(e) => setPrimaryRoleId(e.target.value)}
                disabled={busy || !mayEdit || roleIds.length === 0}
              >
                {roleIds.map((id) => (
                  <option key={id} value={id}>
                    {roles.find((r) => String(r.role_id) === id)?.role_label ?? id}
                  </option>
                ))}
              </select>
            </div>
            {mayEdit && (
              <Button disabled={busy || roleIds.length === 0} onClick={handleSaveRoles}>
                Save roles
              </Button>
            )}
          </div>
        </div>

        {mayEdit && (
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
        )}
      </Card>

      {isSalesperson && (
        <Card>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>Linked Salesperson</h3>
          <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '0 0 12px' }}>
            This user&apos;s dashboard data is locked to whichever salesperson is selected here. Changes are recorded in an
            audit trail.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ minWidth: 260 }}>
              <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
                Salesperson
              </label>
              <select
                value={salespersonKey}
                onChange={(e) => setSalespersonKey(e.target.value)}
                disabled={busy}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14, boxSizing: 'border-box' }}
              >
                <option value="">Unlinked</option>
                {salespersonOptions.map((sp) => (
                  <option key={sp.salesperson_key} value={sp.salesperson_key}>
                    {sp.salesperson_name}
                    {sp.sales_team_name ? ` — ${sp.sales_team_name}` : ''}
                    {sp.distribution_channel ? ` (${sp.distribution_channel})` : ''}
                  </option>
                ))}
              </select>
            </div>
            {mayEdit && (
              <Button disabled={busy} onClick={handleSaveSalesperson}>
                Save
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Effective Permissions &amp; Overrides</h3>
        <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '0 0 12px' }}>
          Checked = the user has it, from any of their roles. Changing a box saves a personal override (marked •), which wins
          over every role; &quot;Reset&quot; returns the row to the roles&apos; defaults.
        </p>
        <div style={{ overflowX: 'auto', border: '1px solid var(--ps-color-border)', borderRadius: 'var(--ps-card-radius-sm, 10px)' }}>
          <table className="ps-perm-matrix">
            <thead>
              <tr>
                <th style={{ textAlign: 'start' }}>Page / module</th>
                {ACTIONS.map((a) => (
                  <th key={a}>{ACTION_LABEL[a]}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {registry.map((entry) => {
                const perm = permissions[entry.key];
                const rowOverrides = overrides[entry.key] ?? {};
                const hasOverride = Object.keys(rowOverrides).length > 0;
                return (
                  <tr key={entry.key} className="ps-datatable-row">
                    <th scope="row" style={{ textAlign: 'start', fontWeight: 500 }}>
                      {entry.label}
                      {entry.group === 'admin' && <span style={{ marginInlineStart: 6, fontSize: 11, color: 'var(--ps-color-muted-text)' }}>(Admin)</span>}
                    </th>
                    {ACTIONS.map((a) => (
                      <td key={a}>
                        {entry.actions.includes(a) ? (
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <input
                              type="checkbox"
                              aria-label={`${ACTION_LABEL[a]}: ${entry.label}`}
                              checked={Boolean(perm?.[FLAG[a]])}
                              disabled={busy || !mayEdit || user.role_name === 'ADMIN'}
                              onChange={(e) => handlePermissionChange([{ pageKey: entry.key, action: a, allowed: e.target.checked }])}
                            />
                            {rowOverrides[a] !== undefined && (
                              <span title="Personal override" style={{ color: 'var(--ps-color-accent)', fontWeight: 700 }}>
                                •
                              </span>
                            )}
                          </label>
                        ) : (
                          <span aria-hidden style={{ color: 'var(--ps-color-border)' }}>
                            —
                          </span>
                        )}
                      </td>
                    ))}
                    <td>
                      {mayEdit && hasOverride && (
                        <button
                          type="button"
                          className="ps-cn-export-btn"
                          disabled={busy}
                          onClick={() =>
                            handlePermissionChange(
                              (Object.keys(rowOverrides) as PermissionAction[]).map((action) => ({ pageKey: entry.key, action, allowed: null })),
                            )
                          }
                        >
                          Reset
                        </button>
                      )}
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
