'use client';
import React from 'react';
import type { ProductDashboardOverview, RefreshStatus } from '../lib/api';
import { formatTimestamp } from '../lib/format';
import { fmtDate, fmtLYD, fmtUomQty } from '../lib/materialsAnalogy/shared';
import { RefreshFooter } from './RefreshFooter';
import { ValidationStatusBar } from './ValidationStatusBar';

/**
 * Freshness + coverage strip shared by the four Product pages. Same ValidationStatusBar/RefreshFooter
 * pair (and the same refresh-status source) as every live Sales page, plus:
 *   - "Data as of <last ETL run>" and the period the sales figures cover;
 *   - the Unmapped line: sales whose Company + Odoo product name has no PRODUCTS.xlsx row. They are
 *     part of every total; the names are listed in QA_ProductUnmapped (see docs/product_data_runbook.md).
 */
export function ProductDataStatusBar({
  refresh,
  data,
}: {
  refresh: RefreshStatus | null | undefined;
  data: ProductDashboardOverview | null | undefined;
}) {
  const lastRefresh = refresh ? formatTimestamp(refresh.lastRefreshTime) : undefined;
  return (
    <>
      <ValidationStatusBar
        isStale={refresh?.isStale}
        isInverted={refresh?.isInverted}
        refreshCheck={refresh?.refreshCheck}
        lastRefreshTime={lastRefresh}
      />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 20px',
          padding: '6px 24px',
          fontSize: 12,
          color: 'var(--ps-color-muted-text)',
          borderBottom: '1px solid var(--ps-color-border)',
        }}
      >
        <span>
          Data as of <strong style={{ color: 'var(--ps-color-text)' }}>{lastRefresh ?? '—'}</strong>
        </span>
        {data ? (
          <span>
            Sales period {fmtDate(data.period.from)} – {fmtDate(data.period.to)} ({data.period.days} days)
          </span>
        ) : null}
        {data ? (
          <span title="Sales lines whose Company + Odoo product name is not in PRODUCTS.xlsx. Included in every total.">
            Unmapped: <strong style={{ color: 'var(--ps-color-text)' }}>{fmtLYD(data.unmapped.value)}</strong> · {fmtUomQty(data.unmapped.volumeByUom)} ·{' '}
            {data.unmapped.products} product{data.unmapped.products === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
    </>
  );
}

export function ProductRefreshFooter({ refresh }: { refresh: RefreshStatus | null | undefined }) {
  return (
    <RefreshFooter
      lastUpdate={formatTimestamp((refresh?.lastUpdate ?? null))}
      lastOrderCreated={formatTimestamp((refresh?.lastOrderCreated ?? null))}
      lastRefreshTime={formatTimestamp((refresh?.lastRefreshTime ?? null))}
    />
  );
}
