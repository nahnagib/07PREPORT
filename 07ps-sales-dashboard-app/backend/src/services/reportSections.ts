/**
 * Overview Report section builders -- one per dashboard page, each calling the EXACT SAME
 * measures/*.ts functions its own routes/*.ts /overview endpoint already calls (see that route
 * file for the reference Promise.all shape this mirrors). This guarantees the PDF's numbers can
 * never silently diverge from what the live page shows, because it is the same query.
 *
 * NOT related to the Python `reporting/` pipeline (a separate, full-history, forecasting report) --
 * see routes/reports.ts's header comment.
 */
import { Pool } from 'mysql2/promise';
import { Filters, mtdWindow, ytdWindow } from '../measures/filters';
import { TargetStatus, classifyVsTarget, variancePct as calcVariancePct } from '../measures/classify';
import {
  computeYtdCard,
  computeMtdCard,
  computeAspCard,
  fetchValueVolume,
  fetchTargetForMonths,
} from '../measures/tachometer';
import {
  computeDailyCriticalNumber,
  computeDailyCounter,
  computeMonthlyCounter,
  computeYearlyCounter,
  fetchCompanyNamesByKey,
} from '../measures/criticalNumber';
import { computeRevenueTrendKpis, fetchRevenueTrendSeries } from '../measures/revenueTrend';
import { computeInvoicesEngineKpis } from '../measures/invoicesEngine';
import { computeCustomerGrowthOverview } from '../measures/customerGrowth';
import { computePipelineHealthOverview } from '../measures/pipelineHealth';
import { computePipelineTrendOverview } from '../measures/pipelineTrend';
import { computeActivityMomentumOverview } from '../measures/activityMomentum';

export type Unit = 'currency' | 'volume' | 'count' | 'percent';

export interface ReportKpi {
  key: string;
  label: string;
  actual: number | null;
  target: number | null;
  status: TargetStatus;
  variancePct: number | null; // vs target when a target exists
  priorPeriodActual: number | null;
  priorPeriodLabel: string | null; // e.g. "vs LYTD" -- null when no prior-period figure exists
  unit: Unit;
}

export interface TrendPoint {
  label: string; // e.g. "2026-05"
  value: number;
}

export interface ReportSection {
  pageKey: string;
  label: string;
  omitted: boolean;
  omittedReason?: string;
  kpis: ReportKpi[];
  trend?: { seriesLabel: string; points: TrendPoint[] };
  note?: string; // data-completeness caveats (e.g. Activity Momentum)
}

function kpi(
  key: string,
  label: string,
  actual: number | null,
  target: number | null,
  unit: Unit,
  priorPeriodActual: number | null = null,
  priorPeriodLabel: string | null = null,
): ReportKpi {
  return {
    key,
    label,
    actual,
    target,
    status: classifyVsTarget(actual, target),
    variancePct: calcVariancePct(actual, target),
    priorPeriodActual,
    priorPeriodLabel,
    unit,
  };
}

