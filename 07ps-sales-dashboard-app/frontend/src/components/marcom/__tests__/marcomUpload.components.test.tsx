import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UploadPreview, type UploadPreviewProps } from '../UploadPreview';
import { RollbackDialog, BatchHistory } from '../BatchHistory';
import { precheckFile } from '../UploadDropzone';
import { canConfirm } from '../../../lib/marcomUploadMachine';
import { makePreview } from '../../../lib/__tests__/fixtures';
import type { BatchItem, Preview } from '../../../lib/marcomApi';

/**
 * Render-level tests for the upload screen's pieces. No jsdom/browser is available in this repo
 * (same constraint as packages/ui's Gauge regression test), so components are rendered to static
 * markup and asserted structurally; behavioural transitions live in marcomUploadMachine.test.ts.
 */
const noop = () => undefined;

function html(preview: Preview, over: Partial<UploadPreviewProps> = {}): string {
  const state = { status: 'preview' as const, preview, confirmedBrands: over.confirmedBrands ?? false, tab: 'all' as const };
  return renderToStaticMarkup(
    <UploadPreview
      preview={preview} confirmedBrands={state.confirmedBrands} tab="all" canConfirm={canConfirm(state)}
      onToggleBrands={noop} onTab={noop} onConfirm={noop} onCancel={noop} onDownloadReport={noop} {...over}
    />,
  );
}
const confirmDisabled = (markup: string) => /data-testid="confirm-import"[^>]*disabled|disabled=""[^>]*data-testid="confirm-import"/.test(markup);

describe('UploadPreview', () => {
  it('clean preview: Confirm import is enabled, no error section', () => {
    const m = html(makePreview());
    expect(m).toContain('data-testid="confirm-import"');
    expect(confirmDisabled(m)).toBe(false);
    expect(m).not.toContain('Blocking errors');
    expect(m).toContain('February 2026');
  });

  it('with errors: shows sheet + cell, keeps Confirm disabled, offers the CSV report', () => {
    const m = html(makePreview({
      errorCount: 1, canCommit: false,
      issues: [{ severity: 'error', sheet: 'P1 - MARCOM Spending', table: 'spend', cell: 'B7', code: 'INVALID_MONTH', message: '"Agust" is not a valid month name' }],
    }));
    expect(m).toContain('Blocking errors (1)');
    expect(m).toContain('P1 - MARCOM Spending');
    expect(m).toContain('B7');
    expect(m).toContain('INVALID_MONTH');
    expect(confirmDisabled(m)).toBe(true);
    expect(m).toContain('Download error report (CSV)');
  });

  it('warnings are listed separately and do not disable Confirm', () => {
    const m = html(makePreview({
      warningCount: 1, issues: [{ severity: 'warning', sheet: 'P4 - Trade Marketing', table: 'trade', cell: 'C7', code: 'PERCENT_SCALED', message: 'read as 94%' }],
    }));
    expect(m).toContain('Warnings (1)');
    expect(m).not.toContain('Blocking errors');
    expect(confirmDisabled(m)).toBe(false);
  });

  it('new brands: required checkbox is shown and gates Confirm', () => {
    const p = makePreview({ newBrands: ['Brand Z'], requiresNewBrandConfirmation: true });
    const unticked = html(p, { confirmedBrands: false });
    expect(unticked).toContain('data-testid="confirm-new-brands"');
    expect(unticked).toContain('Brand Z');
    expect(confirmDisabled(unticked)).toBe(true);
    const ticked = html(p, { confirmedBrands: true });
    expect(ticked).toContain('checked=""');
    expect(confirmDisabled(ticked)).toBe(false);
  });

  it('nothing to import: explains why (with the skipped example rows) and has no Confirm button', () => {
    const m = html(makePreview({ nothingToImport: true, canCommit: false, totals: { insert: 0, update: 0, unchanged: 0, examplesSkipped: 7 } }));
    expect(m).toContain('Nothing to import (7 example rows skipped)');
    expect(m).not.toContain('data-testid="confirm-import"');
  });

  it('duplicate file banner', () => {
    const m = html(makePreview({ duplicateOf: { batchId: 2, uploadedAt: '2026-09-01T10:00:00.000Z', uploadedBy: 'Nahla' }, nothingToImport: true, canCommit: false }));
    expect(m).toContain('already imported');
    expect(m).toContain('by Nahla');
  });

  it('shows old -> new for updated rows', () => {
    const p = makePreview({
      tables: [{ id: 'spend', label: 'P1 MARCOM Spending', rowsFound: 1, insert: 0, update: 1, unchanged: 0, invalid: 0, skippedEmpty: 0, skippedExample: 0,
        updates: [{ rowNumber: 7, key: '2026|2|brand a', changes: [{ field: 'spend', old: '10000.00', new: '12000.00' }] }], updatesTruncated: false }],
    });
    expect(html(p)).toContain('spend 10000.00 → 12000.00');
  });

  it('while committing the actions are disabled and labelled', () => {
    const m = html(makePreview(), { busy: true });
    expect(m).toContain('Importing…');
    expect(confirmDisabled(m)).toBe(true);
  });
});

