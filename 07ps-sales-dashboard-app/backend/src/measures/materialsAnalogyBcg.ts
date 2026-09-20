/**
 * BCG Matrix page metric definition.
 *
 * Source tables (confirmed live against `powerBI_Data`, same "auto-created from the ETL's sheet
 * keys, not from data/warehouse/migrations/" pattern documented in measures/pipelineHealth.ts's
 * header): `fact_bcgmatrix` is the live product-classification snapshot the Python ETL's
 * BCGMatrixBuilder writes on every scheduled run (both the 3-hour incremental and nightly
 * full-refresh already call it unconditionally -- see data/etl/src/sales_pipeline/pipeline.py),
 * joined to `dim_product` for Category/Brand (also live, same pattern). Both refresh on the
 * existing ETL cadence; this module does no computation of its own beyond the join and the
 * category exclusion below -- volume_class_YTD/profit_class_YTD/bcg_class_YTD/bcg_code_YTD/
 * bcg_movement all arrive precomputed from BCGMatrixBuilder (calendar YTD/LYTD, company-specific
 * HV thresholds, 35% profit threshold -- see legacy_transform.py's BCGMatrixBuilder for the
 * source of truth).
 *
 * Two known gaps in the underlying live data, neither fixed here (out of scope for wiring the
 * read path -- these are Python ETL / source-data issues):
 *   - A slice of rows have `bcg_class_YTD` of NULL or the literal string 'Unclassified' (missing
 *     avg_product_cost_YTD in Dim_ProductCost prevents profit_class_YTD from resolving). The
 *     dashboard's BCG_CLASSES UI only has 4 known classes/colors, so these rows are excluded here
 *     rather than rendered with an undefined class/color -- report the excluded count if asked,
 *     don't silently pretend they don't exist.
 *   - Some rows have a raw perc_gross_profit_YTD of exactly 1.0 (100% once scaled to percentage
 *     points, see toPercent below), almost certainly the same missing-cost issue rather than a
 *     genuine full-margin product. Served as-is; a GP% display at/near 100% for a product should
 *     be read with that caveat.
 *
 * quantity_growth_pct is genuinely NULL (not 0) in fact_bcgmatrix for every product with no LYTD
 * baseline -- BCGMatrixBuilder divides by `lytd_quantity.where(lytd_quantity.ne(0))`, i.e. a
 * missing/zero prior-year quantity produces NaN, not a false 0% (confirmed live: every one of the
 * rows with NULL quantity_growth_pct has bcg_movement='New', and vice versa -- the two fields
 * agree exactly). That NULL is preserved through `toNullableNumber` below rather than coerced to
 * 0 by `toNumber` -- `Number(null) === 0` in JS, so using the same `toNumber` helper here would
 * silently turn "no baseline to compare" into a false "flat" reading on the BCG Matrix bubble
 * chart's Y axis. Every other numeric field is a real value whenever bcg_class_YTD resolves (see
 * above), so `toNumber`'s 0-default stays correct for those.
 *
 * quantity_growth_pct / perc_gross_profit_YTD / perc_gross_profit_LYTD are stored in
 * fact_bcgmatrix as raw ratios (e.g. 0.35), not already-scaled percentage points -- confirmed
 * directly against BCGMatrixBuilder's own Python: `profit.ge(cls.PROFIT_THRESHOLD)` compares the
 * stored value against `PROFIT_THRESHOLD = 0.35` directly, which only makes sense if the field is
 * a 0-1 fraction. `toPercent` below multiplies these three fields by 100 so the API's `_pct`
 * naming is actually true (a consumer formatting `perc_gross_profit_YTD.toFixed(1) + '%'` gets
 * "35.0%", not "0.3%"). This was found and fixed while investigating the BCG bubble chart's
 * Y-axis scaling -- displaying the raw fraction directly is what made the chart's default
 * percentile domain (computed on unscaled values) crush nearly every normal-growth product
 * against the 0% line while a handful of extreme-ratio outliers (small LYTD denominators)
 * stretched the domain into the hundreds.
 */

import type { Pool } from 'mysql2/promise';
import { buildWhereClause, type Filters } from './filters';

/** Categories that are packaging/input material, not a sellable finished product -- same set
 * already enforced client-side in frontend/src/lib/materialsAnalogy/shared.ts's
 * NON_SELLABLE_CATEGORIES. Applied here too so the exclusion holds for every consumer of this
 * query, not just the one page that remembers to filter it client-side. */
