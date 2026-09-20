import rawFacts from './data.json';

/**
 * Materials Analogy module (Stock Velocity / PIM Contribution / Product Lifecycle) -- shared
 * types, thresholds, formatters, and color mapping for all 3 still-synthetic report pages.
 *
 * `data.json` is synthetic (generated from the real PRODUCTS.xlsx master data, not a live
 * warehouse query -- see docs/mockups/materials-analogy/ for the generation notes) since no
 * Odoo/warehouse extract for stock velocity, PIM contribution, or product lifecycle exists yet.
 * Every other field-facing report on this page (Pipeline Health, etc.) is wired to a real backend
 * endpoint (see lib/hooks.ts's use*Overview pattern) -- these 3 pages are the one place in the app
 * that render real chart/table components against local static data instead. If/when a real
 * backend measure exists for these, only this file's `FACTS` export needs to change to a
 * use*Overview-style hook -- every page component below already treats it as "the data," not
 * "the mock data."
 *
 * BCG Matrix is the exception: it moved off this file's `FACTS`/`classifyBcg` and now fetches
 * live data via `useBcgMatrixOverview` (lib/hooks.ts) from `backend/src/measures/
 * materialsAnalogyBcg.ts`, which queries the real `fact_bcgmatrix` table -- refreshed by the same
 * scheduled ETL as every other live page (see that file's header for the live-table details).
 * `BCG_VOLUME_THRESHOLD`/`BCG_PROFIT_THRESHOLD_PCT`/`classifyBcg` below stay exported as the
 * documented spec (and are still exercised by this file's own `FACTS` computation for internal
 * consistency), but BCG Matrix's page component no longer calls them -- its classification now
 * arrives precomputed from the live pipeline.
 */

export type BcgClass = 'Stars' | 'Cash Cows' | 'Strategic' | 'Dogs';

export interface MaterialsAnalogyFact {
  ProductKey: string;
  ProductName: string;
  Company: 'Tika' | 'Majaal' | 'MAJAAL';
  Category: string;
  Brand: string;
  /** Not present in the current synthetic dataset (every row is effectively blank) -- kept as a
   * real, optional field rather than omitted so PIM Contribution's full hierarchy drill (Company
   * -> Category -> Brand -> SubBrand -> Family -> Size) is honest about the schema this data would
   * have once a real SubBrand source exists, not just hardcoded to 5 levels because the 6th
   * happens to be empty today. See that page's HIERARCHY_LEVELS/normalizeHierarchyValue for how a
   * uniformly-blank level like this gets auto-skipped rather than shown as a single 100% slice. */
  SubBrand?: string | null;
  Family: string;
  Size: string;
  SKU: string;
  IsActive: number;
  bcg_class_YTD: BcgClass;
  /** Same classification, computed from LYTD figures -- exposed so `bcg_movement`'s YTD-vs-LYTD
   * transition is independently checkable, not just an opaque derived label. */
  bcg_class_LYTD: BcgClass;
  volume_class_YTD: 'HV' | 'LV';
  profit_class_YTD: 'HP' | 'LP';
  /** e.g. "HV-HP" -- the raw pre-mapping code, useful for spot-checking the threshold logic
   * itself independent of the Stars/Cash Cows/Strategic/Dogs label. */
  bcg_code_YTD: string;
  bcg_movement: 'New' | 'Stable' | 'Improved' | 'Declined' | 'Lost';
  lifecycle_segment: 'Stars' | 'Cash Cows' | 'Strategic' | 'Dogs' | 'Mature' | 'Discontinued';
  is_mature: boolean;
  is_discontinued: boolean;
  total_value_YTD: number;
  total_value_LYTD: number;
  value_growth_pct: number;
  total_quantity_YTD: number;
  total_quantity_LYTD: number;
  quantity_growth_pct: number;
  avg_unit_price_YTD: number;
  avg_unit_price_LYTD: number;
  perc_gross_profit_YTD: number;
  perc_gross_profit_LYTD: number;
  current_stock_qty: number;
  avg_daily_sales_qty: number;
  days_of_inventory: number;
  first_sale_date: string;
  months_since_first_sale: number;
  last_supply_date: string;
  months_since_last_supply: number;
  last_sale_date: string;
  months_since_last_sale: number;
}

export function normCompany(c: string): 'Tika' | 'Majaal' {
  return c === 'MAJAAL' ? 'Majaal' : (c as 'Tika' | 'Majaal');
}

