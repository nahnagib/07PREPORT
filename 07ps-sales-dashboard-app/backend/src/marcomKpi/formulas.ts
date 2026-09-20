import { Rat, ratio } from './rat';

/**
 * Every MARCOM KPI formula, one line each. All inputs are SUMS already (numerators and
 * denominators are added first, THEN divided -- ratios are never averaged across months, brands or
 * platforms). Zero denominators yield null (-> `na`), never NaN/Infinity.
 * All results are exact fractions/ratios (Rat); percent conversion happens in makeKpi.
 */
export const roiRatio = (revenueAttributed: Rat, spend: Rat): Rat | null => ratio(revenueAttributed, spend);
export const budgetUtilization = (spend: Rat, budget: Rat): Rat | null => ratio(spend, budget);
export const brandGrowth = (revenueCurrent: Rat, revenueLastYear: Rat): Rat | null => ratio(revenueCurrent.sub(revenueLastYear), revenueLastYear);
export const cac = (spend: Rat, newCustomers: Rat): Rat | null => ratio(spend, newCustomers);
/** Σ(avg_invoice × new_customers) ÷ Σnew_customers -- weighted by customers, never a plain mean of invoices. */
export const weightedAvgInvoice = (invoiceTimesCustomers: Rat, newCustomers: Rat): Rat | null => ratio(invoiceTimesCustomers, newCustomers);
export const cacPctOfInvoice = (cacValue: Rat | null, weightedInvoice: Rat | null): Rat | null =>
  cacValue === null || weightedInvoice === null ? null : ratio(cacValue, weightedInvoice);
export const cpc = (socialPostCost: Rat, clicks: Rat): Rat | null => ratio(socialPostCost, clicks);

/**
 * Campaign "Spend vs Revenue Rate %". The template computes Revenue ÷ Spend (shown ×100 as a
 * percentage). To switch to Spend ÷ Revenue, change ONLY this line.
 */
export const campaignRate = (revenue: Rat, spend: Rat): Rat | null => ratio(revenue, spend);

export const ctr = (clicks: Rat, impressions: Rat): Rat | null => ratio(clicks, impressions);
export const engagementRate = (paid: Rat, organic: Rat, impressions: Rat): Rat | null => ratio(paid.add(organic), impressions);
export const organicShare = (paid: Rat, organic: Rat): Rat | null => ratio(organic, paid.add(organic));
export const bounceRate = (bounceVisitors: Rat, totalVisitors: Rat): Rat | null => ratio(bounceVisitors, totalVisitors);
export const avgSessionMinutes = (totalMinutes: Rat, sessions: Rat): Rat | null => ratio(totalMinutes, sessions);
export const attendanceRate = (actual: Rat, expected: Rat): Rat | null => ratio(actual, expected);

/** Whole days from start to end (ISO 'YYYY-MM-DD'), end - start. */
export function durationDays(startIso: string, endIso: string): number {
  const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(endIso) - t(startIso)) / 86_400_000);
}
