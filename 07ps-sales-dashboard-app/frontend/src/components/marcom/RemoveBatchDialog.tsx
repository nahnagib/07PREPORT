'use client';
import React, { useEffect, useState } from 'react';
import { Button, ErrorState, LoadingSkeleton } from '@07ps/ui';
import type { BatchItem, RemovePreview } from '../../lib/marcomApi';
import { formatTimestamp } from '../../lib/format';

/** What the user types to arm the red button: the batch's file name, or REMOVE. */
export function removeConfirmed(typed: string, filename: string): boolean {
  const t = typed.trim();
  return t === 'REMOVE' || (t.length > 0 && t === filename.trim());
}

export interface RemoveBatchDialogProps {
  batch: BatchItem | null;
  preview: RemovePreview | null;
  previewLoading: boolean;
  previewError: string | null;
  onRetryPreview: () => void;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', fontSize: 12, color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '6px 8px', fontSize: 13, borderBottom: '1px solid var(--ps-color-border)', verticalAlign: 'top' };
const label: React.CSSProperties = { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)' };
const input: React.CSSProperties = {
  width: '100%', marginTop: 4, padding: 8, borderRadius: 6, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)',
  color: 'var(--ps-color-text)', fontFamily: 'inherit', fontSize: 14,
};

/**
 * "Remove batch": first the impact (GET /remove-preview, nothing written), then a required reason and the typed
 * confirmation (the file name, or REMOVE) before the red button works.
 */
