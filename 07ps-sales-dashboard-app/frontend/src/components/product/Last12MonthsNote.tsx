'use client';
import React from 'react';
import type { ProductDashboardOverview } from '../../lib/api';

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The Product pages' window under the page header (2026-11-14): "Last 12 Months · 14 Nov 2025 – 14 Nov 2026". The dates
 * are the API's own `period` (backend lib/last12Months.ts), never computed here, so the label and the numbers can't drift.
 */
export function Last12MonthsNote({ period }: { period: ProductDashboardOverview['period'] | null | undefined }) {
  return (
    <div data-testid="last-12-months-note" style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: -12 }}>
      <strong style={{ color: 'var(--ps-color-text)', fontWeight: 600 }}>{period?.label ?? 'Last 12 Months'}</strong>
      {period ? ` · ${fmtDay(period.from)} – ${fmtDay(period.to)} · compared with ${fmtDay(period.priorFrom)} – ${fmtDay(period.priorTo)}` : ''}
    </div>
  );
}
