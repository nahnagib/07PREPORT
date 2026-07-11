'use client';
import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Card, DataTable, EmptyState, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import { adminApi, ApiError, ImportResult, ImportRowError, ImportRowSuccess } from '../../../../lib/api';

export default function AdminImportPage() {
  return (
    <PermissionGuard pageKey="admin_users">
      <AdminLayout title="Excel Import">
        <ImportBody />
      </AdminLayout>
    </PermissionGuard>
  );
}

function ImportBody() {
  const { token } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  // The template endpoint is behind requireAuth like every other admin route -- a plain <a href>
  // wouldn't send the Bearer token, so fetch it with auth and trigger the download from a blob.
  async function handleDownloadTemplate() {
    if (!token) return;
    const res = await fetch(adminApi.downloadImportTemplateUrl(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      setError('Failed to download template.');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'user-import-template.xlsx';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !file) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await adminApi.importUsers(token, file);
      setResult(res);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed.');
    } finally {
      setSubmitting(false);
    }
  }

  const createdColumns: Column<ImportRowSuccess>[] = [
    { key: 'rowNumber', header: 'Row' },
    { key: 'fullName', header: 'Full Name' },
    { key: 'email', header: 'Email' },
    { key: 'role', header: 'Role' },
  ];
  const errorColumns: Column<ImportRowError>[] = [
    { key: 'rowNumber', header: 'Row' },
    { key: 'email', header: 'Email' },
    { key: 'errors', header: 'Errors', render: (r) => r.errors.join('; ') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <Link href="/admin/users" style={{ fontSize: 13, color: 'var(--ps-color-accent)' }}>
        ← Back to User Management
      </Link>

      <Card>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 8px' }}>Bulk Import Users from Excel</h2>
        <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', margin: '0 0 16px' }}>
          Upload an .xlsx file with columns: <strong>Full Name</strong>, <strong>Email</strong>, <strong>Role</strong>{' '}
          (required), and optional <strong>Temporary Password</strong>, <strong>Status</strong>, <strong>Salesperson Key</strong>.
          Every created account starts with must-change-password enabled. Invalid rows are reported below instead of
          being imported.
        </p>
        <button
          type="button"
          onClick={handleDownloadTemplate}
          style={{ border: 'none', background: 'none', padding: 0, fontSize: 13, color: 'var(--ps-color-accent)', cursor: 'pointer', textDecoration: 'underline' }}
        >
          Download a blank template (.xlsx)
        </button>

        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={submitting}
          />
          <Button type="submit" disabled={submitting || !file}>
            {submitting ? 'Importing...' : 'Import'}
          </Button>
        </form>
        {error && <p style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: 12 }}>{error}</p>}
      </Card>

      {result && (
        <>
          <Card>
            <div style={{ display: 'flex', gap: 24, fontSize: 14 }}>
              <span>Total rows: <strong>{result.totalRows}</strong></span>
              <span style={{ color: 'var(--ps-color-success)' }}>Created: <strong>{result.createdCount}</strong></span>
              <span style={{ color: 'var(--ps-color-alert)' }}>Errors: <strong>{result.errorCount}</strong></span>
            </div>
          </Card>

          {result.created.length > 0 && (
            <Card>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px' }}>Created Users</h3>
              <DataTable columns={createdColumns} rows={result.created} getRowId={(r) => String(r.rowNumber)} />
            </Card>
          )}

          {result.errors.length > 0 && (
            <Card>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px', color: 'var(--ps-color-alert)' }}>Row Errors</h3>
              <DataTable columns={errorColumns} rows={result.errors} getRowId={(r) => String(r.rowNumber)} />
            </Card>
          )}

          {result.created.length === 0 && result.errors.length === 0 && (
            <EmptyState message="The file had no data rows." />
          )}
        </>
      )}
    </div>
  );
}