describe('client pre-checks (convenience only; the server is the authority)', () => {
  it('accepts .xlsx within 10 MB', () => expect(precheckFile({ name: 'a.XLSX', size: 1000 })).toBeNull());
  it.each([['a.xlsm', 10], ['a.xls', 10], ['a.csv', 10], ['a.xlsx.exe', 10], ['a.xlsx', 0], ['a.xlsx', 10 * 1024 * 1024 + 1]])('rejects %s (%d bytes)', (name, size) => {
    expect(precheckFile({ name, size })).not.toBeNull();
  });
});

describe('BatchHistory', () => {
  const batch = (over: Partial<BatchItem> = {}): BatchItem => ({
    batchId: 4, filename: 'mar.xlsx', fileHash: 'h', templateVersion: '1.0', uploadedBy: { id: 1, name: 'Nahla' }, uploadedAt: '2026-09-20T09:00:00.000Z',
    status: 'SUCCESS', period: { from: '2026-03', to: '2026-03', label: 'March 2026' }, totals: { inserted: 9, updated: 1, unchanged: 2, examplesSkipped: 7 },
    canRollback: true, rolledBackAt: null, rolledBackBy: null, rollbackReason: null, errorMessage: null, ...over,
  });
  const render = (rows: BatchItem[] | null, over: Record<string, unknown> = {}) => renderToStaticMarkup(
    <BatchHistory rows={rows} loading={false} error={null} detail={null} detailLoading={false} onRetry={noop} onOpen={noop} onCloseDetail={noop}
      onDownload={noop} onRollback={noop} {...over} />,
  );

  it('empty history shows the empty state', () => expect(render([])).toContain('No MARCOM uploads yet'));
  it('load failure shows a retryable error', () => expect(render(null, { error: 'Could not load the import history.' })).toContain('Could not load the import history.'));
  it('loading shows a skeleton, not the table', () => expect(render(null, { loading: true })).not.toContain('Import history'));
  it('shows status text (not colour only), counts, period; rollback only on the latest', () => {
    const m = render([batch(), batch({ batchId: 3, status: 'ROLLED_BACK', canRollback: false }), batch({ batchId: 2, status: 'FAILED', canRollback: false, totals: null })]);
    expect(m).toContain('✔ Success');
    expect(m).toContain('↺ Rolled back');
    expect(m).toContain('✖ Failed');
    expect(m).toContain('9 / 1 / 2');
    expect(m).toContain('March 2026');
    expect(m.match(/Roll back latest batch/g)).toHaveLength(1);
  });
});

describe('RollbackDialog', () => {
  it('renders nothing without a target', () => {
    expect(renderToStaticMarkup(<RollbackDialog batch={null} busy={false} error={null} onConfirm={noop} onCancel={noop} />)).toBe('');
  });
  it('requires a reason: the Roll back button starts disabled', () => {
    const b = { batchId: 4 } as BatchItem;
    const m = renderToStaticMarkup(<RollbackDialog batch={b} busy={false} error={null} onConfirm={vi.fn()} onCancel={noop} />);
    expect(m).toContain('Roll back batch #4?');
    expect(m).toContain('Reason (required)');
    expect(/<button[^>]*disabled=""[^>]*>Roll back<\/button>/.test(m)).toBe(true);
  });
  it('shows a server error inline', () => {
    const m = renderToStaticMarkup(<RollbackDialog batch={{ batchId: 4 } as BatchItem} busy={false} error="Only the latest successful batch can be rolled back." onConfirm={noop} onCancel={noop} />);
    expect(m).toContain('Only the latest successful batch');
  });
});
