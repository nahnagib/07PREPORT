'use client';
/**
 * One design for every inventory visual of Stock Velocity (2026-11-11): Fast vs Slow Movers, Stock Aging, Stock-Out Risk
 * and Overstock share
 *   - the labels (INV): Odoo's own names, checked against our Odoo 17 -- "Quantity On Hand" (product.product
 *     qty_available) and "Total Value" (the Inventory Valuation report, stock.valuation.layer value); the sales measures
 *     have no single Odoo field and keep the agreed names (Quantity Sold, Sales Value, Sales Velocity);
 *   - the hover (InventoryHover): name, Company + BCG Class badges, the 7 standard figures in one order, then the
 *     visual's own line(s); a figure that does not apply shows "–" with the same reason everywhere;
 *   - the export (inventoryExportColumns + exportInventoryCsv / exportInventoryPdf): the 11 standard columns in the
 *     hover's order, then the visual's own columns, and a summary section under the CSV rows;
 *   - the legend (ShareLegend): "■ Name  N SKUs · x.x%".
 */
import React from 'react';
import { exportRowsAsCsv, exportRowsAsPdf, type TableExportCell } from '@07ps/ui';
import { BCG_COLOR, UNCLASSIFIED_NO_COST, UNCLASSIFIED_ZERO_REVENUE, type ProductFact, type Thresholds } from '../../lib/materialsAnalogy/shared';
import { Pill, ProductTooltip, TooltipRow, ltrLabel, type ExportColumn } from './ProductUi';

/** The labels of every inventory hover, table header, KPI, legend, help line and export. */
export const INV = {
  productId: 'Product ID',
  productName: 'Product name',
  company: 'Company',
  bcgClass: 'BCG Class',
  qtyOnHand: 'Quantity On Hand',
  totalValue: 'Total Value',
  doh: 'Days on Hand (DOH)',
  stockAge: 'Stock Age (days)',
  velocity: 'Sales Velocity',
  qtySold: 'Quantity Sold',
  salesValue: 'Sales Value',
} as const;

/** The two reasons a figure does not apply -- the same words on every visual. */
export const NO_SALES_REASON = 'No sales in period';
export const NO_STOCK_REASON = 'No stock';
export const NOT_CLASSIFIED = 'Not classified (no sales in period)';
/** Sold, but never with a standard cost in the database: no profit, so no class. */
export const NOT_CLASSIFIED_NO_PROFIT = 'Not classified (no profit data)';
const na = (reason: string) => `– ${reason}`;

/** BCG Class with the BCG page's own names (Stars / Cash Cows / Strategic / Dogs, config thresholds); no class = Not
 * classified (no sales, or no profit data). */
export function bcgClassName(cls: string | null | undefined): string {
  if (!cls) return NOT_CLASSIFIED;
  if (cls === UNCLASSIFIED_ZERO_REVENUE) return 'Not classified (zero revenue)';
  return cls === UNCLASSIFIED_NO_COST ? NOT_CLASSIFIED_NO_PROFIT : cls;
}
export function bcgClassColor(cls: string | null | undefined): string {
  return (cls && BCG_COLOR[cls]) || 'var(--ps-color-neutral-text)';
}

