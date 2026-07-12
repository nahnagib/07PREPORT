/**
 * Invoices Engine page metric definitions.
 *
 * Reads Fact_SalesLines (filtered) at its real invoice-LINE grain (see tachometer.ts's module
 * docstring -- "Fact_SalesLines (filtered)_line is invoice-LINE grain built for the Invoices
 * Engine page's per-invoice efficiency metrics"). Every other page on this platform aggregates
 * Fact_SalesLines up to the order/header level; this is the one page that needs the line grain
 * itself, plus the per-line InvoiceKey/InvoiceValue/Invoice Class columns already computed
 * upstream by the ETL (see data/etl/src/sales_pipeline/legacy_transform.py's
 * SalesLinesFactBuilder -- "Invoice Class" carries a space in the live column name, "fix for Power
 * BI compatibility", hence the backtick-quoting below).
 *
 * Per-invoice averages (lines/sales/volume per invoice) are derived, not stored: an invoice's
 * `InvoiceValue`/`Invoice Class` are broadcast onto every one of its line rows, so summing a line
 * column directly (e.g. SUM(Value)) already yields the correct invoice-level total across a date
 * window -- it's only the *per-invoice average* that needs COUNT(DISTINCT InvoiceKey) as the
 * denominator, exactly like fetchValueVolume already sums Value/Volume without any invoice-level
 * grouping. No second warehouse, no second classification/threshold scheme -- reuses
 * buildWhereClause and the same YTD/LYTD/MTD/LMTD window helpers as every other page.
 *
 * Page-filter scope (InvoicesEngineScope) -- added for the Sales Trend "click a year" and
 * Invoices Classification "click a class" page-filter interactions. Composes on top of the
 * standard 5-dimension Filters/anchorDate the same way everywhere else on this page already
 * works; see each function's own comment for exactly which scope fields it honors and which it
 * deliberately ignores (a chart never re-scopes *itself* by the selection it produced -- see
 * routes/invoicesEngine.ts for the full self-exclusion wiring).
 */

import type { Pool } from 'mysql2/promise';
import { buildWhereClause, dateOnlyUTC, lmtdWindow, lytdWindow, mtdWindow, ytdWindow, type DateWindow, type Filters } from './filters';

function toDateOnlyString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Normalizes Fact_SalesLines.`Invoice Class` down to a bare A/B/C/D letter, or 'Unclassified'.
 *
 * Confirmed finding vs assumption: the live column does not hold a bare letter -- it already
 * carries the full descriptive string computed upstream by the ETL (e.g. "Class A (>50K)", "Class
 * B (25K - 50K)"), and a small number of rows (367, per 0002_core_sales_facts.sql's header note on
 * the equivalent snake_case column) are NULL. Normalizing here, once, keeps every caller (sort
 * order, color mapping, frontend label lookup, and now the class page-filter clause below) working
 * off one stable A/B/C/D/Unclassified code regardless of the source column's exact wording. */
function normalizeInvoiceClass(raw: unknown): string {
  const s = raw == null ? '' : String(raw).trim();
  const match = s.match(/^Class\s+([A-Da-d])\b/);
  if (match) return match[1].toUpperCase();
  if (/^[A-Da-d]$/.test(s)) return s.toUpperCase();
  return 'Unclassified';
}

export interface InvoicesEngineScope {
  /** Restricts to a single calendar year -- sourced from a Sales Trend bar/point click in
   * page-filter mode (not drill-down). Callers apply this differently depending on the shape of
   * the query it's being applied to: windowed (YTD/MTD-style) queries remap their anchor date into
   * this year (see `anchorForYear` below) so every existing window helper keeps working unchanged;
   * already-by-year queries instead restrict their GROUP BY down to this one year (see
   * `buildYearSqlClause`). */
  year?: number;
  /** Restricts to a single normalized Invoice Class ('A' | 'B' | 'C' | 'D' | 'Unclassified') --
   * sourced from an Invoices Classification donut segment click. */
  invoiceClass?: string;
}

/** Same-month/day anchor, remapped onto `year` -- lets every existing ytdWindow/mtdWindow/
 * lytdWindow/lmtdWindow helper keep computing a normal, non-empty window when a year page-filter
 * is active, instead of intersecting that window with a `dd.Year = ?` clause (which would go empty
 * for any year other than the window's own, since ytdWindow/mtdWindow are always anchored to
 * "today"). */
function anchorForYear(anchor: Date, year: number | undefined): Date {
  if (year === undefined) return anchor;
  return dateOnlyUTC(year, anchor.getUTCMonth() + 1, anchor.getUTCDate());
}

