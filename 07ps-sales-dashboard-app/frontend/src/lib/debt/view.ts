import type { DebtDrillKind, DebtMeta, DebtOption, DebtReportScope, DebtTrend } from '../api';
import { formatDate, formatNumber } from '../format';

/**
 * Pure helpers of the Receivables and Collections page (app/(departments)/price/receivables-collections). Every label and threshold comes from
 * GET /debt-report/meta (Odoo's own labels in English and Arabic, our scope / bucket names, the size-tier thresholds
 * from the backend config); nothing here hard-codes one.
 */

export type LabelLang = 'en' | 'ar';

/** An option's label in the chosen language (Arabic falls back to English when Odoo has no translation). */
export function optLabel(o: Pick<DebtOption, 'labelEn' | 'labelAr'>, lang: LabelLang): string {
  return lang === 'ar' && o.labelAr ? o.labelAr : o.labelEn;
}

export function pickLabel(en: string | null | undefined, ar: string | null | undefined, lang: LabelLang): string {
  return (lang === 'ar' && ar ? ar : en) ?? '—';
}

/** Size-tier option label with its configured range, e.g. "Large (≥ LYD 100,000)". */
export function tierLabel(t: DebtMeta['options']['sizeTiers'][number], lang: LabelLang): string {
  const money = (v: number) => `LYD ${formatNumber(v)}`;
  const range = t.min !== null && t.max !== null ? `${money(t.min)}–${money(t.max)}` : t.min !== null ? `≥ ${money(t.min)}` : `< ${money(t.max as number)}`;
  return `${optLabel(t, lang)} (${range})`;
}

/**
 * Bar colour of an aging bucket: not-due buckets in the accent (blue) family, overdue ones in the alert (red) family,
 * each family darker the further from "due today". `index` is the bucket's position within its own family (0-based,
 * nearest to today first), `count` the family's size.
 */
export function agingColor(isOverdue: boolean, index: number, count: number): string {
  const strength = count <= 1 ? 100 : Math.round(45 + (55 * index) / (count - 1));
  const base = isOverdue ? 'var(--ps-color-alert)' : 'var(--ps-color-accent)';
  return `color-mix(in srgb, ${base} ${strength}%, var(--ps-color-surface))`;
}

/** Colour per aging bucket key, in AgingBucketKey order; not-due keys count down towards today (1 = furthest). */
export function agingColors(buckets: { agingBucketKey: number; isOverdue: boolean }[]): Map<number, string> {
  const notDue = buckets.filter((b) => !b.isOverdue);
  const overdue = buckets.filter((b) => b.isOverdue);
  const out = new Map<number, string>();
  // not due: the bucket nearest today (last in key order) is lightest
  notDue.forEach((b, i) => out.set(b.agingBucketKey, agingColor(false, notDue.length - 1 - i, notDue.length)));
  overdue.forEach((b, i) => out.set(b.agingBucketKey, agingColor(true, i, overdue.length)));
  return out;
}

/** Tooltip of the Invoice size filter: the tiers classify on Odoo's company-currency (LYD) residual of the invoice. */
export const SIZE_TIER_HINT = 'Size tier based on the invoice\'s open LYD value';

/** "42.3%" or "—". */
export function pctLabel(p: number | null | undefined): string {
  return p === null || p === undefined ? '—' : `${(p * 100).toFixed(1)}%`;
}

/** What a drill-down lists: an overdue bar its overdue lines, an aging bar / a table row every open line. */
export function drillTitle(kind: DebtDrillKind, label: string, currency: string | null): string {
  const what =
    kind === 'aging' ? 'Open documents in' : kind === 'account' ? 'Open documents of' : kind === 'customer_open' ? 'Open invoices of' : 'Overdue documents of';
  return `${what} ${label} · ${currency ?? 'All currencies (≈ LYD)'}`;
}

/** The figure a drill-down must reconcile to: the overdue amount, or the open balance for an aging bar / table row. */
export function drillReconciles(kind: DebtDrillKind): 'overdueAmount' | 'openBalance' {
  return kind === 'aging' || kind === 'account' || kind === 'customer_open' ? 'openBalance' : 'overdueAmount';
}

