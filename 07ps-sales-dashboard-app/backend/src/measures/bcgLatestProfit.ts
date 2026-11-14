/**
 * BCG class on each Active product's LAST 12 MONTHS (2026-11-14; was the latest costed calendar window), with the
 * threshold rule of the config (bcg block of
 * data/etl/config/product_dashboard.json, served in etl_sales_product_dashboard_meta.ConfigJson):
 *   high volume = Qty >= the company's volume_threshold (Majaal 3,500 / Tika 25,000); high profit = GP% >= profit_threshold_pct (35%)
 *   Stars = high / high · Cash Cows = high volume, low GP% · Strategic = low volume, high GP% · Dogs = low / low
 * GP% = (Value - CostValue) / Value and Profit = Value - CostValue, from the product sales table (after every exclusion).
 *
 * Window = lib/last12Months.ts. When every sales day of the window is fully costed the whole window is used; otherwise
 * the fully costed days only ("Last 12 Months (costed sales)"). No costed day = Unclassified (no cost); costed days with
 * zero revenue = Unclassified (zero revenue): both are "Not classified" on the BCG Matrix page.
 * Company-wide like the ETL class: the Customer Group / Channel / Branch / Salesperson filters never reclassify.
 */
import type { Pool, RowDataPacket } from 'mysql2/promise';

export const UNCLASSIFIED_NO_COST = 'Unclassified (no cost)';
export const UNCLASSIFIED_ZERO_REVENUE = 'Unclassified (zero revenue)';

/** The bcg thresholds of data/etl/config/product_dashboard.json. Used only when the ETL snapshot of the config
 * (etl_sales_product_dashboard_meta.ConfigJson) lacks them -- a snapshot written while the thresholds were removed. */
export const DEFAULT_BCG_THRESHOLDS = { volume_threshold: { Majaal: 3500, Tika: 25000, Athena: 3500 }, profit_threshold_pct: 35 };

/** The served thresholds with the bcg thresholds always present (the config snapshot's own values win). */
export function withBcgThresholds(thresholds: Record<string, unknown>): Record<string, unknown> {
  const bcg = (thresholds.bcg ?? {}) as {
    volume_threshold?: Record<string, number>;
    profit_threshold_pct?: number;
    movement_stable_band_pct?: number;
  };
  return {
    ...thresholds,
    bcg: {
      volume_threshold: { ...DEFAULT_BCG_THRESHOLDS.volume_threshold, ...bcg.volume_threshold },
      profit_threshold_pct: bcg.profit_threshold_pct ?? DEFAULT_BCG_THRESHOLDS.profit_threshold_pct,
      ...(bcg.movement_stable_band_pct != null && { movement_stable_band_pct: bcg.movement_stable_band_pct }),
    },
  };
}

export interface BcgWindowRow {
  k: string;
  company: string;
  /** Every sales day of the window is fully costed. */
  complete: boolean;
  /** Fully costed days only; null = none. */
  totals: { value: number; qty: number; cost: number; lastDate: string } | null;
}

export interface BcgLatest {
  bcgClass: string;
  volume: number | null;
  value: number | null;
  profit: number | null;
  grossProfitPct: number | null;
  /** 'Last 12 Months' or 'Last 12 Months (costed sales)'; null = no profit data. */
  dataPeriod: string | null;
  /** Latest sale date included in the profit calculation. */
  dataAsOf: string | null;
}

export interface BcgRule {
  volume: Record<string, number>;
  profitPct: number;
}

/** The config thresholds; company names are matched case-insensitively. Missing = no high volume / 35%. */
export function bcgRule(thresholds: Record<string, unknown>): BcgRule {
  const bcg = (thresholds.bcg ?? {}) as { volume_threshold?: Record<string, number>; profit_threshold_pct?: number };
  const volume: Record<string, number> = {};
  for (const [company, v] of Object.entries(bcg.volume_threshold ?? {})) volume[company.trim().toUpperCase()] = Number(v);
  return { volume, profitPct: typeof bcg.profit_threshold_pct === 'number' ? bcg.profit_threshold_pct : 35 };
}

export function classify(company: string, qty: number, grossProfitPct: number, rule: BcgRule): string {
  const threshold = rule.volume[company.trim().toUpperCase()] ?? Number.POSITIVE_INFINITY;
  const highVolume = qty >= threshold;
  const highProfit = grossProfitPct >= rule.profitPct;
  if (highVolume) return highProfit ? 'Stars' : 'Cash Cows';
  return highProfit ? 'Strategic' : 'Dogs';
}

/** Each product's class, profit and date from its last-12-months row. */
export function last12MonthsBcg(rows: BcgWindowRow[], rule: BcgRule, label = 'Last 12 Months'): Map<string, BcgLatest> {
  const out = new Map<string, BcgLatest>();
  for (const row of rows) {
    if (!row.totals) {
      out.set(row.k, { bcgClass: UNCLASSIFIED_NO_COST, volume: null, value: null, profit: null, grossProfitPct: null, dataPeriod: null, dataAsOf: null });
      continue;
    }
    const { value, qty, cost, lastDate } = row.totals;
    const profit = value - cost;
    const gp = value === 0 ? null : (profit / value) * 100;
    out.set(row.k, {
      bcgClass: gp === null ? UNCLASSIFIED_ZERO_REVENUE : classify(row.company, qty, gp, rule),
      volume: qty,
      value,
      profit,
      grossProfitPct: gp,
      dataPeriod: row.complete ? label : `${label} (costed sales)`,
      dataAsOf: lastDate,
    });
  }
  return out;
}

/** One row per product sold in [from, to], company-wide, after every exclusion. */
export async function fetchBcgLast12Months(pool: Pool, from: string, to: string, excludedCompanies: string[]): Promise<BcgWindowRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `WITH daily AS (
       SELECT d.*,
              CASE WHEN d.UncostedQty = 0 AND d.CostValue IS NOT NULL
                        AND d.Value IS NOT NULL AND d.Qty IS NOT NULL
                        AND (d.CostedQty <> 0 OR d.CostValue <> 0 OR d.Qty = 0)
                   THEN 1 ELSE 0 END AS fullyCosted
       FROM v_sales_product_daily d
       WHERE d.OrderDate BETWEEN ? AND ? AND d.Company NOT IN (?) AND d.Lines > 0
     )
     SELECT ProductCompanyKey AS k, MAX(Company) AS company,
            SUM(CASE WHEN fullyCosted = 1 THEN Value END) AS value,
            SUM(CASE WHEN fullyCosted = 1 THEN Qty END) AS qty,
            SUM(CASE WHEN fullyCosted = 1 THEN CostValue END) AS cost,
            SUM(1 - fullyCosted) AS incompleteDays,
            SUM(fullyCosted = 1 AND (CostedQty <> 0 OR CostValue <> 0)) AS costedRows,
            DATE_FORMAT(MAX(CASE WHEN fullyCosted = 1 THEN OrderDate END), '%Y-%m-%d') AS lastDate
     FROM daily
     GROUP BY ProductCompanyKey`,
    [from, to, excludedCompanies],
  );
  return rows.map((r) => ({
    k: String(r.k),
    company: String(r.company ?? ''),
    complete: Number(r.incompleteDays) === 0,
    totals: Number(r.costedRows) > 0 && r.lastDate
      ? { value: Number(r.value), qty: Number(r.qty), cost: Number(r.cost), lastDate: String(r.lastDate) }
      : null,
  }));
}