// ------------------------------------------------------------------ number formats (K / M with one decimal, currency first)
function compact(abs: number): string {
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  return abs.toFixed(abs > 0 && abs < 10 && !Number.isInteger(abs) ? 1 : 0);
}
export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return `${v < 0 ? '-' : ''}LYD ${compact(Math.abs(v))}`;
}
export function fmtQty(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return `${v < 0 ? '-' : ''}${compact(Math.abs(v))} Units`;
}
export function fmtVelocity(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v.toFixed(2)} Unit/day`;
}

// ------------------------------------------------------------------ the standard figures
const hasStock = (r: ProductFact) => r.onHandQty > 0;
const hasSales = (r: ProductFact) => r.volume !== 0 || r.value !== 0;

export interface InventoryLine {
  label: string;
  value: string;
  color?: string;
}

/** Rows 3-9 of the hover, in order, with the not-applicable reasons. */
export function inventoryFields(r: ProductFact): InventoryLine[] {
  const doh = !hasStock(r) && r.stockQty <= 0 ? na(NO_STOCK_REASON) : r.daysOfInventory === null ? na(NO_SALES_REASON) : `${Math.round(r.daysOfInventory)} days`;
  const age = !hasStock(r) ? na(NO_STOCK_REASON) : r.stockAgeDays === null ? '–' : `${Math.round(r.stockAgeDays)} days`;
  return [
    { label: INV.qtyOnHand, value: fmtQty(r.onHandQty) },
    { label: INV.totalValue, value: fmtMoney(r.onHandValue) },
    { label: INV.doh, value: doh },
    { label: INV.stockAge, value: age },
    { label: INV.velocity, value: r.velocity && r.velocity > 0 ? fmtVelocity(r.velocity) : na(NO_SALES_REASON) },
    { label: INV.qtySold, value: hasSales(r) ? fmtQty(r.volume) : na(NO_SALES_REASON) },
    { label: INV.salesValue, value: hasSales(r) ? fmtMoney(r.value) : na(NO_SALES_REASON) },
  ];
}

/** The one hover of the four inventory visuals: `extra` = the visual's own line(s), shown last. */
export function InventoryHover({ r, extra }: { r: ProductFact; extra: InventoryLine[] }) {
  const cls = r.bcg_class_YTD;
  return (
    <ProductTooltip name={r.ProductName} company={r.Company} badges={<Pill color={bcgClassColor(cls)} label={bcgClassName(cls)} />}>
      <div data-testid="inventory-hover">
        {inventoryFields(r).map((f) => (
          <TooltipRow key={f.label} label={f.label} value={f.value} />
        ))}
        <div style={{ borderTop: '1px solid var(--ps-color-border)', marginTop: 4, paddingTop: 4 }}>
          {extra.map((f) => (
            <TooltipRow key={f.label} label={f.label} value={f.value} valueColor={f.color} />
          ))}
        </div>
      </div>
    </ProductTooltip>
  );
}

// ------------------------------------------------------------------ export
const round = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** The 11 standard columns of every inventory export, in the hover's order. */
export function inventoryExportColumns(): ExportColumn<ProductFact>[] {
  return [
    { header: INV.productId, value: (r) => r.ProductKey },
    { header: INV.productName, value: (r) => ltrLabel(r.ProductName) },
    { header: INV.company, value: (r) => r.Company },
    { header: INV.bcgClass, value: (r) => bcgClassName(r.bcg_class_YTD) },
    { header: `${INV.qtyOnHand} (Units)`, align: 'right', value: (r) => round(r.onHandQty, 4), text: (r) => fmtQty(r.onHandQty) },
    { header: `${INV.totalValue} (LYD)`, align: 'right', value: (r) => round(r.onHandValue), text: (r) => fmtMoney(r.onHandValue) },
    { header: 'DOH (days)', align: 'right', value: (r) => round(r.daysOfInventory, 0), text: (r) => (r.daysOfInventory === null ? '–' : `${Math.round(r.daysOfInventory)}`) },
    { header: INV.stockAge, align: 'right', value: (r) => (hasStock(r) ? round(r.stockAgeDays, 0) : null), text: (r) => (hasStock(r) && r.stockAgeDays !== null ? `${Math.round(r.stockAgeDays)}` : '–') },
    { header: `${INV.velocity} (Unit/day)`, align: 'right', value: (r) => round(r.velocity, 4), text: (r) => fmtVelocity(r.velocity) },
    { header: `${INV.qtySold} (Units)`, align: 'right', value: (r) => round(r.volume, 4), text: (r) => fmtQty(r.volume) },
    { header: `${INV.salesValue} (LYD)`, align: 'right', value: (r) => round(r.value), text: (r) => fmtMoney(r.value) },
  ];
}

/** `<base>_<company>_<from>_<to>`, e.g. fast_slow_movers_majaal_2026-01-01_2026-11-10 (".csv" / ".pdf" added on save). */
export function inventoryFileName(base: string, companyLabel: string, from?: string | null, to?: string | null): string {
  const company = (companyLabel || 'all').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '_').replace(/^_+|_+$/g, '') || 'all';
  return [base, company, from, to].filter(Boolean).join('_');
}

export interface ExportSummary {
  title: string;
  headers: string[];
  rows: TableExportCell[][];
}

/** One CSV: the product rows, then a blank line and the summary section (its own header row). */
export function exportInventoryCsv<T>(fileName: string, columns: ExportColumn<T>[], rows: T[], summary?: ExportSummary): Promise<void> {
  const body: TableExportCell[][] = rows.map((r) => columns.map((c) => c.value(r)));
  if (summary) body.push([], [summary.title], summary.headers, ...summary.rows);
  return exportRowsAsCsv({ headers: columns.map((c) => c.header), rows: body, fileName });
}

export function exportInventoryPdf<T>(opts: { title: string; subtitle: string; fileName: string; columns: ExportColumn<T>[]; rows: T[] }): Promise<void> {
  const { title, subtitle, fileName, columns, rows } = opts;
  return exportRowsAsPdf({
    title,
    subtitle,
    fileName,
    columns: columns.map((c) => ({ header: c.header, align: c.align })),
    rows: rows.map((r) => columns.map((c) => (c.text ? c.text(r) : String(c.value(r) ?? '–')))),
  });
}

/** Summary rows per group: SKU count, % of SKUs, Quantity On Hand, Total Value, Quantity Sold. */
export function groupSummary(title: string, groupHeader: string, groups: { label: string; rows: ProductFact[] }[]): ExportSummary {
  const total = groups.reduce((t, g) => t + g.rows.length, 0);
  const sum = (rows: ProductFact[], f: (r: ProductFact) => number) => round(rows.reduce((t, r) => t + f(r), 0)) ?? 0;
  const line = (label: string, rows: ProductFact[]): TableExportCell[] => [
    label, rows.length, total > 0 ? round((rows.length / total) * 100, 1) : 0, sum(rows, (r) => r.onHandQty), sum(rows, (r) => r.onHandValue), sum(rows, (r) => r.volume),
  ];
  return {
    title,
    headers: [groupHeader, 'SKUs', '% of SKUs', `${INV.qtyOnHand} (Units)`, `${INV.totalValue} (LYD)`, `${INV.qtySold} (Units)`],
    rows: [...groups.map((g) => line(g.label, g.rows)), line('Total', groups.flatMap((g) => g.rows))],
  };
}

// ------------------------------------------------------------------ visual-specific rules
/** A company's limit from config days_of_inventory.<key> (null when the company has none). */
export function companyDohLimit(thresholds: Thresholds, key: 'overstock_days' | 'stockout_risk_days', company: string): number | null {
  const doi = (thresholds?.days_of_inventory ?? {}) as Record<string, unknown>;
  const v = ((doi[key] ?? {}) as Record<string, number>)[company];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Overstock: the finished-goods units above the company's overstock DOH (all of them when nothing sold). */
export function overstockExcess(r: ProductFact, thresholds: Thresholds): { qty: number; value: number } {
  if (r.stockQty <= 0) return { qty: 0, value: 0 };
  const limit = companyDohLimit(thresholds, 'overstock_days', r.Company);
  const unitValue = r.stockQty > 0 ? r.stockValue / r.stockQty : 0;
  const qty = r.daysOfInventory === null || r.daysOfInventory <= 0 || limit === null
    ? r.stockQty
    : Math.max(0, r.stockQty * (1 - limit / r.daysOfInventory));
  return { qty, value: qty * unitValue };
}

/** Stock-Out Risk: Out of stock (no finished goods) · High (DOH under half the company minimum) · Watch (under it). */
export function stockOutRisk(r: ProductFact, thresholds: Thresholds): { level: 'Out of stock' | 'High' | 'Watch'; days: number | null } {
  const limit = companyDohLimit(thresholds, 'stockout_risk_days', r.Company);
  const days = r.stockQty <= 0 ? 0 : r.daysOfInventory;
  if (days === 0 || r.stockQty <= 0) return { level: 'Out of stock', days: 0 };
  return { level: limit !== null && days !== null && days < limit / 2 ? 'High' : 'Watch', days };
}
export const RISK_COLOR: Record<string, string> = { 'Out of stock': 'var(--ps-color-alert)', High: 'var(--ps-color-alert)', Watch: 'var(--ps-color-gold)' };

// ------------------------------------------------------------------ legend
export interface LegendItem {
  key: string;
  label: string;
  color: string;
  skus: number;
}

/** "■ Name  N SKUs · x.x%" -- the legend of every inventory card. */
export function ShareLegend({ items, onSelect, bind }: { items: LegendItem[]; onSelect?: (key: string) => void; bind?: (key: string) => Record<string, unknown> }) {
  const total = items.reduce((t, s) => t + s.skus, 0);
  return (
    <div data-testid="share-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10 }}>
      {items.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => s.skus > 0 && onSelect?.(s.key)}
          {...(bind ? bind(s.key) : {})}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: s.skus > 0 && onSelect ? 'pointer' : 'default', color: 'var(--ps-color-text)', fontSize: 12 }}
        >
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
          <span>{s.label}</span>
          <span style={{ color: 'var(--ps-color-muted-text)', fontVariantNumeric: 'tabular-nums' }}>
            {s.skus.toLocaleString('en-US')} SKUs · {(total > 0 ? (s.skus / total) * 100 : 0).toFixed(1)}%
          </span>
        </button>
      ))}
    </div>
  );
}

export { TooltipRow };
