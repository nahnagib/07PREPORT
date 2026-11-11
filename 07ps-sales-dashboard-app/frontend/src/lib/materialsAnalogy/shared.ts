import type { AgingBucketAmount, BcgMovement, LifecycleSegment, ProductCompanyPart, ProductDashboardOverview, ProductDashboardRow, StockBand, UomQty } from '../api';

/**
 * Product pages (BCG Matrix / Stock Velocity / PIM Contribution / Product Lifecycle) -- shared types,
 * formatters and colors. All four pages read live data from `useProductDashboard` (lib/hooks.ts),
 * served by backend/src/measures/productDashboard.ts from tables the ETL rebuilds on every run
 * (data/etl/src/sales_pipeline/product_dashboard.py). There is no local/sample product data any more:
 * every threshold (BCG volume/profit, days-of-inventory bands, lifecycle rule) is applied by the ETL
 * from data/etl/config/product_dashboard.json and arrives precomputed.
 *
 * One product = one Odoo product (product.product id) in ONE company; `id` is that key ('Majaal|2163'). Products are
 * never combined across companies (2026-11-04). Every attribute is Odoo's value as stored, 'Unassigned' where Odoo
 * has none. Nothing is matched or grouped on a product name. Athena is not on the Product pages (left out by the ETL
 * and the API; PRODUCT_EXCLUDED_COMPANIES drops it from the page filters too). Every Product visual is based on VOLUME
 * (invoiced quantity), always added up as "Unit" whatever the Odoo UoM (2026-11-07); revenue is secondary.
 */

/** Companies never shown on the Product pages (same list as the ETL / API). */
export const PRODUCT_EXCLUDED_COMPANIES = ['Athena'];
export const isProductPageCompany = (name: string | null | undefined) => !PRODUCT_EXCLUDED_COMPANIES.includes(String(name ?? ''));

/** Customer Groups that are not real sales (3 Backoffice, 4 Inter Company): the ETL drops their lines from every Product
 * table (config product_pages_excluded_segment_keys), so they are never offered in the Product pages' Customer Group filter. */
export const PRODUCT_EXCLUDED_SEGMENT_KEYS = [3, 4];
export const isProductPageSegment = (segmentKey: unknown) => !PRODUCT_EXCLUDED_SEGMENT_KEYS.includes(Number(segmentKey));

export const BCG_CLASSES = ['Stars', 'Cash Cows', 'Strategic', 'Dogs'] as const;
export type BcgClass = (typeof BCG_CLASSES)[number];
export const UNCLASSIFIED_NO_COST = 'Unclassified (no cost)';
export const UNCLASSIFIED_ZERO_REVENUE = 'Unclassified (zero revenue)';

