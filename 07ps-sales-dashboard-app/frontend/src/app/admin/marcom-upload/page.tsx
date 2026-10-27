'use client';
import React, { useCallback, useEffect, useReducer, useState } from 'react';
import Link from 'next/link';
import { Button, Card, ErrorState } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { PermissionGuard } from '../../../components/AuthGuard';
import { UploadDropzone } from '../../../components/marcom/UploadDropzone';
import { UploadPreview } from '../../../components/marcom/UploadPreview';
import { BatchHistory, RollbackDialog } from '../../../components/marcom/BatchHistory';
import { BrandCompanyCard } from '../../../components/marcom/BrandCompanyCard';
import { RemoveBatchDialog } from '../../../components/marcom/RemoveBatchDialog';
import { useAuth } from '../../../lib/AuthProvider';
import { BatchDetail, BatchItem, MarcomApiError, RemovePreview, marcomApi } from '../../../lib/marcomApi';
import { canConfirm, initialUploadState, uploadReducer } from '../../../lib/marcomUploadMachine';

export default function MarcomUploadPage() {
  return (
    <PermissionGuard pageKey="admin_marcom_upload">
      <AdminLayout title="MARCOM Data Upload">
        <Body />
      </AdminLayout>
    </PermissionGuard>
  );
}

const describe = (err: unknown, fallback: string) => (err instanceof MarcomApiError ? err.message : fallback);