export interface DebtPageFilters {
  snapshotDate: string | null;
  companyKeys: number[];
  segmentKeys: number[];
  channelKeys: number[];
  salespersonKeys: number[];
  salesTeamKeys: string[];
  customerKeys: number[];
  overdueStatus: 'all' | 'overdue' | 'not_due';
  agingBucketKeys: number[];
  deliveryStatuses: string[];
  paymentTermKeys: number[];
  invoiceTiers: ('large' | 'medium' | 'small')[];
  /** Customer Category: 'A'..'D', 'none' */
  customerCategories: string[];
  includeOther: boolean;
  includeIntercompany: boolean;
}

/** Defaults: latest snapshot, Company All, customer debt only, inter-company excluded, no filter. */
export const DEFAULT_DEBT_FILTERS: DebtPageFilters = {
  snapshotDate: null,
  companyKeys: [],
  segmentKeys: [],
  channelKeys: [],
  salespersonKeys: [],
  salesTeamKeys: [],
  customerKeys: [],
  overdueStatus: 'all',
  agingBucketKeys: [],
  deliveryStatuses: [],
  paymentTermKeys: [],
  invoiceTiers: [],
  customerCategories: [],
  includeOther: false,
  includeIntercompany: false,
};

export function isDefaultFilters(f: DebtPageFilters): boolean {
  return JSON.stringify(f) === JSON.stringify(DEFAULT_DEBT_FILTERS);
}

/** Number of filters set beyond the defaults (the Filters button badge). */
export function activeFilterCount(f: DebtPageFilters): number {
  const lists = [f.companyKeys, f.segmentKeys, f.channelKeys, f.salespersonKeys, f.salesTeamKeys, f.customerKeys, f.agingBucketKeys, f.deliveryStatuses, f.paymentTermKeys, f.invoiceTiers, f.customerCategories];
  return (
    lists.filter((l) => l.length > 0).length +
    (f.snapshotDate ? 1 : 0) +
    (f.overdueStatus !== 'all' ? 1 : 0) +
    (f.includeOther ? 1 : 0) +
    (f.includeIntercompany ? 1 : 0)
  );
}

/** The API scope of the page filters; a salesperson's own lock is applied by the server (their selection is ignored). */
export function toScope(f: DebtPageFilters, isSalesperson: boolean): DebtReportScope {
  return {
    snapshotDate: f.snapshotDate,
    includeOther: f.includeOther,
    includeIntercompany: f.includeIntercompany,
    companyKeys: isSalesperson ? [] : f.companyKeys,
    segmentKeys: isSalesperson ? [] : f.segmentKeys,
    channelKeys: isSalesperson ? [] : f.channelKeys,
    salespersonKeys: isSalesperson ? [] : f.salespersonKeys,
    salesTeamKeys: isSalesperson ? [] : f.salesTeamKeys,
    customerKeys: f.customerKeys,
    overdueStatus: f.overdueStatus,
    agingBucketKeys: f.agingBucketKeys,
    deliveryStatuses: f.deliveryStatuses,
    paymentTermKeys: f.paymentTermKeys,
    invoiceTiers: f.invoiceTiers,
    customerCategories: f.customerCategories,
  };
}

/** The values of the "Include" dropdown: the two scope toggles as one multi-select. */
export type IncludeValue = 'other' | 'intercompany';
export function includeValues(f: Pick<DebtPageFilters, 'includeOther' | 'includeIntercompany'>): IncludeValue[] {
  return [...(f.includeOther ? (['other'] as const) : []), ...(f.includeIntercompany ? (['intercompany'] as const) : [])];
}
export function fromIncludeValues(values: string[]): Pick<DebtPageFilters, 'includeOther' | 'includeIntercompany'> {
  return { includeOther: values.includes('other'), includeIntercompany: values.includes('intercompany') };
}


