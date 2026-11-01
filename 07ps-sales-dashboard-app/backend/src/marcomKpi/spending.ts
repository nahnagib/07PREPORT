import { Rat, R, sum } from './rat';
import { Kpi, makeKpi } from './kpi';
import * as F from './formulas';
import { AppliedPeriod, BrandRef, Num, companiesOf, groupBy, monthRange, total } from './common';
import { OVER_BUDGET_ABOVE, RAG_RULES } from './thresholds';
import { buildRoi } from './roi';
import type { OtherSpendRow } from './totalSpend';

/**
 * One Year + Month + Brand cell of Page 1 (template 2.0), already merged in pages.ts:
 *  - spend = Total MARCOM Spend = campaignSpend (prorated by active days) + otherSpend;
 *  - the P1 inputs (null when the brand has spend in that month but no P1 row yet).
 * Revenue inputs are brand-level and monthly. `needsReview` = row from template 1.x whose revenue was asked as a
 * company total (migration 0062): it has no brand revenue and is left out of the brand-revenue KPIs.
 */
export interface SpendRow {
  year: number; month: number; brandId: number; brand: string;
  /** 'GROUP' = group-level activity (BMH events): spend only, no brand revenue. */
  kind?: 'BRAND' | 'GROUP';
  spend: Num; campaignSpend?: Num; otherSpend?: Num;
  /** Revenue Attributed to Marketing. */
  revenue: Num | null;
  brandRevenue: Num | null; brandRevenueLy: Num | null; companyTotal?: Num | null;
  budget: Num | null;
  /** Finance Booked MARCOM Total (optional input) -- Unallocated = booked - spend. */
  booked?: Num | null;
  newCustomers: Num | null; avgInvoice: Num | null; socialPostCost: Num | null; clicks: Num | null;
  needsReview?: boolean;
}

export interface SpendingInput extends AppliedPeriod {
  /** Rows for `year`, months fromMonth..toMonth (already brand-filtered, current rows only). */
  current: SpendRow[];
  /** The same months of year - 1 (already brand-filtered, current rows only). */
  previous: SpendRow[];
  /** The selected brands (all brands when no filter) -- drives the per-brand and per-company rows. */
  brands: BrandRef[];
  /** Other (non-campaign) spend lines of `year`, months fromMonth..toMonth, selected brands. */
  otherLines?: OtherSpendRow[];
  /** Category order of the spend-category lookup (its sort order). */
  categories?: string[];
}

/** Label of the campaign bucket in the spend-by-category breakdown. */
export const CAMPAIGNS_CATEGORY = 'Campaigns';

interface Agg {
  spend: Rat; campaign: Rat; other: Rat; revenue: Rat; budget: Rat;
  /** Brand revenue of rows with BOTH months known (growth compares like with like). */
  brandRevenue: Rat; brandRevenueLy: Rat; growthRows: number;
  /** Brand revenue / attributed revenue of rows with brand revenue known (attributed %). */
  revenueBase: Rat; attributedOnBase: Rat;
  /** Brand revenue / company total of rows where the company total was entered (brand share %). */
  shareBrand: Rat; shareCompany: Rat; shareRows: number;
  /** Unallocated = Σ booked - Σ spend over rows where finance entered a booked total. */
  booked: Rat; spendOnBooked: Rat; bookedRows: number;
  customers: Rat; invoiceTimesCustomers: Rat; post: Rat; clicks: Rat;
}

const known = (v: Num | null | undefined): v is Num => v !== null && v !== undefined && v !== '';
const isBrand = (r: SpendRow) => (r.kind ?? 'BRAND') === 'BRAND' && !r.needsReview;