// ---- BCG classification thresholds -- company-specific, applied per row's own Company, never a
// single global/portfolio-wide cutoff (that was the bug in the first pass: an overall median
// instead of each company's own threshold). Exact values as specified, not derived/estimated. ----
export const BCG_VOLUME_THRESHOLD: Record<'Majaal' | 'Tika', number> = { Majaal: 3500, Tika: 25000 };
export const BCG_PROFIT_THRESHOLD_PCT = 35;

function classifyBcg(qty: number, profitPct: number, company: 'Tika' | 'Majaal') {
  const volumeClass: 'HV' | 'LV' = qty >= BCG_VOLUME_THRESHOLD[company] ? 'HV' : 'LV';
  const profitClass: 'HP' | 'LP' = profitPct >= BCG_PROFIT_THRESHOLD_PCT ? 'HP' : 'LP';
  const bcgClass: BcgClass =
    volumeClass === 'HV' && profitClass === 'HP'
      ? 'Stars'
      : volumeClass === 'HV' && profitClass === 'LP'
        ? 'Cash Cows'
        : volumeClass === 'LV' && profitClass === 'HP'
          ? 'Strategic'
          : 'Dogs';
  return { volumeClass, profitClass, bcgClass, code: `${volumeClass}-${profitClass}` };
}

/** Ordinal "portfolio quality" score used only to decide Improved vs Declined for `bcg_movement`
 * -- Dogs (neither HV nor HP) is worst, Stars (both) is best, Cash Cows/Strategic (exactly one)
 * are equal-ranked lateral positions, so a class change between those two alone is treated as
 * Stable (a lateral move), not an improvement or decline. */
function bcgQualityScore(cls: BcgClass): number {
  return cls === 'Stars' ? 2 : cls === 'Dogs' ? 0 : 1;
}

type RawFact = Omit<MaterialsAnalogyFact, 'bcg_class_LYTD' | 'volume_class_YTD' | 'profit_class_YTD' | 'bcg_code_YTD'>;

export const FACTS: MaterialsAnalogyFact[] = (rawFacts as RawFact[]).map((r) => {
  const company = normCompany(r.Company);
  const ytd = classifyBcg(r.total_quantity_YTD, r.perc_gross_profit_YTD, company);
  const lytd = classifyBcg(r.total_quantity_LYTD, r.perc_gross_profit_LYTD, company);

  let bcg_movement: MaterialsAnalogyFact['bcg_movement'];
  if (r.is_discontinued) {
    bcg_movement = 'Lost';
  } else if (r.months_since_first_sale <= 12) {
    bcg_movement = 'New';
  } else if (ytd.bcgClass === lytd.bcgClass) {
    bcg_movement = 'Stable';
  } else {
    const scoreDelta = bcgQualityScore(ytd.bcgClass) - bcgQualityScore(lytd.bcgClass);
    bcg_movement = scoreDelta > 0 ? 'Improved' : scoreDelta < 0 ? 'Declined' : 'Stable';
  }

  const lifecycle_segment: MaterialsAnalogyFact['lifecycle_segment'] = r.is_discontinued ? 'Discontinued' : r.is_mature ? 'Mature' : ytd.bcgClass;

  return {
    ...r,
    Company: company,
    bcg_class_YTD: ytd.bcgClass,
    bcg_class_LYTD: lytd.bcgClass,
    volume_class_YTD: ytd.volumeClass,
    profit_class_YTD: ytd.profitClass,
    bcg_code_YTD: ytd.code,
    bcg_movement,
    lifecycle_segment,
  };
});

/** Categories that are packaging/input material, not a sellable finished product -- confirmed
 * against the real master data (PRODUCTS.xlsx, Majaal sheet; Tika has neither category), not
 * assumed from UI label text. BCG classification (Stars/Cash Cows/Strategic/Dogs) is a portfolio
 * question about sellable products, so these never belong in a BCG number.
 *
 * Deliberately does NOT filter the base `FACTS` export -- Stock Velocity/PIM Contribution/Product
 * Lifecycle legitimately track these categories' own stock/ASP behavior and were never asked to
 * exclude them. `BCG_FACTS` is the data-layer export the BCG Matrix page (and anything else that
 * does BCG-style classification against this module in the future) should use instead of `FACTS`,
 * so the exclusion can never be forgotten in one chart/table but not another on that page. */
export const NON_SELLABLE_CATEGORIES = new Set(['Paper Bags', 'Raw Materials']);
export const BCG_FACTS: MaterialsAnalogyFact[] = FACTS.filter((r) => !NON_SELLABLE_CATEGORIES.has(r.Category));