const NON_SELLABLE_CATEGORIES = ['Paper Bags', 'Raw Materials'];

const KNOWN_BCG_CLASSES = ['Stars', 'Cash Cows', 'Strategic', 'Dogs'];

/**
 * Optional Customer Group / Distribution Channel / Branch / Salesperson / date-range scoping for
 * the Section 4 filter-bar rollout. Deliberately does NOT recompute BCG classification against
 * the filtered subset's own volume (confirmed with the project owner): fact_bcgmatrix's
 * Stars/Cash Cows/Strategic/Dogs quadrants, Revenue YTD/LYTD, GP%, and Vol Growth all stay exactly
 * what BCGMatrixBuilder computed against the FULL company-wide volume -- a single salesperson's or
 * branch's slice of a product would almost always fall below the HV threshold, so recomputing per
 * filter would reclassify most products toward Strategic/Dogs in a way that reads as a bug, not a
 * real signal. Instead, these filters narrow WHICH already-classified products are shown, by
 * intersecting with the set of ProductKeys that have a matching Fact_SalesLines row -- every number
 * for a product that survives the filter is untouched.
 *
 * `companyKeys` is deliberately not part of `Filters` here even though it exists on the shared
 * type -- this page keeps its own existing Tika/Majaal pill toggle (Company is a 2-value,
 * page-specific control here, per the Materials Analogy convention documented in
 * frontend/src/components/FilterBar.tsx), so the numeric company_key dimension is never read.
 *
 * `fromDate`/`toDate` are the same "narrows the transaction window feeding the product-set
 * membership check" semantics, not a recomputed YTD/LYTD window (confirmed with the project
 * owner) -- every number stays real calendar YTD vs LYTD regardless of what's picked here.
 */
export interface BcgProductScope {
  filters: Pick<Filters, 'segmentKeys' | 'channelKeys' | 'salesTeamKeys' | 'salespersonKeys'>;
  fromDate?: string;
  toDate?: string;
}

/** Builds the `AND <alias>.ProductKey IN (...)` fragment (or '' if no scope is active) that both
 * the classified and discontinued queries below append. Returns '' rather than a no-op `1=1`
 * clause so the common "no filters/date range set" case emits byte-for-byte the same SQL as before
 * this feature existed. Exported so materialsAnalogyBrandPerformance.ts's measure can apply the
 * exact same RBAC-forced product scoping (see resolveScopedFilters/applySalespersonLock) against
 * its own `dim_product`-anchored query instead of duplicating this logic -- this clause is the
 * data-layer permission enforcement Standards Section 5.2 requires, not something safe to
 * reimplement per-file. `productAlias` lets a caller whose main query aliases the product table
 * differently (Brand Performance's query aliases it `p`, not `f`) still emit `p.ProductKey IN
 * (...)` against the correct alias. */
export function buildProductScopeClause(
  scope: BcgProductScope | undefined,
  productAlias = 'f',
): { clause: string; params: Array<string | number> } {
  if (!scope) return { clause: '', params: [] };
  const { clause: dimensionClause, params: dimensionParams } = buildWhereClause(scope.filters, 'fs');
  const extraClauses: string[] = [];
  const extraParams: Array<string | number> = [];
  if (scope.fromDate) {
    extraClauses.push('fs.order_date_date >= ?');
    extraParams.push(scope.fromDate);
  }
  if (scope.toDate) {
    extraClauses.push('fs.order_date_date <= ?');
    extraParams.push(scope.toDate);
  }
  const hasDimensionFilter = dimensionClause !== '1=1';
  if (!hasDimensionFilter && extraClauses.length === 0) return { clause: '', params: [] };

  const clauses = [...(hasDimensionFilter ? [dimensionClause] : []), ...extraClauses];
  return {
    clause: `AND ${productAlias}.ProductKey IN (SELECT DISTINCT fs.ProductKey FROM Fact_SalesLines fs WHERE ${clauses.join(' AND ')})`,
    params: [...(hasDimensionFilter ? dimensionParams : []), ...extraParams],
  };
}

