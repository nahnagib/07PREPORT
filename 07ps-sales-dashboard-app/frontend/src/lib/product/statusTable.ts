import type { ProductDashboardScope, ProductStatus, ProductStatusSkuRow, ProductStatusSummary } from '../api';
import { fmtLYD, fmtUnits } from '../materialsAnalogy/shared';

/**
 * BCG Matrix → status table (/product/bcg-matrix/products, 2026-11-15). The Product Status cards and the Total SKUs chips
 * open the table with ?status=<key> plus the page's Company and Date filters, so the table shows exactly the SKUs the
 * card counted (the API groups them the same way: backend measures skuListOf).
 */
export const STATUS_KEYS = ['active', 'non_active', 'dormant', 'unclassified'] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

export const STATUS_OF_KEY: Record<StatusKey, ProductStatus> = {
  active: 'Active',
  non_active: 'NonActive',
  dormant: 'Dormant',
  unclassified: 'Unclassified',
};
export const STATUS_LABEL: Record<ProductStatus, string> = {
  Active: 'Active',
  NonActive: 'Non Active',
  Dormant: 'Dormant',
  Unclassified: 'Unclassified',
};
export const STATUS_DEFINITION: Record<ProductStatus, string> = {
  Active: 'Units sold and in stock',
  NonActive: 'Units sold but not in stock, OR in stock but not sold',
  Dormant: 'archived, or no stock and no sales',
  Unclassified: 'SKUs not for sale',
};

/** One colour per status: the Total SKUs chips, the status cards and the SKU Trend columns (2026-11-16). */
export const STATUS_COLOR: Record<StatusKey, string> = {
  active: 'var(--ps-color-success)',
  non_active: 'var(--ps-color-watch)',
  dormant: 'var(--ps-color-alert)',
  unclassified: 'var(--ps-color-neutral-text)',
};

export function parseStatusKey(v: string | null | undefined): StatusKey {
  return (STATUS_KEYS as readonly string[]).includes(v ?? '') ? (v as StatusKey) : 'active';
}

/** Non Active sub-filter, the card's "with stock / zero stock" split. */
export type StockFilter = 'all' | 'with' | 'zero';
export function parseStockFilter(v: string | null | undefined): StockFilter {
  return v === 'with' || v === 'zero' ? v : 'all';
}

/** The table page URL for one status with the page's Company + Date filters. */
export function statusTableHref(status: StatusKey, scope: ProductDashboardScope, stock: StockFilter = 'all'): string {
  const params = new URLSearchParams({ status });
  if (scope.company) params.set('company', scope.company);
  if (scope.fromDate) params.set('fromDate', scope.fromDate);
  if (scope.toDate) params.set('toDate', scope.toDate);
  if (stock !== 'all') params.set('stock', stock);
  return `/product/bcg-matrix/products?${params.toString()}`;
}

/** The scope carried in the table page's URL (the BCG page's Company + Date filters). */
export function scopeFromParams(params: { get(name: string): string | null }): ProductDashboardScope {
  const company = params.get('company') ?? undefined;
  const fromDate = params.get('fromDate') ?? undefined;
  const toDate = params.get('toDate') ?? undefined;
  return { ...(company ? { company } : {}), ...(fromDate && toDate ? { fromDate, toDate } : {}) };
}

/** SKUs per status: must equal the cards (statusMatchesCards). */
export function statusCounts(skus: ProductStatusSkuRow[]): Record<ProductStatus, number> {
  const out: Record<ProductStatus, number> = { Active: 0, NonActive: 0, Dormant: 0, Unclassified: 0 };
  for (const r of skus) out[r.status] += 1;
  return out;
}

export function statusMatchesCards(skus: ProductStatusSkuRow[], summary: ProductStatusSummary | null): boolean {
  if (!summary) return false;
  const c = statusCounts(skus);
  const withStock = skus.filter((r) => r.status === 'NonActive' && r.withStock).length;
  return skus.length === summary.total && c.Active === summary.active.count && c.NonActive === summary.nonActive.count
    && c.Dormant === summary.dormant.count && c.Unclassified === summary.unclassified.count && withStock === summary.nonActive.withStock;
}

export function rowsForStatus(skus: ProductStatusSkuRow[], status: ProductStatus, stock: StockFilter = 'all'): ProductStatusSkuRow[] {
  return skus.filter((r) => r.status === status && (status !== 'NonActive' || stock === 'all' || (stock === 'with') === r.withStock));
}

/** "412.3K Unit · LYD 18.6M": the quantity on hand of a status's SKUs and its value (2026-11-16, every status card). */
export function onHandLine(b: { onHandQty?: number; onHandValue?: number }): string {
  return `${fmtUnits(b.onHandQty ?? 0)} · ${fmtLYD(b.onHandValue ?? 0)}`;
}

/** "LYD 57.27": a class's ASP = sales value ÷ units sold in the period, 2 decimals; "–" when nothing was sold. */
export function fmtAsp(value: number, units: number): string {
  if (!units) return '–';
  return `LYD ${(value / units).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