export interface ProductFact {
  /** Company|Odoo product id -- the product's identity. */
  id: string;
  /** Opens the product in Odoo (new tab, OdooLink); null without a link. */
  odooUrl: string | null;
  ProductKey: string | null;
  ProductName: string;
  OdooProductName: string | null;
  Company: 'Majaal' | 'Tika' | string;
  Category: string | null;
  Brand: string | null;
  SubBrand: string | null;
  Family: string | null;
  Size: string | null;
  SKU: string | null;
  IsActive: number | null;
  // -- period (follows the date range; default calendar YTD) --
  value: number;
  /** Invoiced quantity of the period, added up as "Unit" across UoMs. */
  volume: number;
  volumeByUom: UomQty[];
  uom: string | null;
  velocity: number | null;
  /** Distinct order dates in the period (how often the product sells). */
  orderDays: number;
  valuePrior: number;
  volumePrior: number;
  avgUnitPrice: number | null;
  grossProfitPct: number | null;
  // -- BCG (calendar YTD vs LYTD, as of the last ETL run) --
  bcg_class_YTD: string | null;
  bcg_class_LYTD: string | null;
  /** The data the class is computed on: the product's latest fully costed window (calendar YTD, else its latest year). */
  bcgVolume: number | null;
  bcgProfit: number | null;
  bcgGrossProfitPct: number | null;
  /** 'YTD 2026' or '2025'; null = no profit data in the database. */
  bcgDataPeriod: string | null;
  bcgDataAsOf: string | null;
  bcg_movement: BcgMovement | null;
  bcgExcludedCategory: boolean;
  total_value_YTD: number;
  total_value_LYTD: number;
  total_quantity_YTD: number;
  total_quantity_LYTD: number;
  avg_unit_price_YTD: number | null;
  perc_gross_profit_YTD: number | null;
  quantity_growth_pct: number | null;
  // -- stock & lifecycle (as of the last ETL run) --
  stockQty: number;
  stockValue: number;
  inTransitQty: number;
  inTransitValue: number;
  avgDailySales: number;
  daysOfInventory: number | null;
  stockBand: StockBand;
  stockAgeDays: number | null;
  stockAgeBucket: string | null;
  /** Odoo's On Hand in the product's company (every internal location) and its value. */
  onHandQty: number;
  onHandValue: number;
  stockAgeOldestDays: number | null;
  agingBuckets: AgingBucketAmount[];
  lifecycle: LifecycleSegment;
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  daysSinceLastSale: number | null;
  /** Always [Company]; parts = the row's own period sales (one company). */
  Companies: string[];
  parts: ProductCompanyPart[];
}

function daysBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function toProductFacts(data: ProductDashboardOverview | null | undefined): ProductFact[] {
  if (!data) return [];
  return data.products.filter((r) => isProductPageCompany(r.company)).map((r: ProductDashboardRow) => ({
    id: r.productCompanyKey,
    odooUrl: r.odooUrl ?? null,
    ProductKey: r.productKey,
    ProductName: r.productName,
    OdooProductName: r.odooProductName,
    Company: r.company,
    Category: r.category,
    Brand: r.brand,
    SubBrand: r.subBrand,
    Family: r.family,
    Size: r.size,
    SKU: r.sku,
    IsActive: r.isActive,
    value: r.value,
    volume: r.volume,
    volumeByUom: r.volumeByUom,
    uom: r.uom,
    velocity: r.velocity,
    orderDays: r.orderDays ?? 0,
    valuePrior: r.valuePrior,
    volumePrior: r.volumePrior,
    avgUnitPrice: r.avgUnitPrice,
    grossProfitPct: r.grossProfitPct,
    bcg_class_YTD: r.bcgClassYTD,
    bcg_class_LYTD: r.bcgClassLYTD,
    bcgVolume: r.bcgVolume ?? null,
    bcgProfit: r.bcgProfit ?? null,
    bcgGrossProfitPct: r.bcgGrossProfitPct ?? null,
    bcgDataPeriod: r.bcgDataPeriod ?? null,
    bcgDataAsOf: r.bcgDataAsOf ?? null,
    bcg_movement: r.bcgMovement,
    bcgExcludedCategory: r.bcgExcludedCategory,
    total_value_YTD: r.valueYTD,
    total_value_LYTD: r.valueLYTD,
    total_quantity_YTD: r.volumeYTD,
    total_quantity_LYTD: r.volumeLYTD,
    avg_unit_price_YTD: r.volumeYTD ? r.valueYTD / r.volumeYTD : null,
    perc_gross_profit_YTD: r.grossProfitPctYTD,
    quantity_growth_pct: r.volumeLYTD > 0 ? ((r.volumeYTD - r.volumeLYTD) / r.volumeLYTD) * 100 : null,
    stockQty: r.stockQty,
    stockValue: r.stockValue,
    inTransitQty: r.inTransitQty,
    inTransitValue: r.inTransitValue,
    avgDailySales: r.avgDailySales,
    daysOfInventory: r.daysOfInventory,
    stockBand: r.stockBand,
    stockAgeDays: r.stockAgeDays ?? null,
    stockAgeBucket: r.stockAgeBucket ?? null,
    onHandQty: r.onHandQty ?? 0,
    onHandValue: r.onHandValue ?? 0,
    stockAgeOldestDays: r.stockAgeOldestDays ?? null,
    agingBuckets: r.agingBuckets ?? [],
    lifecycle: r.lifecycleSegment,
    firstSaleDate: r.firstSaleDate,
    lastSaleDate: r.lastSaleDate,
    daysSinceLastSale: daysBetween(r.lastSaleDate, data.asOfDate),
    Companies: r.companies ?? [r.company],
    parts: r.parts ?? [],
  }));
}

