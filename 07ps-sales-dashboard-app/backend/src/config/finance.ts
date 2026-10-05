/**
 * Debt Report settings (Finance / Price department). Thresholds, tier labels and the Odoo link live here -- never in
 * the page components, which receive them from GET /debt-report/meta. Each value can be overridden by environment
 * variable without a code change.
 *
 *   FINANCE_TIER_LARGE_MIN   open amount (LYD, company currency) from which a document / customer is "Large" (100000)
 *   FINANCE_TIER_MEDIUM_MIN  from which it is "Medium"; below it is "Small" (10000)
 *   ODOO_WEB_BASE_URL        base of the "open in Odoo" links (falls back to ODOO_URL, then majaal.odoo.com)
 *
 * Tiers are computed at query time from aggregated open amounts: a document's tier from the sum of its open lines,
 * a customer's from its open balance per company, both on the selected snapshot and receivable scopes (the
 * signed net amount: a credit balance is Small).
 */

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number (got "${raw}")`);
  return value;
}

export type SizeTier = 'large' | 'medium' | 'small';

export interface SizeTierDefinition {
  key: SizeTier;
  labelEn: string;
  labelAr: string;
  /** inclusive lower bound in LYD; null = no lower bound */
  min: number | null;
  /** exclusive upper bound in LYD; null = no upper bound */
  max: number | null;
}

export function sizeTiers(): SizeTierDefinition[] {
  const large = numberEnv('FINANCE_TIER_LARGE_MIN', 100_000);
  const medium = numberEnv('FINANCE_TIER_MEDIUM_MIN', 10_000);
  if (!(medium < large)) throw new Error('FINANCE_TIER_MEDIUM_MIN must be below FINANCE_TIER_LARGE_MIN');
  return [
    { key: 'large', labelEn: 'Large', labelAr: 'كبير', min: large, max: null },
    { key: 'medium', labelEn: 'Medium', labelAr: 'متوسط', min: medium, max: large },
    { key: 'small', labelEn: 'Small', labelAr: 'صغير', min: null, max: medium },
  ];
}

/** SQL CASE turning an amount expression into a tier key, from the configured thresholds (bound as parameters). */
export function tierCaseSql(amountExpr: string): { sql: string; params: number[] } {
  const [large, medium] = sizeTiers();
  return {
    sql: `CASE WHEN ${amountExpr} >= ? THEN 'large' WHEN ${amountExpr} >= ? THEN 'medium' ELSE 'small' END`,
    params: [large.min as number, medium.min as number],
  };
}

export function odooWebBaseUrl(): string {
  return (process.env.ODOO_WEB_BASE_URL || process.env.ODOO_URL || 'https://majaal.odoo.com').replace(/\/+$/, '');
}

/** Number of customers in the "Overdue by customer" chart. */
export const DEBT_TOP_CUSTOMERS = 15;
/** Comparison windows of the "change in overdue" KPI and the exposure table, in days. */
export const DEBT_CHANGE_WINDOWS = [7, 30] as const;
/** Days of sales behind sales_last_90d / DSO. */
export const DEBT_SALES_WINDOW_DAYS = 90;
