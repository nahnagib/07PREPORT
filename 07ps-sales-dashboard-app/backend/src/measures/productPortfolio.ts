/**
 * One definition of "our products" -- the ETL's product_status() (data/etl product_dashboard.py) mirrored.
 *
 * Every SKU is in exactly one bucket, checked in this order (2026-11-15 rules):
 *   1. Unclassified  SKUs not for sale: an active ProductExclusions.xlsx rule (Products / Categories Exclude, no Products
 *                    Keep) or the automatic Raw Materials category -- the ETL's ExcludedByProduct / ExcludedByCategory
 *   2. Dormant       archived in Odoo (IsActive = 0)
 *   3. Active        sales in the selected period AND stock on hand > 0
 *   4. Non Active    sales but no stock, OR stock but no sales
 *   5. Dormant       no stock AND no sales
 * Stock = Odoo Quantity On Hand (OnHandQty) of the ETL's last refresh: the warehouse keeps no stock history.
 * The PORTFOLIO is Active + Non Active: every Product page calculation, chart, ranking, share, BCG and export uses it.
 * Dormant and Unclassified are counted only by Total SKUs, their own cards and the status table's own tabs.
 */
export type ProductStatus = 'Unclassified' | 'Dormant' | 'Active' | 'NonActive';
export const PRODUCT_STATUSES: ProductStatus[] = ['Unclassified', 'Dormant', 'Active', 'NonActive'];
export const PORTFOLIO_STATUSES: readonly ProductStatus[] = ['Active', 'NonActive'];

export function isPortfolioStatus(status: string | null | undefined): status is 'Active' | 'NonActive' {
  return status === 'Active' || status === 'NonActive';
}

const flag = (v: unknown) => v !== null && v !== undefined && Number(v) === 1;

/** Steps 3-5: a live (not archived, not excluded) SKU from its sales in the period and its stock on hand. */
export function statusFromSalesAndStock(sold: boolean, inStock: boolean): 'Active' | 'NonActive' | 'Dormant' {
  if (sold && inStock) return 'Active';
  if (sold || inStock) return 'NonActive';
  return 'Dormant';
}

export function isArchivedRow(row: Record<string, unknown> | undefined): boolean {
  return Boolean(row) && row!.IsActive !== null && row!.IsActive !== undefined && Number(row!.IsActive) === 0;
}

export function isExcludedRow(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false;
  return flag(row.ExcludedByProduct) || flag(row.ExcludedByCategory) || row.ProductStatus === 'Unclassified';
}

/** A v_sales_product_dashboard row's bucket for the period (`sold` = sold in the selected period). */
export function productStatusOf(row: Record<string, unknown> | undefined, sold: boolean): ProductStatus {
  if (!row) return sold ? 'NonActive' : 'Dormant'; // a sale of a product missing from the catalog: no stock known
  if (isExcludedRow(row)) return 'Unclassified';
  if (isArchivedRow(row)) return 'Dormant';
  const onHand = Number(row.OnHandQty);
  return statusFromSalesAndStock(sold, Number.isFinite(onHand) && onHand > 0);
}

/** A SKU's bucket from its company rows (a variant in both companies is one SKU): any Unclassified row > every row Dormant
 * > Active > Non Active. (combineSkuStatus in productDashboard.ts applies the full rule to the summed stock and sales.) */
export function combineStatuses(statuses: (string | null)[]): ProductStatus {
  if (statuses.includes('Unclassified')) return 'Unclassified';
  if (statuses.length > 0 && statuses.every((s) => s === 'Dormant')) return 'Dormant';
  if (statuses.includes('Active')) return 'Active';
  return 'NonActive';
}