/** Rows that belong in a BCG quadrant: one of the 4 classes, not a packaging/raw-material category. */
export function isBcgClassified(r: ProductFact): r is ProductFact & { bcg_class_YTD: BcgClass } {
  return !r.bcgExcludedCategory && BCG_CLASSES.includes(r.bcg_class_YTD as BcgClass);
}

// ---- Formatters (Libyan Dinar ISO code is LYD) ----
export function fmtLYD(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${sign}LYD ${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}LYD ${(abs / 1e3).toFixed(0)}K`;
  return `${sign}LYD ${abs.toFixed(0)}`;
}

export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

/** Quantities in different units of measure are never added together: "12.3K UNIT · 450 m²". */
export function sumByUom(rows: { volumeByUom: UomQty[] }[]): UomQty[] {
  const acc = new Map<string, number>();
  rows.forEach((r) => r.volumeByUom.forEach(({ uom, qty }) => acc.set(uom, (acc.get(uom) ?? 0) + qty)));
  return [...acc.entries()].map(([uom, qty]) => ({ uom, qty })).sort((a, b) => b.qty - a.qty);
}

/** Odoo unit names can be Arabic ("وحدة", "كيس"): each "qty unit" item is wrapped in Unicode bidi
 * isolates (FSI ... PDI) so a right-to-left unit never reorders the numbers around it. */
const isolate = (text: string) => `⁨${text}⁩`;

export function fmtUomQty(list: UomQty[], max = 3): string {
  if (!list.length) return '0';
  const shown = list.slice(0, max).map(({ uom, qty }) => isolate(`${fmtNum(qty)}${uom ? ` ${uom}` : ''}`));
  return list.length > max ? `${shown.join(' · ')} · +${list.length - max} more` : shown.join(' · ');
}

/** Label of a quantity added up across units of measure. */
export const UNIT_LABEL = 'Unit';
/** A quantity added up across products / UoMs: "12.3K Unit". */
export function fmtUnits(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${fmtNum(v)} ${UNIT_LABEL}`;
}

/** One product's period volume with its own UoM name ("Unit" when it sold in several UoMs). */
export function fmtVolume(r: Pick<ProductFact, 'volume' | 'uom'>): string {
  return isolate(`${fmtNum(r.volume)} ${r.uom || UNIT_LABEL}`);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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

export function distinctSorted(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
}

// ---- Colors (existing design tokens) ----
export const BCG_COLOR: Record<string, string> = {
  Stars: 'var(--ps-color-gold)',
  'Cash Cows': 'var(--ps-color-success)',
  Strategic: 'var(--ps-color-accent)',
  Dogs: 'var(--ps-color-alert)',
  [UNCLASSIFIED_NO_COST]: 'var(--ps-color-neutral-text)',
  [UNCLASSIFIED_ZERO_REVENUE]: 'var(--ps-color-neutral-text)',
};

/** BCG class definitions from the ETL's own thresholds (config/product_dashboard.json, served as overview.thresholds). */
export interface BcgThresholds {
  volume: Record<string, number>;
  profitPct: number | null;
  /** Product Movement: Stable band (± %) and "New" = first sale within these days. */
  movementBandPct: number | null;
  newWithinDays: number | null;
}
export function bcgThresholds(thresholds: Record<string, unknown> | undefined): BcgThresholds {
  const bcg = (thresholds?.bcg ?? {}) as { volume_threshold?: Record<string, number>; profit_threshold_pct?: number; movement_stable_band_pct?: number };
  const lifecycle = (thresholds?.lifecycle ?? {}) as { new_first_sale_within_days?: number };
  const volume = Object.fromEntries(Object.entries(bcg.volume_threshold ?? {}).filter(([company]) => isProductPageCompany(company)));
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    volume,
    profitPct: num(bcg.profit_threshold_pct),
    movementBandPct: num(bcg.movement_stable_band_pct),
    newWithinDays: num(lifecycle.new_first_sale_within_days),
  };
}

