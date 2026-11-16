'use client';
import React from 'react';
import type { ProductDashboardOverview } from '../../lib/api';

type Period = ProductDashboardOverview['period'];

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "14 Nov 2025 – 14 Nov 2026". */
export function periodDates(period: Pick<Period, 'from' | 'to'>): string {
  return `${fmtDay(period.from)} – ${fmtDay(period.to)}`;
}

/** The period's name everywhere on the Product pages (cards, tables, hovers, exports): "Last 12 Months" for the default,
 * the dates for a custom range -- always the API's own `period`, never hard-coded. */
export function periodLabel(period: Period | null | undefined): string {
  if (!period) return '';
  return period.isDefault ? period.label : periodDates(period);
}

/**
 * The Product pages' period under the page header (2026-11-14): "Last 12 Months · 14 Nov 2025 – 14 Nov 2026 · compared
 * with ..." or, for a custom range, its dates. The dates are the API's own `period` (backend lib/last12Months.ts).
 */
export function PeriodNote({ period, base }: { period: Period | null | undefined; /** e.g. "Based on Active + Non Active SKUs" */ base?: string }) {
  if (!period) return <div data-testid="period-note" style={{ fontSize: 11, minHeight: 16, marginBottom: -12 }} />;
  return (
    <div data-testid="period-note" style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: -12 }}>
      <strong style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{period.isDefault ? period.label : 'Custom range'}</strong>
      {` · ${periodDates(period)} · compared with ${periodDates({ from: period.priorFrom, to: period.priorTo })}`}
      {base && <span data-testid="period-note-base"> · <strong style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{base}</strong></span>}
    </div>
  );
}
