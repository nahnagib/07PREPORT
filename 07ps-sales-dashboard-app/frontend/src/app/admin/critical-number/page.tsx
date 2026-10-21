'use client';
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, DataTable, DateInput, EmptyState, ErrorState, LoadingSkeleton, TextInput, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { AdminOnlyGuard } from '../../../components/AuthGuard';
import { useAuth } from '../../../lib/AuthProvider';
import { APP_TIMEZONE, formatCompactCurrency, formatCurrencyFull, formatDate, formatDateTime } from '../../../lib/format';
import { adminApi, ApiError, type CriticalNumberAdminView, type CriticalNumberHistoryRow } from '../../../lib/api';
import { changeRatio, isLargeChange, parseCriticalNumberInput } from '../../../lib/criticalNumberAdmin';

/**
 * Admin > Critical Number (2026-10-21): the company-wide Daily Critical Number (baseline daily sales target) the
 * Critical Number page measures every Daily / Monthly / Yearly Counter against. Admin role only (backend:
 * requireAdminRole). Every change is a new dated value applying from its "Effective from" date onward; past days keep
 * the value that was active on them, so past counters never change. Company / Customer Group shares (Admin >
 * Companies / Customer Groups) still scale it.
 */
export default function AdminCriticalNumberPage() {
  return (
    <AdminOnlyGuard>
      <AdminLayout title="Critical Number">
        <CriticalNumberBody />
      </AdminLayout>
    </AdminOnlyGuard>
  );
}

const NOTE =
  'The company-wide Daily Critical Number: the baseline daily sales target of the Critical Number page. A change applies from its ' +
  '"Effective from" date onward; days before it keep the value that was active on them, so past Daily / Monthly / Yearly counters ' +
  'do not change. Monthly and Yearly targets add up each working day at its own value. The Company / Customer Group shares ' +
  '(Admin > Companies / Customer Groups) still scale this value when those filters are used.';

/** A date-only string ("2026-11-01") as "1 Nov 2026" -- read as UTC so it never shifts a day. */
const formatDay = (day: string) => formatDate(`${day}T00:00:00Z`, 'UTC');
const changedBy = (r: CriticalNumberHistoryRow) => r.createdByName ?? r.createdByEmail ?? (r.createdBy === null ? 'System (initial value)' : '—');

function CriticalNumberBody() {
  const { token } = useAuth();
  const [view, setView] = useState<CriticalNumberAdminView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoadError(null);
    adminApi
      .getCriticalNumber(token)
      .then(setView)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load the Critical Number.'));
  }, [token]);

  useEffect(load, [load]);

  if (loadError) return <ErrorState message={loadError} onRetry={load} />;
  if (!view) return <LoadingSkeleton variant="kpi" />;

  const columns: Column<CriticalNumberHistoryRow>[] = [
    { key: 'valueLyd', header: 'Value', render: (r) => <span title={formatCurrencyFull(r.valueLyd, 2)}>{formatCompactCurrency(r.valueLyd)}</span> },
    {
      key: 'effectiveFrom',
      header: 'Effective from',
      render: (r) => (
        <span>
          {formatDay(r.effectiveFrom)}
          {r.effectiveFrom > view.today ? <span style={{ marginInlineStart: 6, fontSize: 12, color: 'var(--ps-color-watch)' }}>(scheduled)</span> : null}
          {view.current?.id === r.id ? <span style={{ marginInlineStart: 6, fontSize: 12, color: 'var(--ps-color-accent)' }}>(active today)</span> : null}
        </span>
      ),
    },
    { key: 'createdBy', header: 'Changed by', render: changedBy },
    { key: 'createdAt', header: 'Changed at', render: (r) => (r.createdAt ? formatDateTime(r.createdAt, APP_TIMEZONE) : '—') },
    { key: 'note', header: 'Note', render: (r) => r.note ?? '' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)', maxWidth: 1000 }}>
      <div style={{ padding: 12, borderRadius: 8, background: 'var(--ps-color-watch-bg, var(--ps-color-surface))', border: '1px solid var(--ps-color-watch-border, var(--ps-color-border))', fontSize: 13 }}>
        {NOTE}
      </div>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>Current Daily Critical Number</div>
        {view.current ? (
          <>
            <div style={{ fontSize: 32, fontWeight: 700, fontVariantNumeric: 'tabular-nums', margin: '4px 0' }} title={formatCurrencyFull(view.current.valueLyd, 2)}>
              {formatCompactCurrency(view.current.valueLyd)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
              Effective from {formatDay(view.current.effectiveFrom)} · last changed by {changedBy(view.current)}
              {view.current.createdAt ? ` on ${formatDateTime(view.current.createdAt, APP_TIMEZONE)}` : ''}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--ps-color-alert)', marginTop: 4 }}>
            No value stored yet -- the dashboard uses LYD 560.0K until database migration 0055 is applied.
          </div>
        )}
        {view.scheduled.length > 0 ? (
          <div style={{ fontSize: 13, marginTop: 8, color: 'var(--ps-color-watch)' }}>
            Scheduled:{' '}
            {view.scheduled.map((r) => `${formatCompactCurrency(r.valueLyd)} from ${formatDay(r.effectiveFrom)}`).join(' · ')}
          </div>
        ) : null}
      </Card>

      <ChangeForm current={view.current?.valueLyd ?? null} today={view.today} onSaved={setView} />

      <Card>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>History</h2>
        {view.history.length === 0 ? (
          <EmptyState message="No changes yet." />
        ) : (
          <DataTable columns={columns} rows={view.history} getRowId={(r) => String(r.id)} />
        )}
      </Card>
    </div>
  );
}