function fullYearWindow(year: number): DateWindow {
  return { start: dateOnlyUTC(year, 1, 1), end: dateOnlyUTC(year, 12, 31) };
}

function buildInvoiceClassSqlClause(invoiceClass: string | undefined, alias: string): { clause: string; params: string[] } {
  if (!invoiceClass) return { clause: '1=1', params: [] };
  const col = `${alias}.\`Invoice Class\``;
  if (invoiceClass === 'Unclassified') {
    return { clause: `(${col} IS NULL OR ${col} NOT LIKE 'Class %')`, params: [] };
  }
  // Matches either a bare letter (defensive -- in case the source column is ever simplified) or
  // the live "Class X ..." wording (see normalizeInvoiceClass's header note).
  return { clause: `(${col} = ? OR ${col} LIKE ?)`, params: [invoiceClass, `Class ${invoiceClass} %`] };
}

function buildYearSqlClause(year: number | undefined, alias: string): { clause: string; params: number[] } {
  if (year === undefined) return { clause: '1=1', params: [] };
  return { clause: `${alias}.Year = ?`, params: [year] };
}

// ---------------------------------------------------------------------------
// Zone A / Zone B KPI tiles -- per-invoice averages + invoice count, for one date window.
// ---------------------------------------------------------------------------

export interface InvoiceStats {
  invoiceCount: number;
  avgLinesPerInvoice: number | null;
  avgSalesPerInvoice: number | null;
  avgVolumePerInvoice: number | null;
}

async function fetchInvoiceStats(pool: Pool, window: DateWindow, filters: Filters, scope: InvoicesEngineScope = {}): Promise<InvoiceStats> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const cls = buildInvoiceClassSqlClause(scope.invoiceClass, 'fsl');
  const sql = `
    SELECT
      COUNT(*)                             AS lineCount,
      COUNT(DISTINCT fsl.InvoiceKey)       AS invoiceCount,
      COALESCE(SUM(fsl.Value), 0)          AS totalValue,
      COALESCE(SUM(fsl.Volume), 0)         AS totalVolume
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
      AND ${cls.clause}
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params, ...cls.params]);
  const row = (rows as any[])[0];
  const invoiceCount = Number(row.invoiceCount);
  const lineCount = Number(row.lineCount);
  const totalValue = Number(row.totalValue);
  const totalVolume = Number(row.totalVolume);
  return {
    invoiceCount,
    avgLinesPerInvoice: invoiceCount > 0 ? lineCount / invoiceCount : null,
    avgSalesPerInvoice: invoiceCount > 0 ? totalValue / invoiceCount : null,
    avgVolumePerInvoice: invoiceCount > 0 ? totalVolume / invoiceCount : null,
  };
}

export interface InvoicesEngineKpis {
  ytd: InvoiceStats;
  lytd: InvoiceStats;
  mtd: InvoiceStats;
  lmtd: InvoiceStats;
}

/** The Zone A (Avg Lines/Sales/Volume per Invoice) and Zone B (Total Invoices) tiles, all four
 * periods, in one round trip -- same YTD/LYTD/MTD/LMTD window helpers every other page uses.
 * Honors both scope fields: `year` remaps the anchor (see anchorForYear), `invoiceClass` narrows
 * every query. Neither Zone A nor Zone B chart *produces* a selection, so both scope fields always
 * apply here regardless of which chart the user clicked. */
export async function computeInvoicesEngineKpis(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: InvoicesEngineScope = {},
): Promise<InvoicesEngineKpis> {
  const effectiveAnchor = anchorForYear(anchor, scope.year);
  const [ytd, lytd, mtd, lmtd] = await Promise.all([
    fetchInvoiceStats(pool, ytdWindow(effectiveAnchor), filters, scope),
    fetchInvoiceStats(pool, lytdWindow(effectiveAnchor), filters, scope),
    fetchInvoiceStats(pool, mtdWindow(effectiveAnchor), filters, scope),
    fetchInvoiceStats(pool, lmtdWindow(effectiveAnchor), filters, scope),
  ]);
  return { ytd, lytd, mtd, lmtd };
}

// ---------------------------------------------------------------------------
// Sales Trend (Zone B chart): Invoice Sales Value + # of Invoices by Year, drillable to
// Year -> Invoice Class, or (when drill-down is off) itself the source of the Year page-filter.
// ---------------------------------------------------------------------------

export interface InvoiceYearPoint {
  year: number;
  label: string;
  invoiceSalesValue: number;
  invoiceCount: number;
}

/** Year-by-year Invoice Sales Value (bars) / # of Invoices (line) -- every year present in the
 * data up through `anchor`'s year, not just the current year, so the chart shows real history.
 *
 * Deliberately ignores `scope.year`: this chart is what *produces* the Year page-filter, so it
 * always keeps showing the full multi-year series (the frontend highlights/dims the selected
 * year's bar itself instead) -- only `scope.invoiceClass` (someone else's selection) narrows it. */
export async function fetchSalesTrendByYear(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: InvoicesEngineScope = {},
): Promise<InvoiceYearPoint[]> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const cls = buildInvoiceClassSqlClause(scope.invoiceClass, 'fsl');
  const sql = `
    SELECT
      dd.Year                              AS year,
      COALESCE(SUM(fsl.Value), 0)          AS invoiceSalesValue,
      COUNT(DISTINCT fsl.InvoiceKey)       AS invoiceCount
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date <= ? AND ${clause} AND ${cls.clause}
    GROUP BY dd.Year
    ORDER BY dd.Year
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(anchor), ...params, ...cls.params]);
  return (rows as any[]).map((r) => ({
    year: Number(r.year),
    label: String(r.year),
    invoiceSalesValue: Number(r.invoiceSalesValue),
    invoiceCount: Number(r.invoiceCount),
  }));
}

