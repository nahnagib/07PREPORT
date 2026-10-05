import type { DebtDrillKind, DebtMeta, DebtOption, DebtReportScope } from '../api';
import { formatNumber } from '../format';

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

/** Tooltip of the Invoice size / Customer size filters: the tiers classify on Odoo's company-currency (LYD) residual. */
export const SIZE_TIER_HINT = 'Size tier based on LYD value';

/** "42.3%" or "—". */
export function pctLabel(p: number | null | undefined): string {
  return p === null || p === undefined ? '—' : `${(p * 100).toFixed(1)}%`;
}

/** What a drill-down lists: an overdue bar its overdue lines, an aging bar / a table row every open line. */
export function drillTitle(kind: DebtDrillKind, label: string, currency: string): string {
  const what =
    kind === 'aging' ? 'Open documents in' : kind === 'account' ? 'Open documents of' : 'Overdue documents of';
  return `${what} ${label} · ${currency}`;
}

/** The figure a drill-down must reconcile to: the overdue amount, or the open balance for an aging bar / table row. */
export function drillReconciles(kind: DebtDrillKind): 'overdueAmount' | 'openBalance' {
  return kind === 'aging' || kind === 'account' ? 'openBalance' : 'overdueAmount';
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