export interface BcgFact {
  ProductKey: string;
  ProductName: string;
  Company: string;
  Category: string | null;
  Brand: string | null;
  /** Null only for a `discontinuedFacts` row (see BcgMatrixOverview) -- real LYTD sales, zero YTD
   * activity, so there's nothing to classify into a quadrant this year. Every row in the plain
   * `facts` array always has one of the 4 known classes (see the query's own WHERE clause). */
  bcg_class_YTD: 'Stars' | 'Cash Cows' | 'Strategic' | 'Dogs' | null;
  bcg_class_LYTD: string | null;
  volume_class_YTD: string | null;
  profit_class_YTD: string | null;
  bcg_code_YTD: string | null;
  bcg_movement: 'New' | 'Stable' | 'Improved' | 'Declined' | 'Lost' | null;
  total_value_YTD: number;
  total_value_LYTD: number;
  total_quantity_YTD: number;
  total_quantity_LYTD: number;
  /** Null means "no LYTD baseline to compare against" (a genuinely new product), not "0% growth"
   * -- see header note. Consumers must treat null distinctly, not display it as 0%. */
  quantity_growth_pct: number | null;
  avg_unit_price_YTD: number;
  avg_unit_price_LYTD: number;
  perc_gross_profit_YTD: number;
  perc_gross_profit_LYTD: number;
}

