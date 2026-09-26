import React from 'react';
import { Button, Card, DataTable, type Column } from '@07ps/ui';
import type { Issue, Preview, TableId } from '../../lib/marcomApi';

export interface UploadPreviewProps {
  preview: Preview;
  confirmedBrands: boolean;
  tab: TableId | 'all';
  /** True while the commit request is in flight. */
  busy?: boolean;
  /** Result of canConfirm() from the state machine -- the single rule for enabling Confirm. */
  canConfirm: boolean;
  onToggleBrands: (value: boolean) => void;
  onTab: (tab: TableId | 'all') => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** Omitted when the user may not export (download the error report). */
  onDownloadReport?: () => void;
}

interface IssueRow extends Record<string, unknown> { id: string; sheet: string; cell: string; code: string; message: string }

const issueColumns: Column<IssueRow>[] = [
  { key: 'sheet', header: 'Sheet', render: (r) => r.sheet || '—' },
  { key: 'cell', header: 'Cell', render: (r) => r.cell || '—' },
  { key: 'code', header: 'Code' },
  { key: 'message', header: 'Message' },
];

const toRows = (issues: Issue[]): IssueRow[] =>
  issues.map((i, n) => ({ id: `${i.code}-${i.sheet}-${i.cell}-${n}`, sheet: i.sheet, cell: i.cell, code: i.code, message: i.message }));

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'alert' | 'watch' | 'success' }) {
  const color = tone ? `var(--ps-color-${tone})` : 'var(--ps-color-text)';
  return (
    <Card aria-label={label} style={{ padding: 12, minWidth: 110, textAlign: 'center' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>{label}</div>
    </Card>
  );
}

const th: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontSize: 12, color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)' };
const td: React.CSSProperties = { textAlign: 'right', padding: '6px 10px', fontSize: 13, borderBottom: '1px solid var(--ps-color-border)' };

/**
 * The dry-run result: what would be inserted/updated/skipped per table, blocking errors, warnings,
 * old -> new values for overwritten rows, the new-brand confirmation and the confirm/cancel actions.
 * Purely presentational (no hooks) -- all rules live in lib/marcomUploadMachine.ts and the server.
 */
export function UploadPreview(p: UploadPreviewProps) {
  const { preview } = p;
  const errors = preview.issues.filter((i) => i.severity === 'error');
  const warnings = preview.issues.filter((i) => i.severity === 'warning');
  const inTab = (i: Issue) => p.tab === 'all' || i.table === p.tab || i.table === '';
  const shownTables = p.tab === 'all' ? preview.tables : preview.tables.filter((t) => t.id === p.tab);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="marcom-preview">
      <div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{preview.filename}</div>
        <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
          Template v{preview.templateVersion}
          {preview.period ? ` · Period covered: ${preview.period.label}` : ' · No dated rows found'}
        </div>
      </div>

      {preview.duplicateOf && (
        <div role="status" style={{ padding: 12, borderRadius: 8, border: '1px solid var(--ps-color-watch)', fontSize: 13 }}>
          ! This exact file was already imported on {new Date(preview.duplicateOf.uploadedAt).toLocaleDateString()}
          {preview.duplicateOf.uploadedBy ? ` by ${preview.duplicateOf.uploadedBy}` : ''}. Importing it again changes nothing.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="To insert" value={preview.totals.insert} tone={preview.totals.insert ? 'success' : undefined} />
        <Stat label="To update" value={preview.totals.update} tone={preview.totals.update ? 'watch' : undefined} />
        <Stat label="Unchanged" value={preview.totals.unchanged} />
        <Stat label="Example rows skipped" value={preview.totals.examplesSkipped} />
        <Stat label="Errors" value={preview.errorCount} tone={preview.errorCount ? 'alert' : undefined} />
        <Stat label="Warnings" value={preview.warningCount} tone={preview.warningCount ? 'watch' : undefined} />
      </div>

      <div role="tablist" aria-label="Sheets" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {([{ id: 'all', label: 'All sheets' }, ...preview.tables] as { id: TableId | 'all'; label: string }[]).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={p.tab === t.id}
            onClick={() => p.onTab(t.id)}
            style={{
              padding: '6px 10px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--ps-color-border)',
              background: p.tab === t.id ? 'var(--ps-color-accent)' : 'var(--ps-color-surface)',
              color: p.tab === t.id ? 'var(--ps-color-on-accent)' : 'var(--ps-color-text)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Row counts per table">
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Table</th>
              <th style={th}>Rows found</th><th style={th}>Insert</th><th style={th}>Update</th>
              <th style={th}>Unchanged</th><th style={th}>Skipped (empty / example)</th><th style={th}>Invalid</th>
            </tr>
          </thead>
          <tbody>
            {shownTables.map((t) => (
              <tr key={t.id}>
                <td style={{ ...td, textAlign: 'left' }}>{t.label}</td>
                <td style={td}>{t.rowsFound}</td><td style={td}>{t.insert}</td><td style={td}>{t.update}</td>
                <td style={td}>{t.unchanged}</td><td style={td}>{t.skippedEmpty} / {t.skippedExample}</td><td style={td}>{t.invalid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {errors.filter(inTab).length > 0 && (
        <section aria-label="Blocking errors">
          <h3 style={{ fontSize: 14, margin: '0 0 6px', color: 'var(--ps-color-alert)' }}>✖ Blocking errors ({errors.filter(inTab).length}) — fix these in the workbook and upload again</h3>
          <DataTable columns={issueColumns} rows={toRows(errors.filter(inTab))} getRowId={(r) => r.id} />
        </section>
      )}

      {warnings.filter(inTab).length > 0 && (
        <section aria-label="Warnings">
          <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>! Warnings ({warnings.filter(inTab).length}) — these do not block the import</h3>
          <DataTable columns={issueColumns} rows={toRows(warnings.filter(inTab))} getRowId={(r) => r.id} />
        </section>
      )}

      {shownTables.some((t) => t.updates.length > 0) && (
        <section aria-label="Updated rows">
          <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>Updated rows — old → new</h3>
          {shownTables.filter((t) => t.updates.length > 0).map((t) => (
            <div key={t.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t.label}{t.updatesTruncated ? ' (first 200 shown)' : ''}</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {t.updates.map((u) => (
                  <li key={`${t.id}-${u.rowNumber}`}>
                    Row {u.rowNumber}: {u.changes.map((c) => `${c.field} ${c.old ?? '(empty)'} → ${c.new ?? '(empty)'}`).join('; ')}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {preview.requiresNewBrandConfirmation && (
        <div role="group" aria-label="New brands" style={{ padding: 12, borderRadius: 8, border: '1px solid var(--ps-color-watch)' }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            ! This file introduces {preview.newBrands.length} brand name{preview.newBrands.length === 1 ? '' : 's'} that
            {preview.newBrands.length === 1 ? ' does' : ' do'} not exist yet: <strong>{preview.newBrands.join(', ')}</strong>.
            A typo would silently create a new brand, so please confirm they are correct.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              data-testid="confirm-new-brands"
              checked={p.confirmedBrands}
              disabled={p.busy}
              onChange={(e) => p.onToggleBrands(e.target.checked)}
            />
            Yes, create these brands
          </label>
        </div>
      )}

      {preview.nothingToImport && preview.errorCount === 0 && (
        <div role="status" style={{ padding: 12, borderRadius: 8, border: '1px solid var(--ps-color-border)', fontSize: 14 }}>
          Nothing to import{preview.totals.examplesSkipped ? ` (${preview.totals.examplesSkipped} example row${preview.totals.examplesSkipped === 1 ? '' : 's'} skipped)` : ''}.
          {preview.totals.unchanged > 0 ? ` All ${preview.totals.unchanged} rows already match the stored data.` : ' Fill in your data rows and upload again.'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {preview.issues.length > 0 && p.onDownloadReport && (
          <Button variant="secondary" onClick={p.onDownloadReport} disabled={p.busy}>Download error report (CSV)</Button>
        )}
        <Button variant="secondary" onClick={p.onCancel} disabled={p.busy}>{preview.nothingToImport ? 'Upload another file' : 'Cancel'}</Button>
        {!(preview.nothingToImport && preview.errorCount === 0) && (
          <Button onClick={p.onConfirm} disabled={!p.canConfirm || p.busy} data-testid="confirm-import">
            {p.busy ? 'Importing…' : 'Confirm import'}
          </Button>
        )}
      </div>
    </div>
  );
}