function aggregate(rows: SpendRow[]): Agg {
  const growth = rows.filter((r) => isBrand(r) && known(r.brandRevenue) && known(r.brandRevenueLy));
  const base = rows.filter((r) => isBrand(r) && known(r.brandRevenue));
  const share = rows.filter((r) => isBrand(r) && known(r.brandRevenue) && known(r.companyTotal));
  const booked = rows.filter((r) => known(r.booked));
  return {
    spend: total(rows, (r) => r.spend),
    campaign: total(rows, (r) => r.campaignSpend ?? 0),
    other: total(rows, (r) => r.otherSpend ?? 0),
    revenue: total(rows, (r) => r.revenue ?? 0),
    budget: total(rows, (r) => r.budget ?? 0),
    brandRevenue: total(growth, (r) => r.brandRevenue!),
    brandRevenueLy: total(growth, (r) => r.brandRevenueLy!),
    growthRows: growth.length,
    revenueBase: total(base, (r) => r.brandRevenue!),
    attributedOnBase: total(base, (r) => r.revenue ?? 0),
    shareBrand: total(share, (r) => r.brandRevenue!),
    shareCompany: total(share, (r) => r.companyTotal!),
    shareRows: share.length,
    booked: total(booked, (r) => r.booked!),
    spendOnBooked: total(booked, (r) => r.spend),
    bookedRows: booked.length,
    customers: total(rows, (r) => r.newCustomers ?? 0),
    invoiceTimesCustomers: sum(rows.map((r) => R(r.avgInvoice).mul(R(r.newCustomers)))),
    post: total(rows, (r) => r.socialPostCost ?? 0),
    clicks: total(rows, (r) => r.clicks ?? 0),
  };
}

const n = (r: Rat) => r.toNumber();
const unallocated = (a: Agg): number | null => (a.bookedRows ? n(a.booked.sub(a.spendOnBooked)) : null);

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
    campaignSpend: n(a.campaign),
    otherSpend: n(a.other),
    budget: n(a.budget),
    overBudget: v !== null && v.cmp(R(OVER_BUDGET_ABOVE)) > 0,
  };
}

function growthBlock(a: Agg) {
  return {
    ...makeKpi('percent', a.growthRows ? F.brandGrowth(a.brandRevenue, a.brandRevenueLy) : null, { direction: 'higher_better' }),
    revenueCurrent: n(a.brandRevenue),
    revenueLastYear: n(a.brandRevenueLy),
    /** Marketing-attributed share of brand revenue (Σ attributed ÷ Σ brand revenue). */
    attributedPct: makeKpi('percent', F.attributedPct(a.attributedOnBase, a.revenueBase), { direction: 'higher_better' }),
    /** Brand revenue ÷ company total revenue, over months where the company total was entered. */
    brandShare: makeKpi('percent', a.shareRows ? F.brandShare(a.shareBrand, a.shareCompany) : null),
  };
}

function cpcBlock(a: Agg) {
  return {
    ...makeKpi('lyd', F.cpc(a.post, a.clicks), { rule: 'cpc', direction: 'lower_better' }),
    socialPostCost: n(a.post),
    clicks: n(a.clicks),
  };
}

function reconBlock(a: Agg) {
  return { campaignSpend: n(a.campaign), otherSpend: n(a.other), totalSpend: n(a.spend), booked: a.bookedRows ? n(a.booked) : null, unallocated: unallocated(a) };
}