/** "Majaal 3,500 / Tika 25,000 units" -- the config volume thresholds. */
const volumeValues = (t: BcgThresholds) => {
  const parts = Object.entries(t.volume).map(([company, v]) => `${company} ${v.toLocaleString('en-US')}`);
  return parts.length ? `${parts.join(' / ')} units` : 'the company threshold';
};
const gpRule = (t: BcgThresholds) => (t.profitPct === null ? 'the GP% threshold' : `${t.profitPct}%`);
/** The Product Movement rule in one line, with the config values (the "?" of the Product Movement donut). */
export function movementRule(t: BcgThresholds): string {
  const band = t.movementBandPct === null ? 'X%' : `${t.movementBandPct}%`;
  const days = t.newWithinDays === null ? 'N days' : `${t.newWithinDays} days`;
  return `Improved > +${band} · Drop < −${band} · Stable within ±${band} · New = first sale ≤ ${days} or no LYTD · archived Odoo products are left out`;
}

/** The BCG class rule in one line, with the config thresholds (the "?" of the BCG page). */
export function bcgClassRule(t: BcgThresholds): string {
  return `High volume = Volume ≥ ${volumeValues(t)} · High profit = GP% ≥ ${gpRule(t)}`;
}
export function bcgClassDefinition(cls: string, t: BcgThresholds): string {
  switch (cls) {
    case 'Stars':
      return `Volume ≥ ${volumeValues(t)}, GP% ≥ ${gpRule(t)}`;
    case 'Cash Cows':
      return `Volume ≥ ${volumeValues(t)}, GP% < ${gpRule(t)}`;
    case 'Strategic':
      return `Volume < ${volumeValues(t)}, GP% ≥ ${gpRule(t)}`;
    case 'Dogs':
      return `Volume < ${volumeValues(t)}, GP% < ${gpRule(t)}`;
    case UNCLASSIFIED_ZERO_REVENUE:
      return 'Gross profit margin is undefined at zero revenue';
    default:
      return 'No sale with a standard cost in the database, so profit cannot be calculated';
  }
}
/** What to do with each class (category info / tooltips). A Dog is NOT an automatic discontinue. */
export const BCG_RECOMMENDATION: Record<BcgClass, string> = {
  Stars: 'Protect availability, keep investing, support growth, monitor.',
  'Cash Cows': 'Review pricing, discounts, cost structure, supplier terms and channel profitability.',
  Strategic: 'Protect profitability, look for ways to grow volume, avoid unnecessary discounting.',
  Dogs: 'Review before deciding to retain, improve, reposition or discontinue. A Dog is not an automatic discontinue: it may matter for strategic, seasonal, contractual or assortment reasons.',
};

export const LIFECYCLE_SEGMENTS: LifecycleSegment[] = ['New', 'Growing', 'Mature', 'Declining', 'Discontinued', 'Never sold'];
export const SEGMENT_COLOR: Record<LifecycleSegment, string> = {
  New: 'var(--ps-color-accent)',
  Growing: 'var(--ps-color-success)',
  Mature: 'var(--ps-color-gold)',
  Declining: 'var(--ps-color-watch)',
  Discontinued: 'var(--ps-color-neutral-text)',
  'Never sold': 'var(--ps-color-muted-text)',
};

