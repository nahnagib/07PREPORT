/**
 * One definition of "our products" (2026-11-15) -- the ETL's product_status() (data/etl product_dashboard.py) mirrored.
 *
 * Every SKU is in exactly one bucket, first match wins:
 *   1. Unclassified  an active ProductExclusions.xlsx rule (Products / Categories Exclude, no Products Keep) or the automatic
 *                    Raw Materials category -- the ETL's ExcludedByProduct / ExcludedByCategory flags or ProductStatus
 *   2. Dormant       archived in Odoo (IsActive = 0, or the ETL said Dormant)
 *   3. Active        sold in the selected period
 *   4. Non Active    not sold in the selected period (never sold included)
 * The PORTFOLIO is Active + Non Active: every Product page calculation, chart, ranking, share and export uses it. Dormant and
 * Unclassified are counted only by Total SKUs, their own cards and the status table's own tabs.
 */
export type ProductStatus = 'Unclassified' | 'Dormant' | 'Active' | 'NonActive';
export const PRODUCT_STATUSES: ProductStatus[] = ['Unclassified', 'Dormant', 'Active', 'NonActive'];
export const PORTFOLIO_STATUSES: readonly ProductStatus[] = ['Active', 'NonActive'];

export function isPortfolioStatus(status: string | null | undefined): status is 'Active' | 'NonActive' {
  return status === 'Active' || status === 'NonActive';
}

const flag = (v: unknown) => v !== null && v !== undefined && Number(v) === 1;

/** A v_sales_product_dashboard row's bucket for the period (`sold` = sold in the selected period). */
export function productStatusOf(row: Record<string, unknown> | undefined, sold: boolean): ProductStatus {
  if (!row) return sold ? 'Active' : 'NonActive';
  const etl = row.ProductStatus === null || row.ProductStatus === undefined ? null : String(row.ProductStatus);
  if (flag(row.ExcludedByProduct) || flag(row.ExcludedByCategory) || etl === 'Unclassified') return 'Unclassified';
  const archived = row.IsActive !== null && row.IsActive !== undefined && Number(row.IsActive) === 0;
  if (etl === 'Dormant' || archived) return 'Dormant';
  return sold ? 'Active' : 'NonActive';
}

/** A SKU's bucket from its company rows (a variant in both companies is one SKU): any Unclassified row > any Active row >
 * all rows Dormant > Non Active. */
export function combineStatuses(statuses: (string | null)[]): ProductStatus {
  if (statuses.includes('Unclassified')) return 'Unclassified';
  if (statuses.includes('Active')) return 'Active';
  if (statuses.length > 0 && statuses.every((s) => s === 'Dormant')) return 'Dormant';
  return 'NonActive';
}
