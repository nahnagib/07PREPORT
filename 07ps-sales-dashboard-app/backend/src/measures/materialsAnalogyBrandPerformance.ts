/**
 * PIM Contribution "Brand Performance" card + brand drill-down page metric definition.
 *
 * Migrates both consumers off `frontend/src/lib/materialsAnalogy/data.json` (a ~32% offline
 * sample of the real catalog, confirmed the root cause of undercounted SKU Count/revenue/volume
 * figures for every partner brand -- see that file's own header and materialsAnalogyBcg.ts's
 * precedent for the same kind of migration on this page's BCG Matrix card).
 *
 * Source tables: same live `dim_product` / `fact_bcgmatrix` pair as materialsAnalogyBcg.ts, but
 * joined the other way around. BCG Matrix anchors on `fact_bcgmatrix` (JOIN), which only contains
 * products with at least one valid-invoice sales line -- a zero-sales product never appears there,
 * so anchoring on it would undercount SKU Count for the same reason `data.json` did, just less
 * severely. This measure anchors on `dim_product` (LEFT JOIN to `fact_bcgmatrix`) instead, so every
 * catalog row for a brand counts once, with sales-driven stats defaulting to 0/null for products
 * that haven't sold yet.
 *
 * Cross-company fan-out (found and fixed while building this, not present in BCG Matrix's own
 * query because that page deliberately keeps Company+Product grain -- see its header): confirmed
 * live that `fact_bcgmatrix`'s real grain is (Company, ProductKey), not ProductKey alone -- the
 * same catalog item can have genuine sales recorded under both "Majaal" and "Tika" (e.g. FILA's
 * MJ-SR-FL-SR-... products). A naive `dim_product LEFT JOIN fact_bcgmatrix ON ProductKey` fans out
 * one dim_product row into two, inflating SKU Count (confirmed: FILA's live dim_product count is 8,
 * but a naive join produced 12). Fixed by pre-aggregating fact_bcgmatrix by ProductKey (SUMming
 * value/quantity across companies, revenue-weighting the GP%/ASP ratios) in a subquery before the
 * join, so the join stays strictly 1:1 with dim_product. `Company` on the returned row is therefore
 * `dim_product.Company` (the catalog's own company attribution), not `fact_bcgmatrix.Company` --
 * consistent with the "SKU Count/company split describes the catalog, not the sales ledger" model
 * `computeBrandStats` (materialsAnalogy/shared.ts) already assumes (each row has exactly one
 * Company). 39 ProductKeys warehouse-wide have this cross-company fan-out as of this writing.
 *
 * `bcg_movement` is used downstream only for `skuCountLYTD` (`bcg_movement !== 'New'`, i.e. "existed
 * as of last YTD"). When a product's two company-rows disagree (rare, but possible since
 * BCGMatrixBuilder's volume thresholds are company-specific), the aggregation prefers whichever
 * company-row is NOT 'New' -- a product that existed under either company last year counts as
 * having existed, rather than picking one company's value arbitrarily.
 *
 * No NON_SELLABLE_CATEGORIES filter (unlike BCG Matrix) -- `computeBrandStats` today runs over
 * plain `FACTS`, not `BCG_FACTS`, so Paper Bags/Raw Materials rows are already included for any
 * brand that has them; this migration preserves that, doesn't silently narrow it.
 *
 * No *optional* brand/company/date scoping server-side -- Company/Category/BCG Class filtering on
 * this page stays a client-side concern (`filterFacts`/the page's own filter state), matching BCG
 * Matrix's "fetch everything, filter client-side" model for those page-level filters, unchanged by
 * this migration.
 *
 * RBAC-forced scope is NOT optional, though, and is still applied here: `resolveScopedFilters`
 * (see scopeContext.ts's own header -- "every route that queries measures data MUST go through
 * resolveScopedFilters") forces a SALESPERSON-tier or role-data-scope-restricted caller's
 * segment/channel/salesTeam/salesperson filters even when they request none, which is the
 * data-layer enforcement Standards Section 5.2 requires. Reuses `buildProductScopeClause` exported
 * from materialsAnalogyBcg.ts (same `AND <alias>.ProductKey IN (SELECT DISTINCT ... FROM
 * Fact_SalesLines ...)` narrowing BCG Matrix already applies) rather than reimplementing that
 * security-sensitive logic here -- for an unrestricted caller (the common case) this is a no-op,
 * same as it is for BCG Matrix.
 */

import type { Pool } from 'mysql2/promise';
import { buildProductScopeClause, type BcgProductScope } from './materialsAnalogyBcg';

export interface BrandPerformanceFact {
  ProductKey: string;
  ProductName: string;
  Company: string;
  Category: string | null;
  Brand: string | null;
  bcg_class_YTD: 'Stars' | 'Cash Cows' | 'Strategic' | 'Dogs' | null;
  bcg_movement: 'New' | 'Stable' | 'Improved' | 'Declined' | 'Lost' | null;
  total_value_YTD: number;
  total_value_LYTD: number;
  total_quantity_YTD: number;
  total_quantity_LYTD: number;
  avg_unit_price_YTD: number | null;
  avg_unit_price_LYTD: number | null;
  perc_gross_profit_YTD: number | null;
  perc_gross_profit_LYTD: number | null;
  quantity_growth_pct: number | null;
}

