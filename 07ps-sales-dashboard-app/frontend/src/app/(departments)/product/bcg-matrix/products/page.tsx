'use client';
import React, { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, DataGrid, ErrorState, LoadingSkeleton, VisualInfoIcons, type DataGridColumn } from '@07ps/ui';
import { AppHeader } from '../../../../../components/AppHeader';
import { BottomNavBar } from '../../../../../components/BottomNavBar';
import { PermissionGuard } from '../../../../../components/AuthGuard';
import { ValidationStatusBar } from '../../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../../components/RefreshFooter';
import { OdooLink } from '../../../../../components/OdooLink';
import { PeriodNote, periodDates, periodLabel } from '../../../../../components/product/PeriodNote';
import { ProductName, useProfitAccess } from '../../../../../components/product/ProductUi';
import { useProductFilters } from '../../../../../components/product/useProductFilters';
import { useAuth } from '../../../../../lib/AuthProvider';
import { useProductStatusList, useRefreshStatus } from '../../../../../lib/hooks';
import { formatTimestamp } from '../../../../../lib/format';
import { fmtLYD, fmtNum, BCG_COLOR } from '../../../../../lib/materialsAnalogy/shared';
import { vh } from '../../../../../lib/visualHelp';
import type { ProductStatusSkuRow } from '../../../../../lib/api';
import {
  STATUS_DEFINITION,
  STATUS_KEYS,
  STATUS_LABEL,
  STATUS_OF_KEY,
  parseStatusKey,
  parseStockFilter,
  rowsForStatus,
  scopeFromParams,
  statusCounts,
  statusMatchesCards,
  statusTableHref,
  type StockFilter,
} from '../../../../../lib/product/statusTable';

/**
 * Product status table (2026-11-15): /product/bcg-matrix/products?status=active|non_active|dormant|unclassified, opened
 * from the BCG Matrix page's Product Status cards and Total SKUs chips. The Company and Date filters come in the URL (the
 * BCG page's own), so the counts here are the cards' counts: the API builds the rows with the cards' SKU grouping
 * (backend measures skuListOf), and a mismatch is shown, never hidden. One row = one SKU (an Odoo variant; a variant in
 * two companies is one row listing both). Profit / GP% only with View on profit_data.
 */
type Row = ProductStatusSkuRow & Record<string, unknown> & { id: string };

