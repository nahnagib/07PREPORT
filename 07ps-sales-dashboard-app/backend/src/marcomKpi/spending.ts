import { Rat, R, sum } from './rat';
import { Kpi, makeKpi } from './kpi';
import * as F from './formulas';
import { AppliedPeriod, BrandRef, Num, companiesOf, groupBy, monthRange, total } from './common';
import { OVER_BUDGET_ABOVE, RAG_RULES } from './thresholds';
import { buildRoi } from './roi';

export interface SpendRow {
  year: number; month: number; brandId: number; brand: string;
  spend: Num; revenue: Num; companyCurrent: Num; companyLy: Num; budget: Num;
  newCustomers: Num; avgInvoice: Num; socialPostCost: Num; clicks: Num;
}

export interface SpendingInput extends AppliedPeriod {
  /** Rows for `year`, months fromMonth..toMonth (already brand-filtered, current rows only). */
  current: SpendRow[];
  /** The same months of year - 1 (already brand-filtered, current rows only). */
  previous: SpendRow[];
  /** The selected brands (all brands when no filter) -- drives the per-brand and per-company rows. */
  brands: BrandRef[];
}

interface Agg {
  spend: Rat; revenue: Rat; companyCurrent: Rat; companyLy: Rat; budget: Rat;
  customers: Rat; invoiceTimesCustomers: Rat; post: Rat; clicks: Rat;
}

function aggregate(rows: SpendRow[]): Agg {
  return {
    spend: total(rows, (r) => r.spend),
    revenue: total(rows, (r) => r.revenue),
    companyCurrent: total(rows, (r) => r.companyCurrent),
    companyLy: total(rows, (r) => r.companyLy),
    budget: total(rows, (r) => r.budget),
    customers: total(rows, (r) => r.newCustomers),
    invoiceTimesCustomers: sum(rows.map((r) => R(r.avgInvoice).mul(R(r.newCustomers)))),
    post: total(rows, (r) => r.socialPostCost),
    clicks: total(rows, (r) => r.clicks),
  };
}

const n = (r: Rat) => r.toNumber();

function cacBlock(a: Agg) {
  const cacValue = F.cac(a.spend, a.customers);
  const weighted = F.weightedAvgInvoice(a.invoiceTimesCustomers, a.customers);
  const pctOfInvoice = F.cacPctOfInvoice(cacValue, weighted);
  const pctKpi = makeKpi('percent', pctOfInvoice, { rule: 'cacPctOfInvoice', direction: 'lower_better' });
  // The card's colour is the %-of-invoice status; the LYD figure itself has no threshold.
  const cacKpi: Kpi = { ...makeKpi('lyd', cacValue, { direction: 'lower_better' }), status: pctKpi.status };
  return {
    ...cacKpi,
    pctOfInvoice: pctKpi,
    weightedAvgInvoice: weighted === null ? null : n(weighted),
    newCustomers: n(a.customers),
    spend: n(a.spend),
  };
}

function budgetBlock(a: Agg) {
  const v = F.budgetUtilization(a.spend, a.budget);
  return {
    ...makeKpi('percent', v),
    spend: n(a.spend),
    budget: n(a.budget),
    overBudget: v !== null && v.cmp(R(OVER_BUDGET_ABOVE)) > 0,
  };
}

function growthBlock(a: Agg) {
  return {
    ...makeKpi('percent', F.brandGrowth(a.companyCurrent, a.companyLy), { direction: 'higher_better' }),
    revenueCurrent: n(a.companyCurrent),
    revenueLastYear: n(a.companyLy),
  };
}

function cpcBlock(a: Agg) {
  return {
    ...makeKpi('lyd', F.cpc(a.post, a.clicks), { rule: 'cpc', direction: 'lower_better' }),
    socialPostCost: n(a.post),
    clicks: n(a.clicks),
  };
}

