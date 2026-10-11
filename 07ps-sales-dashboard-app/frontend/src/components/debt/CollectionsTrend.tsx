'use client';
import React, { useEffect } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Button, ChartPanel, ComboChart, DataGrid, EmptyState, ErrorState, LoadingSkeleton, type DataGridColumn } from '@07ps/ui';
import type { CollectionGrain, CollectionPaymentRow, CollectionPoint, CollectionsDrilldown, CollectionsTrend } from '../../lib/api';
import { formatCompactMoney, formatDate, formatMoney, formatNumber } from '../../lib/format';
import { safeOdooUrl } from '../../lib/debt/view';

/**
 * Collections trend (GET /debt-report/collections-trend, backend measures/debtCollections.ts): posted customer payments
 * per day / week (Sunday..Saturday) / month, in the page's chart currency, split by what they paid -- invoices overdue on
 * the payment date, invoices not yet due, other receivables, and money not matched to anything yet -- with the total
 * collected (line) and the collection rate against the overdue open at the start of the period (right axis, only where
 * a receivable snapshot exists on the period's first day). Click a period for its payments.
 */
export const COLLECTIONS_INFO =
  'Posted customer payments by payment date (Odoo), split by what they were applied to; credit notes, write-offs and exchange differences are not collections. Collection rate = paid against invoices overdue at the start of the period / that overdue (needs a receivable snapshot on the day before).';