export const STOCK_BAND_LABEL: Record<StockBand, string> = {
  Overstock: 'Overstock',
  NoMovement: 'No movement',
  Normal: 'Normal',
  StockOutRisk: 'Stock-out risk',
  NoStockNoSales: 'No stock, no sales',
};
/** "Overstocked" = over the company's days-of-inventory threshold OR stock with no sales in the look-back. */
export function isOverstocked(r: ProductFact): boolean {
  return r.stockBand === 'Overstock' || r.stockBand === 'NoMovement';
}

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

/** Product Movement colours: Improved green, Stable yellow, Drop red, New accent, Discontinued grey. */
export const MOVEMENTS: BcgMovement[] = ['New', 'Stable', 'Improved', 'Drop', 'Discontinued'];
export const MOVEMENT_COLOR: Record<BcgMovement, string> = {
  New: 'var(--ps-color-accent)',
  Stable: 'var(--ps-color-gold)',
  Improved: 'var(--ps-color-success)',
  Drop: 'var(--ps-color-alert)',
  Discontinued: 'var(--ps-color-neutral-text)',
};

export const MOVEMENT_LABEL: Record<BcgMovement, string> = {
  New: 'New',
  Stable: 'Stable',
  Improved: 'Improved',
  Drop: 'Drop',
  Discontinued: 'Discontinued',
};

// ---- Page-level Company / Category / BCG Class filtering (PIM Contribution + its brand drill-down) ----
export interface PimFilters {
  company: CompanyFilter;
  category: string[];
  bcgClass: string;
}

/** The company itself is applied by the API (company view vs all companies); `company` here only drops rows of
 * another company if a company-view response is mixed with an older one. */
export function filterByPageFilters<T extends { Company: string; Companies?: string[]; Category: string | null; bcg_class_YTD: string | null }>(
  rows: T[],
  filters: PimFilters,
): T[] {
  return rows.filter(
    (r) =>
      (filters.company === 'All' || (r.Companies ?? [r.Company]).includes(filters.company)) &&
      (filters.category.length === 0 || (r.Category !== null && filters.category.includes(r.Category))) &&
      (filters.bcgClass === 'All' || r.bcg_class_YTD === filters.bcgClass),
  );
}

/** Partner brand tracking list (PIM Contribution). The Brand is the product's main vendor in Odoo; a partner brand
 * matches every product whose Brand equals one of `odooNames` (case-insensitive). A brand with no product in Odoo
 * yet still gets a card ("not currently assigned in Odoo"), so it shows up as soon as it is filled in Odoo. */
export interface PartnerBrand {
  requested: string;
  /** Names the brand may carry in Odoo (vendor name), compared case-insensitively. */
  odooNames: string[];
}

export const PARTNER_BRANDS: PartnerBrand[] = [
  { requested: 'Ape Grupo', odooNames: ['APE Group', 'Ape Grupo', 'APE'] },
  { requested: 'VitrA', odooNames: ['Vitra'] },
  { requested: 'Onyx', odooNames: ['Onix', 'Onyx'] },
  { requested: 'Mayor', odooNames: ['Ceramica Mayor', 'Mayor'] },
  { requested: 'QUA', odooNames: ['QUA'] },
  { requested: 'FILA', odooNames: ['FILA SOLUTIONS', 'FILA'] },
  { requested: 'TAU', odooNames: ['TAU ceramica', 'TAU'] },
  // 2026-11-07: the vendor names exactly as on product.supplierinfo (no Arabic spelling found for these four;
  // "شركة السرايا البيضاء" is a different vendor, Al-Saraya Al-Bayda, and is NOT Al-Saraya Al-Hamra)
  { requested: 'Stonewrap', odooNames: ['Stonewrap'] },
  // one card for both (2026-11-07): volume, revenue, revenue-weighted GP%, SKUs and change vs LY of the two together
  { requested: 'Saquer Gulf & Lotus Tile', odooNames: ['Saquer Gulf', 'Lotus Tile'] },
  { requested: 'Al-Saraya Al-Hamra', odooNames: ['Al-Saraya Al-Hamra'] },
];

