/**
 * Product page targets (2026-11-15). Served to the pages in the product dashboard's `thresholds.freshness_targets` --
 * never hard-coded in a component.
 *
 * Portfolio Freshness target per company, in % of the company's portfolio (Active + Non Active SKUs): at or above the
 * target = On Track, below = Below Target. Company names match v_sales_product_dashboard.Company (case-insensitive).
 */
export const FRESHNESS_TARGET_PCT: Readonly<Record<string, number>> = Object.freeze({
  Tika: 10,
  Majaal: 20,
});
