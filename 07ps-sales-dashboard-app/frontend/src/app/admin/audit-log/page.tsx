'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Card, DataTable, EmptyState, ErrorState, LoadingSkeleton, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { AdminOnlyGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { APP_TIMEZONE } from '../../../lib/format';
import { adminApi, ApiError, AuditLogRow } from '../../../lib/api';

const ETL_INPUT_FILE = 'etl_input_file';

const ENTITY_LABEL: Record<string, string> = {
  [ETL_INPUT_FILE]: 'ETL input file upload',
};

/**
 * Admin-role-only view of audit_log -- who changed what, and when. Defaults to the ETL input-file
 * uploads made from the ETL Control Center; other entity types (e.g. MARCOM uploads) are one filter
 * away. Gated on the Admin role directly, like the ETL Control Center (backend: requireAdminRole).
 */
export default function AdminAuditLogPage() {
  return (
    <AdminOnlyGuard>
      <AdminLayout title="Audit Log">
        <AuditLogBody />
      </AdminLayout>
    </AdminOnlyGuard>
  );
}

function formatBytes(n: unknown): string {
  if (typeof n !== 'number') return '';
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** One-line human summary of an entry; the raw JSON is always available underneath. */
function summarize(row: AuditLogRow): string {
  const after = (row.after_value ?? {}) as Record<string, unknown>;
  if (row.entity_type === ETL_INPUT_FILE) {
    const counts = after.rowCounts as Record<string, number> | undefined;
    const parts = [
      after.uploadedFilename ? `from "${String(after.uploadedFilename)}"` : null,
      formatBytes(after.size_bytes),
      counts ? Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ') : null,
      after.backupPath ? `backup: ${String(after.backupPath)}` : 'no previous file',
    ];
    return parts.filter(Boolean).join(' · ');
  }
  if (typeof after.event === 'string') return after.event;
  return '';
}

function AuditLogBody() {
  const { token } = useAuth();
  const [entityTypes, setEntityTypes] = useState<string[]>([ETL_INPUT_FILE]);
  const [entityType, setEntityType] = useState(ETL_INPUT_FILE);
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const pageSize = 25;

  useEffect(() => {
    if (!token) return;
    adminApi
      .listAuditEntityTypes(token)
      .then((res) => setEntityTypes(Array.from(new Set([ETL_INPUT_FILE, ...res.entityTypes]))))
      .catch(() => {});
  }, [token]);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    adminApi
      .listAuditLog(token, { entityType: entityType || undefined, page, pageSize })
      .then((res) => {
        setRows(res.rows);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the audit log.'))
      .finally(() => setLoading(false));
  }, [token, entityType, page]);

  useEffect(() => {
    load();
  }, [load]);

  const columns: Column<AuditLogRow>[] = [
    {
      key: 'changed_at',
      header: 'When',
      render: (r) => new Date(r.changed_at).toLocaleString(undefined, { timeZone: APP_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' }),
    },
    { key: 'changed_by_name', header: 'Who', render: (r) => r.changed_by_name ?? r.changed_by_email ?? (r.changed_by ? `User #${r.changed_by}` : '—') },
    { key: 'entity_type', header: 'Type', render: (r) => ENTITY_LABEL[r.entity_type] ?? r.entity_type },
    { key: 'entity_id', header: 'Item' },
    { key: 'action', header: 'Action' },
    {
      key: 'after_value',
      header: 'Details',
      render: (r) => (
        <div style={{ maxWidth: 520 }}>
          <div>{summarize(r)}</div>
          {openId === r.audit_id && (
            <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0 0' }}>
              {JSON.stringify({ before: r.before_value, after: r.after_value }, null, 2)}
            </pre>
          )}
        </div>
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pagerButton = (disabled: boolean): React.CSSProperties => ({
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid var(--ps-color-border)',
    background: 'var(--ps-color-surface)',
    cursor: disabled ? 'not-allowed' : 'pointer',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <div style={{ minWidth: 240 }}>
          <label htmlFor="audit-entity-type" style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
            Activity type
          </label>
          <select
            id="audit-entity-type"
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              setPage(1);
            }}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14 }}
          >
            <option value="">All activity</option>
            {entityTypes.map((t) => (
              <option key={t} value={t}>
                {ENTITY_LABEL[t] ?? t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Card>
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
          {total} entr{total === 1 ? 'y' : 'ies'} · Page {page} of {totalPages} · click a row for the full before/after record
        </div>
        {loading ? (
          <LoadingSkeleton variant="kpi" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rows.length === 0 ? (
          <EmptyState message="No audit entries match this filter yet." />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              getRowId={(r) => String(r.audit_id)}
              onRowClick={(r) => setOpenId((cur) => (cur === r.audit_id ? null : r.audit_id))}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={pagerButton(page <= 1)}>
                Previous
              </button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={pagerButton(page >= totalPages)}>
                Next
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
