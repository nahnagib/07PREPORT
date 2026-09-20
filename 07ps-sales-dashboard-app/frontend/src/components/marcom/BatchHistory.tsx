'use client';
import React, { useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import type { BatchDetail, BatchItem } from '../../lib/marcomApi';
import { formatTimestamp } from '../../lib/format';

const STATUS_LABEL: Record<BatchItem['status'], string> = {
  SUCCESS: '✔ Success',
  FAILED: '✖ Failed',
  ROLLED_BACK: '↺ Rolled back',
};
const STATUS_COLOR: Record<BatchItem['status'], string> = {
  SUCCESS: 'var(--ps-color-success)',
  FAILED: 'var(--ps-color-alert)',
  ROLLED_BACK: 'var(--ps-color-muted-text)',
};

export function StatusBadge({ status }: { status: BatchItem['status'] }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 600, color: STATUS_COLOR[status], whiteSpace: 'nowrap' }}>{STATUS_LABEL[status]}</span>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 12, color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 13, borderBottom: '1px solid var(--ps-color-border)', verticalAlign: 'top' };

export interface BatchHistoryProps {
  rows: BatchItem[] | null;
  loading: boolean;
  error: string | null;
  detail: BatchDetail | null;
  detailLoading: boolean;
  onRetry: () => void;
  onOpen: (id: number) => void;
  onCloseDetail: () => void;
  onDownload: (id: number) => void;
  onRollback: (batch: BatchItem) => void;
}

export function BatchHistory(p: BatchHistoryProps) {
  if (p.loading && !p.rows) return <LoadingSkeleton />;
  if (p.error && !p.rows) return <ErrorState message={p.error} onRetry={p.onRetry} />;
  if (!p.rows || p.rows.length === 0) return <EmptyState message="No MARCOM uploads yet. Upload the filled template above to get started." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {p.error && <ErrorState message={p.error} onRetry={p.onRetry} />}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Import history">
          <thead>
            <tr>
              <th style={th}>Date</th><th style={th}>Uploader</th><th style={th}>File</th><th style={th}>Status</th>
              <th style={th}>Inserted / Updated / Unchanged</th><th style={th}>Period</th><th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((b) => (
              <tr key={b.batchId}>
                <td style={td}>{formatTimestamp(b.uploadedAt)}</td>
                <td style={td}>{b.uploadedBy.name ?? '—'}</td>
                <td style={td}>{b.filename}</td>
                <td style={td}><StatusBadge status={b.status} /></td>
                <td style={td}>{b.totals ? `${b.totals.inserted} / ${b.totals.updated} / ${b.totals.unchanged}` : '—'}</td>
                <td style={td}>{b.period?.label ?? '—'}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Button variant="secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => p.onOpen(b.batchId)}>Details</Button>
                    {b.status !== 'FAILED' && (
                      <Button variant="secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => p.onDownload(b.batchId)}>Download file</Button>
                    )}
                    {b.canRollback && (
                      <Button variant="secondary" style={{ padding: '4px 8px', fontSize: 12, color: 'var(--ps-color-alert)' }} onClick={() => p.onRollback(b)}>
                        Roll back latest batch
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(p.detail || p.detailLoading) && (
        <Card aria-label="Batch detail" style={{ padding: 16 }}>
          {p.detailLoading || !p.detail ? (
            <LoadingSkeleton />
          ) : (
            <BatchDetailView detail={p.detail} onClose={p.onCloseDetail} />
          )}
        </Card>
      )}
    </div>
  );
}

function BatchDetailView({ detail, onClose }: { detail: BatchDetail; onClose: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <strong>Batch #{detail.batchId}</strong> — {detail.filename} <StatusBadge status={detail.status} />
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
            Template v{detail.templateVersion} · SHA-256 {detail.fileHash.slice(0, 16)}… · {detail.period?.label ?? 'no period'}
          </div>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close details">✕</Button>
      </div>
      {detail.status === 'ROLLED_BACK' && (
        <div style={{ fontSize: 13 }}>
          Rolled back {formatTimestamp(detail.rolledBackAt)}{detail.rolledBackBy ? ` by ${detail.rolledBackBy}` : ''}. Reason: {detail.rollbackReason ?? '—'}
        </div>
      )}
      {detail.status === 'FAILED' && <div style={{ fontSize: 13, color: 'var(--ps-color-alert)' }}>✖ {detail.errorMessage ?? 'The import failed and nothing was saved.'}</div>}
      {detail.tables.length > 0 && (
        <table style={{ borderCollapse: 'collapse', fontSize: 13 }} aria-label="Counts per table">
          <thead><tr><th style={th}>Table</th><th style={th}>Inserted</th><th style={th}>Updated</th><th style={th}>Unchanged</th></tr></thead>
          <tbody>
            {detail.tables.map((t) => (
              <tr key={t.id}><td style={td}>{t.label}</td><td style={td}>{t.inserted}</td><td style={td}>{t.updated}</td><td style={td}>{t.unchanged}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {detail.newBrands.length > 0 && <div style={{ fontSize: 13 }}>New brands created: {detail.newBrands.join(', ')}</div>}
      {detail.warnings.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>! {detail.warnings.length} warning{detail.warnings.length === 1 ? '' : 's'}</summary>
          <ul style={{ fontSize: 13, paddingLeft: 18 }}>
            {detail.warnings.map((w, i) => <li key={i}>{[w.sheet, w.cell].filter(Boolean).join('!')}{w.sheet || w.cell ? ': ' : ''}{w.message}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export interface RollbackDialogProps {
  batch: BatchItem | null;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/** Rollback confirmation with a required reason (ConfirmDialog has no input slot). */
export function RollbackDialog({ batch, busy, error, onConfirm, onCancel }: RollbackDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (batch) setReason(''); }, [batch]);
  useEffect(() => {
    if (!batch) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [batch, busy, onCancel]);
  if (!batch) return null;
  const valid = reason.trim().length >= 3;

  return (
    <div role="presentation" onClick={() => !busy && onCancel()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="marcom-rollback-title" onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 460, background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderRadius: 14, padding: 24, color: 'var(--ps-color-text)' }}>
        <h2 id="marcom-rollback-title" style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px' }}>Roll back batch #{batch.batchId}?</h2>
        <p style={{ fontSize: 14, margin: '0 0 12px', color: 'var(--ps-color-muted-text)' }}>
          Rows this batch inserted are removed and rows it updated return to their previous values. The pages will show the earlier numbers again.
          Only the latest batch can be rolled back.
        </p>
        <label htmlFor="marcom-rollback-reason" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)' }}>Reason (required)</label>
        <textarea id="marcom-rollback-reason" value={reason} maxLength={500} rows={3} disabled={busy}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: '100%', marginTop: 4, padding: 8, borderRadius: 6, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontFamily: 'inherit' }} />
        {error && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: 'var(--ps-color-alert)' }}>✖ {error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => onConfirm(reason.trim())} disabled={!valid || busy}>{busy ? 'Rolling back…' : 'Roll back'}</Button>
        </div>
      </div>
    </div>
  );
}
