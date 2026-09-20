import { Rat, R, sum } from './rat';
import { Kpi, makeKpi, naKpi, classify, Status } from './kpi';
import * as F from './formulas';
import { AppliedPeriod, BrandRef, Num, groupBy, monthRange, total } from './common';
import { OVER_BUDGET_ABOVE, RAG_RULES } from './thresholds';

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
  /** The selected brands (all brands when no filter) -- drives the per-brand rows. */
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

/** Page 1 -- MARCOM Spending. Pure: rows in, chart-ready payload out. */
export function buildSpending(input: SpendingInput) {
  const { year, fromMonth, toMonth, current, previous, brands } = input;
  const months = monthRange(fromMonth, toMonth);
  const cur = aggregate(current);
  const prev = aggregate(previous);
  const byMonthCur = groupBy(current, (r) => r.month);
  const byMonthPrev = groupBy(previous, (r) => r.month);

  const series = (pick: (a: Agg) => Rat) =>
    months.map((m) => {
      const rows = byMonthCur.get(m);
      return { month: m, value: rows ? n(pick(aggregate(rows))) : null };
    });

  // ROI: cumulative over the selected range, and monthly points for Y and Y-1.
  const roiYtd = F.roiRatio(cur.revenue, cur.spend);
  const hasPrev = previous.length > 0;
  const roiLytd = hasPrev ? F.roiRatio(prev.revenue, prev.spend) : null;
  const roiMonthly = months.map((m) => {
    const c = byMonthCur.get(m);
    const p = byMonthPrev.get(m);
    const cv = c ? F.roiRatio(aggregate(c).revenue, aggregate(c).spend) : null;
    const pv = p ? F.roiRatio(aggregate(p).revenue, aggregate(p).spend) : null;
    return {
      month: m,
      current: cv === null ? null : cv.toNumber(),
      currentStatus: (c ? classify('roi', cv) : 'na') as Status,
      lastYear: pv === null ? null : pv.toNumber(),
      lastYearStatus: (p ? classify('roi', pv) : 'na') as Status,
    };
  });

  const byBrand = groupBy(current, (r) => r.brandId);
  const perBrand = brands.map((b) => ({ brand: b, agg: aggregate(byBrand.get(b.id) ?? []) }));

  const meta: { missing: string[] } = { missing: [] };
  if (!hasPrev) meta.missing.push('lastYearData');

  return {
    period: { year, fromMonth, toMonth },
    hasData: current.length > 0,
    meta,
    totals: {
      spend: { total: n(cur.spend), unit: 'lyd', series: series((a) => a.spend) },
      revenueAttributed: { total: n(cur.revenue), unit: 'lyd', series: series((a) => a.revenue) },
      companyRevenue: { total: n(cur.companyCurrent), unit: 'lyd', series: series((a) => a.companyCurrent) },
    },
    roi: {
      /** Cumulative over fromMonth..toMonth (= YTD when fromMonth is 1). `previous` is the LYTD ROI when uploaded. */
      ytd: makeKpi('ratio', roiYtd, { rule: 'roi', direction: 'higher_better', previous: hasPrev ? roiLytd : null }),
      lytd: hasPrev ? makeKpi('ratio', roiLytd, { rule: 'roi', direction: 'higher_better' }) : null,
      monthly: roiMonthly,
      /** Reference lines for the chart, read from the threshold config (green above `greenAbove`, red below `redBelow`). */
      bands: { greenAbove: Number(RAG_RULES.roi.green.value), redBelow: Number(RAG_RULES.roi.red.value) },
    },
    budgetUtilization: {
      overall: budgetBlock(cur),
      brands: perBrand.map(({ brand, agg }) => ({ brandId: brand.id, brand: brand.name, ...budgetBlock(agg) })),
    },
    brandGrowth: {
      overall: growthBlock(cur),
      brands: perBrand.map(({ brand, agg }) => ({ brandId: brand.id, brand: brand.name, ...growthBlock(agg) })),
    },
    cac: {
      overall: cacBlock(cur),
      brands: perBrand.map(({ brand, agg }) => ({ brandId: brand.id, brand: brand.name, ...cacBlock(agg) })),
    },
    cpc: {
      overall: cpcBlock(cur),
      brands: perBrand.map(({ brand, agg }) => ({ brandId: brand.id, brand: brand.name, ...cpcBlock(agg) })),
    },
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
