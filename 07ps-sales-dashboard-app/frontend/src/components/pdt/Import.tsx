'use client';
import React, { useRef, useState } from 'react';
import { Button, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { ENTRY, PLAN } from '../../lib/pdp/api';
import { errorText, usePdp } from '../../lib/pdp/hooks';
import { TRACKER, trackerDownload, trackerUpload, type ImportLog, type ImportPreview, type StageCode } from '../../lib/pdt/api';
import { fmtStamp, type Lookup } from './common';
import s from './Pdt.module.css';

/**
 * Data entry & follow-up › Excel import: upload Product_Development_Input.xlsx -> preview (counts, row errors, what
 * changes; nothing written) -> Confirm import (the same file, checked by its SHA-256). History and the export in the same
 * format (export -> edit in Excel -> import) below. Needs product_development_entry Create (+ Edit to confirm).
 */
export function ImportTab({ lookup, refresh, revision }: { lookup: Lookup; refresh: () => void; revision: number }) {
  const { token, canCreate, canEdit, canExport } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [done, setDone] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = usePdp<{ rows: ImportLog[] }>(`${TRACKER}/import/history`, revision);
  const canUpload = canCreate(ENTRY) || canEdit(ENTRY);
  const canConfirm = canCreate(ENTRY) && canEdit(ENTRY);

  const choose = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    setDone(null);
    setError(null);
    if (!f) return;
    setBusy('preview');
    try {
      setPreview(await trackerUpload<ImportPreview>('/import/preview', token, f));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!file || !preview) return;
    setBusy('confirm');
    setError(null);
    try {
      const r = await trackerUpload<ImportPreview>('/import/confirm', token, file, { sha256: preview.sha256 });
      setDone(r);
      setPreview(null);
      setFile(null);
      if (input.current) input.current.value = '';
      refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={s.stack} data-testid="pdt-import">
      <section className={s.card}>
        <div className={s.cardHead}>
          <div>
            <h2 className={s.cardTitle}>Excel import</h2>
            <p className={s.cardSub}>
              Upload <b>Product_Development_Input.xlsx</b> (sheets Products, Status updates, Blockers &amp; decisions, Lists). You see a preview first; nothing is
              saved until you confirm. Products are matched by Code, blockers by ID; status updates are added (exact duplicates skipped). A product missing from
              the file is kept and listed.
            </p>
          </div>
          {(canExport(ENTRY) || canExport(PLAN)) && (
            <Button variant="secondary" onClick={() => trackerDownload('/import/export', token, 'Product_Development_Input.xlsx')}>
              Download current data (Excel)
            </Button>
          )}
        </div>
        {canUpload ? (
          <div className={s.toolbar}>
            <div>
              <label className={s.fieldLabel} htmlFor="pdt-import-file">Excel file (.xlsx, max 10 MB)</label>
              <input ref={input} id="pdt-import-file" type="file" accept=".xlsx" onChange={(e) => void choose(e.target.files?.[0] ?? null)} disabled={busy !== null} />
            </div>
            {busy === 'preview' && <span className={s.muted}>Reading the file…</span>}
          </div>
        ) : (
          <p className={s.muted}>You can view the import history. Uploading needs the Product Development Plan data-entry Create permission.</p>
        )}
        {error && <div className={s.error} role="alert" style={{ marginTop: 12 }}>{error}</div>}
        {done && (
          <div className={s.badge} role="status" style={{ padding: '10px 12px', fontSize: 13, marginTop: 12 }}>
            Imported {done.fileName}: {done.counts.products.new} new and {done.counts.products.changed} changed products, {done.counts.updates.new} status updates,{' '}
            {done.counts.blockers.new + done.counts.blockers.changed} blockers / decisions.
          </div>
        )}
      </section>

      {preview && <PreviewView preview={preview} lookup={lookup} onConfirm={confirm} onCancel={() => void choose(null)} busy={busy === 'confirm'} canConfirm={canConfirm} />}

      <section className={s.card}>
        <h2 className={s.cardTitle} style={{ marginBottom: 12 }}>Import history</h2>
        {history.error && <ErrorState message={history.error} onRetry={history.retry} />}
        {!history.data && !history.error && <LoadingSkeleton variant="table" />}
        {history.data && history.data.rows.length === 0 && <EmptyState message="No import yet." />}
        {history.data && history.data.rows.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead><tr><th>When</th><th>By</th><th>File</th><th>Products</th><th>Updates</th><th>Blockers</th><th>Not in the file</th></tr></thead>
              <tbody>
                {history.data.rows.map((h) => (
                  <tr key={h.importId}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtStamp(h.importedAt)}</td>
                    <td>{h.importedBy ?? '—'}</td>
                    <td>{h.fileName}</td>
                    <td>{h.counts.products.new} new · {h.counts.products.changed} changed · {h.counts.products.unchanged} unchanged</td>
                    <td>{h.counts.updates.new} added</td>
                    <td>{h.counts.blockers.new} new · {h.counts.blockers.changed} changed</td>
                    <td>{h.missingCodes.length ? h.missingCodes.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: 'alert' | 'good' }) {
  return (
    <div className={s.kpi} style={{ padding: 14 }}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={`${s.kpiValue}${tone === 'good' && value > 0 ? ` ${s.kpiGood}` : ''}`} style={{ fontSize: 24, margin: '6px 0 0', color: tone === 'alert' && value > 0 ? 'var(--ps-color-alert)' : undefined }}>{value}</div>
    </div>
  );
}

function PreviewView({ preview, lookup, onConfirm, onCancel, busy, canConfirm }: { preview: ImportPreview; lookup: Lookup; onConfirm: () => void; onCancel: () => void; busy: boolean; canConfirm: boolean }) {
  const c = preview.counts;
  const changed = preview.products.filter((p) => p.action !== 'unchanged');
  const stages = lookup.stages;
  return (
    <section className={s.card} data-testid="pdt-import-preview">
      <div className={s.cardHead}>
        <div>
          <h2 className={s.cardTitle}>
            Preview: {preview.fileName}{' '}
            <span className={`${s.badge}${preview.errors.length ? ` ${s.badgeWarn}` : ''}`}>{preview.errors.length ? `${preview.errors.length} error(s)` : 'ready to import'}</span>
          </h2>
          <p className={s.cardSub}>Nothing has been saved yet. Check the numbers, then confirm.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onConfirm} disabled={busy || !preview.canConfirm || !canConfirm} title={!canConfirm ? 'Confirming needs data-entry Create and Edit' : undefined}>
            {busy ? 'Importing…' : 'Confirm import'}
          </Button>
        </div>
      </div>

      <h3 className={s.cardTitle} style={{ fontSize: 14, margin: '4px 0 10px' }}>Products ({c.products.rows} rows)</h3>
      <div className={s.kpis}>
        <Count label="New" value={c.products.new} tone="good" />
        <Count label="Changed" value={c.products.changed} />
        <Count label="Unchanged" value={c.products.unchanged} />
        <Count label="Stage changes" value={c.products.stageChanges} />
        <Count label="Errors" value={c.products.errors} tone="alert" />
      </div>
      <div className={s.twoCol} style={{ marginTop: 16 }}>
        <div>
          <h3 className={s.cardTitle} style={{ fontSize: 14, marginBottom: 10 }}>Status updates ({c.updates.rows} rows)</h3>
          <div className={s.kpis}>
            <Count label="New" value={c.updates.new} tone="good" />
            <Count label="Duplicates skipped" value={c.updates.duplicates} />
            <Count label="Errors" value={c.updates.errors} tone="alert" />
          </div>
        </div>
        <div>
          <h3 className={s.cardTitle} style={{ fontSize: 14, marginBottom: 10 }}>Blockers &amp; decisions ({c.blockers.rows} rows)</h3>
          <div className={s.kpis}>
            <Count label="New" value={c.blockers.new} tone="good" />
            <Count label="Changed" value={c.blockers.changed} />
            <Count label="Unchanged" value={c.blockers.unchanged} />
            <Count label="Errors" value={c.blockers.errors} tone="alert" />
          </div>
        </div>
      </div>
      <p className={s.muted} style={{ marginTop: 12 }}>
        Lists: {c.families.inFile} families ({c.families.new} new, {c.families.changed} description changes).
        {preview.healthForced.length > 0 && ` ${preview.healthForced.length} product(s) will be set to Blocked because they have an open Blocker: ${preview.healthForced.join(', ')}.`}
      </p>

      {preview.errors.length > 0 && (
        <>
          <h3 className={s.cardTitle} style={{ fontSize: 14, margin: '18px 0 10px', color: 'var(--ps-color-alert)' }}>Errors to fix in Excel before importing</h3>
          <div className={s.tableWrap}>
            <table className={s.table} data-testid="pdt-import-errors">
              <thead><tr><th>Sheet</th><th>Row</th><th>Column</th><th>Problem</th><th>Code</th></tr></thead>
              <tbody>
                {preview.errors.map((e, i) => (
                  <tr key={i}>
                    <td>{e.sheet}</td>
                    <td>{e.row || '—'}</td>
                    <td>{e.field}</td>
                    <td>{e.message}</td>
                    <td className={s.muted}>{e.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className={s.cardTitle} style={{ fontSize: 14, margin: '18px 0 10px' }}>Where we stand after this import</h3>
      <div className={s.tableWrap} style={{ margin: 0 }}>
        <table className={s.matrix}>
          <thead>
            <tr><th>Family</th>{stages.map((st) => <th key={st.code}>{st.label}</th>)}<th>Total</th></tr>
          </thead>
          <tbody>
            {preview.whereWeStand.map((r) => (
              <tr key={r.family}>
                <td>{r.family}</td>
                {stages.map((st) => <td key={st.code}>{r.counts[st.code as StageCode] || <span className={s.muted}>·</span>}</td>)}
                <td><b>{r.total}</b></td>
              </tr>
            ))}
            <tr className={s.totalRow}>
              <td>Total</td>
              {stages.map((st) => <td key={st.code}>{preview.whereWeStand.reduce((n, r) => n + (r.counts[st.code as StageCode] ?? 0), 0)}</td>)}
              <td>{preview.whereWeStand.reduce((n, r) => n + r.total, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {changed.length > 0 && (
        <>
          <h3 className={s.cardTitle} style={{ fontSize: 14, margin: '18px 0 10px' }}>What changes ({changed.length})</h3>
          <div className={s.tableWrap} style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table className={s.table}>
              <thead><tr><th>Code</th><th>Product</th><th>Action</th><th>Stage</th><th>Changed columns</th></tr></thead>
              <tbody>
                {changed.map((p) => (
                  <tr key={p.code}>
                    <td>{p.code}</td>
                    <td>{p.name}</td>
                    <td>{p.action === 'new' ? 'New' : 'Changed'}</td>
                    <td>{p.stageFrom && p.stageFrom !== p.stageTo ? `${lookup.label('stage', p.stageFrom)} → ${lookup.label('stage', p.stageTo)}` : lookup.label('stage', p.stageTo)}</td>
                    <td className={s.muted}>{p.fields.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {preview.missingFromFile.length > 0 && (
        <p className={s.muted} style={{ marginTop: 12 }}>
          Kept, not in the file ({preview.missingFromFile.length}): {preview.missingFromFile.map((m) => `${m.code} ${m.name}`).join(' · ')}
        </p>
      )}
    </section>
  );
}