export interface BrandPerformanceOverview {
  facts: BrandPerformanceFact[];
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Preserves SQL NULL as `null` rather than coercing to 0 -- correct for a no-sales product's
 * ASP/GP%/growth (no baseline to compute a ratio from), same convention as
 * materialsAnalogyBcg.ts's toNullableNumber. */
function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Fraction (0.35) -> percentage points (35), null-preserving -- see toNullableNumber. */
function toPercent(value: unknown): number | null {
  const n = toNullableNumber(value);
  return n === null ? null : n * 100;
}

/** `productScope` is the `AND p.ProductKey IN (...)` fragment from buildProductScopeClause (or ''
 * when unscoped) -- applied against `p` (dim_product), not `agg`/`f`, so a scoped caller still sees
 * every catalog row for a product their scope covers, not just the ones with matching sales lines
 * inside the aggregation subquery. */
function buildSql(productScope: string): string {
  return `
  SELECT
    p.ProductKey                     AS productKey,
    p.ProductName                    AS productName,
    p.Company                        AS company,
    p.Category                       AS category,
    p.Brand                          AS brand,
    agg.bcg_class_YTD                AS bcgClassYTD,
    agg.bcg_movement                 AS bcgMovement,
    COALESCE(agg.total_value_YTD, 0)     AS totalValueYTD,
    COALESCE(agg.total_value_LYTD, 0)    AS totalValueLYTD,
    COALESCE(agg.total_quantity_YTD, 0)  AS totalQuantityYTD,
    COALESCE(agg.total_quantity_LYTD, 0) AS totalQuantityLYTD,
    agg.avg_unit_price_YTD           AS avgUnitPriceYTD,
    agg.avg_unit_price_LYTD          AS avgUnitPriceLYTD,
    agg.perc_gross_profit_YTD        AS percGrossProfitYTD,
    agg.perc_gross_profit_LYTD       AS percGrossProfitLYTD,
    agg.quantity_growth_pct          AS quantityGrowthPct
  FROM dim_product p
  LEFT JOIN (
    SELECT
      f.ProductKey,
      MAX(f.bcg_class_YTD) AS bcg_class_YTD,
      COALESCE(
        MAX(CASE WHEN f.bcg_movement IS NOT NULL AND f.bcg_movement <> 'New' THEN f.bcg_movement END),
        MIN(f.bcg_movement)
      ) AS bcg_movement,
      SUM(f.total_value_YTD) AS total_value_YTD,
      SUM(f.total_value_LYTD) AS total_value_LYTD,
      SUM(f.total_quantity_YTD) AS total_quantity_YTD,
      SUM(f.total_quantity_LYTD) AS total_quantity_LYTD,
      SUM(f.total_value_YTD) / NULLIF(SUM(f.total_quantity_YTD), 0) AS avg_unit_price_YTD,
      SUM(f.total_value_LYTD) / NULLIF(SUM(f.total_quantity_LYTD), 0) AS avg_unit_price_LYTD,
      SUM(f.perc_gross_profit_YTD * f.total_value_YTD) / NULLIF(SUM(f.total_value_YTD), 0) AS perc_gross_profit_YTD,
      SUM(f.perc_gross_profit_LYTD * f.total_value_LYTD) / NULLIF(SUM(f.total_value_LYTD), 0) AS perc_gross_profit_LYTD,
      AVG(f.quantity_growth_pct) AS quantity_growth_pct
    FROM fact_bcgmatrix f
    GROUP BY f.ProductKey
  ) agg ON agg.ProductKey = p.ProductKey
  WHERE 1=1
    ${productScope}
`;
}

function mapRowToFact(r: any): BrandPerformanceFact {
  return {
    ProductKey: String(r.productKey),
    ProductName: String(r.productName ?? ''),
    Company: String(r.company ?? ''),
    Category: r.category ?? null,
    Brand: r.brand ?? null,
    bcg_class_YTD: (r.bcgClassYTD as BrandPerformanceFact['bcg_class_YTD']) ?? null,
    bcg_movement: r.bcgMovement ?? null,
    total_value_YTD: toNumber(r.totalValueYTD),
    total_value_LYTD: toNumber(r.totalValueLYTD),
    total_quantity_YTD: toNumber(r.totalQuantityYTD),
    total_quantity_LYTD: toNumber(r.totalQuantityLYTD),
    avg_unit_price_YTD: toNullableNumber(r.avgUnitPriceYTD),
    avg_unit_price_LYTD: toNullableNumber(r.avgUnitPriceLYTD),
    perc_gross_profit_YTD: toPercent(r.percGrossProfitYTD),
    perc_gross_profit_LYTD: toPercent(r.percGrossProfitLYTD),
    quantity_growth_pct: toPercent(r.quantityGrowthPct),
  };
}

export async function computeBrandPerformanceOverview(
  pool: Pool,
  scope?: BcgProductScope,
): Promise<BrandPerformanceOverview> {
  const productScope = buildProductScopeClause(scope, 'p');
  const [rows] = await pool.query(buildSql(productScope.clause), productScope.params);
  return { facts: (rows as any[]).map(mapRowToFact) };
}