/** True when the product's Brand is one of the partner brand's Odoo names (case-insensitive). */
export function isBrandOf(brand: PartnerBrand, r: { Brand: string | null }): boolean {
  const b = (r.Brand ?? '').trim().toUpperCase();
  return b !== '' && brand.odooNames.some((n) => n.toUpperCase() === b);
}

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
  revenue: number;
  pct: number;
}

export interface FoundBrandStats extends PartnerBrand {
  revenue: number;
  revenuePrior: number;
  deltaPct: number | null;
  /** Units sold in the period (added up across UoMs), the same period last year, and the change. */
  volume: number;
  volumePrior: number;
  volumeDeltaPct: number | null;
  volumeByUom: UomQty[];
  gp: number | null;
  skuCount: number;
  skuSold: number;
  companySplit: BrandCompanySplit[];
}

/** Brand stats for the selected period (volume added up as Unit and its change vs the same period last year, value,
 * revenue-weighted GP%), highest volume first. SKU Count = catalog rows of the brand; SKUs Sold = those with sales in
 * the period. */
export function computeBrandStats(rows: ProductFact[]): { found: FoundBrandStats[]; notFound: PartnerBrand[] } {
  const withRows = PARTNER_BRANDS.map((b) => ({ b, brandRows: rows.filter((r) => isBrandOf(b, r)) }));
  const found = withRows
    .filter(({ brandRows }) => brandRows.length > 0)
    .map(({ b, brandRows }) => {
      const revenue = sum(brandRows, (r) => r.value);
      const revenuePrior = sum(brandRows, (r) => r.valuePrior);
      const costed = brandRows.filter((r) => r.grossProfitPct !== null && r.value > 0);
      const costedValue = sum(costed, (r) => r.value);
      // One company per product row: the split is the rows' own company.
      const companyRevenue = new Map<string, number>();
      brandRows.forEach((r) => companyRevenue.set(r.Company, (companyRevenue.get(r.Company) ?? 0) + r.value));
      return {
        ...b,
        revenue,
        revenuePrior,
        deltaPct: revenuePrior > 0 ? ((revenue - revenuePrior) / revenuePrior) * 100 : null,
        volume: sum(brandRows, (r) => r.volume),
        volumePrior: sum(brandRows, (r) => r.volumePrior),
        volumeDeltaPct: (() => {
          const prior = sum(brandRows, (r) => r.volumePrior);
          return prior > 0 ? ((sum(brandRows, (r) => r.volume) - prior) / prior) * 100 : null;
        })(),
        volumeByUom: sumByUom(brandRows),
        gp: costedValue > 0 ? sum(costed, (r) => (r.grossProfitPct as number) * r.value) / costedValue : null,
        skuCount: brandRows.length,
        skuSold: brandRows.filter((r) => r.value !== 0 || r.volume !== 0).length,
        companySplit: [...companyRevenue.entries()]
          .sort((a, c) => c[1] - a[1])
          .map(([company, rev]) => ({ company, revenue: rev, pct: revenue > 0 ? (rev / revenue) * 100 : 0 })),
      };
    })
    .sort((a, c) => c.volume - a.volume || c.revenue - a.revenue);
  return { found, notFound: withRows.filter(({ brandRows }) => brandRows.length === 0).map(({ b }) => b) };
}

// ---- Stock Velocity: Sales Frequency, ISR, Stock Aging -- every limit from config/product_dashboard.json ----------
export type Thresholds = Record<string, unknown> | undefined;