// ---------------------------------------------------------------------------
// Tachometer -- reuses computeYtdCard/computeMtdCard/computeAspCard exactly as
// routes/tachometer.ts's /overview does.
// ---------------------------------------------------------------------------
export async function buildTachometerSection(pool: Pool, anchor: Date, filters: Filters): Promise<ReportSection> {
  const [ytdValue, ytdVolume, mtdValue, mtdVolume] = await Promise.all([
    computeYtdCard(pool, anchor, filters, 'value'),
    computeYtdCard(pool, anchor, filters, 'volume'),
    computeMtdCard(pool, anchor, filters, 'value'),
    computeMtdCard(pool, anchor, filters, 'volume'),
  ]);
  const [ytdVV, ytdTarget, mtdVV, mtdTarget] = await Promise.all([
    fetchValueVolume(pool, ytdWindow(anchor), filters),
    fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters),
    fetchValueVolume(pool, mtdWindow(anchor), filters),
    fetchTargetForMonths(pool, anchor.getUTCFullYear(), filters, { month: anchor.getUTCMonth() + 1 }),
  ]);
  const aspYtd = computeAspCard(ytdVV, ytdTarget);
  const aspMtd = computeAspCard(mtdVV, mtdTarget);

  return {
    pageKey: 'tachometer',
    label: 'Tachometer',
    omitted: false,
    kpis: [
      kpi('ytd_value', 'YTD Revenue', ytdValue.actual, ytdValue.targetToDate, 'currency', ytdValue.lastYearSamePeriod, 'vs LYTD'),
      kpi('ytd_volume', 'YTD Volume', ytdVolume.actual, ytdVolume.targetToDate, 'volume', ytdVolume.lastYearSamePeriod, 'vs LYTD'),
      kpi('mtd_value', 'MTD Revenue', mtdValue.actual, mtdValue.targetToDate, 'currency', mtdValue.lastYearSamePeriod, 'vs LMTD'),
      kpi('mtd_volume', 'MTD Volume', mtdVolume.actual, mtdVolume.targetToDate, 'volume', mtdVolume.lastYearSamePeriod, 'vs LMTD'),
      kpi('ytd_asp', 'YTD ASP', aspYtd.actualAsp, aspYtd.targetAsp, 'currency'),
      kpi('mtd_asp', 'MTD ASP', aspMtd.actualAsp, aspMtd.targetAsp, 'currency'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Critical Number -- reuses computeDailyCriticalNumber + the 3 counters exactly
// as routes/criticalNumber.ts does.
// ---------------------------------------------------------------------------
export async function buildCriticalNumberSection(pool: Pool, anchor: Date, filters: Filters): Promise<ReportSection> {
  const companyNamesByKey = await fetchCompanyNamesByKey(pool);
  const dailyCriticalNumber = await computeDailyCriticalNumber(pool, anchor, filters, companyNamesByKey);
  const [dailyCounter, monthlyCounter, yearlyCounter] = await Promise.all([
    computeDailyCounter(pool, anchor, filters, dailyCriticalNumber),
    computeMonthlyCounter(pool, anchor, filters, companyNamesByKey, dailyCriticalNumber),
    computeYearlyCounter(pool, anchor, filters, companyNamesByKey, dailyCriticalNumber),
  ]);

  const counterKpi = (key: string, label: string, c: { actualValue?: number; expectedValue?: number; actual?: number; target?: number }) => {
    const actual = c.actualValue ?? c.actual ?? null;
    const target = c.expectedValue ?? c.target ?? null;
    return kpi(key, label, actual ?? null, target ?? null, 'currency');
  };

  return {
    pageKey: 'critical_number',
    label: 'Critical Number',
    omitted: false,
    kpis: [
      counterKpi('daily_counter', 'Daily Pace', dailyCounter as any),
      counterKpi('monthly_counter', 'Monthly Pace', monthlyCounter as any),
      counterKpi('yearly_counter', 'Yearly Pace', yearlyCounter as any),
    ],
  };
}

// ---------------------------------------------------------------------------
// Revenue Trend -- computeRevenueTrendKpis already returns VarianceCard objects
// with variancePct/flag/status baked in; reused verbatim, not recomputed.
// ---------------------------------------------------------------------------
export async function buildRevenueTrendSection(pool: Pool, anchor: Date, filters: Filters): Promise<ReportSection> {
  const [series, kpis] = await Promise.all([
    fetchRevenueTrendSeries(pool, anchor, filters),
    computeRevenueTrendKpis(pool, anchor, filters),
  ]);

  const fromVarianceCard = (key: string, label: string, unit: Unit, card: { variancePct: number | null; status: string }) => ({
    key,
    label,
    actual: null,
    target: null,
    status: (card.status as TargetStatus) ?? TargetStatus.NO_TARGET,
    variancePct: card.variancePct,
    priorPeriodActual: null,
    priorPeriodLabel: null,
    unit,
  });

  return {
    pageKey: 'revenue_trend',
    label: 'Revenue Trend',
    omitted: false,
    kpis: [
      fromVarianceCard('value_variance_ytd', 'YTD Value Variance', 'currency', kpis.valueVarianceYtd),
      fromVarianceCard('value_variance_mtd', 'MTD Value Variance', 'currency', kpis.valueVarianceMtd),
      fromVarianceCard('volume_variance_ytd', 'YTD Volume Variance', 'volume', kpis.volumeVarianceYtd),
      fromVarianceCard('asp_variance_ytd', 'YTD ASP Variance', 'currency', kpis.aspVarianceYtd),
    ],
    trend: {
      seriesLabel: 'Monthly Revenue (Value)',
      points: series.map((p: any) => ({ label: p.label ?? `${p.year}-${String(p.month).padStart(2, '0')}`, value: p.value })),
    },
  };
}

// ---------------------------------------------------------------------------
// Invoices Engine -- no target concept in the warehouse for invoice averages,
// so these are NO_TARGET KPIs compared against LYTD instead.
// ---------------------------------------------------------------------------
export async function buildInvoicesEngineSection(pool: Pool, anchor: Date, filters: Filters): Promise<ReportSection> {
  const kpis = await computeInvoicesEngineKpis(pool, anchor, filters, {});
  return {
    pageKey: 'invoices_engine',
    label: 'Invoices Engine',
    omitted: false,
    kpis: [
      kpi('invoice_count_ytd', 'YTD Invoice Count', kpis.ytd.invoiceCount, null, 'count', kpis.lytd.invoiceCount, 'vs LYTD'),
      kpi('avg_sales_per_invoice_ytd', 'Avg Sales per Invoice (YTD)', kpis.ytd.avgSalesPerInvoice, null, 'currency', kpis.lytd.avgSalesPerInvoice, 'vs LYTD'),
      kpi('avg_lines_per_invoice_ytd', 'Avg Lines per Invoice (YTD)', kpis.ytd.avgLinesPerInvoice, null, 'count', kpis.lytd.avgLinesPerInvoice, 'vs LYTD'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Customer Growth -- no target concept for customer counts; compared vs LYTD.
// ---------------------------------------------------------------------------
export async function buildCustomerGrowthSection(pool: Pool, anchor: Date, filters: Filters): Promise<ReportSection> {
  const overview = await computeCustomerGrowthOverview(pool, anchor, filters, {});
  const k = overview.kpis;
  const rates = overview.rates;
  return {
    pageKey: 'customer_growth',
    label: 'Customer Growth',
    omitted: false,
    kpis: [
      kpi('total_customers_ytd', 'Active Customers (YTD)', k.totalCustomers.ytd, null, 'count', k.totalCustomers.lytd, 'vs LYTD'),
      kpi('new_customers_ytd', 'New Customers (YTD)', k.newCustomers.ytd, null, 'count', k.newCustomers.lytd, 'vs LYTD'),
      kpi('retention_rate', 'Retention Rate', rates.retentionRatePct, null, 'percent'),
      kpi('churn_rate', 'Churn Rate', rates.churnRatePct, null, 'percent'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Pipeline Health -- funnel is YTD point-in-time (no prior-period field on the
// type); Stage Benchmark already carries real fixed targets + status.
// ---------------------------------------------------------------------------
export async function buildPipelineHealthSection(pool: Pool, anchor: Date, filters: Filters): Promise<ReportSection> {
  const overview = await computePipelineHealthOverview(pool, anchor, filters);
  const funnel = overview.funnel;
  const benchmarks: ReportKpi[] = (overview.stageBenchmark ?? []).map((b: any, i: number) => ({
    key: `stage_benchmark_${i}`,
    label: b.transition,
    actual: b.actualPct,
    target: b.targetPct,
    status: (b.status as TargetStatus) ?? TargetStatus.NO_TARGET,
    variancePct: b.variancePct,
    priorPeriodActual: null,
    priorPeriodLabel: null,
    unit: 'percent',
  }));

  return {
    pageKey: 'pipeline_health',
    label: 'Pipeline Health',
    omitted: false,
    kpis: [
      kpi('leads_ytd', 'YTD Leads', funnel.leads, null, 'count'),
      kpi('opportunities_ytd', 'YTD Opportunities', funnel.opportunities, null, 'count'),
      kpi('quotations_ytd', 'YTD Quotations', funnel.quotations, null, 'count'),
      kpi('sales_orders_ytd', 'YTD Sales Orders', funnel.salesOrders, null, 'count'),
      ...benchmarks,
    ],
  };
}

// ---------------------------------------------------------------------------
// Pipeline Trend -- win rate + monthly quotation series for the chart.
// ---------------------------------------------------------------------------
export async function buildPipelineTrendSection(pool: Pool, anchor: Date, filters: Filters): Promise<ReportSection> {
  const overview = await computePipelineTrendOverview(pool, anchor, filters);
  const qr = overview.quotationRates;
  return {
    pageKey: 'pipeline_trend',
    label: 'Pipeline Trend',
    omitted: false,
    kpis: [
      kpi('win_rate_ytd', 'YTD Win Rate', qr.winRatePct, null, 'percent'),
      kpi('open_quotations', 'Open Quotations', qr.openQuotations, null, 'count'),
      kpi('lost_quotations', 'Lost Quotations', qr.lostQuotations, null, 'count'),
    ],
    trend: {
      seriesLabel: 'Monthly Quotations (YTD)',
      points: (overview.quotationsByMonth ?? []).map((p: any) => ({ label: p.label, value: p.countYtd })),
    },
  };
}

// ---------------------------------------------------------------------------
// Activity Momentum -- honors activityColumnsAvailable exactly like the
// dashboard page does (never fabricates a 0 when the ETL backfill is pending).
// ---------------------------------------------------------------------------
export async function buildActivityMomentumSection(pool: Pool, anchor: Date, filters: Filters): Promise<ReportSection> {
  const overview = await computeActivityMomentumOverview(pool, anchor, filters);
  const counts = overview.counts;
  const rates = overview.rates;
  const kpis: ReportKpi[] = [
    kpi('total_ytd', 'YTD Total Opportunities', counts.totalYtd, null, 'count'),
    kpi('won_ytd', 'YTD Won', counts.won, null, 'count'),
    kpi('lost_ratio', 'Lost Deals Ratio', rates.lostDealsRatio, null, 'percent'),
  ];
  if (overview.activityColumnsAvailable) {
    kpis.push(kpi('inactive_ratio', 'Inactive Deals Ratio', rates.inactiveDealsRatio, null, 'percent'));
  }
  return {
    pageKey: 'activity_momentum',
    label: 'Activity Momentum',
    omitted: false,
    kpis,
    note: overview.activityColumnsAvailable
      ? undefined
      : 'Engagement figures (inactive deals, next-step tracking) are not yet available -- the ETL backfill for these fields is pending.',
  };
}

// Parameter names in a type alias's function signature aren't unused bindings; base eslint's
// no-unused-vars doesn't know that (no @typescript-eslint no-unused-vars in this project's
// .eslintrc.json).
// eslint-disable-next-line no-unused-vars
export type SectionBuilder = (pool: Pool, anchor: Date, filters: Filters) => Promise<ReportSection>;

export const SECTION_BUILDERS: Record<string, SectionBuilder> = {
  tachometer: buildTachometerSection,
  critical_number: buildCriticalNumberSection,
  revenue_trend: buildRevenueTrendSection,
  invoices_engine: buildInvoicesEngineSection,
  customer_growth: buildCustomerGrowthSection,
  pipeline_health: buildPipelineHealthSection,
  pipeline_trend: buildPipelineTrendSection,
  activity_momentum: buildActivityMomentumSection,
};

export const SECTION_ORDER = [
  'tachometer',
  'critical_number',
  'revenue_trend',
  'invoices_engine',
  'customer_growth',
  'pipeline_health',
  'pipeline_trend',
  'activity_momentum',
];