function ChangeForm({ current, today, onSaved }: { current: number | null; today: string; onSaved: (view: CriticalNumberAdminView) => void }) {
  const { token } = useAuth();
  const [raw, setRaw] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const parsed = parseCriticalNumberInput(raw);
  const ratio = parsed.ok ? changeRatio(parsed.value, current) : null;
  const dateError = !effectiveFrom ? 'Pick a date.' : effectiveFrom < today ? 'Cannot be in the past: past days keep their value.' : null;
  const canSave = parsed.ok && !dateError && !submitting && (current === null || parsed.value !== current);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !parsed.ok || dateError) return;
    const large = isLargeChange(parsed.value, current);
    if (
      large &&
      !window.confirm(
        `This changes the Daily Critical Number by ${ratio !== null ? `${ratio > 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%` : 'more than 50%'} ` +
          `(${formatCompactCurrency(current ?? 0)} -> ${formatCompactCurrency(parsed.value)}). Save it anyway?`,
      )
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setSavedMessage(null);
    try {
      const view = await adminApi.changeCriticalNumber(token, {
        value: parsed.value,
        effectiveFrom,
        note: note.trim() || undefined,
        confirmLargeChange: large || undefined,
      });
      onSaved(view);
      setSavedMessage(`Saved: ${formatCompactCurrency(parsed.value)} from ${formatDay(effectiveFrom)}.`);
      setRaw('');
      setNote('');
      setEffectiveFrom(view.today);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the change.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Change the value</h2>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, alignItems: 'start' }}>
        <TextInput
          label="New value (LYD)"
          inputMode="decimal"
          placeholder="560000"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          disabled={submitting}
          error={raw !== '' && !parsed.ok ? parsed.error : undefined}
          helperText={
            parsed.ok
              ? `${formatCompactCurrency(parsed.value)}${ratio !== null ? ` (${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}% vs current)` : ''}`
              : 'Full number, e.g. 560000'
          }
          required
        />
        <DateInput label="Effective from" value={effectiveFrom} onChange={setEffectiveFrom} min={today} disabled={submitting} required helperText={dateError ?? 'Applies from this day onward'} />
        <TextInput label="Reason / note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} disabled={submitting} />
        <div style={{ display: 'flex', alignItems: 'flex-end', minHeight: 62 }}>
          <Button type="submit" disabled={!canSave}>
            {submitting ? 'Saving...' : 'Save change'}
          </Button>
        </div>
      </form>
      {parsed.ok && isLargeChange(parsed.value, current) ? (
        <p style={{ fontSize: 13, color: 'var(--ps-color-watch)', margin: '8px 0 0' }}>More than ±50% of the current value: you will be asked to confirm.</p>
      ) : null}
      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--ps-color-alert)', margin: '8px 0 0' }}>{error}</p>}
      {savedMessage && <p role="status" style={{ fontSize: 13, color: 'var(--ps-color-success, var(--ps-color-text))', margin: '8px 0 0' }}>{savedMessage}</p>}
    </Card>
  );
}
