import type { DebtComparison, DebtMeta, DebtOption, DebtReportScope } from '../api';
import { formatCompactCurrency, formatCurrencyFull, formatDate, formatNumber } from '../format';

/**
 * Pure helpers of the Debt Report page (app/(departments)/price/debt-report). Every label and threshold comes from
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

/** "+LYD 1.2M" / "−LYD 350K" / "LYD 0". */
export function signedCompact(v: number): string {
  if (Math.abs(v) < 0.5) return formatCompactCurrency(0);
  return `${v > 0 ? '+' : '−'}${formatCompactCurrency(Math.abs(v))}`;
}

/** One line of the "change in overdue" card: the change, or when it becomes available. */
export function changeLine(c: DebtComparison & { change: number | null }): string {
  if (c.change === null) return `${c.days}d: available from ${formatDate(c.availableFrom)}`;
  return `${c.days}d: ${signedCompact(c.change)}`;
}

/** Table cell of a per-customer change: the amount, or "—" until the comparison snapshot exists. */
export function changeCell(v: number | null): string {
  return v === null ? '—' : `${v > 0 ? '+' : ''}${formatCurrencyFull(v)}`;
}

export interface DebtPageFilters {
  snapshotDate: string | null;
  companyKeys: number[];
  salespersonKeys: number[];
  salesTeamKeys: string[];
  customerSearch: string;
  overdueStatus: 'all' | 'overdue' | 'not_due';
  agingBucketKeys: number[];
  deliveryStatuses: string[];
  paymentTermKeys: number[];
  documentTypeKeys: string[];
  invoiceTiers: ('large' | 'medium' | 'small')[];
  customerTiers: ('large' | 'medium' | 'small')[];
  includeOther: boolean;
  includeIntercompany: boolean;
}

/** Defaults: latest snapshot, customer debt only, inter-company excluded, no filter. */
export const DEFAULT_DEBT_FILTERS: DebtPageFilters = {
  snapshotDate: null,
  companyKeys: [],
  salespersonKeys: [],
  salesTeamKeys: [],
  customerSearch: '',
  overdueStatus: 'all',
  agingBucketKeys: [],
  deliveryStatuses: [],
  paymentTermKeys: [],
  documentTypeKeys: [],
  invoiceTiers: [],
  customerTiers: [],
  includeOther: false,
  includeIntercompany: false,
};

export function isDefaultFilters(f: DebtPageFilters): boolean {
  return JSON.stringify(f) === JSON.stringify(DEFAULT_DEBT_FILTERS);
}

/** Number of filters set beyond the defaults (the Filters button badge). */
export function activeFilterCount(f: DebtPageFilters): number {
  const lists = [f.companyKeys, f.salespersonKeys, f.salesTeamKeys, f.agingBucketKeys, f.deliveryStatuses, f.paymentTermKeys, f.documentTypeKeys, f.invoiceTiers, f.customerTiers];
  return (
    lists.filter((l) => l.length > 0).length +
    (f.snapshotDate ? 1 : 0) +
    (f.customerSearch.trim() ? 1 : 0) +
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
    salespersonKeys: isSalesperson ? [] : f.salespersonKeys,
    salesTeamKeys: isSalesperson ? [] : f.salesTeamKeys,
    customerSearch: f.customerSearch,
    overdueStatus: f.overdueStatus,
    agingBucketKeys: f.agingBucketKeys,
    deliveryStatuses: f.deliveryStatuses,
    paymentTermKeys: f.paymentTermKeys,
    documentTypeKeys: f.documentTypeKeys,
    invoiceTiers: f.invoiceTiers,
    customerTiers: f.customerTiers,
  };
}

/** Odoo record link (the API builds it from ODOO_WEB_BASE_URL); only http(s) links are rendered. */
export function safeOdooUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}