/** The overdue-status dropdown: the cards' own words ("Not yet due"). */
/** The shared Select adds its own "All" row (= 'all', no filter), so it is not an option here. */
export const OVERDUE_STATUS_OPTIONS: { value: DebtPageFilters['overdueStatus']; label: string }[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'not_due', label: 'Not yet due' },
];

/** Odoo record link (the API builds it from ODOO_WEB_BASE_URL); only http(s) links are rendered. */
export function safeOdooUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/** The Receivables trend on a calendar axis: one point per day from the first to the last snapshot; a day without a
 * snapshot, or a snapshot without any line for the filters (null amounts), stays empty so the line breaks there instead
 * of drawing a trend no data supports (2026-10-11). */
export function dailyTrendPoints(points: DebtTrend['points']): { label: string; total: number | null; overdue: number | null; notDue: number | null }[] {
  if (points.length === 0) return [];
  const byDate = new Map(points.map((p) => [p.snapshotDate, p]));
  const dates = points.map((p) => p.snapshotDate).sort();
  const out = [];
  for (let d = dates[0]; d <= dates[dates.length - 1]; ) {
    const p = byDate.get(d);
    out.push({ label: formatDate(d), total: p?.open ?? null, overdue: p?.overdue ?? null, notDue: p?.notDue ?? null });
    const next = new Date(`${d}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    d = next.toISOString().slice(0, 10);
  }
  return out;
}

/** Day / Week / Month switch of the Receivables trend (same choices and week rule as the Collections trend). */
export type ReceivablesGrain = 'day' | 'week' | 'month';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** First day of the period holding `iso`: the day, the Saturday of its week (Saturday..Friday), the 1st of its month. */
export function receivablesPeriodStart(iso: string, grain: ReceivablesGrain): string {
  if (grain === 'day') return iso;
  if (grain === 'month') return `${iso.slice(0, 7)}-01`;
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Receivables trend points for a grain. Receivables are a BALANCE (what is open on a snapshot date), so a week or a
 * month is never a sum of its days: each period shows its LAST snapshot that has a value (the closing balance), and
 * `asOf` says which day that was. Days keep the gap-preserving daily series (dailyTrendPoints). Weeks run Saturday to
 * Friday and are named by their Saturday ("3 Oct 26"), months "Oct 2026" -- the same labels as the Collections trend.
 */
export function receivablesTrendPoints(points: DebtTrend['points'], grain: ReceivablesGrain): { label: string; total: number | null; overdue: number | null; notDue: number | null; asOf: string | null; periodStart: string }[] {
  if (grain === 'day') return dailyTrendPoints(points).map((p) => ({ ...p, asOf: null, periodStart: p.label }));
  const last = new Map<string, DebtTrend['points'][number]>();
  for (const p of [...points].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))) {
    if (p.open === null) continue;
    last.set(receivablesPeriodStart(p.snapshotDate, grain), p); // later snapshots overwrite earlier ones
  }
  return [...last.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, p]) => {
    const [y, m, d] = start.split('-').map(Number);
    return {
      label: grain === 'month' ? `${SHORT_MONTHS[m - 1]} ${y}` : `${d} ${SHORT_MONTHS[m - 1]} ${String(y).slice(2)}`,
      total: p.open, overdue: p.overdue, notDue: p.notDue, asOf: p.snapshotDate, periodStart: start,
    };
  });
}

// ---- page currency filter (2026-10-15) ------------------------------------------------------------------------------
/** The page-wide currency filter lives in the URL (?currency=USD) so a view can be shared and survives a refresh;
 * absent / invalid = null = "All currencies (≈ LYD)". */
export function currencyFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get('currency')?.trim().toUpperCase() ?? '';
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

/** The same URL with the currency set (or removed for null), every other parameter kept. */
export function searchWithCurrency(search: string, currency: string | null): string {
  const params = new URLSearchParams(search);
  if (currency) params.set('currency', currency);
  else params.delete('currency');
  const q = params.toString();
  return q ? `?${q}` : '';
}

/** Clicking a currency row: the same row again clears the filter, another row switches to it. */
export function toggleCurrency(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}