function Body() {
  const { token, canCreate, canDelete, canExport } = useAuth();
  const mayUpload = canCreate('admin_marcom_upload');
  const mayRollback = canDelete('admin_marcom_upload');
  const mayDownload = canExport('admin_marcom_upload');
  const [state, dispatch] = useReducer(uploadReducer, initialUploadState);

  // ---- history
  const [rows, setRows] = useState<BatchItem[] | null>(null);
  const [histLoading, setHistLoading] = useState(true);
  const [histError, setHistError] = useState<string | null>(null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<BatchItem | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<BatchItem | null>(null);
  const [removePreview, setRemovePreview] = useState<RemovePreview | null>(null);
  const [removePreviewLoading, setRemovePreviewLoading] = useState(false);
  const [removePreviewError, setRemovePreviewError] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    if (!token) return;
    setHistLoading(true);
    setHistError(null);
    marcomApi.listBatches(token)
      .then((r) => setRows(r.rows))
      .catch((err) => setHistError(err instanceof MarcomApiError && err.status === 403
        ? 'You do not have permission to view MARCOM upload history.'
        : describe(err, 'Could not load the import history.')))
      .finally(() => setHistLoading(false));
  }, [token]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ---- upload flow
  async function handleFile(file: File) {
    if (!token) return;
    dispatch({ type: 'FILE_SELECTED', filename: file.name });
    try {
      const preview = await marcomApi.validate(token, file, (progress) => dispatch({ type: 'PROGRESS', progress }));
      dispatch({ type: 'VALIDATED', preview });
    } catch (err) {
      dispatch({ type: 'VALIDATE_FAILED', message: describe(err, 'The file could not be validated.'), code: err instanceof MarcomApiError ? err.code : undefined });
    }
  }

  async function handleConfirm() {
    if (!token || state.status !== 'preview') return;
    const { preview, confirmedBrands } = state;
    dispatch({ type: 'COMMIT_STARTED' });
    try {
      const result = await marcomApi.commit(token, preview.stagedUploadId, confirmedBrands);
      dispatch({ type: 'COMMITTED', result });
      loadHistory();
    } catch (err) {
      dispatch({ type: 'COMMIT_FAILED', message: describe(err, 'The import failed and nothing was saved.'), code: err instanceof MarcomApiError ? err.code : undefined });
    }
  }

  async function safely(fn: () => Promise<unknown>, fallback: string) {
    setActionError(null);
    try { await fn(); } catch (err) { setActionError(describe(err, fallback)); }
  }

  async function openDetail(id: number) {
    if (!token) return;
    setDetailLoading(true);
    setDetail(null);
    try { setDetail(await marcomApi.getBatch(token, id)); } catch (err) { setActionError(describe(err, 'Could not load the batch.')); }
    finally { setDetailLoading(false); }
  }

  async function doRollback(reason: string) {
    if (!token || !rollbackTarget) return;
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      await marcomApi.rollback(token, rollbackTarget.batchId, reason);
      setRollbackTarget(null);
      setDetail(null);
      loadHistory();
    } catch (err) {
      setRollbackError(describe(err, 'The rollback failed. Nothing was changed.'));
    } finally {
      setRollbackBusy(false);
    }
  }

  const loadRemovePreview = useCallback((b: BatchItem) => {
    if (!token) return;
    setRemovePreview(null);
    setRemovePreviewError(null);
    setRemovePreviewLoading(true);
    marcomApi.removePreview(token, b.batchId)
      .then(setRemovePreview)
      .catch((err) => setRemovePreviewError(describe(err, 'Could not load what the removal would change.')))
      .finally(() => setRemovePreviewLoading(false));
  }, [token]);

  function openRemove(b: BatchItem) {
    setRemoveError(null);
    setRemoveTarget(b);
    loadRemovePreview(b);
  }

  async function doRemove(reason: string) {
    if (!token || !removeTarget) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const r = await marcomApi.removeBatch(token, removeTarget.batchId, reason);
      setNotice(`Batch #${r.batchId} removed: ${r.totals.deleted} row${r.totals.deleted === 1 ? '' : 's'} deleted` +
        (r.totals.otherBatchRowsAffected ? `, ${r.totals.otherBatchRowsAffected} row(s) of other batches adjusted` : '') +
        (r.brandsDeleted.length ? `; brands deleted: ${r.brandsDeleted.join(', ')}` : '') + '.');
      setRemoveTarget(null);
      setDetail(null);
      loadHistory();
    } catch (err) {
      setRemoveError(describe(err, 'The removal failed. Nothing was changed.'));
    } finally {
      setRemoveBusy(false);
    }
  }

  const busy = state.status === 'validating' || state.status === 'committing';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <div style={{ padding: 12, borderRadius: 8, border: '1px solid var(--ps-color-border)', fontSize: 13, background: 'var(--ps-color-surface)' }}>
        Upload the monthly MARCOM Contribution workbook. The file is checked first and nothing is saved until you confirm.
        Uploads <strong>merge</strong> by month/brand/campaign: rows missing from the file are kept, so you can upload one month at a time or a full year.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="secondary" onClick={() => safely(() => marcomApi.downloadTemplate(token!), 'Could not download the template.')} disabled={!token}>
          Download template
        </Button>
      </div>
      {actionError && <ErrorState message={actionError} onRetry={() => setActionError(null)} />}

      <Card style={{ padding: 16 }}>
        {!mayUpload && (
          <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>You can view the import history, but your role can&apos;t upload new files.</div>
        )}
        {mayUpload && (state.status === 'idle' || state.status === 'validating') && (
          <UploadDropzone
            disabled={busy}
            progress={state.status === 'validating' ? state.progress : undefined}
            busyLabel={state.status === 'validating' ? `Validating ${state.filename}…` : undefined}
            notice={state.status === 'idle' ? state.notice : undefined}
            onFile={handleFile}
            onReject={(message) => dispatch({ type: 'FILE_REJECTED', message })}
          />
        )}

        {(state.status === 'preview' || state.status === 'committing') && (
          <UploadPreview
            preview={state.preview}
            confirmedBrands={state.confirmedBrands}
            tab={state.tab}
            busy={state.status === 'committing'}
            canConfirm={canConfirm(state.status === 'committing' ? { ...state, status: 'preview' } : state)}
            onToggleBrands={(value) => dispatch({ type: 'TOGGLE_BRANDS', value })}
            onTab={(tab) => dispatch({ type: 'SELECT_TAB', tab })}
            onConfirm={handleConfirm}
            onCancel={() => dispatch({ type: 'RESET' })}
            onDownloadReport={!mayDownload ? undefined : () => safely(() => marcomApi.downloadErrorReport(token!, state.preview.stagedUploadId), 'Could not download the report.')}
          />
        )}

        {state.status === 'failed' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ErrorState message={state.message} />
            <div style={{ display: 'flex', gap: 8 }}>
              {state.preview && <Button variant="secondary" onClick={() => dispatch({ type: 'BACK_TO_PREVIEW' })}>Back to preview</Button>}
              <Button onClick={() => dispatch({ type: 'RESET' })}>Upload a different file</Button>
            </div>
          </div>
        )}

        {state.status === 'expired' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} role="alert">
            <div style={{ fontWeight: 600 }}>! This upload expired</div>
            <div style={{ fontSize: 14 }}>{state.message} (Validated uploads are held for one hour.)</div>
            <div><Button onClick={() => dispatch({ type: 'RESET' })}>Upload again</Button></div>
          </div>
        )}

        {state.status === 'success' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="marcom-success">
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ps-color-success)' }}>✔ Import complete</div>
            <div style={{ fontSize: 14 }}>
              <strong>{state.filename}</strong> — batch #{state.result.batchId}
              {state.result.period ? ` · ${state.result.period.label}` : ''}
            </div>
            <div style={{ fontSize: 14 }}>
              {state.result.totals.inserted} inserted · {state.result.totals.updated} updated · {state.result.totals.unchanged} unchanged
              {state.result.totals.examplesSkipped ? ` · ${state.result.totals.examplesSkipped} example rows skipped` : ''}
            </div>
            {state.result.newBrandsCreated.length > 0 && <div style={{ fontSize: 13 }}>New brands created: {state.result.newBrandsCreated.join(', ')}</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link href="/promotion" style={{ padding: '8px 14px', borderRadius: 8, background: 'var(--ps-color-accent)', color: 'var(--ps-color-on-accent)', textDecoration: 'none', fontSize: 14 }}>
                Go to Promotion pages
              </Link>
              <Button variant="secondary" onClick={() => dispatch({ type: 'RESET' })}>Upload another file</Button>
            </div>
          </div>
        )}
      </Card>

      <BrandCompanyCard token={token} canEdit={mayUpload} />

      <div>
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Import history</h2>
        {notice && (
          <div role="status" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', padding: '10px 12px', marginBottom: 8, borderRadius: 8, fontSize: 13, border: '1px solid var(--ps-color-success-border)', background: 'var(--ps-color-success-bg)', color: 'var(--ps-color-text)' }}>
            <span>✔ {notice}</span>
            <Button variant="ghost" onClick={() => setNotice(null)} aria-label="Dismiss" style={{ padding: '0 6px' }}>✕</Button>
          </div>
        )}
        <BatchHistory
          rows={rows}
          loading={histLoading}
          error={histError}
          detail={detail}
          detailLoading={detailLoading}
          onRetry={loadHistory}
          onOpen={openDetail}
          onCloseDetail={() => setDetail(null)}
          onDownload={!mayDownload ? undefined : (id) => safely(() => marcomApi.downloadBatchFile(token!, id), 'Could not download the original file.')}
          onRollback={!mayRollback ? undefined : (b) => { setRollbackError(null); setRollbackTarget(b); }}
          onRemove={!mayRollback ? undefined : openRemove}
        />
      </div>

      <RollbackDialog batch={rollbackTarget} busy={rollbackBusy} error={rollbackError} onConfirm={doRollback} onCancel={() => setRollbackTarget(null)} />
      <RemoveBatchDialog
        batch={removeTarget}
        preview={removePreview}
        previewLoading={removePreviewLoading}
        previewError={removePreviewError}
        onRetryPreview={() => removeTarget && loadRemovePreview(removeTarget)}
        busy={removeBusy}
        error={removeError}
        onConfirm={doRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
