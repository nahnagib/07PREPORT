'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { adminApi, ApiError, LoginHistoryRow } from '../../../lib/api';

const EVENT_TYPES = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED_PASSWORD',
  'LOGIN_FAILED_LOCKED',
  'LOGIN_FAILED_INACTIVE',
  'LOGOUT',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_RESET_COMPLETED',
  'PASSWORD_CHANGED',
  'FORCE_PASSWORD_CHANGE_SET',
  'ACCOUNT_LOCKED_AUTO',
  'ACCOUNT_STATUS_CHANGED',
  'SESSIONS_REVOKED',
];

export default function AdminLoginHistoryPage() {
  return (
    <PermissionGuard pageKey="admin_login_history">
      <AdminLayout title="Login History">
        <LoginHistoryBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function LoginHistoryBody() {
  const { token } = useAuth();
  const [rows, setRows] = useState<LoginHistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [eventType, setEventType] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pageSize = 50;

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    adminApi
      .listLoginHistory(token, { eventType: eventType || undefined, page, pageSize })
      .then((res) => {
        setRows(res.rows);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load login history.'))
      .finally(() => setLoading(false));
  }, [token, eventType, page]);

  useEffect(() => {
    load();
  }, [load]);

  const columns: Column<LoginHistoryRow>[] = [
    { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
    { key: 'display_name', header: 'User', render: (r) => r.display_name ?? r.email_attempted },
    { key: 'event_type', header: 'Event' },
    { key: 'ip_address', header: 'IP', render: (r) => r.ip_address ?? '—' },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <div style={{ minWidth: 240 }}>
          <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Event Type
          </label>
          <select
            value={eventType}
            onChange={(e) => {
              setEventType(e.target.value);
              setPage(1);
            }}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14 }}
          >
            <option value="">All events</option>
            {EVENT_TYPES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Card>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
          {total} event(s) · Page {page} of {totalPages}
        </div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No login history matches these filters." />
        ) : (
          <>
            <DataTable columns={columns} rows={rows} getRowId={(r) => String(r.id)} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', cursor: page >= totalPages ? 'not-allowed' : 'pointer' }}
              >
                Next
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