export function RemoveBatchDialog(p: RemoveBatchDialogProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (p.batch) { setReason(''); setTyped(''); }
  }, [p.batch]);
  const { batch, busy, onCancel } = p;
  useEffect(() => {
    if (!batch) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [batch, busy, onCancel]);
  if (!batch) return null;

  const pv = p.preview;
  const ready = !!pv && pv.canRemove && !p.previewLoading;
  const valid = ready && reason.trim().length >= 3 && removeConfirmed(typed, batch.filename);
  const superseded = pv?.tables.flatMap((t) => t.deletedSuperseded.map((d) => ({ ...d, sheet: t.label }))) ?? [];
  const handed = pv?.tables.flatMap((t) => t.handedOver.map((d) => ({ ...d, sheet: t.label }))) ?? [];
  const rearmed = pv?.tables.flatMap((t) => t.rearmed.map((d) => ({ ...d, sheet: t.label }))) ?? [];
  const affectedTables = pv?.tables.filter((t) => t.deleted || t.handedOver.length || t.rearmed.length || t.relinked.length) ?? [];

  return (
    <div role="presentation" onClick={() => !busy && onCancel()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="marcom-remove-title" onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 680, maxHeight: '92vh', overflowY: 'auto', background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)', borderRadius: 14, padding: 'clamp(16px, 3vw, 24px)', color: 'var(--ps-color-text)' }}>
        <h2 id="marcom-remove-title" style={{ fontSize: 17, fontWeight: 700, margin: '0 0 6px' }}>Remove batch #{batch.batchId}?</h2>
        <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', marginBottom: 12, overflowWrap: 'anywhere' }}>
          <strong style={{ color: 'var(--ps-color-text)' }}>{batch.filename}</strong> · {batch.uploadedBy.name ?? '—'} · {formatTimestamp(batch.uploadedAt)} · {batch.period?.label ?? 'no period'}
        </div>
        <p style={{ fontSize: 14, margin: '0 0 12px' }}>
          The rows this batch added are deleted from the MARCOM pages. Rows a later upload already replaced keep the later values.
          The batch record, its file and its history entry are kept and it shows as &quot;Removed&quot;.
        </p>

        {p.previewError ? (
          <ErrorState message={p.previewError} onRetry={p.onRetryPreview} />
        ) : p.previewLoading || !pv ? (
          <LoadingSkeleton />
        ) : !pv.canRemove ? (
          <div role="alert" style={{ fontSize: 13, color: 'var(--ps-color-alert)' }}>✖ {pv.blockedReason}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Impact per sheet">
                <thead>
                  <tr><th style={th}>Sheet</th><th style={th}>Rows deleted</th><th style={th}>Other batches affected</th></tr>
                </thead>
                <tbody>
                  {affectedTables.length === 0 ? (
                    <tr><td style={td} colSpan={3}>Nothing to delete: this batch has no rows left.</td></tr>
                  ) : affectedTables.map((t) => (
                    <tr key={t.id}>
                      <td style={td}>{t.label}</td>
                      <td style={td}>{t.deleted}{t.deletedSuperseded.length ? ` (${t.deletedSuperseded.length} already replaced by a later batch)` : ''}</td>
                      <td style={td}>{t.handedOver.length + t.rearmed.length + t.relinked.length || '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td style={{ ...td, fontWeight: 700 }}>Total</td><td style={{ ...td, fontWeight: 700 }}>{pv.totals.deleted}</td><td style={{ ...td, fontWeight: 700 }}>{pv.totals.otherBatchRowsAffected || '—'}</td></tr>
                </tfoot>
              </table>
            </div>
            {superseded.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>{superseded.length} row{superseded.length === 1 ? '' : 's'} a later batch already replaced (the later values stay)</summary>
                <ul style={{ fontSize: 13, paddingLeft: 18, margin: '6px 0' }}>
                  {superseded.map((d) => <li key={`${d.sheet}|${d.key}`}>{d.sheet}: {d.label} → kept from batch #{d.supersededBy}</li>)}
                </ul>
              </details>
            )}
            {handed.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>{handed.length} row{handed.length === 1 ? '' : 's'} kept: a later batch uploaded the same values</summary>
                <ul style={{ fontSize: 13, paddingLeft: 18, margin: '6px 0' }}>
                  {handed.map((d, i) => <li key={i}>{d.sheet}: {d.label} → now belongs to batch #{d.toBatch}</li>)}
                </ul>
              </details>
            )}
            {rearmed.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>{rearmed.length} earlier value{rearmed.length === 1 ? '' : 's'} come back (this batch had replaced them)</summary>
                <ul style={{ fontSize: 13, paddingLeft: 18, margin: '6px 0' }}>
                  {rearmed.map((d, i) => <li key={i}>{d.sheet}: {d.label} → value of batch #{d.batch}</li>)}
                </ul>
              </details>
            )}
            <div style={{ fontSize: 13 }}>
              <div><strong>Brands deleted:</strong> {pv.brands.deleted.length ? pv.brands.deleted.join(', ') : 'none'}</div>
              {pv.brands.kept.length > 0 && (
                <div><strong>Brands kept:</strong> {pv.brands.kept.map((b) => `${b.name} (still used by batch ${b.usedBy.map((n) => `#${n}`).join(', ')})`).join('; ')}</div>
              )}
            </div>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <label htmlFor="marcom-remove-reason" style={label}>Reason (required)</label>
          <textarea id="marcom-remove-reason" value={reason} maxLength={500} rows={2} disabled={busy || !ready}
            onChange={(e) => setReason(e.target.value)} style={input} />
        </div>
        <div style={{ marginTop: 10 }}>
          <label htmlFor="marcom-remove-confirm" style={label}>Type the file name or REMOVE to confirm</label>
          <input id="marcom-remove-confirm" value={typed} disabled={busy || !ready} autoComplete="off" spellCheck={false}
            placeholder={batch.filename} onChange={(e) => setTyped(e.target.value)} style={input} />
        </div>
        {p.error && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: 'var(--ps-color-alert)' }}>✖ {p.error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => p.onConfirm(reason.trim())} disabled={!valid || busy}>{busy ? 'Removing…' : 'Remove batch'}</Button>
        </div>
      </div>
    </div>
  );
}