/** Page 1 -- MARCOM Spending. Pure: rows in, chart-ready payload out. */
export function buildSpending(input: SpendingInput) {
  const { year, fromMonth, toMonth, current, previous, brands } = input;
  const otherLines = input.otherLines ?? [];
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
  const brandRef = (b: BrandRef) => ({ brandId: b.id, brand: b.name, companyKey: b.companyKey ?? null, company: b.company ?? null, kind: b.kind ?? 'BRAND' });
  const perBrand = brands.map((b) => ({ ref: brandRef(b), agg: aggregate(byBrand.get(b.id) ?? []) }));
  const revenueBrands = perBrand.filter((b) => b.ref.kind === 'BRAND');
  const perCompany = companiesOf(brands).map((c) => ({
    ref: { companyKey: c.key, company: c.name, brands: c.brandIds.length },
    agg: aggregate(c.brandIds.flatMap((id) => byBrand.get(id) ?? [])),
  }));

  const meta: { missing: string[]; revenueNeedsReview?: number } = { missing: [] };
  if (!hasPrev) meta.missing.push('lastYearData');
  const review = current.filter((r) => r.needsReview).length;
  if (review) { meta.missing.push('revenueNeedsReview'); meta.revenueNeedsReview = review; }

  const spendPct = (a: Agg) => F.spendPctOfRevenue(a.spend, a.revenue);
  const spendPctBrand = (a: Agg) => F.spendPctOfRevenue(a.spend, a.revenueBase);

  // ---- spend by category: campaigns as one bucket next to the other-spend categories
  const otherByCat = groupBy(otherLines, (l) => l.category);
  const order = input.categories ?? [];
  const catNames = [...otherByCat.keys()].sort((x, y) => {
    const ix = order.indexOf(x); const iy = order.indexOf(y);
    return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy) || x.localeCompare(y);
  });
  const categoryRows = [
    { category: CAMPAIGNS_CATEGORY, isCampaigns: true, amount: cur.campaign, lines: null as number | null },
    ...catNames.map((c) => ({ category: c, isCampaigns: false, amount: total(otherByCat.get(c)!, (l) => l.amount), lines: otherByCat.get(c)!.length as number | null })),
  ];
  const byCategory = {
    total: n(cur.spend),
    categories: categoryRows.map((c) => ({
      category: c.category, isCampaigns: c.isCampaigns, amount: n(c.amount), lines: c.lines,
      share: makeKpi('percent', F.ratioOf(c.amount, cur.spend)).value,
    })),
  };

  return {
    period: { year, fromMonth, toMonth },
    hasData: current.length > 0,
    meta,
    totals: {
      /** Total MARCOM Spend = campaign (prorated) + other. */
      spend: { total: n(cur.spend), unit: 'lyd', series: series((a) => a.spend) },
      campaignSpend: { total: n(cur.campaign), unit: 'lyd', series: series((a) => a.campaign) },
      otherSpend: { total: n(cur.other), unit: 'lyd', series: series((a) => a.other) },
      /** Finance booked total vs Campaign + Other; null when no booked total was entered in the range. */
      unallocated: {
        total: unallocated(cur), booked: cur.bookedRows ? n(cur.booked) : null, rows: cur.bookedRows, unit: 'lyd',
        series: months.map((m) => ({ month: m, value: monthAgg.has(m) ? unallocated(monthAgg.get(m)!) : null })),
      },
      revenueAttributed: { total: n(cur.revenue), unit: 'lyd', series: series((a) => a.revenue) },
      brandRevenue: { total: n(cur.revenueBase), unit: 'lyd', series: series((a) => a.revenueBase) },
      /** Company totals as entered (optional input) -- only for the overlay / brand share. */
      companyRevenue: { total: n(cur.shareCompany), unit: 'lyd', series: series((a) => a.shareCompany) },
      /** Target budget over the range (Σ budget). */
      budget: { total: n(cur.budget), unit: 'lyd', series: series((a) => a.budget) },
      /** Σ total spend ÷ Σ revenue attributed, in percentage points (monthly points summed per month first). */
      spendPctOfRevenue: { ...makeKpi('percent', spendPct(cur), { direction: 'lower_better' }), series: pctSeries(spendPct) },
      /** Σ total spend ÷ Σ brand revenue. */
      spendPctOfBrandRevenue: { ...makeKpi('percent', spendPctBrand(cur), { direction: 'lower_better' }), series: pctSeries(spendPctBrand) },
      /** Σ attributed ÷ Σ brand revenue. */
      attributedPct: makeKpi('percent', F.attributedPct(cur.attributedOnBase, cur.revenueBase), { direction: 'higher_better' }),
      /** Σ total spend ÷ Σ budget (same figure as budgetUtilization.overall). */
      budgetUsed: makeKpi('percent', F.budgetUtilization(cur.spend, cur.budget)),
    },
    byCategory,
    reconciliation: {
      overall: reconBlock(cur),
      /** One row per month and brand with any spend or P1 input: Campaign | Other | Total | Booked | Unallocated. */
      rows: current
        .map((r) => ({ month: r.month, brandId: r.brandId, brand: r.brand, ...reconBlock(aggregate([r])) }))
        .sort((a, b) => a.month - b.month || a.brand.localeCompare(b.brand)),
    },
    otherLines: otherLines
      .map((l) => ({ year: l.year, month: l.month, brandId: l.brandId, brand: l.brand, category: l.category, description: l.description, vendor: l.vendor, amount: R(l.amount).toNumber(), notes: l.notes }))
      .sort((a, b) => a.month - b.month || a.brand.localeCompare(b.brand) || a.category.localeCompare(b.category) || a.description.localeCompare(b.description)),
    roi,
    budgetUtilization: {
      overall: budgetBlock(cur),
      brands: perBrand.map(({ ref, agg }) => ({ ...ref, ...budgetBlock(agg) })),
      companies: perCompany.map(({ ref, agg }) => ({ ...ref, ...budgetBlock(agg) })),
    },
    brandGrowth: {
      overall: growthBlock(cur),
      brands: revenueBrands.map(({ ref, agg }) => ({ ...ref, ...growthBlock(agg) })),
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