export interface BcgMatrixOverview {
  facts: BcgFact[];
  /** Products with real LYTD sales but zero YTD activity -- `bcg_movement = 'Lost'` in the
   * pipeline's own BCGMatrixBuilder output (legacy_transform.py), computed there from an outer
   * merge of the YTD/LYTD period frames specifically so products sold in only one period stay
   * visible (see that file's "Outer-merge the periods..." comment). Nothing sold this year means
   * nothing to classify into a quadrant, so these are kept OUT of `facts` (and therefore out of
   * the quadrant KPI cards / matrix cells) but are a real, first-class part of the Portfolio
   * Movement picture -- callers surface them as their own "Discontinued" slice/table rows instead
   * of silently dropping them. `bcg_class_YTD` is null on every row here by construction. */
  discontinuedFacts: BcgFact[];
  /** Rows dropped because bcg_class_YTD didn't resolve to one of the 4 known classes AND the
   * product isn't a `discontinuedFacts` row either (see header note) -- surfaced as a count, not
   * hidden, so a stale/incomplete cost feed stays visible. Excludes `bcg_movement = 'Lost'` rows
   * on purpose: those have their own explicit, non-hidden home in `discontinuedFacts` now, so
   * counting them here too would double-count the same 385 products as both "discontinued" and
   * "unclassified data quality issue," which they aren't -- they're classified correctly as "we
   * don't sell this anymore." */
  unclassifiedCount: number;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Unlike `toNumber`, preserves SQL NULL as `null` instead of coercing it to 0 -- `Number(null)`
 * is 0 in JS, which is correct for fields where "no data" and "genuinely zero" mean the same
 * thing on screen, but wrong for a ratio like quantity_growth_pct where they don't. */
function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Fraction (0.35) -> percentage points (35) -- see header note. Null-preserving like
 * toNullableNumber, since these fields share the same "no baseline" NULL semantics. */
function toPercent(value: unknown): number | null {
  const n = toNullableNumber(value);
  return n === null ? null : n * 100;
}

const SELECT_COLUMNS = `
  f.ProductKey AS productKey,
  f.ProductName AS productName,
  f.Company AS company,
  p.Category AS category,
  p.Brand AS brand,
  f.bcg_class_YTD AS bcgClassYTD,
  f.bcg_class_LYTD AS bcgClassLYTD,
  f.volume_class_YTD AS volumeClassYTD,
  f.profit_class_YTD AS profitClassYTD,
  f.bcg_code_YTD AS bcgCodeYTD,
  f.bcg_movement AS bcgMovement,
  f.total_value_YTD AS totalValueYTD,
  f.total_value_LYTD AS totalValueLYTD,
  f.total_quantity_YTD AS totalQuantityYTD,
  f.total_quantity_LYTD AS totalQuantityLYTD,
  f.quantity_growth_pct AS quantityGrowthPct,
  f.avg_unit_price_YTD AS avgUnitPriceYTD,
  f.avg_unit_price_LYTD AS avgUnitPriceLYTD,
  f.perc_gross_profit_YTD AS percGrossProfitYTD,
  f.perc_gross_profit_LYTD AS percGrossProfitLYTD
`;

function mapRowToFact(r: any): BcgFact {
  return {
    ProductKey: String(r.productKey),
    ProductName: String(r.productName ?? ''),
    Company: String(r.company ?? ''),
    Category: r.category ?? null,
    Brand: r.brand ?? null,
    bcg_class_YTD: (r.bcgClassYTD as BcgFact['bcg_class_YTD']) ?? null,
    bcg_class_LYTD: r.bcgClassLYTD ?? null,
    volume_class_YTD: r.volumeClassYTD ?? null,
    profit_class_YTD: r.profitClassYTD ?? null,
    bcg_code_YTD: r.bcgCodeYTD ?? null,
    bcg_movement: r.bcgMovement ?? null,
    // toNumber (0-default), not toNullableNumber, for these two: a discontinuedFacts row's real
    // YTD activity IS zero (that's the whole point), unlike quantity_growth_pct's "no baseline to
    // compare" NULL below, where 0 would be a false reading.
    total_value_YTD: toNumber(r.totalValueYTD),
    total_value_LYTD: toNumber(r.totalValueLYTD),
    total_quantity_YTD: toNumber(r.totalQuantityYTD),
    total_quantity_LYTD: toNumber(r.totalQuantityLYTD),
    quantity_growth_pct: toPercent(r.quantityGrowthPct),
    avg_unit_price_YTD: toNumber(r.avgUnitPriceYTD),
    avg_unit_price_LYTD: toNumber(r.avgUnitPriceLYTD),
    perc_gross_profit_YTD: toPercent(r.percGrossProfitYTD) ?? 0,
    perc_gross_profit_LYTD: toPercent(r.percGrossProfitLYTD) ?? 0,
  };
}

export async function computeBcgMatrixOverview(pool: Pool, scope?: BcgProductScope): Promise<BcgMatrixOverview> {
  const placeholders = NON_SELLABLE_CATEGORIES.map(() => '?').join(', ');
  const classPlaceholders = KNOWN_BCG_CLASSES.map(() => '?').join(', ');
  const categoryClause = `(p.Category IS NULL OR p.Category NOT IN (${placeholders}))`;
  const productScope = buildProductScopeClause(scope);

  const sql = `
    SELECT ${SELECT_COLUMNS}
    FROM fact_bcgmatrix f
    JOIN dim_product p ON p.ProductKey = f.ProductKey
    WHERE ${categoryClause}
      AND f.bcg_class_YTD IN (${classPlaceholders})
      ${productScope.clause}
  `;
  const [rows] = await pool.query(sql, [...NON_SELLABLE_CATEGORIES, ...KNOWN_BCG_CLASSES, ...productScope.params]);

  // Discontinued: real LYTD sales, zero YTD activity (bcg_movement = 'Lost', see BcgMatrixOverview
  // header) -- entirely excluded by the classified query above since bcg_class_YTD is null on
  // every one of these rows. Fetched separately rather than folded into `facts` so quadrant
  // KPIs/matrix cells never have to filter them back out again downstream. Note: a discontinued
  // product has zero YTD Fact_SalesLines rows by definition, so an active scope's date range only
  // ever narrows this list further when that range reaches back into LYTD dates -- expected, not a
  // bug, given the scope model (see BcgProductScope's header).
  const discontinuedSql = `
    SELECT ${SELECT_COLUMNS}
    FROM fact_bcgmatrix f
    JOIN dim_product p ON p.ProductKey = f.ProductKey
    WHERE ${categoryClause}
      AND f.bcg_movement = 'Lost'
      ${productScope.clause}
  `;
  const [discontinuedRows] = await pool.query(discontinuedSql, [...NON_SELLABLE_CATEGORIES, ...productScope.params]);

  const countSql = `
    SELECT COUNT(*) AS cnt
    FROM fact_bcgmatrix f
    JOIN dim_product p ON p.ProductKey = f.ProductKey
    WHERE ${categoryClause}
      AND (f.bcg_class_YTD IS NULL OR f.bcg_class_YTD NOT IN (${classPlaceholders}))
      AND (f.bcg_movement IS NULL OR f.bcg_movement != 'Lost')
      ${productScope.clause}
  `;
  const [countRows] = await pool.query(countSql, [...NON_SELLABLE_CATEGORIES, ...KNOWN_BCG_CLASSES, ...productScope.params]);
  const unclassifiedCount = toNumber((countRows as any[])[0]?.cnt);

  const facts: BcgFact[] = (rows as any[]).map(mapRowToFact);
  const discontinuedFacts: BcgFact[] = (discontinuedRows as any[]).map(mapRowToFact);

  return { facts, discontinuedFacts, unclassifiedCount };
}
