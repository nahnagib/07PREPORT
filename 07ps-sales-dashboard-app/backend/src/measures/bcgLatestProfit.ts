/**
 * BCG class on each product's LATEST profit data (2026-11-11), with the threshold rule of the config (bcg block of
 * data/etl/config/product_dashboard.json, served in etl_sales_product_dashboard_meta.ConfigJson):
 *   high volume = Qty >= the company's volume_threshold (Majaal 3,500 / Tika 25,000); high profit = GP% >= profit_threshold_pct (35%)
 *   Stars = high / high · Cash Cows = high volume, low GP% · Strategic = low volume, high GP% · Dogs = low / low
 * GP% = (Value - CostValue) / Value and Profit = Value - CostValue, from the product sales table (after every exclusion).
 *
 * Use the latest complete costed calendar window with a calculable margin. If no complete window has a
 * margin, try the fully costed daily totals in each window. Preserve recorded profit when revenue is zero.
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

interface BcgTotals {
  value: number;
  qty: number;
  cost: number;
  lastDate: string;
}

export interface BcgWindowRow {
  k: string;
  company: string;
  /** 'YTD' or a calendar year ('2025'). */
  win: string;
  complete: boolean;
  totals: BcgTotals | null;
}

export interface BcgLatest {
  bcgClass: string;
  volume: number | null;
  value: number | null;
  profit: number | null;
  grossProfitPct: number | null;
  /** 'YTD 2026' or '2025'; null = no profit data. */
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

/** Each sold product's class, profit and date come from the same window. */
export function latestBcg(rows: BcgWindowRow[], rule: BcgRule, ytdYear: number): Map<string, BcgLatest> {
  const byProduct = new Map<string, BcgWindowRow[]>();
  for (const row of rows) {
    const windows = byProduct.get(row.k) ?? [];
    windows.push(row);
    byProduct.set(row.k, windows);
  }
  const rank = (w: string) => (w === 'YTD' ? Number.POSITIVE_INFINITY : Number(w));
  const out = new Map<string, BcgLatest>();
  for (const [k, windows] of byProduct) {
    windows.sort((a, b) => rank(b.win) - rank(a.win));
    const hasMargin = (w: BcgWindowRow) => w.totals !== null && w.totals.value !== 0;
    const usable = windows.find((w) => w.complete && hasMargin(w))
      ?? windows.find(hasMargin)
      ?? windows.find((w) => w.totals !== null);
    if (!usable?.totals) {
      out.set(k, { bcgClass: UNCLASSIFIED_NO_COST, volume: null, value: null, profit: null, grossProfitPct: null, dataPeriod: null, dataAsOf: null });
      continue;
    }
    const { value, qty, cost, lastDate } = usable.totals;
    const profit = value - cost;
    const gp = value === 0 ? null : (profit / value) * 100;
    const period = usable.win === 'YTD' ? `YTD ${ytdYear}` : usable.win;
    out.set(k, {
      bcgClass: gp === null ? UNCLASSIFIED_ZERO_REVENUE : classify(usable.company, qty, gp, rule),
      volume: qty,
      value,
      profit,
      grossProfitPct: gp,
      dataPeriod: usable.complete ? period : `${period} (costed sales)`,
      dataAsOf: lastDate,
    });
  }
  return out;
}

/** One row per product and window (YTD, then each earlier calendar year), company-wide, after every exclusion. */
export async function fetchBcgWindows(pool: Pool, ytdFrom: string, ytdTo: string, excludedCompanies: string[]): Promise<BcgWindowRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `WITH daily AS (
       SELECT d.*,
              CASE WHEN d.OrderDate >= ? THEN 'YTD' ELSE CAST(YEAR(d.OrderDate) AS CHAR) END AS win,
              CASE WHEN d.UncostedQty = 0 AND d.CostValue IS NOT NULL
                        AND d.Value IS NOT NULL AND d.Qty IS NOT NULL
                        AND (d.CostedQty <> 0 OR d.CostValue <> 0 OR d.Qty = 0)
                   THEN 1 ELSE 0 END AS fullyCosted
       FROM v_sales_product_daily d
       WHERE d.OrderDate <= ? AND d.Company NOT IN (?) AND d.Lines > 0
     )
     SELECT ProductCompanyKey AS k, MAX(Company) AS company, win,
            SUM(CASE WHEN fullyCosted = 1 THEN Value END) AS value,
            SUM(CASE WHEN fullyCosted = 1 THEN Qty END) AS qty,
            SUM(CASE WHEN fullyCosted = 1 THEN CostValue END) AS cost,
            SUM(1 - fullyCosted) AS incompleteDays,
            SUM(fullyCosted = 1 AND (CostedQty <> 0 OR CostValue <> 0)) AS costedRows,
            DATE_FORMAT(MAX(CASE WHEN fullyCosted = 1 THEN OrderDate END), '%Y-%m-%d') AS lastDate
     FROM daily
     GROUP BY ProductCompanyKey, win`,
    [ytdFrom, ytdTo, excludedCompanies],
  );
  return rows.map((r) => ({
    k: String(r.k),
    company: String(r.company ?? ''),
    win: String(r.win),
    complete: Number(r.incompleteDays) === 0,
    totals: Number(r.costedRows) > 0 && r.lastDate
      ? { value: Number(r.value), qty: Number(r.qty), cost: Number(r.cost), lastDate: String(r.lastDate) }
      : null,
  }));
}