/** Page 1 -- MARCOM Spending. Pure: rows in, chart-ready payload out. */
export function buildSpending(input: SpendingInput) {
  const { year, fromMonth, toMonth, current, previous, brands } = input;
  const months = monthRange(fromMonth, toMonth);
  const cur = aggregate(current);
  const byMonthCur = groupBy(current, (r) => r.month);
  const monthAgg = new Map([...byMonthCur].map(([m, rows]) => [m, aggregate(rows)]));

  const series = (pick: (a: Agg) => Rat) =>
    months.map((m) => {
      const a = monthAgg.get(m);
      return { month: m, value: a ? n(pick(a)) : null };
    });
  /** Monthly percent points of a ratio (sum first per month, then divide); null when the month has no data or a zero denominator. */
  const pctSeries = (f: (a: Agg) => Rat | null) =>
    months.map((m) => {
      const a = monthAgg.get(m);
      return { month: m, value: a ? makeKpi('percent', f(a)).value : null };
    });

  // ROI is rendered on the Media Campaign Performance page now; kept here so the API shape does not break.
  const { roi, hasPrev } = buildRoi(current, previous, fromMonth, toMonth);

  const byBrand = groupBy(current, (r) => r.brandId);
  const brandRef = (b: BrandRef) => ({ brandId: b.id, brand: b.name, companyKey: b.companyKey ?? null, company: b.company ?? null });
  const perBrand = brands.map((b) => ({ ref: brandRef(b), agg: aggregate(byBrand.get(b.id) ?? []) }));
  const perCompany = companiesOf(brands).map((c) => ({
    ref: { companyKey: c.key, company: c.name, brands: c.brandIds.length },
    agg: aggregate(c.brandIds.flatMap((id) => byBrand.get(id) ?? [])),
  }));

  const meta: { missing: string[] } = { missing: [] };
  if (!hasPrev) meta.missing.push('lastYearData');

  const spendPct = (a: Agg) => F.spendPctOfRevenue(a.spend, a.revenue);
  const spendPctCompany = (a: Agg) => F.spendPctOfRevenue(a.spend, a.companyCurrent);

  return {
    period: { year, fromMonth, toMonth },
    hasData: current.length > 0,
    meta,
    totals: {
      spend: { total: n(cur.spend), unit: 'lyd', series: series((a) => a.spend) },
      revenueAttributed: { total: n(cur.revenue), unit: 'lyd', series: series((a) => a.revenue) },
      companyRevenue: { total: n(cur.companyCurrent), unit: 'lyd', series: series((a) => a.companyCurrent) },
      /** Target budget over the range (Σ budget). */
      budget: { total: n(cur.budget), unit: 'lyd', series: series((a) => a.budget) },
      /** Σspend ÷ Σrevenue attributed, in percentage points (monthly points summed per month first). */
      spendPctOfRevenue: { ...makeKpi('percent', spendPct(cur), { direction: 'lower_better' }), series: pctSeries(spendPct) },
      /** Σspend ÷ Σcompany revenue -- the same share against total company revenue. */
      spendPctOfCompanyRevenue: { ...makeKpi('percent', spendPctCompany(cur), { direction: 'lower_better' }), series: pctSeries(spendPctCompany) },
      /** Σspend ÷ Σbudget (same figure as budgetUtilization.overall). */
      budgetUsed: makeKpi('percent', F.budgetUtilization(cur.spend, cur.budget)),
    },
    roi,
    budgetUtilization: {
      overall: budgetBlock(cur),
      brands: perBrand.map(({ ref, agg }) => ({ ...ref, ...budgetBlock(agg) })),
      companies: perCompany.map(({ ref, agg }) => ({ ...ref, ...budgetBlock(agg) })),
    },
    brandGrowth: {
      overall: growthBlock(cur),
      brands: perBrand.map(({ ref, agg }) => ({ ...ref, ...growthBlock(agg) })),
      companies: perCompany.map(({ ref, agg }) => ({ ...ref, ...growthBlock(agg) })),
    },
    cac: {
      /** % of invoice scale for the chart, in percentage points, read from the threshold config (green at or below, red above). */
      bands: { greenAtMost: Number(RAG_RULES.cacPctOfInvoice.green.value) * 100, redAbove: Number(RAG_RULES.cacPctOfInvoice.red.value) * 100 },
      overall: cacBlock(cur),
      brands: perBrand.map(({ ref, agg }) => ({ ...ref, ...cacBlock(agg) })),
    },
    cpc: {
      overall: cpcBlock(cur),
      brands: perBrand.map(({ ref, agg }) => ({ ...ref, ...cpcBlock(agg) })),
    },
  };
}
