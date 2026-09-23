'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Card, ConfirmDialog, LoadingSkeleton } from '@07ps/ui';
import { APP_TIMEZONE } from '../lib/format';
import { useAuth } from '../lib/AuthProvider';
import { adminApi, ApiError, EtlInputFileReplaced, EtlInputFileSlot, EtlInputFilesResponse } from '../lib/api';

/** Incremental runs skip these tables once they exist (database_exporter.py), so a new file only
 * lands at the next FULL refresh. */
const FULL_REFRESH_ONLY = new Set(['sales_targets.xlsx', 'OffDays.xlsx']);

function formatBytes(n: number | null): string {
  if (n === null) return '—';
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { timeZone: APP_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' });
}

type Outcome =
  | { kind: 'success'; result: EtlInputFileReplaced }
  | { kind: 'error'; name: string; message: string; problems: string[] };

/**
 * ETL Control Center: lists the ETL's manual input workbooks and lets an admin replace one. The ETL
 * service validates the new file against what the pipeline expects, keeps the old one as a
 * timestamped backup, and swaps the new one in at the path the pipeline reads. It deliberately does
 * NOT start a run -- the file is simply used by the next scheduled (or manual) run.
 */
export function EtlInputFilesCard({ etlRunActive, nextFullRun }: { etlRunActive: boolean; nextFullRun: string | null }) {
  const { token } = useAuth();
  const [data, setData] = useState<EtlInputFilesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ slot: EtlInputFileSlot; file: File } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const targetSlot = useRef<EtlInputFileSlot | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    adminApi
      .getEtlInputFiles(token)
      .then((res) => {
        setData(res);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Could not load the input files.'));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  function pickFile(slot: EtlInputFileSlot) {
    targetSlot.current = slot;
    setOutcome(null);
    if (fileInput.current) {
      fileInput.current.value = '';
      fileInput.current.click();
    }
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const slot = targetSlot.current;
    if (!file || !slot) return;
    const maxBytes = data?.max_bytes ?? 5 * 1024 * 1024;
    if (!/\.xlsx$/i.test(file.name)) {
      setOutcome({ kind: 'error', name: slot.name, message: 'Only .xlsx files are accepted.', problems: [] });
      return;
    }
    if (file.size > maxBytes) {
      setOutcome({
        kind: 'error',
        name: slot.name,
        message: `${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`,
        problems: [],
      });
      return;
    }
    setPending({ slot, file });
  }

  async function confirmUpload() {
    if (!token || !pending) return;
    setUploading(true);
    try {
      const result = await adminApi.replaceEtlInputFile(token, pending.slot.name, pending.file);
      setOutcome({ kind: 'success', result });
      load();
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { problems?: string[] } | undefined) : undefined;
      setOutcome({
        kind: 'error',
        name: pending.slot.name,
        message: err instanceof ApiError ? err.message : 'Upload failed.',
        problems: body?.problems ?? [],
      });
    } finally {
      setUploading(false);
      setPending(null);
    }
  }

  const whenApplied = (name: string) =>
    FULL_REFRESH_ONLY.has(name)
      ? `the next full refresh${nextFullRun ? ` (${formatDateTime(nextFullRun)})` : ''}`
      : 'the next ETL run';

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Input Files</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/admin/audit-log" style={{ fontSize: 13, alignSelf: 'center', color: 'var(--ps-color-accent)' }}>
            Upload history
          </Link>
          <Button variant="secondary" onClick={load}>
            Refresh
          </Button>
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '6px 0 10px' }}>
        Replacing a file does not start the ETL. The new file is validated, the current one is kept as a backup, and the ETL
        uses it on its next run.
      </p>

      <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={onFileChosen} />

      {etlRunActive && (
        <p style={{ fontSize: 13, color: 'var(--ps-color-watch)', margin: '0 0 10px' }}>
          An ETL run is in progress — uploads are disabled until it finishes.
        </p>
      )}

      {outcome?.kind === 'success' && (
        <div role="status" style={{ padding: 10, marginBottom: 10, borderRadius: 8, border: '1px solid var(--ps-color-success)', fontSize: 13 }}>
          <strong>{outcome.result.name} replaced.</strong>{' '}
          {Object.entries(outcome.result.validation.counts)
            .map(([k, v]) => `${v.toLocaleString()} ${k.replace(/_/g, ' ')}`)
            .join(', ')}{' '}
          read. {outcome.result.backup ? <>Previous version backed up to <code>{outcome.result.backup.path}</code>. </> : null}
          It will be used by {whenApplied(outcome.result.name)}.
          {!outcome.result.auditLogged && (
            <div style={{ color: 'var(--ps-color-alert)', marginTop: 4 }}>
              The file was replaced, but the upload could not be recorded in the audit log.
            </div>
          )}
        </div>
      )}
      {outcome?.kind === 'error' && (
        <div role="alert" style={{ padding: 10, marginBottom: 10, borderRadius: 8, border: '1px solid var(--ps-color-alert)', fontSize: 13 }}>
          <strong>{outcome.name} was not replaced.</strong> {outcome.message}
          {outcome.problems.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {outcome.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loadError ? (
        <p style={{ fontSize: 13, color: 'var(--ps-color-watch)', margin: 0 }}>{loadError}</p>
      ) : !data ? (
        <LoadingSkeleton variant="kpi" />
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: 12.5, borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--ps-color-muted-text)' }}>
                  <th style={{ padding: '4px 8px 6px 0' }}>File</th>
                  <th style={{ padding: '4px 8px 6px' }}>Last updated</th>
                  <th style={{ padding: '4px 8px 6px', textAlign: 'right' }}>Size</th>
                  <th style={{ padding: '4px 8px 6px' }}>Last uploaded by</th>
                  <th style={{ padding: '4px 0 6px' }} />
                </tr>
              </thead>
              <tbody>
                {data.files.map((f) => (
                  <React.Fragment key={f.name}>
                    <tr style={{ borderTop: '1px solid var(--ps-color-border)' }}>
                      <td style={{ padding: '6px 8px 6px 0' }}>
                        <div style={{ fontWeight: 600 }}>{f.name}</div>
                        <button
                          type="button"
                          onClick={() => setExpanded((cur) => (cur === f.name ? null : f.name))}
                          style={{ background: 'none', border: 0, padding: 0, color: 'var(--ps-color-accent)', cursor: 'pointer', fontSize: 12 }}
                        >
                          {expanded === f.name ? 'Hide expected columns' : 'Expected columns'}
                        </button>
                      </td>
                      <td style={{ padding: '6px 8px', color: f.exists ? undefined : 'var(--ps-color-alert)' }}>
                        {f.exists ? formatDateTime(f.modified) : 'Missing'}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatBytes(f.size_bytes)}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--ps-color-muted-text)' }}>
                        {f.lastUpload ? `${f.lastUpload.byName ?? `User #${f.lastUpload.byUserId}`} · ${formatDateTime(f.lastUpload.at)}` : '—'}
                      </td>
                      <td style={{ padding: '6px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Button variant="secondary" onClick={() => pickFile(f)} disabled={etlRunActive || uploading}>
                          Upload / Replace
                        </Button>
                      </td>
                    </tr>
                    {expanded === f.name && (
                      <tr>
                        <td colSpan={5} style={{ padding: '0 0 10px', fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
                          <div>Feeds: {f.feeds}. Takes effect at {whenApplied(f.name)}.</div>
                          {f.sheets.map((s) => (
                            <div key={s.label} style={{ marginTop: 4 }}>
                              <strong>{s.sheet_names ? `Sheet named ${s.sheet_names.slice(0, 2).join(' or ')}` : 'First sheet'}</strong>
                              {' — required: '}
                              <code>{s.required.join(', ')}</code>
                              {s.optional.length > 0 && (
                                <>
                                  {'; optional: '}
                                  <code>{s.optional.join(', ')}</code>
                                </>
                              )}
                            </div>
                          ))}
                          {f.recent_backups.length > 0 && (
                            <div style={{ marginTop: 4 }}>
                              Recent backups: {f.recent_backups.map((b) => b.name).join(', ')}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 8 }}>
            ETL input folder <code>{data.input_dir}</code> · backups in <code>{data.backup_dir}</code> · max{' '}
            {formatBytes(data.max_bytes)} per file
          </div>
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={`Replace ${pending?.slot.name ?? ''}?`}
        message={
          pending
            ? `"${pending.file.name}" (${formatBytes(pending.file.size)}) will be checked and, if valid, replace ${pending.slot.name}` +
              ` in the ETL input folder. The current file is kept as a backup. Nothing runs now — it will be used by ${whenApplied(pending.slot.name)}.`
            : ''
        }
        confirmLabel="Replace file"
        onConfirm={confirmUpload}
        onCancel={() => setPending(null)}
        busy={uploading}
      />
    </Card>
  );
}