const fmtCount = (v: number) => v.toLocaleString('en-US');
const fmtGp = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${v.toFixed(1)}%`);
const brandOf = (r: Row) => (r.brand && r.brand !== 'Unassigned' ? r.brand : '—');

export default function ProductStatusTablePage() {
  return (
    <Suspense fallback={null}>
      <ProductStatusTable />
    </Suspense>
  );
}

function ProductStatusTable() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const refresh = useRefreshStatus(token, authError, retryAuth);
  // the header date control only; the table's Company + Date come from the URL (the BCG page's filters)
  const { anchorDate, onAnchorDateChange } = useProductFilters(refresh.data);
  const statusKey = parseStatusKey(params.get('status'));
  const stock = parseStockFilter(params.get('stock'));
  const scope = useMemo(() => scopeFromParams(params), [params]);
  const list = useProductStatusList(token, authError, retryAuth, scope);
  const profit = useProfitAccess(list.data?.profitAccess);
  const status = STATUS_OF_KEY[statusKey];
  const skus = useMemo(() => list.data?.skus ?? [], [list.data]);
  const counts = useMemo(() => statusCounts(skus), [skus]);
  const summary = list.data?.statusSummary ?? null;
  const matches = list.data ? statusMatchesCards(skus, summary) : true;
  const period = list.data?.period ?? null;
  const companyLabel = scope.company ?? 'Majaal + Tika';
  const withStockCount = skus.filter((r) => r.status === 'NonActive' && r.withStock).length;
  const zeroStockCount = counts.NonActive - withStockCount;

  const rows: Row[] = useMemo(
    () => rowsForStatus(skus, status, stock).sort((a, b) => b.units - a.units || b.value - a.value || a.productName.localeCompare(b.productName))
      .map((r) => ({ ...r, id: r.odooProductId })),
    [skus, status, stock],
  );
  const go = (key: typeof statusKey, nextStock: StockFilter = 'all') => router.replace(statusTableHref(key, scope, nextStock));
  const backHref = `/product/bcg-matrix`;

  const columns: DataGridColumn<Row>[] = [
    { key: 'productName', header: 'Product', width: 240, render: (r) => <ProductName name={r.productName} />, rawValue: (r) => r.productName },
    { key: 'sku', header: 'Internal ref', render: (r) => r.sku ?? '—', rawValue: (r) => r.sku ?? '' },
    { key: 'companies', header: 'Company', render: (r) => r.companies.join(', '), rawValue: (r) => r.companies.join(', ') },
    { key: 'category', header: 'Category', render: (r) => <ProductName name={r.category ?? '—'} />, rawValue: (r) => r.category ?? '' },
    { key: 'brand', header: 'Vendor', render: brandOf, rawValue: brandOf },
    { key: 'status', header: 'Status', render: (r) => STATUS_LABEL[r.status], rawValue: (r) => STATUS_LABEL[r.status] },
    ...(status === 'Active' || status === 'NonActive'
      ? [{ key: 'bcgClass', header: 'BCG Class', rawValue: (r: Row) => r.bcgClass ?? '',
          render: (r: Row) => <span style={{ color: (r.bcgClass && BCG_COLOR[r.bcgClass]) || 'var(--ps-color-muted-text)', fontWeight: 700 }}>{r.bcgClass ?? '—'}</span> } as DataGridColumn<Row>]
      : []),
    { key: 'units', header: 'Units (period)', align: 'right', render: (r) => <strong>{fmtNum(r.units)}</strong>, rawValue: (r) => r.units },
    { key: 'unitsPrior', header: 'Units (prior period)', align: 'right', render: (r) => fmtNum(r.unitsPrior), rawValue: (r) => r.unitsPrior },
    { key: 'value', header: 'Sales value', align: 'right', render: (r) => fmtLYD(r.value), rawValue: (r) => r.value },
    ...(profit.view
      ? ([
          { key: 'profit', header: 'Profit', align: 'right', render: (r) => (r.profit == null ? '–' : fmtLYD(r.profit)), rawValue: (r) => r.profit ?? '', sortValue: (r) => r.profit ?? Number.NEGATIVE_INFINITY },
          { key: 'grossProfitPct', header: 'GP%', align: 'right', render: (r) => fmtGp(r.grossProfitPct), rawValue: (r) => r.grossProfitPct ?? '', sortValue: (r) => r.grossProfitPct ?? Number.NEGATIVE_INFINITY },
        ] as DataGridColumn<Row>[])
      : []),
    { key: 'onHandQty', header: 'Qty on hand', align: 'right', render: (r) => fmtNum(r.onHandQty), rawValue: (r) => r.onHandQty },
    { key: 'lastSaleDate', header: 'Last sale', render: (r) => r.lastSaleDate ?? '—', rawValue: (r) => r.lastSaleDate ?? '' },
    ...(status === 'NonActive'
      ? [{ key: 'withStock', header: 'Stock', render: (r: Row) => (r.withStock ? 'Stock · no sales' : 'Sales · no stock'), rawValue: (r: Row) => (r.withStock ? 'Stock · no sales' : 'Sales · no stock') } as DataGridColumn<Row>]
      : []),
    ...(status === 'Dormant'
      ? ([
          { key: 'archived', header: 'Why Dormant', render: (r) => (r.archived ? 'Archived in Odoo' : 'No stock · no sales'), rawValue: (r) => (r.archived ? 'Archived in Odoo' : 'No stock · no sales') },
          { key: 'archivedDate', header: 'Archive date', render: (r) => r.archivedDate ?? 'not loaded', rawValue: (r) => r.archivedDate ?? '' },
        ] as DataGridColumn<Row>[])
      : []),
    ...(status === 'Unclassified'
      ? [{ key: 'exclusionRule', header: 'Exclusion rule', width: 260, render: (r: Row) => <ProductName name={r.exclusionRule ?? '—'} />, rawValue: (r: Row) => r.exclusionRule ?? '' } as DataGridColumn<Row>]
      : []),
    { key: 'odooUrl', header: 'Odoo', render: (r) => (r.odooUrl ? <OdooLink href={r.odooUrl}>Open ↗</OdooLink> : '—'), rawValue: (r) => r.odooUrl ?? '' },
  ];

  const tabStyle = (active: boolean): React.CSSProperties => ({
    border: '1px solid var(--ps-color-border)',
    background: active ? 'var(--ps-color-accent)' : 'transparent',
    color: active ? 'var(--ps-color-on-accent, #fff)' : 'var(--ps-color-text)',
    borderRadius: 999,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  return (
    <PermissionGuard pageKey="bcg_matrix">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader subTitle={`${STATUS_LABEL[status]} products`} anchorDate={anchorDate} onAnchorDateChange={onAnchorDateChange} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />
        <ValidationStatusBar
          isStale={refresh.data?.isStale}
          isInverted={refresh.data?.isInverted}
          refreshCheck={refresh.data?.refreshCheck}
          lastRefreshTime={refresh.data ? formatTimestamp(refresh.data.lastRefreshTime) : undefined}
        />
        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-3, 16px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Link href={backHref} data-testid="status-table-back" style={{ color: 'var(--ps-color-accent)', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
              ← Back to BCG Matrix
            </Link>
            <span style={{ fontSize: 12, color: 'var(--ps-color-muted-text)' }}>
              {companyLabel} · {periodLabel(period)}{period ? ` (${periodDates(period)})` : ''}
            </span>
          </div>
          <PeriodNote period={period} />

          <div role="tablist" aria-label="Product status" data-testid="status-tabs" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {STATUS_KEYS.map((key) => {
              const s = STATUS_OF_KEY[key];
              return (
                <button key={key} type="button" role="tab" aria-selected={key === statusKey} data-testid={`status-tab-${key}`}
                  onClick={() => go(key)} style={tabStyle(key === statusKey)}>
                  {STATUS_LABEL[s]} {list.data ? fmtCount(counts[s]) : ''}
                </button>
              );
            })}
          </div>

          {status === 'NonActive' && list.data && (
            <div role="radiogroup" aria-label="Stock" data-testid="stock-filter" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {([['all', `All ${fmtCount(counts.NonActive)}`], ['with', `Stock · no sales ${fmtCount(withStockCount)}`], ['zero', `Sales · no stock ${fmtCount(zeroStockCount)}`]] as const).map(([key, label]) => (
                <button key={key} type="button" role="radio" aria-checked={stock === key} data-testid={`stock-filter-${key}`}
                  onClick={() => go('non_active', key)} style={{ ...tabStyle(stock === key), fontWeight: 600 }}>
                  {label}
                </button>
              ))}
            </div>
          )}

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 2 }}>
              {STATUS_LABEL[status]} · {STATUS_DEFINITION[status]}
              <VisualInfoIcons title="Product status table" {...vh('product.bcgMatrix.statusTable')} />
            </div>
            <div data-testid="status-table-count" style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 12 }}>
              {fmtCount(rows.length)} SKUs · one row per Odoo product variant · search, sort, filter and export below
            </div>
            {!matches && (
              <div role="alert" data-testid="status-table-mismatch" style={{ fontSize: 12, color: 'var(--ps-color-alert)', marginBottom: 8 }}>
                These rows do not add up to the Product Status cards. Please report this.
              </div>
            )}
            {list.loading ? (
              <LoadingSkeleton variant="table" />
            ) : list.error ? (
              <ErrorState message={list.error} onRetry={list.retry} />
            ) : (
              <DataGrid columns={columns} rows={rows} getRowId={(r) => r.id} pageSize={50}
                fileName={`bcg-matrix-${statusKey.replace('_', '-')}-products`}
                filtersSummary={`${STATUS_LABEL[status]}${status === 'NonActive' && stock !== 'all' ? ` · ${stock === 'with' ? 'With stock' : 'Zero stock'}` : ''} · ${companyLabel} · ${periodLabel(period)}`} />
            )}
          </Card>
        </main>
        <RefreshFooter
          lastUpdate={formatTimestamp(refresh.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refresh.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refresh.data?.lastRefreshTime ?? null)}
        />
        <BottomNavBar active="BCG Matrix" />
      </div>
    </PermissionGuard>
  );
}
