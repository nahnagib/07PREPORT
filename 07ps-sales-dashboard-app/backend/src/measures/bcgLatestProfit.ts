/**
 * BCG class of each Active product on the SELECTED PERIOD (2026-11-14, round 2), with the threshold rule of the config
 * (bcg block of data/etl/config/product_dashboard.json, served in etl_sales_product_dashboard_meta.ConfigJson):
 *   high volume = units sold in the period >= the company's volume_threshold (Majaal 3,500 / Tika 25,000 a year), scaled
 *                 to the period length for a custom range (x days / 365; the default Last 12 Months uses it as is)
 *   high profit = GP% >= profit_threshold_pct (35%); GP% = (Value - CostValue) / Value of the fully costed sales days
 *   Stars = high / high · Cash Cows = high volume, low GP% · Strategic = low volume, high GP% · Dogs = low / low
 * Every Active product gets one of the 4 classes: a product without cost data (no fully costed sales day, or zero revenue
 * on them) has no GP%, which counts as LOW (Cash Cows or Dogs), and is flagged missingCost (profit-access users only).
 * The thresholds stay server-side: the API never sends them (productDashboard.ts publicThresholds).
 * Company-wide: the role scope never reclassifies.
 */
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** The bcg thresholds of data/etl/config/product_dashboard.json. Used only when the ETL snapshot of the config
 * (etl_sales_product_dashboard_meta.ConfigJson) lacks them -- a snapshot written while the thresholds were removed. */
export const DEFAULT_BCG_THRESHOLDS = { volume_threshold: { Majaal: 3500, Tika: 25000, Athena: 3500 }, profit_threshold_pct: 35 };

export const BCG_CLASS_KEYS = ['Stars', 'Cash Cows', 'Strategic', 'Dogs'] as const;
export type BcgClassKey = (typeof BCG_CLASS_KEYS)[number];

/** The config thresholds with the bcg values always present (the config snapshot's own values win). Server-side only. */
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

/** `volumeScale` multiplies the yearly volume threshold (period days / 365 for a custom range, 1 by default).
 * A null GP% (no cost data) is LOW. */
export function classify(company: string, qty: number, grossProfitPct: number | null, rule: BcgRule, volumeScale = 1): BcgClassKey {
  const threshold = (rule.volume[company.trim().toUpperCase()] ?? Number.POSITIVE_INFINITY) * volumeScale;
  const highVolume = qty >= threshold;
  const highProfit = grossProfitPct !== null && grossProfitPct >= rule.profitPct;
  if (highVolume) return highProfit ? 'Stars' : 'Cash Cows';
  return highProfit ? 'Strategic' : 'Dogs';
}

export interface BcgPeriodRow {
  k: string;
  company: string;
  /** Every sale of the period. */
  qty: number;
  value: number;
  /** The fully costed sales days only; null = none. */
  costed: { value: number; cost: number } | null;
  /** Every sales day of the period is fully costed. */
  complete: boolean;
  lastDate: string | null;
  /** At least one sale with quantity > 0 in the period: the product is Active. */
  sold: boolean;
}

export interface BcgResult {
  bcgClass: BcgClassKey;
  /** Units / sales value of the period (all sales). */
  volume: number;
  value: number;
  /** Value - cost of the fully costed days; null = no cost data. */
  profit: number | null;
  grossProfitPct: number | null;
  /** Some (or every) sale of the period has no standard cost in Odoo, or GP% is undefined (zero revenue). */
  missingCost: boolean;
  dataAsOf: string | null;
}

export function classifyPeriod(row: BcgPeriodRow, rule: BcgRule, volumeScale = 1): BcgResult {
  const profit = row.costed ? row.costed.value - row.costed.cost : null;
  const gp = row.costed && row.costed.value !== 0 ? ((row.costed.value - row.costed.cost) / row.costed.value) * 100 : null;
  return {
    bcgClass: classify(row.company, row.qty, gp, rule, volumeScale),
    volume: row.qty,
    value: row.value,
    profit,
    grossProfitPct: gp,
    missingCost: !row.complete || gp === null,
    dataAsOf: row.lastDate,
  };
}

/** One row per product sold in [from, to], company-wide, after every exclusion. */
export async function fetchBcgPeriod(pool: Pool, from: string, to: string, excludedCompanies: string[]): Promise<BcgPeriodRow[]> {
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
            SUM(Qty) AS qty, SUM(Value) AS value,
            SUM(CASE WHEN fullyCosted = 1 THEN Value END) AS costedValue,
            SUM(CASE WHEN fullyCosted = 1 THEN CostValue END) AS costedCost,
            SUM(1 - fullyCosted) AS incompleteDays,
            SUM(fullyCosted = 1 AND (CostedQty <> 0 OR CostValue <> 0)) AS costedRows,
            SUM(CASE WHEN Qty > 0 THEN 1 ELSE 0 END) AS soldRows,
            DATE_FORMAT(MAX(OrderDate), '%Y-%m-%d') AS lastDate
     FROM daily
     GROUP BY ProductCompanyKey`,
    [from, to, excludedCompanies],
  );
  return rows.map((r) => ({
    k: String(r.k),
    company: String(r.company ?? ''),
    qty: Number(r.qty) || 0,
    value: Number(r.value) || 0,
    costed: Number(r.costedRows) > 0 ? { value: Number(r.costedValue) || 0, cost: Number(r.costedCost) || 0 } : null,
    complete: Number(r.incompleteDays) === 0 && Number(r.costedRows) > 0,
    lastDate: r.lastDate ? String(r.lastDate) : null,
    sold: Number(r.soldRows) > 0,
  }));
}
