'use client';
import React, { useState } from 'react';
import { Button, Card } from '@07ps/ui';
import { useAuth } from '../../lib/AuthProvider';
import { errorText, kt as t } from '../../lib/kaizen/text';
import type { KaizenTextKey as MessageKey } from '../../lib/kaizen/text';
import { ApiError } from '../../lib/api';
import { kaizenApi, type KaizenImportResult } from '../../lib/kaizen/api';

/** Admin-only, one-time import of the existing cards: check the file (dry run), then import. The
 * backend refuses the import while any row has a problem, and after a first successful import. */
export function KaizenImportPanel({ onImported }: { onImported: () => void }) {
  const { token } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<KaizenImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(commit: boolean) {
    if (!token || !file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await kaizenApi.importCards(token, file, commit);
      setResult(r);
      if (r.committed) onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  const listLabel = (k: string) => t(`kaizen.dd.list.${k}` as MessageKey);

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <strong>{t('kaizen.imp.title')}</strong>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{t('kaizen.imp.help')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <input
          type="file"
          accept=".xlsx"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
            setError(null);
          }}
        />
        <Button variant="secondary" disabled={!file || busy} onClick={() => run(false)}>{t('kaizen.imp.check')}</Button>
        {result && !result.committed && !result.alreadyImported && result.problems.length === 0 && result.validRows > 0 && (
          <Button disabled={busy} onClick={() => run(true)}>{t('kaizen.imp.commit', { n: result.validRows })}</Button>
        )}
      </div>
      {error && <p role="alert" style={{ margin: 0, color: 'var(--ps-color-alert)', fontSize: 13 }}>{error}</p>}
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          {result.committed ? (
            <span style={{ color: 'var(--ps-color-success)', fontWeight: 700 }}>{t('kaizen.imp.done', { n: result.imported })}</span>
          ) : (
            <span>{t('kaizen.imp.rows', { valid: result.validRows, total: result.fileRows })}</span>
          )}
          {!result.committed && result.alreadyImported && <span style={{ color: 'var(--ps-color-watch)' }}>{t('kaizen.imp.already')}</span>}
          {Object.values(result.unmatched).some((v) => v.length > 0) && (
            <div>
              {t('kaizen.imp.unmatched')}
              <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
                {Object.entries(result.unmatched).filter(([, v]) => v.length > 0).map(([k, v]) => (
                  <li key={k}>{listLabel(k)}: {v.join(', ')}</li>
                ))}
              </ul>
            </div>
          )}
          {result.problems.length > 0 && (
            <ul style={{ margin: 0, paddingInlineStart: 18, color: 'var(--ps-color-alert)', maxHeight: 220, overflowY: 'auto' }}>
              {result.problems.map((p, i) => (
                <li key={i}>
                  {p.row > 0 && <strong>{t('kaizen.imp.row', { row: p.row })}: </strong>}
                  {errorText(p.code) ?? p.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