export interface InvoiceYearClassSlice {
  invoiceClass: string;
  invoiceSalesValue: number;
  invoiceCount: number;
}

export interface InvoiceYearClassBreakdown {
  year: number;
  label: string;
  classes: InvoiceYearClassSlice[];
}

const INVOICE_CLASS_ORDER = ['A', 'B', 'C', 'D'];

/** Same Sales Trend figures, broken down by Invoice Class within each year -- backs the Sales
 * Trend chart's Year -> Invoice Class drill-down. Computed alongside the by-year series (not
 * behind a separate lazy-loaded endpoint) since the data volume is small (a handful of years x 4
 * classes) and it keeps the drill-down instant with no extra round trip.
 *
 * Same self-exclusion as fetchSalesTrendByYear: ignores `scope.year` (this chart produces that
 * filter), honors `scope.invoiceClass`. */
export async function fetchSalesTrendByYearClass(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: InvoicesEngineScope = {},
): Promise<InvoiceYearClassBreakdown[]> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const cls = buildInvoiceClassSqlClause(scope.invoiceClass, 'fsl');
  const sql = `
    SELECT
      dd.Year                              AS year,
      fsl.\`Invoice Class\`                AS invoiceClass,
      COALESCE(SUM(fsl.Value), 0)          AS invoiceSalesValue,
      COUNT(DISTINCT fsl.InvoiceKey)       AS invoiceCount
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date <= ? AND ${clause} AND ${cls.clause}
    GROUP BY dd.Year, fsl.\`Invoice Class\`
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(anchor), ...params, ...cls.params]);

  const byYear = new Map<number, InvoiceYearClassBreakdown>();
  for (const r of rows as any[]) {
    const year = Number(r.year);
    const invoiceClass = normalizeInvoiceClass(r.invoiceClass);
    let entry = byYear.get(year);
    if (!entry) {
      entry = { year, label: String(year), classes: [] };
      byYear.set(year, entry);
    }
    // Merge rather than push -- the source GROUP BY is on the raw (unnormalized) column, so two
    // distinct raw values could in principle normalize to the same class within one year.
    const existing = entry.classes.find((c) => c.invoiceClass === invoiceClass);
    if (existing) {
      existing.invoiceSalesValue += Number(r.invoiceSalesValue);
      existing.invoiceCount += Number(r.invoiceCount);
    } else {
      entry.classes.push({
        invoiceClass,
        invoiceSalesValue: Number(r.invoiceSalesValue),
        invoiceCount: Number(r.invoiceCount),
      });
    }
  }

  return Array.from(byYear.values())
    .sort((a, b) => a.year - b.year)
    .map((entry) => ({
      ...entry,
      classes: entry.classes.sort((a, b) => {
        const ai = INVOICE_CLASS_ORDER.indexOf(a.invoiceClass);
        const bi = INVOICE_CLASS_ORDER.indexOf(b.invoiceClass);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      }),
    }));
}

// ---------------------------------------------------------------------------
// Invoices Trend (Zone C chart): Avg Sales/Lines/Volume per Invoice, by Year. Read-only -- no
// drill-down, no selection of its own; always fully scoped by whatever the other two charts
// selected.
// ---------------------------------------------------------------------------

export interface InvoiceYearEfficiencyPoint {
  year: number;
  label: string;
  avgSalesPerInvoice: number | null;
  avgLinesPerInvoice: number | null;
  avgVolumePerInvoice: number | null;
}

/** Honors both scope fields -- this chart never produces a selection of its own, so it's always
 * fully scoped by whichever of Sales Trend (year) / Invoices Classification (class) the user has
 * selected. With `scope.year` set the GROUP BY naturally collapses to that one year's single bar,
 * same as any other by-year breakdown filtered down to one category. */
export async function fetchInvoicesTrendByYear(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: InvoicesEngineScope = {},
): Promise<InvoiceYearEfficiencyPoint[]> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const cls = buildInvoiceClassSqlClause(scope.invoiceClass, 'fsl');
  const yr = buildYearSqlClause(scope.year, 'dd');
  const sql = `
    SELECT
      dd.Year                              AS year,
      COUNT(*)                             AS lineCount,
      COUNT(DISTINCT fsl.InvoiceKey)       AS invoiceCount,
      COALESCE(SUM(fsl.Value), 0)          AS totalValue,
      COALESCE(SUM(fsl.Volume), 0)         AS totalVolume
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date <= ? AND ${clause} AND ${cls.clause} AND ${yr.clause}
    GROUP BY dd.Year
    ORDER BY dd.Year
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(anchor), ...params, ...cls.params, ...yr.params]);
  return (rows as any[]).map((r) => {
    const invoiceCount = Number(r.invoiceCount);
    const lineCount = Number(r.lineCount);
    const totalValue = Number(r.totalValue);
    const totalVolume = Number(r.totalVolume);
    return {
      year: Number(r.year),
      label: String(r.year),
      avgSalesPerInvoice: invoiceCount > 0 ? totalValue / invoiceCount : null,
      avgLinesPerInvoice: invoiceCount > 0 ? lineCount / invoiceCount : null,
      avgVolumePerInvoice: invoiceCount > 0 ? totalVolume / invoiceCount : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Invoices Classification donut (Zone C): invoice value by Invoice Class, YTD (or, when a Year
// page-filter is active, that full calendar year -- see the window note below).
// ---------------------------------------------------------------------------

export interface InvoiceClassificationSlice {
  invoiceClass: string;
  value: number;
}

/** Deliberately ignores `scope.invoiceClass`: this chart is what *produces* the Class page-filter,
 * so it always keeps showing the full A/B/C/D/Unclassified breakdown (the frontend highlights/dims
 * the selected segment itself instead) -- only `scope.year` (someone else's selection) narrows it.
 *
 * When `scope.year` is set, the window switches from "YTD as of today" to "the full selected
 * calendar year" rather than intersecting the two (which would go empty for any year other than
 * the current one, since ytdWindow is always anchored to "today") -- same reasoning as
 * anchorForYear above, just expressed as a window swap instead of an anchor remap since this query
 * isn't built on ytdWindow/mtdWindow's proration logic. */
export async function fetchInvoiceClassificationYtd(
  pool: Pool,
  anchor: Date,
  filters: Filters,
  scope: InvoicesEngineScope = {},
): Promise<InvoiceClassificationSlice[]> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const window = scope.year !== undefined ? fullYearWindow(scope.year) : ytdWindow(anchor);
  const sql = `
    SELECT
      fsl.\`Invoice Class\`                AS invoiceClass,
      COALESCE(SUM(fsl.Value), 0)          AS value
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ? AND ${clause}
    GROUP BY fsl.\`Invoice Class\`
  `;
  const [rows] = await pool.query(sql, [toDateOnlyString(window.start), toDateOnlyString(window.end), ...params]);

  // Merge by normalized class -- see fetchSalesTrendByYearClass's comment on why this can't just
  // map 1:1 off the raw (unnormalized) GROUP BY rows.
  const byClass = new Map<string, InvoiceClassificationSlice>();
  for (const r of rows as any[]) {
    const invoiceClass = normalizeInvoiceClass(r.invoiceClass);
    const value = Number(r.value);
    const existing = byClass.get(invoiceClass);
    if (existing) existing.value += value;
    else byClass.set(invoiceClass, { invoiceClass, value });
  }

  return Array.from(byClass.values()).sort((a, b) => {
    const ai = INVOICE_CLASS_ORDER.indexOf(a.invoiceClass);
    const bi = INVOICE_CLASS_ORDER.indexOf(b.invoiceClass);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}