// ---- Stock band thresholds (company-specific, per row's own Company -- never a single global
// rule) ----
export const DOH_THRESHOLDS = {
  Tika: { overstock: 60, understock: 30 },
  Majaal: { overstock: 180, understock: 60 },
} as const;

export type StockBand = 'Overstock' | 'Normal' | 'StockOutRisk';

export function stockBand(r: MaterialsAnalogyFact): StockBand {
  const t = DOH_THRESHOLDS[r.Company as 'Tika' | 'Majaal'];
  if (r.days_of_inventory > t.overstock) return 'Overstock';
  if (r.days_of_inventory < t.understock) return 'StockOutRisk';
  return 'Normal';
}

// ---- Formatters (LYD 1.2M / 45K / signed % convention used throughout the report -- the Libyan
// Dinar's ISO code is LYD, not LBD (that's Lebanese Pound); fixed here and renamed so a future
// edit can't reintroduce the wrong code by copying the old function name) ----
export function fmtLYD(v: number): string {
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${sign}LYD ${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}LYD ${(abs / 1e3).toFixed(0)}K`;
  return `${sign}LYD ${abs.toFixed(0)}`;
}

export function fmtNum(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function fmtPct(v: number, digits = 1): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function sum<T>(arr: T[], fn: (r: T) => number): number {
  return arr.reduce((a, r) => a + fn(r), 0);
}

// ---- Colors -- reused CSS custom properties, same set/precedent as pipeline-health's
// FUNNEL_COLORS/CATEGORY_PALETTE constants (frontend/src/app/(departments)/promotion/
// pipeline-health/page.tsx), not new hex codes. Each report page that needs one of these copies
// the reference, same convention every other report page already follows (there is no shared
// exported CHART_PALETTE in @07ps/ui to import instead). */
export const BCG_COLOR: Record<MaterialsAnalogyFact['bcg_class_YTD'], string> = {
  Stars: 'var(--ps-color-gold)',
  'Cash Cows': 'var(--ps-color-success)',
  Strategic: 'var(--ps-color-accent)',
  Dogs: 'var(--ps-color-alert)',
};

export const SEGMENT_COLOR: Record<MaterialsAnalogyFact['lifecycle_segment'], string> = {
  ...BCG_COLOR,
  Mature: 'var(--ps-color-last-year)',
  Discontinued: 'var(--ps-color-neutral-text)',
};

export const CATEGORY_PALETTE = [
  'var(--ps-color-accent)',
  'var(--ps-color-success)',
  'var(--ps-color-gold)',
  'var(--ps-color-watch)',
  'var(--ps-color-alert)',
  'var(--ps-color-last-year)',
  'var(--ps-color-neutral-text)',
];

export const COMPANIES = ['All', 'Majaal', 'Tika'] as const;
export type CompanyFilter = (typeof COMPANIES)[number];

export function distinctSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

// ---- Display names -- see generate step: scratchpad's clean_product_names.py (rule-based, run
// once offline; no LLM call at page-render time). Keyed by ProductKey, ships alongside data.json
// as cleanProductNames.json. Falls back to the raw ProductName for any key the cleaner left
// untouched or that's missing from the map (defensive -- every current key is present). Takes the
// narrow {ProductKey, ProductName} shape rather than the full MaterialsAnalogyFact so it also
// works for the live-data BcgFact rows (backend/src/measures/materialsAnalogyBcg.ts's shape),
// which don't carry every synthetic-only field this type has. ----
export function getDisplayName(displayNames: Record<string, string>, r: { ProductKey: string; ProductName: string }): string {
  return displayNames[r.ProductKey] ?? r.ProductName;
}

// ---- Movement colors -- bcg_movement (New/Stable/Improved/Declined/Lost), same real-token
// convention as BCG_COLOR/SEGMENT_COLOR above. ----
export const MOVEMENT_COLOR: Record<MaterialsAnalogyFact['bcg_movement'], string> = {
  New: 'var(--ps-color-accent)',
  Stable: 'var(--ps-color-success)',
  Improved: 'var(--ps-color-gold)',
  Declined: 'var(--ps-color-alert)',
  Lost: 'var(--ps-color-neutral-text)',
};

/** Presentation-layer rename for BCG Matrix's Portfolio Movement (donut/legend/table/tooltip
 * badges) -- 'Declined' displays as "Drop" and 'Lost' displays as "Discontinued" everywhere that
 * page renders movement text, without touching the underlying `bcg_movement` values themselves
 * (still 'Declined'/'Lost' end to end, matching the live pipeline's own BCGMatrixBuilder output --
 * see legacy_transform.py). Kept separate from MOVEMENT_COLOR (which stays keyed by the raw
 * values and is shared with Product Lifecycle's own bcg_movement usage) so this rename is scoped
 * to BCG Matrix's display layer only, not a data-model change that could affect that other page. */
export const MOVEMENT_LABEL: Record<MaterialsAnalogyFact['bcg_movement'], string> = {
  New: 'New',
  Stable: 'Stable',
  Improved: 'Improved',
  Declined: 'Drop',
  Lost: 'Discontinued',
};

// ---- Page-level Company/Category/BCG Class filtering -- shared between PIM Contribution's
// summary page and its brand drill-down route (a real separate route, not an inline section --
// see pim-contribution/brand/[brand]/page.tsx's header comment) so both apply the exact same
// filter semantics to FACTS instead of two independently-maintained copies that could drift. ----
export interface PimFilters {
  company: CompanyFilter;
  category: string[];
  bcgClass: string;
}

/** Narrow structural subset `filterByPageFilters` needs -- `Category`/`bcg_class_YTD` are nullable
 * here (unlike `MaterialsAnalogyFact`'s non-null versions) so the live `BrandPerformanceFact` type
 * satisfies this too; a null value just never matches an active category/BCG-class filter, same as
 * how a real "Unspecified"/unclassified row already behaved against a non-empty filter list before
 * this generalization. */
export interface PageFilterableRow {
  Company: string;
  Category: string | null;
  bcg_class_YTD: string | null;
}

/** Company/Category/BCG Class predicate shared by every FACTS-based consumer of this page
 * (`filterFacts` below) and the live Brand Performance data (pim-contribution/page.tsx,
 * pim-contribution/brand/[brand]/page.tsx) -- one implementation instead of two independently
 * maintained copies that could drift. */
export function filterByPageFilters<T extends PageFilterableRow>(rows: T[], filters: PimFilters): T[] {
  return rows.filter(
    (r) =>
      (filters.company === 'All' || r.Company === filters.company) &&
      (filters.category.length === 0 || (r.Category !== null && filters.category.includes(r.Category))) &&
      (filters.bcgClass === 'All' || r.bcg_class_YTD === filters.bcgClass),
  );
}

export function filterFacts(rows: MaterialsAnalogyFact[], filters: PimFilters): MaterialsAnalogyFact[] {
  return filterByPageFilters(rows, filters);
}

/** Partner brand tracking list (PIM Contribution's Brand Performance section) -- the 8 names as
 * given, matched against the real `Brand` field values actually present in the product master
 * data (36 distinct values in data.json). Confirmed via a case-insensitive scan plus a
 * Levenshtein-distance check against every real Brand value -- none of the 8 names match verbatim,
 * so a literal exact-string match would have wrongly reported all 8 as missing. 5 of 8 have a
 * real, unambiguous match (casing/spelling differences only); the other 3 (VitrA, RAK CERAMICS,
 * Porcelanosa) have no reasonable candidate at all -- their closest real Brand values by edit
 * distance (HIDRA, Germa, ARCANA respectively) are unrelated brands with coincidental letter
 * overlap, not spelling variants. Kept in the list with `matched: null` and rendered as "not
 * currently stocked" rather than silently dropped, since whoever compiled this list has a real
 * reason to expect all 8 to be tracked.
 *
 * Exported from here (not kept page-local) because both the summary page's brand cards and the
 * brand drill-down route need the same 8-name canonical list and matching -- `requested` is the
 * ONLY name that should ever appear in either view; `matched` is purely a data-matching detail,
 * never surfaced as a second name string in the UI. */
export interface PartnerBrand {
  requested: string;
  /** Real Brand value as stored in the data, or null if no reasonable match exists. */
  matched: string | null;
}

export const PARTNER_BRANDS: PartnerBrand[] = [
  { requested: 'Ape Grupo', matched: 'APE' },
  { requested: 'VitrA', matched: null },
  { requested: 'Onyx', matched: 'ONIX' },
  { requested: 'Mayor', matched: 'MAYOR' },
  { requested: 'QUA', matched: 'QUA' },
  { requested: 'RAK CERAMICS', matched: null },
  { requested: 'Porcelanosa', matched: null },
  { requested: 'FILA', matched: 'FILA' },
];

/** URL-safe slug for a partner brand's canonical `requested` name, e.g. "Ape Grupo" -> "ape-grupo"
 * -- used for the brand drill-down route (`/product/pim-contribution/brand/[brand]`). */
export function slugifyBrand(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function findPartnerBrandBySlug(slug: string): PartnerBrand | undefined {
  return PARTNER_BRANDS.find((b) => slugifyBrand(b.requested) === slug);
}

export interface BrandCompanySplit {
  company: string;
  revenueYTD: number;
  pct: number;
}

export interface FoundBrandStats extends PartnerBrand {
  matched: string;
  revenueYTD: number;
  revenueLYTD: number;
  deltaPct: number;
  volumeYTD: number;
  asp: number;
  gp: number;
  skuCount: number;
  /** Count of this brand's SKUs that already existed as of the prior YTD period -- i.e. every
   * matched row EXCEPT ones classified `bcg_movement === 'New'` (first sale within the last 12
   * months, so it wasn't part of the brand's portfolio LYTD). Reuses the movement classification
   * FACTS already computes above rather than introducing a second, parallel definition of "existed
   * last year." `skuCount` itself (YTD) is unchanged -- this is purely the LYTD counterpart so a
   * card can show portfolio breadth change over time. */
  skuCountLYTD: number;
  companySplit: BrandCompanySplit[];
}

/** Narrow structural subset of the fields `computeBrandStats` actually reads -- lets it accept
 * either the synthetic `MaterialsAnalogyFact[]` (data.json/FACTS, still used by Stock Velocity/
 * Product Lifecycle/this page's own hierarchy drill-down) or the live `BrandPerformanceFact[]`
 * (backend/src/measures/materialsAnalogyBrandPerformance.ts, api.ts) without either type needing to
 * extend the other. `perc_gross_profit_YTD` stays non-null here -- the live type's nullable version
 * (no sales activity yet) gets coerced to 0 at the call site (page.tsx/brand/[brand]/page.tsx), not
 * inside this function, since a no-sales row's `total_value_YTD` is already 0 and the weighted-GP
 * formula below multiplies by it either way. */
export interface BrandStatsRow {
  Brand: string | null;
  Company: string;
  total_value_YTD: number;
  total_value_LYTD: number;
  total_quantity_YTD: number;
  perc_gross_profit_YTD: number;
  bcg_movement: MaterialsAnalogyFact['bcg_movement'] | null;
}

/** Computes every found partner brand's stats against an already-filtered row set (respecting
 * whatever Company/Category/BCG Class scope the caller applied via `filterFacts`) -- shared by the
 * summary page's brand cards and the brand drill-down route's own header stats, so both always
 * agree on Revenue YTD/deltaPct/etc. for a given filter scope instead of two independently
 * computed copies. GP% is revenue-weighted (sum(gp * value) / sum(value)), not a plain average of
 * each row's own GP% -- a brand's blended margin should be dominated by its high-revenue SKUs, not
 * diluted by a handful of tiny ones. */
export function computeBrandStats(rows: BrandStatsRow[]): { found: FoundBrandStats[]; notFound: PartnerBrand[] } {
  const found = PARTNER_BRANDS.filter((b): b is PartnerBrand & { matched: string } => b.matched !== null)
    .map((b) => {
      const brandRows = rows.filter((r) => r.Brand === b.matched);
      const revenueYTD = sum(brandRows, (r) => r.total_value_YTD);
      const revenueLYTD = sum(brandRows, (r) => r.total_value_LYTD);
      const volumeYTD = sum(brandRows, (r) => r.total_quantity_YTD);
      const companyRevenue = new Map<string, number>();
      brandRows.forEach((r) => {
        const co = normCompany(r.Company);
        companyRevenue.set(co, (companyRevenue.get(co) ?? 0) + r.total_value_YTD);
      });
      const companySplit: BrandCompanySplit[] = [...companyRevenue.entries()]
        .sort((a, c) => c[1] - a[1])
        .map(([co, rev]) => ({ company: co, revenueYTD: rev, pct: revenueYTD > 0 ? (rev / revenueYTD) * 100 : 0 }));
      return {
        ...b,
        matched: b.matched,
        revenueYTD,
        revenueLYTD,
        deltaPct: revenueLYTD > 0 ? ((revenueYTD - revenueLYTD) / revenueLYTD) * 100 : 0,
        volumeYTD,
        asp: volumeYTD > 0 ? revenueYTD / volumeYTD : 0,
        gp: revenueYTD > 0 ? sum(brandRows, (r) => r.perc_gross_profit_YTD * r.total_value_YTD) / revenueYTD : 0,
        skuCount: brandRows.length,
        skuCountLYTD: brandRows.filter((r) => r.bcg_movement !== 'New').length,
        companySplit,
      };
    })
    .sort((a, c) => c.revenueYTD - a.revenueYTD);
  const notFound = PARTNER_BRANDS.filter((b) => b.matched === null);
  return { found, notFound };
}