/** Sales Frequency bucket: average days between selling days up to `maxGapDays` (null = no upper limit). */
export interface FrequencyBucketDef {
  key: string;
  maxGapDays: number | null;
}
export const DEFAULT_FREQUENCY_BUCKETS: FrequencyBucketDef[] = [
  { key: 'Daily', maxGapDays: 2 },
  { key: 'Weekly', maxGapDays: 7 },
  { key: 'Monthly', maxGapDays: 30 },
  { key: 'Quarterly', maxGapDays: 90 },
  { key: 'Rarely', maxGapDays: null },
];
export function frequencyBuckets(thresholds: Thresholds): FrequencyBucketDef[] {
  const raw = ((thresholds?.sales_frequency ?? {}) as { buckets?: { key: string; max_gap_days: number | null }[] }).buckets;
  return raw?.length ? raw.map((b) => ({ key: b.key, maxGapDays: b.max_gap_days ?? null })) : DEFAULT_FREQUENCY_BUCKETS;
}
/** "Daily (≤ 2 days)", "Weekly (3–7 days)", ..., "Rarely (> 90 days)". */
export function frequencyLabel(buckets: FrequencyBucketDef[], key: string): string {
  const i = buckets.findIndex((b) => b.key === key);
  if (i < 0) return key;
  const prev = i > 0 ? buckets[i - 1].maxGapDays : null;
  const max = buckets[i].maxGapDays;
  if (max === null) return `${key} (> ${prev ?? 0} days)`;
  if (prev === null) return `${key} (≤ ${max} days)`;
  return `${key} (${prev + 1}–${max} days)`;
}
const FREQUENCY_TONES = ['var(--ps-color-success)', 'var(--ps-color-accent)', 'var(--ps-color-gold)', 'var(--ps-color-watch)', 'var(--ps-color-alert)'];
/** Most frequent green ... rarest red (the last bucket is always red). */
export function frequencyColor(buckets: FrequencyBucketDef[], key: string): string {
  const i = buckets.findIndex((b) => b.key === key);
  return i === buckets.length - 1 ? 'var(--ps-color-alert)' : FREQUENCY_TONES[Math.max(0, i)] ?? 'var(--ps-color-neutral-text)';
}

/** Average days between selling days = days in the period ÷ distinct order days; null when it did not sell. */
export function averageSaleGap(orderDays: number, periodDays: number): number | null {
  return orderDays > 0 && periodDays > 0 ? periodDays / orderDays : null;
}
/** The bucket of a product's average gap (null = did not sell in the period). */
export function frequencyBucket(orderDays: number, periodDays: number, buckets: FrequencyBucketDef[] = DEFAULT_FREQUENCY_BUCKETS): string | null {
  const gap = averageSaleGap(orderDays, periodDays);
  if (gap === null) return null;
  return (buckets.find((b) => b.maxGapDays === null || gap <= b.maxGapDays) ?? buckets[buckets.length - 1]).key;
}

/** ISR = inventory on hand value (LYD at cost) ÷ net sales value of the period: green ≤ target, yellow below red, red from red. */
export interface IsrBands {
  targetPct: number;
  redPct: number;
}
export function isrBands(thresholds: Thresholds): IsrBands {
  const stock = (thresholds?.stock ?? {}) as { isr_target_pct?: number; isr_red_pct?: number };
  return { targetPct: stock.isr_target_pct ?? 15, redPct: stock.isr_red_pct ?? 25 };
}
export function isrPct(inventoryValue: number, salesValue: number): number | null {
  return salesValue > 0 ? (inventoryValue / salesValue) * 100 : null;
}
export function isrStatus(pct: number | null, bands: IsrBands): 'success' | 'watch' | 'alert' | 'neutral' {
  if (pct === null) return 'neutral';
  if (pct <= bands.targetPct) return 'success';
  return pct < bands.redPct ? 'watch' : 'alert';
}

/** Stock Aging buckets (labels as the ETL writes them in StockAgeBucket), youngest green ... oldest red. */
export interface AgingBucketDef {
  /** Column key of the bucket (AgeQty_<key>); the label when the config has none. */
  key: string;
  label: string;
  maxDays: number | null;
}
export function agingBuckets(thresholds: Thresholds): AgingBucketDef[] {
  const raw = ((thresholds?.stock ?? {}) as { aging_buckets?: { key?: string; label: string; max_days: number | null }[] }).aging_buckets;
  return (raw ?? []).map((b) => ({ key: b.key ?? b.label, label: b.label, maxDays: b.max_days ?? null }));
}
const AGING_TONES = ['var(--ps-color-success)', 'var(--ps-color-gold)', 'var(--ps-color-watch)', 'var(--ps-color-alert)', 'color-mix(in srgb, var(--ps-color-alert) 65%, black)'];
export function agingColor(buckets: AgingBucketDef[], label: string): string {
  const i = buckets.findIndex((b) => b.label === label);
  if (i < 0) return 'var(--ps-color-neutral-text)';
  return AGING_TONES[Math.round((i * (AGING_TONES.length - 1)) / Math.max(1, buckets.length - 1))];
}

