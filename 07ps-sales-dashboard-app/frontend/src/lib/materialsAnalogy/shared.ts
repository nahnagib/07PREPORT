import type { BcgMovement, LifecycleSegment, ProductDashboardOverview, ProductDashboardRow, StockBand, UomQty } from '../api';

/**
 * Product pages (BCG Matrix / Stock Velocity / PIM Contribution / Product Lifecycle) -- shared types,
 * formatters and colors. All four pages read live data from `useProductDashboard` (lib/hooks.ts),
 * served by backend/src/measures/productDashboard.ts from tables the ETL rebuilds on every run
 * (data/etl/src/sales_pipeline/product_dashboard.py). There is no local/sample product data any more:
 * every threshold (BCG volume/profit, days-of-inventory bands, lifecycle rule) is applied by the ETL
 * from data/etl/config/product_dashboard.json and arrives precomputed.
 *
 * One product = Company + Odoo product name (PRODUCTS.xlsx row). `id` is that key; `ProductKey` from
 * the sheet is NOT unique and is never used to group.
 */

export type BcgClass = 'Stars' | 'Cash Cows' | 'Strategic' | 'Dogs';
export const BCG_CLASSES: BcgClass[] = ['Stars', 'Cash Cows', 'Strategic', 'Dogs'];
export const UNCLASSIFIED_NO_COST = 'Unclassified (no cost)';

export interface ProductFact {
  /** Company + normalized Odoo product name -- the product's identity. */
  id: string;
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
  isMapped: boolean;
  // -- period (follows the date range; default calendar YTD) --
  value: number;
  volume: number | null;
  volumeByUom: UomQty[];
  uom: string | null;
  velocity: number | null;
  valuePrior: number;
  avgUnitPrice: number | null;
  grossProfitPct: number | null;
  // -- BCG (calendar YTD vs LYTD, as of the last ETL run) --
  bcg_class_YTD: string | null;
  bcg_class_LYTD: string | null;
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
  lifecycle: LifecycleSegment;
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  daysSinceLastSale: number | null;
}

function daysBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function toProductFacts(data: ProductDashboardOverview | null | undefined): ProductFact[] {
  if (!data) return [];
  return data.products.map((r: ProductDashboardRow) => ({
    id: r.productMatchKey,
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
    isMapped: r.isMapped,
    value: r.value,
    volume: r.volume,
    volumeByUom: r.volumeByUom,
    uom: r.uom,
    velocity: r.velocity,
    valuePrior: r.valuePrior,
    avgUnitPrice: r.avgUnitPrice,
    grossProfitPct: r.grossProfitPct,
    bcg_class_YTD: r.bcgClassYTD,
    bcg_class_LYTD: r.bcgClassLYTD,
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
    lifecycle: r.lifecycleSegment,
    firstSaleDate: r.firstSaleDate,
    lastSaleDate: r.lastSaleDate,
    daysSinceLastSale: daysBetween(r.lastSaleDate, data.asOfDate),
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
  return abs > 0 && abs < 10 ? v.toFixed(1) : v.toFixed(0);
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

export function fmtUomQty(list: UomQty[], max = 3): string {
  if (!list.length) return '0';
  const shown = list.slice(0, max).map(({ uom, qty }) => `${fmtNum(qty)}${uom ? ` ${uom}` : ''}`);
  return list.length > max ? `${shown.join(' · ')} · +${list.length - max} more` : shown.join(' · ');
}

export function fmtVolume(r: Pick<ProductFact, 'volume' | 'volumeByUom' | 'uom'>): string {
  if (r.volume === null) return fmtUomQty(r.volumeByUom);
  return `${fmtNum(r.volume)}${r.uom ? ` ${r.uom}` : ''}`;
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
};

export const LIFECYCLE_SEGMENTS: LifecycleSegment[] = ['New', 'Growing', 'Mature', 'Declining', 'Discontinued'];
export const SEGMENT_COLOR: Record<LifecycleSegment, string> = {
  New: 'var(--ps-color-accent)',
  Growing: 'var(--ps-color-success)',
  Mature: 'var(--ps-color-gold)',
  Declining: 'var(--ps-color-watch)',
  Discontinued: 'var(--ps-color-neutral-text)',
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

export const MOVEMENT_COLOR: Record<BcgMovement, string> = {
  New: 'var(--ps-color-accent)',
  Stable: 'var(--ps-color-success)',
  Improved: 'var(--ps-color-gold)',
  Declined: 'var(--ps-color-alert)',
  Lost: 'var(--ps-color-neutral-text)',
};

/** BCG Matrix display rename: 'Declined' shows as "Drop", 'Lost' as "Discontinued". */
export const MOVEMENT_LABEL: Record<BcgMovement, string> = {
  New: 'New',
  Stable: 'Stable',
  Improved: 'Improved',
  Declined: 'Drop',
  Lost: 'Discontinued',
};

// ---- Page-level Company / Category / BCG Class filtering (PIM Contribution + its brand drill-down) ----
export interface PimFilters {
  company: CompanyFilter;
  category: string[];
  bcgClass: string;
}

export function filterByPageFilters<T extends { Company: string; Category: string | null; bcg_class_YTD: string | null }>(
  rows: T[],
  filters: PimFilters,
): T[] {
  return rows.filter(
    (r) =>
      (filters.company === 'All' || r.Company === filters.company) &&
      (filters.category.length === 0 || (r.Category !== null && filters.category.includes(r.Category))) &&
      (filters.bcgClass === 'All' || r.bcg_class_YTD === filters.bcgClass),
  );
}

/** Partner brand tracking list (PIM Contribution). `matched` = the Brand value as stored in PRODUCTS.xlsx,
 * or null when no such brand exists (rendered as "not currently stocked"). */
export interface PartnerBrand {
  requested: string;
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
  matched: string;
  revenue: number;
  revenuePrior: number;
  deltaPct: number | null;
  volumeByUom: UomQty[];
  gp: number | null;
  skuCount: number;
  skuSold: number;
  companySplit: BrandCompanySplit[];
}

/** Brand stats for the selected period (value, prior-year same period, volume per UoM, revenue-weighted
 * GP%). SKU Count = catalog rows of the brand; SKUs Sold = those with sales in the period. */
export function computeBrandStats(rows: ProductFact[]): { found: FoundBrandStats[]; notFound: PartnerBrand[] } {
  const found = PARTNER_BRANDS.filter((b): b is PartnerBrand & { matched: string } => b.matched !== null)
    .map((b) => {
      const brandRows = rows.filter((r) => (r.Brand ?? '').toUpperCase() === b.matched.toUpperCase());
      const revenue = sum(brandRows, (r) => r.value);
      const revenuePrior = sum(brandRows, (r) => r.valuePrior);
      const costed = brandRows.filter((r) => r.grossProfitPct !== null && r.value > 0);
      const costedValue = sum(costed, (r) => r.value);
      const companyRevenue = new Map<string, number>();
      brandRows.forEach((r) => companyRevenue.set(r.Company, (companyRevenue.get(r.Company) ?? 0) + r.value));
      return {
        ...b,
        matched: b.matched,
        revenue,
        revenuePrior,
        deltaPct: revenuePrior > 0 ? ((revenue - revenuePrior) / revenuePrior) * 100 : null,
        volumeByUom: sumByUom(brandRows),
        gp: costedValue > 0 ? sum(costed, (r) => (r.grossProfitPct as number) * r.value) / costedValue : null,
        skuCount: brandRows.length,
        skuSold: brandRows.filter((r) => r.value !== 0 || (r.volume ?? 0) !== 0).length,
        companySplit: [...companyRevenue.entries()]
          .sort((a, c) => c[1] - a[1])
          .map(([company, rev]) => ({ company, revenue: rev, pct: revenue > 0 ? (rev / revenue) * 100 : 0 })),
      };
    })
    .sort((a, c) => c.revenue - a.revenue);
  return { found, notFound: PARTNER_BRANDS.filter((b) => b.matched === null) };
}