export const COLLECTIONS_NOTE = 'A collection = a posted customer payment, by its payment date. Credit notes are not collections.';
const GRAIN_LABELS: Record<CollectionGrain, string> = { day: 'Day', week: 'Week', month: 'Month' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The x-axis label of a period: unique per period, so a click maps back to it. */
export function periodLabel(p: Pick<CollectionPoint, 'periodStart'>, grain: CollectionGrain): string {
  const [y, m, d] = p.periodStart.split('-').map(Number);
  if (grain === 'month') return `${MONTHS[m - 1]} ${y}`;
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`; // a week by its Sunday
}

/** Tooltip / drill-down title of a period: "Week 4–10 Oct 2026", "Oct 2026", "11 Oct 2026". */
export function periodTitle(p: Pick<CollectionPoint, 'periodStart' | 'periodEnd'>, grain: CollectionGrain): string {
  if (grain === 'day') return formatDate(p.periodStart);
  if (grain === 'month') return periodLabel(p, 'month');
  return `Week ${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}`;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function CollectionsTrendPanel({
  currency,
  data,
  loading,
  error,
  onRetry,
  grain,
  onGrainChange,
  onPeriodClick,
}: {
  currency: string | null;
  data: CollectionsTrend | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  grain: CollectionGrain;
  onGrainChange: (g: CollectionGrain) => void;
  onPeriodClick: (p: CollectionPoint) => void;
}) {
  const ccy = data?.currency ?? currency ?? '';
  const compact = (v: number) => formatCompactMoney(ccy, v);
  const full = (v: number) => formatMoney(ccy, v);
  const list = data?.points ?? [];
  const byLabel = new Map(list.map((p) => [periodLabel(p, grain), p]));
  const hasRate = list.some((p) => p.collectionRate !== null);
  const points = list.map((p) => ({
    label: periodLabel(p, grain),
    overdue: p.appliedOverdue,
    notDue: p.appliedNotDue,
    other: p.appliedOther,
    unapplied: p.unapplied,
    total: p.collected,
    rate: p.collectionRate,
  }));
  const hasOther = list.some((p) => Math.abs(p.appliedOther) > 0.005);
  const header = (
    <div role="group" aria-label="Period" style={{ display: 'inline-flex', gap: 4 }}>
      {(Object.keys(GRAIN_LABELS) as CollectionGrain[]).map((g) => (
        <Button key={g} variant={g === grain ? 'primary' : 'secondary'} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => onGrainChange(g)} aria-pressed={g === grain}>
          {GRAIN_LABELS[g]}
        </Button>
      ))}
    </div>
  );
  return (
    <ChartPanel title={`Collections trend · ${ccy}`} infoText={COLLECTIONS_INFO} headerActions={header}>
      {error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading && !data ? (
        <LoadingSkeleton variant="chart" />
      ) : !data || data.points.every((p) => p.payments === 0) ? (
        <>
          <p style={note}>{COLLECTIONS_NOTE}</p>
          <EmptyState message={`No ${ccy} customer payment in this range for these filters.`} />
        </>
      ) : (
        <>
          <p style={note}>
            {COLLECTIONS_NOTE} History from {formatDate(data.firstPaymentDate)}; {hasRate ? 'collection rate where a snapshot exists at the period start.' : 'no collection rate in this range (it needs a receivable snapshot on the day before a period starts).'}
          </p>
          <ComboChart
            title={`Collections trend ${ccy}`}
            showTitle={false}
            points={points}
            bars={[
              { key: 'overdue', name: 'Collected - overdue invoices', color: 'var(--ps-color-success)', stackId: 'paid' },
              { key: 'notDue', name: 'Collected - not yet due', color: 'var(--ps-color-accent)', stackId: 'paid' },
              ...(hasOther ? [{ key: 'other', name: 'Other receivables', color: 'var(--ps-color-gold)', stackId: 'paid' }] : []),
              { key: 'unapplied', name: 'Not matched yet', color: 'var(--ps-color-muted-text)', stackId: 'paid' },
            ]}
            lines={[
              { key: 'total', name: 'Total collected', color: 'var(--ps-color-text)', yAxisId: 'left', labelFormatter: points.length <= 8 ? compact : undefined },
              ...(hasRate ? [{ key: 'rate', name: 'Collection rate', color: 'var(--ps-color-watch)', yAxisId: 'right' as const }] : []),
            ]}
            leftAxisFormatter={compact}
            rightAxisFormatter={pct}
            tooltipFormatters={{ total: full, overdue: full, notDue: full, other: full, unapplied: full, rate: pct }}
            tooltipLabelFormatter={(label) => {
              const p = byLabel.get(label);
              return p ? `${periodTitle(p, grain)} · ${formatNumber(p.payments)} payment${p.payments === 1 ? '' : 's'}` : label;
            }}
            connectNulls={false}
            topPadding={24}
            height={300}
            onCategoryClick={(label) => {
              const p = byLabel.get(label);
              if (p && p.payments > 0) onPeriodClick(p);
            }}
          />
        </>
      )}
    </ChartPanel>
  );
}

type PayGridRow = CollectionPaymentRow & { id: string } & Record<string, unknown>;

/** The payments of one period (GET /debt-report/collections-drilldown); their amounts add up to the bar clicked. */
export function CollectionsDrilldownModal({
  point,
  grain,
  currency,
  data,
  loading,
  error,
  onRetry,
  onClose,
}: {
  point: CollectionPoint;
  grain: CollectionGrain;
  currency: string;
  data: CollectionsDrilldown | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const money = (key: keyof CollectionPaymentRow & string, header: string): DataGridColumn<PayGridRow> => ({
    key, header, align: 'right', width: 140, rawValue: (r) => Number(r[key] ?? 0), render: (r) => formatMoney(currency, Number(r[key] ?? 0)),
  });
  const columns: DataGridColumn<PayGridRow>[] = [
    { key: 'payment', header: 'Payment', width: 160 },
    { key: 'paymentDate', header: 'Date', width: 110, render: (r) => formatDate(r.paymentDate) },
    { key: 'company', header: 'Company', width: 90 },
    { key: 'customer', header: 'Customer', width: 220, render: (r) => <span dir="auto">{r.customer}</span> },
    { key: 'salesperson', header: 'Salesperson', width: 150, render: (r) => <span dir="auto">{r.salesperson}</span> },
    { key: 'salesTeam', header: 'Branch', width: 150, render: (r) => <span dir="auto">{r.salesTeam}</span> },
    money('amount', 'Amount'),
    money('appliedOverdue', 'Overdue invoices'),
    money('appliedNotDue', 'Not yet due'),
    money('appliedOther', 'Other'),
    money('unapplied', 'Not matched'),
    { key: 'invoices', header: 'Applied to', width: 280, render: (r) => <span dir="auto">{r.invoices || '—'}</span> },
    {
      key: 'odooUrl', header: 'Odoo', width: 80, rawValue: (r) => r.odooUrl,
      render: (r) => {
        const href = safeOdooUrl(r.odooUrl);
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--ps-color-accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Open <ExternalLink size={12} aria-hidden />
          </a>
        ) : '—';
      },
    },
  ];
  const rows: PayGridRow[] = (data?.rows ?? []).map((r, i) => ({ ...r, id: `${r.paymentId}:${i}` }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const reconciled = data && !data.truncated && Math.abs(total - point.collected) < 0.01;
  const title = `Payments · ${periodTitle(point, grain)} · ${currency}`;
  return (
    <div role="presentation" onClick={onClose} style={overlay}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={panel}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</h2>
            <p style={note}>Posted customer payments dated in this period, one row per salesperson + branch they were applied to. &quot;Not matched&quot; is as of the last refresh.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={closeButton}>
            <X size={18} aria-hidden />
          </button>
        </div>
        {error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : loading && !data ? (
          <LoadingSkeleton variant="table" />
        ) : (
          <>
            <div role="status" style={summary}>
              <span>{formatNumber(new Set(rows.map((r) => r.paymentId)).size)} payments</span>
              <span>
                Total <strong>{formatMoney(currency, total)}</strong>
              </span>
              <span style={{ color: reconciled ? 'var(--ps-color-muted-text)' : 'var(--ps-color-alert)' }}>
                {data?.truncated ? 'First 1,000 rows only' : reconciled ? `= the bar clicked (${formatMoney(currency, point.collected)})` : `≠ the bar clicked (${formatMoney(currency, point.collected)})`}
              </span>
            </div>
            <DataGrid<PayGridRow> columns={columns} rows={rows} getRowId={(r) => r.id} fileName={`collections-${currency}-${point.periodStart}`} pageSize={25} maxBodyHeight={460} />
          </>
        )}
      </div>
    </div>
  );
}

const note: React.CSSProperties = { margin: '0 0 12px', fontSize: 12, color: 'var(--ps-color-muted-text)' };
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0, 0, 0, 0.45)', display: 'flex', alignItems: 'center',
  justifyContent: 'center', padding: 'var(--ps-space-3, 16px)',
};
const panel: React.CSSProperties = {
  width: 'min(1400px, 100%)', maxHeight: '92vh', overflow: 'auto', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)',
  borderRadius: 12, border: '1px solid var(--ps-color-border)', padding: 'var(--ps-space-3, 16px)', display: 'flex', flexDirection: 'column', gap: 12,
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
};
const summary: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '4px 20px', fontSize: 12.5, color: 'var(--ps-color-text)' };
const closeButton: React.CSSProperties = {
  background: 'none', border: '1px solid var(--ps-color-border)', borderRadius: 8, padding: 6, cursor: 'pointer', color: 'var(--ps-color-text)',
  display: 'inline-flex',
};