/** Fast vs Slow Movers benchmark (config stock.fast_mover_vs_category_median_pct / slow_mover_vs_category_median_pct). */
export interface MoverRule {
  fastPct: number;
  slowPct: number;
}
export type MoverGroup = 'Fast' | 'Normal' | 'Slow';
export function moverRule(thresholds: Thresholds): MoverRule {
  const stock = (thresholds?.stock ?? {}) as { fast_mover_vs_category_median_pct?: number; slow_mover_vs_category_median_pct?: number };
  return { fastPct: stock.fast_mover_vs_category_median_pct ?? 150, slowPct: stock.slow_mover_vs_category_median_pct ?? 50 };
}
/** Fast ≥ fastPct of the category median · Slow ≤ slowPct · Normal in between (both boundaries inclusive). */
export function moverGroupOf(pctOfMedian: number, rule: MoverRule): MoverGroup {
  if (pctOfMedian >= rule.fastPct) return 'Fast';
  return pctOfMedian <= rule.slowPct ? 'Slow' : 'Normal';
}
/** Each SKU's velocity as a % of the MEDIAN velocity of the SKUs of its own category in the same company (only the
 * SKUs passed in: those that sold in the period). A SKU alone in its category is 100% of itself, so Normal. */
export function velocityVsCategoryMedian<T extends { id: string; Company: string; Category: string | null; velocity: number | null }>(rows: T[]): Map<string, number> {
  const groups = new Map<string, T[]>();
  rows.forEach((r) => {
    const key = `${r.Company}|${r.Category ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  });
  const out = new Map<string, number>();
  groups.forEach((list) => {
    const m = median(list.map((r) => r.velocity ?? 0));
    list.forEach((r) => out.set(r.id, m > 0 ? ((r.velocity ?? 0) / m) * 100 : 100));
  });
  return out;
}
/** Each SKU's category median Sales Velocity (same company + category), Unit/day. */
export function categoryMedianVelocity<T extends { id: string; Company: string; Category: string | null; velocity: number | null }>(rows: T[]): Map<string, number> {
  const groups = new Map<string, T[]>();
  rows.forEach((r) => {
    const key = `${r.Company}|${r.Category ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  });
  const out = new Map<string, number>();
  groups.forEach((list) => {
    const m = median(list.map((r) => r.velocity ?? 0));
    list.forEach((r) => out.set(r.id, m));
  });
  return out;
}
export function moverRuleText(rule: MoverRule): string {
  return `Sales Velocity = Quantity Sold ÷ days in period. Fast ≥ ${rule.fastPct}% of the category median · Slow ≤ ${rule.slowPct}%`;
}

/** Days-on-hand limits per company (config days_of_inventory), for the "?" lines: "Tika > 60 days · Majaal > 180 days". */
export function dohRule(thresholds: Thresholds, key: 'overstock_days' | 'stockout_risk_days', sign: '>' | '<'): string {
  const doi = (thresholds?.days_of_inventory ?? {}) as Record<string, Record<string, number> | number>;
  const limits = Object.entries((doi[key] ?? {}) as Record<string, number>).filter(([c]) => isProductPageCompany(c));
  return limits.length ? limits.map(([c, d]) => `${c} ${sign} ${d} days`).join(' · ') : `company limit (${key})`;
}
export function lookbackDays(thresholds: Thresholds): number {
  const doi = (thresholds?.days_of_inventory ?? {}) as { lookback_days?: number };
  return doi.lookback_days ?? 90;
}
