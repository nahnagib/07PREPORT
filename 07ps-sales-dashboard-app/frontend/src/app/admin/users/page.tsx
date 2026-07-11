'use client';
import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, SemanticBadge, TextInput, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi, AdminRole, AdminUser, UserStatus, ApiError } from '../../../lib/api';

const STATUS_TO_SEMANTIC: Record<UserStatus, 'success' | 'watch' | 'alert' | 'neutral'> = {
  ACTIVE: 'success',
  PENDING_PASSWORD_CHANGE: 'watch',
  LOCKED: 'alert',
  INACTIVE: 'neutral',
};
const STATUS_LABEL: Record<UserStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  LOCKED: 'Locked',
  PENDING_PASSWORD_CHANGE: 'Pending Password Change',
};

function StatusPill({ status }: { status: UserStatus }) {
  const semantic = STATUS_TO_SEMANTIC[status];
  const colorVar =
    semantic === 'success'
      ? 'var(--ps-color-success)'
      : semantic === 'watch'
        ? 'var(--ps-color-watch)'
        : semantic === 'alert'
          ? 'var(--ps-color-alert)'
          : 'var(--ps-color-neutral-text)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: colorVar,
        border: `1px solid ${colorVar}`,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: colorVar, flexShrink: 0 }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function AdminUsersPage() {
  return (
    <PermissionGuard pageKey="admin_users">
      <AdminLayout title="User Management">
        <UsersPageBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function UsersPageBody() {
  const { token } = useAuth();
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<UserStatus | ''>('');
  const [showCreate, setShowCreate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    Promise.all([
      adminApi.listUsers(token, { search: search || undefined, status: statusFilter || undefined, pageSize: 100 }),
      roles.length ? Promise.resolve(roles) : adminApi.listRoles(token),
    ])
      .then(([usersRes, rolesRes]) => {
        setRows(usersRes.rows);
        setTotal(usersRes.total);
        setRoles(rolesRes);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load users.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(userId: number, action: () => Promise<unknown>) {
    setActionBusy(userId);
    setActionError(null);
    try {
      await action();
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setActionBusy(null);
    }
  }

  const columns: Column<AdminUser>[] = [
    { key: 'display_name', header: 'Full Name', render: (r) => <Link href={`/admin/users/${r.user_id}`}>{r.display_name}</Link> },
    { key: 'email', header: 'Email' },
    { key: 'role_label', header: 'Role', render: (r) => r.role_label ?? '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    {
      key: 'last_login_at',
      header: 'Last Login',
      render: (r) => (r.last_login_at ? new Date(r.last_login_at).toLocaleString() : 'Never'),
    },
    {
      key: 'user_id',
      header: 'Actions',
      render: (r) => {
        const busy = actionBusy === r.user_id;
        return (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {r.status !== 'ACTIVE' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => runAction(r.user_id, () => adminApi.setStatus(token as string, r.user_id, 'ACTIVE'))}
                style={{ padding: '4px 8px', fontSize: 12 }}
              >
                Activate
              </Button>
            )}
            {r.status !== 'LOCKED' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => runAction(r.user_id, () => adminApi.setStatus(token as string, r.user_id, 'LOCKED'))}
                style={{ padding: '4px 8px', fontSize: 12 }}
              >
                Lock
              </Button>
            )}
            {r.status !== 'INACTIVE' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => runAction(r.user_id, () => adminApi.setStatus(token as string, r.user_id, 'INACTIVE'))}
                style={{ padding: '4px 8px', fontSize: 12 }}
              >
                Disable
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => runAction(r.user_id, () => adminApi.revokeSessions(token as string, r.user_id))}
              style={{ padding: '4px 8px', fontSize: 12 }}
            >
              Revoke Sessions
            </Button>
            <Link href={`/admin/users/${r.user_id}`} style={{ fontSize: 12, alignSelf: 'center', color: 'var(--ps-color-accent)' }}>
              Details
            </Link>
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 220 }}>
            <TextInput label="Search" placeholder="Name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div style={{ minWidth: 200 }}>
            <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as UserStatus | '')}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--ps-color-border)',
                background: 'var(--ps-color-surface)',
                color: 'var(--ps-color-text)',
                fontSize: 14,
              }}
            >
              <option value="">All</option>
              {(Object.keys(STATUS_LABEL) as UserStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/admin/users/import">
            <Button variant="secondary">Import from Excel</Button>
          </Link>
          <Button onClick={() => setShowCreate((s) => !s)}>{showCreate ? 'Cancel' : 'Create User'}</Button>
        </div>
      </div>

      {showCreate && (
        <CreateUserPanel
          roles={roles}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {actionError && <ErrorState message={actionError} onRetry={() => setActionError(null)} />}

      <Card>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{total} user(s)</div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No users match these filters." />
        ) : (
          <DataTable columns={columns} rows={rows} getRowId={(r) => String(r.user_id)} />
        )}
      </Card>
    </div>
  );
}

function CreateUserPanel({ roles, onCreated }: { roles: AdminRole[]; onCreated: () => void }) {
  const { token } = useAuth();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState<number | ''>('');
  const [salespersonKey, setSalespersonKey] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; tempPassword: string } | null>(null);

  const selectedRole = roles.find((r) => r.role_id === roleId);
  const isSalesperson = selectedRole?.role_name === 'SALESPERSON';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !roleId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminApi.createUser(token, {
        fullName,
        email,
        roleId: Number(roleId),
        tempPassword: tempPassword || undefined,
        salespersonKey: isSalesperson && salespersonKey ? Number(salespersonKey) : null,
      });
      setResult({ email: res.user.email, tempPassword: res.tempPassword });
      setFullName('');
      setEmail('');
      setRoleId('');
      setSalespersonKey('');
      setTempPassword('');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create user.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Create User</h2>
      {result && (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: 'var(--ps-color-success-bg)',
            border: '1px solid var(--ps-color-success-border)',
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          Created <strong>{result.email}</strong>. Temporary password: <code>{result.tempPassword}</code>
          {' '}(also emailed if SMTP is configured). They must change it on first login.
        </div>
      )}
      <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <TextInput label="Full Name" value={fullName} onChange={(e) => setFullName(e.target.value)} required disabled={submitting} />
        <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={submitting} />
        <div>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Role
          </label>
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : '')}
            required
            disabled={submitting}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14, boxSizing: 'border-box' }}
          >
            <option value="">Select a role</option>
            {roles.map((r) => (
              <option key={r.role_id} value={r.role_id}>
                {r.role_label}
              </option>
            ))}
          </select>
        </div>
        {isSalesperson && (
          <TextInput
            label="Salesperson Key"
            value={salespersonKey}
            onChange={(e) => setSalespersonKey(e.target.value)}
            helperText="The Dim_Salesperson key this user's data is locked to."
            disabled={submitting}
          />
        )}
        <TextInput
          label="Temporary Password"
          value={tempPassword}
          onChange={(e) => setTempPassword(e.target.value)}
          helperText="Leave blank to auto-generate."
          disabled={submitting}
        />
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create User'}
          </Button>
        </div>
      </form>
      {error && <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: 8 }}>{error}</p>}
    </Card>
  );
}
