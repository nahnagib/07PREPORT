'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { CreditPolicyChart } from '../../../../components/debt/CreditPolicyChart';
import { DebtDrilldownModal, type DebtDrillTarget } from '../../../../components/debt/DebtDrilldownModal';
import { CollectionsDrilldownModal, CollectionsTrendPanel } from '../../../../components/debt/CollectionsTrend';
import { useAuth } from '../../../../lib/AuthProvider';
import { useDebtReport } from '../../../../lib/hooks';
import type { CollectionGrain, CollectionPoint, CollectionsDrilldown, CollectionsTrend, DebtAging, DebtCurrencyOverview, DebtCustomerRow, DebtCustomers, DebtDrilldown, DebtDrillKind, DebtMeta, DebtOverview, DebtTrend } from '../../../../lib/api';
import { formatCompactMoney, formatDate, formatMoney, formatNumber, formatTimestamp } from '../../../../lib/format';
import {
  DEFAULT_DEBT_FILTERS,
  OVERDUE_STATUS_OPTIONS,
  SIZE_TIER_HINT,
  agingColors,
  dailyTrendPoints,
  fromIncludeValues,
  includeValues,
  isDefaultFilters,
  optLabel,
  pctLabel,
  tierLabel,
  toScope,
  toggleCurrency,
  type DebtPageFilters,
  type LabelLang,
} from '../../../../lib/debt/view';
import { useUrlCurrency } from '../../../../lib/debt/useUrlCurrency';
import { creditBucket, creditBucketOptions, creditColor, creditSoft, type CreditBucket } from '../../../../lib/debt/creditPolicy';
import { CUSTOMER_CATEGORY_DEFINITION } from '../../../../lib/customerCategory';
import {
  Button,
  ChartPanel,
  ComboChart,
  DataGrid,
  EmptyState,
  ErrorState,
  GroupedBarChart,
  KpiTile,
  LoadingSkeleton,
  Select,
  type DataGridColumn,
  type GroupedBarChartPoint,
  type SelectOption,
} from '@07ps/ui';

/**
 * Receivables and Collections (Price / Finance department; was "Debt Report" at /price/debt-report, which redirects
 * here): open customer receivables from the snapshot the finance ETL takes at 02:00 and 15:00
 * (fact_finance_receivable_snapshot). Internal names (permission debt_report, GET /debt-report/*, tables) are unchanged. Default view: the latest snapshot, customer debt only (customer invoices,
 * credit notes, receipts, inbound customer payments), inter-company excluded -- the v_finance_* views. The two toggles
 * add the other receivable entries and the inter-company balances.
 *
 * The whole page leaves out the excluded segments and sales teams (warehouse table cfg_finance_report_exclusion,
 * applied by the API to every number; listed in the strip from GET /debt-report/meta). The KPI cards show one group
 * per currency, the customer table one row per company + customer + currency. Clicking a chart bar or a table row
 * opens the lines behind it (GET /debt-report/drilldown), which add up to the figure clicked.
 *
 * Currency filter (2026-10-15; replaces the "Charts currency" toggle): one page-wide filter, kept in the URL
 * (?currency=USD, lib/debt/useUrlCurrency.ts) so a view can be shared and survives a refresh. Default (no currency):
 * "All currencies (≈ LYD)" -- the Aging Map, every chart, both trends, the drill-downs and the customer table add up
 * every currency in LYD, exactly as the header's grand total does: Odoo's own Amount Due in LYD, at the rate Odoo
 * booked on each invoice's date (never a rate of ours), always marked "≈". Clicking a currency row of cards (a button,
 * aria-pressed) shows that currency alone, in its own units; clicking it again goes back to all currencies. The header
 * band (DebtTotalBand) always shows every currency, whatever the filter.
 *
 * Definitions (decisions of 2026-10-06, so the page matches Odoo's Invoices list): "Total debt" = the open amount
 * of customer invoices only (Odoo's Amount Due), counted like Odoo; Overdue + Not yet due split it (each 0-100%); the
 * customer count is customers with an open invoice. Credit notes, unreconciled payments and the two toggles' lines
 * never reach the cards, the charts or the Aging Map: they only show in the customer table (Unapplied credits, Net
 * balance) and its drill-down. Credit Policy Escalation (components/debt/CreditPolicyChart.tsx, GET /debt-report/aging; replaced the
 * term-multiple Aging Map 2026-10-15) places every customer by the days overdue (from the day after the due date) of its unpaid invoice with the earliest due date,
 * in the credit policy's zones (backend config/creditPolicy.ts), in the page's currency (all currencies: every customer once). It
 * ignores the line-level filters (overdue status, aging bucket, delivery status, payment term, invoice size), which would change
 * which invoice decides, and has its own payment-term filter (it only chooses customers). A dot opens the customer's open
 * invoices; the Customers table's Aging bucket is the same zone.
 *
 * Filters (2026-10-07): every filter is a dropdown (the shared Select), worded as on the other pages -- Company
 * (multi-select), Customer group, Distribution Channel, Branch = the sales team, Salesperson, Customer (searchable,
 * name or Odoo id). These dimensions cross-filter one another using the same cascade as Promotion. Customer Category
 * is the Customer Growth category (lib/customerCategory.ts). "Reset filters" restores DEFAULT_DEBT_FILTERS.
 *
 * Every label comes from GET /debt-report/meta: Odoo's own labels (English; the "Odoo labels" EN/AR
 * switch was removed 2026-10-13), our scope and aging-bucket names, and the size-tier thresholds from the backend
 * config. The freshness strip shows the FINANCE refresh, never the sales one; its other items (snapshot, scope, exclusions,
 * currency note, a failed run) are for the Admin role only (2026-10-19). Access and the salesperson scope are
 * enforced by the API (routes/debtReport.ts); this page only mirrors them.
 *
 * Cards (2026-10-07): one row per currency, exactly five cards each -- Total debt (Odoo's Amount Due of the open
 * customer invoices), Customers (with an open invoice), Invoices (open), Overdue and Not yet due (amount + % of Total
 * debt; the two add up to Total debt). Under every amount, the LYD figure: Odoo's own company-currency amount
 * (amount_residual), never a rate of ours -- for USD / EUR it reads "≈ LYD ...". Odoo converts at the rate it booked
 * on the invoice (its invoice date), so one currency can mix several rates.
 *
 * Grand total (2026-10-11): "All currencies" is a summary band above the rows (DebtTotalBand), not a row of its own, so
 * it never reads as a fourth currency: the sum of the rows' LYD amounts (≈ when a converted amount is in it), a
 * customer owing in several currencies counted once, and a currency-mix bar whose colours match the rows' currency
 * badges (tokens.css --ps-ccy-*).
 */
/** The card note (2026-10-08): the cards count posted customer invoices with an amount due -- Odoo's Invoices list with
 * the Unpaid AND Posted filters. Draft invoices (Unpaid alone lists them) are not receivables and are never counted. */
const OPEN_INVOICES_NOTE = 'Total debt = posted invoices with an amount due (Odoo: Unpaid + Posted); draft invoices are not counted';

export default function ReceivablesCollectionsPage() {
  const { user, token, error: authError, retryAuth, logout, isSalesperson, isAdmin, canView } = useAuth();
  const allowed = canView('debt_report');
  const roleLabel = user?.role.label ?? user?.fullName;
  const [filters, setFilters] = useState<DebtPageFilters>(DEFAULT_DEBT_FILTERS);
  // Odoo labels in English (the "Odoo labels" EN/AR switch was removed from the filters 2026-10-13).
  const lang: LabelLang = 'en';
  // the page-wide currency filter (?currency=USD); null = every currency in LYD
  const { currency, setCurrency, ready: currencyReady } = useUrlCurrency();
  const [drill, setDrill] = useState<DebtDrillTarget | null>(null);
  const [showAllPeople, setShowAllPeople] = useState(false);
  const [agingTerm, setAgingTerm] = useState<string | null>(null);
  const [collectionGrain, setCollectionGrain] = useState<CollectionGrain>('week');
  const [collectionPoint, setCollectionPoint] = useState<CollectionPoint | null>(null);

  const scope = useMemo(() => toScope(filters, isSalesperson), [filters, isSalesperson]);
  // Cross-filter the finance snapshot with the same dimension cascade as Promotion.
  const metaScope = useMemo(
    () => ({ snapshotDate: scope.snapshotDate, includeOther: scope.includeOther, includeIntercompany: scope.includeIntercompany,
      companyKeys: scope.companyKeys, segmentKeys: scope.segmentKeys, channelKeys: scope.channelKeys,
      salesTeamKeys: scope.salesTeamKeys, salespersonKeys: scope.salespersonKeys, customerKeys: scope.customerKeys }),
    [scope.snapshotDate, scope.includeOther, scope.includeIntercompany, scope.companyKeys, scope.segmentKeys, scope.channelKeys, scope.salesTeamKeys, scope.salespersonKeys, scope.customerKeys],
  );
  const meta = useDebtReport<DebtMeta>(token, authError, retryAuth, 'meta', metaScope, undefined, allowed);
  // Only adopt a response for the current selection; retained options from an earlier request must never prune it.
  useEffect(() => {
    if (meta.loading || !meta.data || meta.scopeKey !== JSON.stringify(metaScope) || isSalesperson) return;
    const selected = meta.data.filters;
    setFilters((previous) => {
      const next = { ...previous, companyKeys: selected.companyKeys.map(Number), segmentKeys: selected.segmentKeys.map(Number),
        channelKeys: selected.channelKeys.map(Number), salesTeamKeys: selected.salesTeamKeys,
        salespersonKeys: selected.salespersonKeys.map(Number), customerKeys: selected.customerKeys.map(Number),
        paymentTermKeys: previous.paymentTermKeys.filter((k) => meta.data!.options.paymentTerms.some((t) => t.value === String(k))) };
      return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
    });
  }, [meta.loading, meta.data, meta.scopeKey, metaScope, isSalesperson]);
  const overview = useDebtReport<DebtOverview>(token, authError, retryAuth, 'overview', scope, undefined, allowed);
  const trend = useDebtReport<DebtTrend>(token, authError, retryAuth, 'trend', scope, undefined, allowed);
  const customers = useDebtReport<DebtCustomers>(token, authError, retryAuth, 'customers', scope, undefined, allowed);
  const drillExtra = useMemo<Record<string, string | number>>(
    () => {
      const extra: Record<string, string | number> = {};
      if (drill) Object.assign(extra, { kind: drill.kind, key: drill.key }, drill.currency ? { currency: drill.currency } : {});
      return extra;
    },
    [drill],
  );
  const drilldown = useDebtReport<DebtDrilldown>(token, authError, retryAuth, 'drilldown', scope, drillExtra, allowed && drill !== null);

  // a drill-down belongs to the filters it was opened with
  useEffect(() => setDrill(null), [scope]);
  const closeDrill = useCallback(() => setDrill(null), []);

  const o = meta.data?.options;
  const set = <K extends keyof DebtPageFilters>(key: K, value: DebtPageFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const opts = (list: { value: string; labelEn: string; labelAr: string | null }[] | undefined): SelectOption[] =>
    (list ?? []).map((x) => ({ value: x.value, label: optLabel(x, lang) }));
  const lockedReason = isSalesperson ? 'Locked to your own customers' : undefined;
  const scopeLabel = (key: string) => {
    const s = o?.scopes.find((x) => x.value === key);
    return s ? optLabel(s, lang) : key;
  };
  const defaultScope = o?.scopes.find((s) => s.isDefault);
  const otherScope = o?.scopes.find((s) => !s.isDefault);
  const exclusions = meta.data?.exclusions;

  const snapshotDate = overview.data?.snapshotDate ?? meta.data?.snapshotDate ?? null;
  const currencies = overview.data?.currencies ?? [];
  // what the charts show: the picked currency in its own units, else every currency in LYD (≈, Odoo's own amounts)
  const cur: DebtCurrencyOverview | undefined = currency ? currencies.find((c) => c.currency === currency) : overview.data?.all;
  const ccy = currency ?? LYD;
  const approx = currency ? '' : '≈ ';
  const viewLabel = currency ?? 'All currencies (≈ LYD)';
  const colors = useMemo(() => agingColors(cur?.aging ?? []), [cur?.aging]);
  // axis ticks and bar labels stay short ("LYD 4.0M"; the titles say ≈ LYD); tooltips and tables carry the ≈
  const compact = (v: number) => formatCompactMoney(ccy, v);
  const full = (v: number) => `${approx}${formatMoney(ccy, v)}`;
  const currencyParam = useMemo<Record<string, string>>(() => (currency ? { currency } : { allCurrencies: 'true' }) as Record<string, string>, [currency]);

  // Aging Map: the page's currency (or all); the line-level filters are left out (the server ignores them), so changing one does
  // not reload the map
  const agingScope = useMemo(
    () => ({ ...scope, overdueStatus: 'all' as const, agingBucketKeys: [], deliveryStatuses: [], paymentTermKeys: [], invoiceTiers: [] }),
    [scope],
  );
  const agingExtra = useMemo<Record<string, string | number>>(() => {
    const extra: Record<string, string | number> = { ...currencyParam };
    if (agingTerm) extra.term = agingTerm;
    return extra;
  }, [currencyParam, agingTerm]);
  const aging = useDebtReport<DebtAging>(token, authError, retryAuth, 'aging', agingScope, agingExtra, allowed && currencyReady);
  // Collections trend: payments carry their own date, so no snapshot date here -- full history, same filters
  const collectionScope = useMemo(() => ({ ...scope, snapshotDate: null }), [scope]);
  const collectionExtra = useMemo<Record<string, string | number>>(() => ({ grain: collectionGrain, ...currencyParam }), [currencyParam, collectionGrain]);
  const collections = useDebtReport<CollectionsTrend>(token, authError, retryAuth, 'collections-trend', collectionScope, collectionExtra, allowed && currencyReady);
  const collectionDrillExtra = useMemo<Record<string, string | number>>(
    () => (collectionPoint ? { ...currencyParam, grain: collectionGrain, period: collectionPoint.periodStart } : {}),
    [collectionPoint, currencyParam, collectionGrain],
  );
  const collectionDrill = useDebtReport<CollectionsDrilldown>(token, authError, retryAuth, 'collections-drilldown', collectionScope, collectionDrillExtra, allowed && collectionPoint !== null);
  useEffect(() => setCollectionPoint(null), [collectionScope, currency, collectionGrain]);
  const closeCollectionDrill = useCallback(() => setCollectionPoint(null), []);

  // a drill-down lists the lines of the page's currency, or of every currency (reconciled in LYD)
  const openDrill = (kind: DebtDrillKind, key: string, label: string, expected: number) => setDrill({ kind, key, label, currency, expected });
  // a new currency closes an open drill-down (it belonged to the previous view)
  useEffect(() => setDrill(null), [currency]);

  // bar labels are what a click returns: made unique (two customers with the same name), mapped back to the point
  const groupPoints = (list: DebtCurrencyOverview['topCustomers'] | undefined, limit?: number): GroupedBarChartPoint[] => {
    const seen = new Map<string, number>();
    return (list ?? []).slice(0, limit).map((g) => {
      const n = (seen.get(g.label) ?? 0) + 1;
      seen.set(g.label, n);
      return { label: n > 1 ? `${g.label} (${n})` : g.label, overdue: g.overdue, _key: g.key, _name: g.label, _pct: g.pctOfOverdue, _open: g.open, _detail: g.detail ?? null };
    });
  };
  const onGroupClick = (kind: DebtDrillKind, points: GroupedBarChartPoint[]) => (label: string) => {
    const p = points.find((x) => x.label === label);
    if (p) openDrill(kind, String(p._key), String(p._name), Number(p.overdue));
  };
  const groupTooltip = (p: GroupedBarChartPoint) => (
    <TooltipBox title={String(p._name ?? p.label)}>
      {p._detail ? <TooltipRow label="Company" value={String(p._detail)} /> : null}
      <TooltipRow label="Overdue" value={full(Number(p.overdue))} />
      <TooltipRow label="% of total overdue" value={pctLabel(p._pct as number | null)} />
      <TooltipRow label="Open (net)" value={full(Number(p._open))} />
      <TooltipRow label="" value="Click for the invoices" />
    </TooltipBox>
  );
  const barHeight = (n: number) => Math.max(220, n * 30 + 50);
  const peopleLimit = showAllPeople ? undefined : 15;

  const agingPoints: GroupedBarChartPoint[] = (cur?.aging ?? []).map((a) => ({
    label: a.label,
    amount: a.amount,
    _key: a.agingBucketKey,
    _n: a.lineCount,
  }));
  const trendPoints = dailyTrendPoints(currency ? (trend.data?.points ?? []).filter((p) => p.currency === currency) : (trend.data?.all ?? []));

  // ---- customer table ------------------------------------------------------------------------------------------------
  // the page's currency filter decides the rows (the table has no currency filter of its own any more)
  // the Aging bucket = the customer's credit-policy zone, exactly as the escalation chart places it (same API code)
  const creditZones = useMemo(() => meta.data?.creditPolicy?.zones ?? [], [meta.data]);
  const customerRows: CustomerGridRow[] = useMemo(
    () =>
      (customers.data?.rows ?? [])
        .filter((r) => !currency || r.currency === currency)
        // all currencies: one ranking by overdue in LYD (the server sorts within each currency)
        .sort((a, b) => (currency ? 0 : b.lyd.overdue - a.lyd.overdue || b.lyd.open - a.lyd.open || a.lyd.net - b.lyd.net))
        .map((r) => {
          const bucket = creditBucket(currency ? r.creditZone?.currency ?? null : r.creditZone?.all ?? null, creditZones);
          return {
            ...r,
            id: `${r.companyKey}:${r.customerKey}:${r.currency}`,
            salespersonList: r.salespersons.join(', '),
            teamList: r.salesTeams.join(', '),
            segmentList: r.segments.join(', '),
            agingBucket: bucket.filterValue,
            bucket,
          };
        }),
    [customers.data, currency, creditZones],
  );
  const distinctOptions = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
  // one currency: each row in its own units; all currencies: every row in LYD (≈ unless the row already is in LYD)
  const rowMoney = (key: 'invoiceAmount' | 'open' | 'overdue' | 'credits' | 'net', header: string): DataGridColumn<CustomerGridRow> =>
    currency
      ? { key, header, align: 'right', width: 160, rawValue: (r) => r[key], render: (r) => formatMoney(r.currency, r[key]) }
      : {
          key, header: `${header} (≈ LYD)`, align: 'right', width: 170, rawValue: (r) => r.lyd[key],
          render: (r) => `${r.currency === LYD ? '' : '≈ '}${formatMoney(LYD, r.lyd[key])}`,
        };
  const customerColumns: DataGridColumn<CustomerGridRow>[] = [
    { key: 'company', header: 'Company', width: 90, filterOptions: distinctOptions(customerRows.map((r) => r.company)) },
    { key: 'customer', header: 'Customer', width: 230, render: (r) => <span dir="auto">{r.customer}</span> },
    { key: 'customerCategory', header: 'Customer Category', width: 130, filterOptions: distinctOptions(customerRows.map((r) => r.customerCategory)) },
    { key: 'currency', header: 'Currency', width: 90 },
    { key: 'openDocuments', header: 'Open invoices', align: 'right', width: 110, render: (r) => formatNumber(r.openDocuments) },
    rowMoney('invoiceAmount', 'Invoices amount'),
    rowMoney('open', 'Open invoices amount'),
    rowMoney('overdue', 'Overdue'),
    {
      key: 'agingBucket',
      header: 'Aging bucket',
      width: 170,
      // by actual age: credits only (—) < not yet due < days overdue of the earliest unpaid due date
      sortValue: (r) => r.bucket.sortValue,
      filterOptions: creditBucketOptions(creditZones),
      render: (r) => <BucketBadge bucket={r.bucket} />,
    },
    rowMoney('credits', 'Unapplied credits'),
    rowMoney('net', 'Net balance'),
    listColumn('salespersonList', 'Salesperson', 180, distinctOptions(customerRows.flatMap((r) => r.salespersons)), (r) => r.salespersons),
    listColumn('teamList', 'Branch', 180, distinctOptions(customerRows.flatMap((r) => r.salesTeams)), (r) => r.salesTeams),
    listColumn('segmentList', 'Segment', 110, distinctOptions(customerRows.flatMap((r) => r.segments)), (r) => r.segments),
  ];

  const freshness = meta.data?.freshness;
  const nothing = overview.data && overview.data.lineCount === 0;
  const firstSnapshot = meta.data?.snapshots[0]?.date ?? null;
  const trendNote =
    `Snapshot history started on ${formatDate(firstSnapshot ?? snapshotDate)} and grows by one snapshot a day (taken at 02:00 and refreshed at 15:00).` +
    (trend.data && trend.data.snapshotCount < 2 ? ' The trend needs at least 2 snapshots.' : '');
  const exclusionText = exclusions
    ? [
        exclusions.segments.length ? `segments ${exclusions.segments.join(', ')}` : null,
        exclusions.salesTeams.length ? `teams ${exclusions.salesTeams.join(', ')}` : null,
        exclusions.invoiceTeams?.length ? 'invoices without an Odoo sales team' : null,
      ]
        .filter(Boolean)
        .join('; ')
    : null;
  const exclusionTitle = exclusions?.teams.map((t) => `${t.salesTeamKey} ${t.salesTeam} (${t.segment ?? '—'})`).join('\n');

  return (
    <PermissionGuard pageKey="debt_report">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader pageTitle="Receivables and Collections" anchorDate="" onAnchorDateChange={() => {}} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />

        <FilterBar
          onReset={() => setFilters(DEFAULT_DEBT_FILTERS)}
          isPristine={isDefaultFilters(filters)}
          showDateRange={false}
          showCompanyDimension={false}
          showTransactionDimensions={false}
          showLastOrderInfo={false}
          extraFields={
            <>
              <Field width={170}>
                <Select
                  label="Date"
                  options={[...(meta.data?.snapshots ?? [])].reverse().map((s) => ({ value: s.date, label: formatDate(s.date) }))}
                  value={[filters.snapshotDate ?? meta.data?.snapshotDate ?? ''].filter(Boolean)}
                  onChange={(v) => set('snapshotDate', v[0] && v[0] !== meta.data?.snapshots[meta.data.snapshots.length - 1]?.date ? v[0] : null)}
                  loading={meta.loading}
                />
              </Field>
              <Field width={150}>
                {/* the shared Select brings its own "All" row (= no company filter): no 'all' option here */}
                <Select
                  label="Company"
                  options={(o?.companies ?? []).map((c) => ({ value: c.value, label: c.labelEn }))}
                  value={filters.companyKeys.map(String)}
                  onChange={(v) => set('companyKeys', v.map(Number))}
                  multiSelect
                  loading={meta.loading}
                  disabled={isSalesperson}
                  lockedReason={lockedReason}
                  placeholder="All"
                />
              </Field>
              <Field>
                <Select label="Customer group" options={opts(o?.customerGroups)} value={filters.segmentKeys.map(String)} onChange={(v) => set('segmentKeys', v.map(Number))} multiSelect searchable loading={meta.loading} disabled={isSalesperson} lockedReason={lockedReason} placeholder="All" />
              </Field>
              <Field>
                <Select label="Distribution Channel" options={opts(o?.distributionChannels)} value={filters.channelKeys.map(String)} onChange={(v) => set('channelKeys', v.map(Number))} multiSelect searchable loading={meta.loading} disabled={isSalesperson} lockedReason={lockedReason} placeholder="All" />
              </Field>
              <Field>
                <Select label="Branch" options={opts(o?.salesTeams)} value={filters.salesTeamKeys} onChange={(v) => set('salesTeamKeys', v)} multiSelect searchable loading={meta.loading} disabled={isSalesperson} lockedReason={lockedReason} placeholder="All" />
              </Field>
              <Field>
                <Select label="Salesperson" options={opts(o?.salespersons)} value={filters.salespersonKeys.map(String)} onChange={(v) => set('salespersonKeys', v.map(Number))} multiSelect searchable loading={meta.loading} disabled={isSalesperson} lockedReason={lockedReason} placeholder="All" />
              </Field>
              <Field width={220} title="Search by name or Odoo id">
                <Select label="Customer" options={opts(o?.customers)} value={filters.customerKeys.map(String)} onChange={(v) => set('customerKeys', v.map(Number))} multiSelect searchable loading={meta.loading} placeholder="All" />
              </Field>
              <Field width={150}>
                <Select
                  label="Overdue status"
                  options={OVERDUE_STATUS_OPTIONS}
                  value={filters.overdueStatus === 'all' ? [] : [filters.overdueStatus]}
                  onChange={(v) => set('overdueStatus', (v[0] ?? 'all') as DebtPageFilters['overdueStatus'])}
                />
              </Field>
              <Field>
                <Select label="Aging bucket" options={opts(o?.agingBuckets)} value={filters.agingBucketKeys.map(String)} onChange={(v) => set('agingBucketKeys', v.map(Number))} multiSelect placeholder="All" />
              </Field>
              <Field>
                <Select label="Delivery status" options={opts(o?.deliveryStatuses)} value={filters.deliveryStatuses} onChange={(v) => set('deliveryStatuses', v)} multiSelect placeholder="All" />
              </Field>
              <Field>
                <Select label="Payment term" options={opts(o?.paymentTerms)} value={filters.paymentTermKeys.map(String)} onChange={(v) => set('paymentTermKeys', v.map(Number))} multiSelect searchable placeholder="All" />
              </Field>
              <Field width={190} title={SIZE_TIER_HINT}>
                <Select
                  label="Invoice size ⓘ"
                  options={(o?.sizeTiers ?? []).map((t) => ({ value: t.value, label: tierLabel(t, lang) }))}
                  value={filters.invoiceTiers}
                  onChange={(v) => set('invoiceTiers', v as DebtPageFilters['invoiceTiers'])}
                  multiSelect
                  placeholder="All"
                />
              </Field>
              <Field width={190} title={`${CUSTOMER_CATEGORY_DEFINITION} The same category as on Customer Growth.`}>
                <Select
                  label="Customer Category ⓘ"
                  options={(o?.customerCategories ?? []).map((c) => ({ value: c.value, label: c.labelEn }))}
                  value={filters.customerCategories}
                  onChange={(v) => set('customerCategories', v)}
                  multiSelect
                  placeholder="All"
                />
              </Field>
              <Field width={220}>
                <Select
                  label="Include"
                  options={[
                    { value: 'other', label: otherScope ? optLabel(otherScope, 'en') : 'Other receivable entries' },
                    { value: 'intercompany', label: 'Inter-company' },
                  ]}
                  value={includeValues(filters)}
                  onChange={(v) => setFilters((f) => ({ ...f, ...fromIncludeValues(v) }))}
                  multiSelect
                  placeholder="None"
                />
              </Field>
            </>
          }
        />

        {meta.error ? <ErrorState message={meta.error} onRetry={meta.retry} /> : null}

        {/* The data context is for the Admin role only (2026-10-19): everyone else sees the finance refresh alone. The API
            leaves out the exclusions and the failed-run fields for them too (routes/debtReport.ts stripAdminOnlyMeta). */}
        <div style={strip} role="status">
          {isAdmin ? (
            <span>
              Receivables snapshot <strong style={{ color: 'var(--ps-color-text)' }}>{formatDate(snapshotDate)}</strong>
            </span>
          ) : null}
          <span>
            Finance refresh <strong style={{ color: 'var(--ps-color-text)' }}>{formatTimestamp(freshness?.lastSuccessUtc ?? null)}</strong>
          </span>
          {isAdmin ? (
            <>
              {freshness?.lastFailureUtc ? (
                <span style={{ color: 'var(--ps-color-alert)' }}>Last finance run failed at {formatTimestamp(freshness.lastFailureUtc)}</span>
              ) : null}
              <span>
                Showing{' '}
                <strong style={{ color: 'var(--ps-color-text)' }}>
                  {[defaultScope ? scopeLabel(defaultScope.value) : null, filters.includeOther && otherScope ? scopeLabel(otherScope.value) : null].filter(Boolean).join(' + ')}
                </strong>
                {filters.includeIntercompany ? ', inter-company included' : ', inter-company excluded'}
              </span>
              {exclusionText ? (
                <span title={exclusionTitle} dir="auto">
                  Always excluded: <strong style={{ color: 'var(--ps-color-text)' }}>{exclusionText}</strong>
                </span>
              ) : null}
              <span>Amounts per currency; LYD equivalents (≈) are Odoo&apos;s own amounts, at the Odoo rate of each invoice&apos;s date</span>
            </>
          ) : null}
        </div>

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px) clamp(16px, 3vw, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)', minWidth: 0 }}>
          {overview.loading && !overview.data ? (
            <LoadingSkeleton variant="chart" />
          ) : overview.error ? (
            <ErrorState message={overview.error} onRetry={overview.retry} />
          ) : nothing ? (
            <EmptyState message="No open receivable matches these filters." onResetFilters={() => setFilters(DEFAULT_DEBT_FILTERS)} />
          ) : (
            <>
              {overview.data ? <DebtTotalBand all={overview.data.allCurrencies} currencies={currencies} snapshotDate={overview.data.snapshotDate} /> : null}
              <h2 style={{ ...h2, margin: '4px 0 -8px', fontSize: 15, color: 'var(--ps-color-muted-text)' }}>
                By currency <span style={{ fontWeight: 400, fontSize: 12.5 }}>· click a currency to show it alone on the whole page</span>
              </h2>
              <style>{CURRENCY_ROW_CSS}</style>
              {currencies.map((c) => (
                <DebtCards
                  key={c.currency}
                  currency={c.currency}
                  totals={c.kpis}
                  lyd={{ open: c.kpis.openAmountCompany, overdue: c.kpis.overdueAmountCompany, notDue: c.kpis.notDueAmountCompany }}
                  shareOfTotal={overview.data?.allCurrencies.openAmount ? c.kpis.openAmountCompany / overview.data.allCurrencies.openAmount : null}
                  selected={currency === c.currency}
                  dimmed={currency !== null && currency !== c.currency}
                  onToggle={() => setCurrency(toggleCurrency(currency, c.currency))}
                />
              ))}
              <p style={{ ...note, margin: 0 }}>{OPEN_INVOICES_NOTE}.</p>

              <div role="status" aria-live="polite" style={viewBar}>
                <span>
                  Showing: <strong style={{ color: 'var(--ps-color-text)' }}>{currency ? `${currency} only` : 'All currencies (≈ LYD)'}</strong>
                </span>
                {currency ? (
                  <button type="button" onClick={() => setCurrency(null)} style={linkButton}>
                    Clear
                  </button>
                ) : null}
                <span>
                  {currency
                    ? currencies.some((c) => c.currency === currency)
                      ? `Amounts in ${currency}.`
                      : `No open ${currency} invoice for these filters.`
                    : "Amounts are LYD equivalents: Odoo's Amount Due at the rate booked on each invoice's date."}{' '}
                  Click a bar to see the invoices behind it.
                </span>
              </div>

              <CreditPolicyChart
                data={aging.data}
                loading={aging.loading}
                error={aging.error}
                onRetry={aging.retry}
                term={agingTerm}
                onTermChange={setAgingTerm}
                viewLabel={viewLabel}
                onCustomerClick={(c) => openDrill('customer_open', String(c.customerKey), c.customer, c.totalOutstanding)}
              />

              <div style={grid2}>
              <ChartPanel title={`Receivables trend · ${viewLabel}`} infoText="Open invoices per snapshot date (line), split into overdue and not yet due (stacked bars), with the same filters">
                {trend.error ? (
                  <ErrorState message={trend.error} onRetry={trend.retry} />
                ) : (
                  <>
                    <p style={note}>{trendNote}</p>
                    <ComboChart
                      showTitle={false}
                      points={trendPoints}
                      bars={[
                        { key: 'overdue', name: 'Overdue', color: 'var(--ps-color-alert)', stackId: 'debt' },
                        { key: 'notDue', name: 'Not yet due', color: 'var(--ps-color-accent)', stackId: 'debt' },
                      ]}
                      lines={[{ key: 'total', name: 'Open invoices', color: 'var(--ps-color-text)', yAxisId: 'left', labelFormatter: trendPoints.length <= 8 ? compact : undefined }]}
                      leftAxisFormatter={compact}
                      tooltipFormatters={{ total: full, overdue: full, notDue: full }}
                      connectNulls={false}
                      topPadding={24}
                      height={300}
                    />
                  </>
                )}
              </ChartPanel>
              <CollectionsTrendPanel
                currency={currency}
                data={collections.data}
                loading={collections.loading}
                error={collections.error}
                onRetry={collections.retry}
                grain={collectionGrain}
                onGrainChange={setCollectionGrain}
                onPeriodClick={setCollectionPoint}
              />
              </div>

              <div style={grid2}>
                {(() => {
                  const points = groupPoints(cur?.topCustomers);
                  return (
                    <ChartPanel
                      title={`Overdue by customer · ${viewLabel}`}
                      infoText={`Top ${meta.data?.topCustomers ?? 15} customers by overdue amount; % of the total overdue. Click a bar for its overdue invoices`}
                      tableColumns={[{ key: 'label', header: 'Customer' }, { key: 'overdueLabel', header: 'Overdue', align: 'right' }, { key: 'pctLabel', header: '% of total', align: 'right' }]}
                      tableRows={(cur?.topCustomers ?? []).map((g) => ({ ...g, overdueLabel: full(g.overdue), pctLabel: pctLabel(g.pctOfOverdue) }))}
                      getRowId={(r) => r.key}
                    >
                      {points.length ? (
                        <GroupedBarChart
                          showTitle={false}
                          points={points}
                          bars={[{ key: 'overdue', name: 'Overdue', color: 'var(--ps-color-alert)' }]}
                          valueFormatter={compact}
                          tooltipContent={groupTooltip}
                          onCategoryClick={onGroupClick('customer', points)}
                          height={barHeight(points.length)}
                          yAxisWidth={170}
                        />
                      ) : (
                        <NoData />
                      )}
                    </ChartPanel>
                  );
                })()}

                <ChartPanel
                  title={`Ageing · ${viewLabel}`}
                  infoText="Open amount per aging bucket (days past the line's own due date). Not due in blue, overdue in red; due today is not overdue. Click a bar for its invoices"
                  tableColumns={[{ key: 'label', header: 'Bucket' }, { key: 'amountLabel', header: 'Open amount', align: 'right' }, { key: 'lineCount', header: 'Lines', align: 'right' }]}
                  tableRows={(cur?.aging ?? []).map((a) => ({ ...a, id: String(a.agingBucketKey), amountLabel: full(a.amount) }))}
                  getRowId={(r) => r.id}
                >
                  <GroupedBarChart
                    showTitle={false}
                    points={agingPoints}
                    bars={[{ key: 'amount', name: 'Open amount', color: 'var(--ps-color-accent)' }]}
                    colorForPoint={(p) => colors.get(Number(p._key))}
                    valueFormatter={compact}
                    onCategoryClick={(label) => {
                      const p = agingPoints.find((x) => x.label === label);
                      if (p && Number(p._n) > 0) openDrill('aging', String(p._key), String(p.label), Number(p.amount));
                    }}
                    tooltipContent={(p) => (
                      <TooltipBox title={String(p.label)}>
                        <TooltipRow label="Open amount" value={full(Number(p.amount))} />
                        <TooltipRow label="Lines" value={formatNumber(Number(p._n))} />
                        <TooltipRow label="" value="Click for the invoices" />
                      </TooltipBox>
                    )}
                    height={barHeight(agingPoints.length)}
                    yAxisWidth={120}
                  />
                </ChartPanel>
              </div>

              <div style={grid2}>
                {(
                  [
                    ['salesperson', 'Overdue by salesperson', cur?.bySalesperson, 'Salesperson of the invoice (else the customer of record). Click a bar for its overdue invoices'],
                    ['team', 'Overdue by branch', cur?.byTeam, 'Branch (sales team) of the invoice, Excel org; an invoice without an Odoo sales team is Unknown. Click a bar for its overdue invoices'],
                  ] as const
                ).map(([kind, title, list, info]) => {
                  const points = groupPoints(list, peopleLimit);
                  return (
                    <ChartPanel
                      key={kind}
                      title={`${title} · ${viewLabel}`}
                      infoText={info}
                      tableColumns={[{ key: 'label', header: 'Name' }, { key: 'overdueLabel', header: 'Overdue', align: 'right' }, { key: 'pctLabel', header: '% of total', align: 'right' }]}
                      tableRows={(list ?? []).map((g) => ({ ...g, overdueLabel: full(g.overdue), pctLabel: pctLabel(g.pctOfOverdue) }))}
                      getRowId={(r) => r.key}
                      headerActions={
                        (list?.length ?? 0) > 15 ? (
                          <Button variant="ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setShowAllPeople((s) => !s)}>
                            {showAllPeople ? 'Top 15' : `All ${list?.length}`}
                          </Button>
                        ) : null
                      }
                    >
                      {points.length ? (
                        <GroupedBarChart
                          showTitle={false}
                          points={points}
                          bars={[{ key: 'overdue', name: 'Overdue', color: 'var(--ps-color-alert)' }]}
                          valueFormatter={compact}
                          tooltipContent={groupTooltip}
                          onCategoryClick={onGroupClick(kind, points)}
                          height={barHeight(points.length)}
                          yAxisWidth={150}
                        />
                      ) : (
                        <NoData />
                      )}
                    </ChartPanel>
                  );
                })}
              </div>
            </>
          )}

          <section style={{ minWidth: 0 }}>
            <h2 style={h2}>Customers · {viewLabel}</h2>
            <p style={note}>
              One row per company, customer and currency, sorted by overdue{currency ? `; ${currency} rows only` : '; amounts in LYD (≈ = converted at Odoo’s booked rate)'}. Open
              invoices, their amounts and Overdue count customer invoices only; Unapplied credits = credit notes + unreconciled payments; Net
              balance = every line (customers with credits only are listed too). Aging bucket = the customer&apos;s credit-policy zone, as on the
              escalation chart (days overdue of the earliest unpaid invoice, counted from the day after its due date; Not yet due before it, — with credits only). Salesperson, team and segment list every value on the customer’s lines.
              Click a row for every open document behind its net balance.
            </p>
            {customers.error ? (
              <ErrorState message={customers.error} onRetry={customers.retry} />
            ) : customers.loading && !customers.data ? (
              <LoadingSkeleton variant="table" />
            ) : (
              <DataGrid<CustomerGridRow>
                columns={customerColumns}
                rows={customerRows}
                enableFiltering={false}
                getRowId={(r) => r.id}
                fileName={`receivables-collections-customers-${currency ?? 'all-currencies'}-${snapshotDate ?? 'latest'}`}
                extraFilterParts={[`Currency: ${currency ?? 'All currencies (≈ LYD)'}`]}
                pageSize={15}
                maxBodyHeight={520}
                onRowClick={(r) => setDrill({ kind: 'account', key: `${r.companyKey}:${r.customerKey}`, label: `${r.customer} · ${r.company}`, currency: r.currency, expected: r.net })}
              />
            )}
          </section>
        </main>

        {drill ? (
          <DebtDrilldownModal
            target={drill}
            data={drilldown.data}
            loading={drilldown.loading}
            error={drilldown.error}
            onRetry={drilldown.retry}
            onClose={closeDrill}
            snapshotDate={snapshotDate}
          />
        ) : null}

        {collectionPoint ? (
          <CollectionsDrilldownModal
            point={collectionPoint}
            grain={collectionGrain}
            currency={currency}
            data={collectionDrill.data}
            loading={collectionDrill.loading}
            error={collectionDrill.error}
            onRetry={collectionDrill.retry}
            onClose={closeCollectionDrill}
          />
        ) : null}

        <BottomNavBar active="Receivables and Collections" />
      </div>
    </PermissionGuard>
  );
}

type CustomerGridRow = DebtCustomerRow & {
  id: string;
  salespersonList: string;
  teamList: string;
  segmentList: string;
  /** the Aging bucket column's filter value (zone label / Not yet due / —) and badge (lib/debt/creditPolicy.ts) */
  agingBucket: string;
  bucket: CreditBucket;
} & Record<string, unknown>;

/** The Aging bucket cell: the credit-policy zone as a badge in the zone's colour ("Green · 0 – 15 Days"), grey for Not
 * yet due, plain "—" for credits only. */
function BucketBadge({ bucket }: { bucket: CreditBucket }) {
  if (!bucket.tone) return <span style={{ color: 'var(--ps-color-muted-text)' }}>{bucket.label}</span>;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '1px 9px 1px 7px', borderRadius: 999, fontSize: 12, fontWeight: 600,
        whiteSpace: 'nowrap', color: bucket.tone === 'block' ? '#fff' : bucket.tone === 'notdue' ? 'var(--ps-color-text)' : '#111827', border: `1px solid ${creditColor(bucket.tone)}`, background: creditSoft(bucket.tone),
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: creditColor(bucket.tone), outline: bucket.tone === 'block' ? '1px solid #f3f4f6' : undefined }} />
      {bucket.label}
    </span>
  );
}

/** A column listing several names; its dropdown filter keeps the rows where any of them matches. */
function listColumn(
  key: 'salespersonList' | 'teamList' | 'segmentList',
  header: string,
  width: number,
  filterOptions: { value: string; label: string }[],
  values: (r: CustomerGridRow) => string[],
): DataGridColumn<CustomerGridRow> {
  return { key, header, width, filterOptions, filterMatch: (r, v) => values(r).includes(v), render: (r) => <span dir="auto">{r[key]}</span> };
}

const viewBar: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 12px', fontSize: 12.5, color: 'var(--ps-color-muted-text)' };
const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, color: 'var(--ps-color-accent)', textDecoration: 'underline', cursor: 'pointer',
};
/** A currency row of cards is the page's currency filter: hover lifts it, the selected row glows in its currency's
 * colour (--ccy-tone, tokens.css --ps-ccy-*), the others dim while one is selected. */
const CURRENCY_ROW_CSS = `
.ps-ccy-row { min-width: 0; margin: 0 -12px; padding: 10px; border-radius: 14px; border: 2px solid transparent; cursor: pointer; outline: none;
  transition: opacity .15s, border-color .15s, box-shadow .15s, transform .15s; }
.ps-ccy-row:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--ccy-tone) 45%, transparent); }
.ps-ccy-row:focus-visible { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ccy-tone) 50%, transparent); }
.ps-ccy-row[aria-pressed="true"] { border-color: var(--ccy-tone);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ccy-tone) 20%, transparent), 0 6px 18px color-mix(in srgb, var(--ccy-tone) 22%, transparent); }
.ps-ccy-row[data-dimmed="true"] { opacity: .5; }
.ps-ccy-row[data-dimmed="true"]:hover { opacity: .8; }
@media (prefers-reduced-motion: reduce) { .ps-ccy-row { transition: none; } .ps-ccy-row:hover { transform: none; } }
`;
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 'var(--ps-space-3, 16px)' };
const strip: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 20px', padding: '6px clamp(16px, 3vw, 24px)', fontSize: 12,
  color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)',
};
const note: React.CSSProperties = { margin: '0 0 12px', fontSize: 12, color: 'var(--ps-color-muted-text)' };
const h2: React.CSSProperties = { margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)' };

/** The amounts and counts behind one row of cards (a currency, or every currency in LYD). */
interface CardTotals {
  openAmount: number;
  openDocuments: number;
  customers: number;
  overdueAmount: number;
  overduePctOfOpen: number | null;
  notDueAmount: number;
  notDuePctOfOpen: number | null;
}

/** A currency's identity colour: its row badge and its segment of the mix bar (tokens.css --ps-ccy-*). */
function currencyTone(currency: string): string {
  return ['LYD', 'USD', 'EUR'].includes(currency) ? `var(--ps-ccy-${currency.toLowerCase()})` : 'var(--ps-color-muted-text)';
}

function CurrencyBadge({ currency }: { currency: string }) {
  const tone = currencyTone(currency);
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px 2px 8px', borderRadius: 999, fontSize: 13, fontWeight: 700,
        letterSpacing: 0.3, color: 'var(--ps-color-text)', border: `1px solid color-mix(in srgb, ${tone} 55%, transparent)`,
        background: `color-mix(in srgb, ${tone} 16%, transparent)`,
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: tone }} />
      {currency}
    </span>
  );
}

/**
 * The grand total: every currency's open invoices in LYD (the sum of the rows' LYD amounts), one band above the
 * per-currency rows. "≈" marks it as soon as a converted (non-LYD) amount is in it; the mix bar shows each currency's
 * share in the colours of the rows' badges.
 */
function DebtTotalBand({ all, currencies, snapshotDate }: { all: CardTotals & { currency: string }; currencies: DebtCurrencyOverview[]; snapshotDate: string | null }) {
  const converted = currencies.some((c) => c.currency !== all.currency && c.kpis.openAmountCompany !== 0);
  const approx = converted ? '≈ ' : '';
  const mix = currencies
    .map((c) => ({ currency: c.currency, amount: c.kpis.openAmountCompany, share: all.openAmount ? c.kpis.openAmountCompany / all.openAmount : 0 }))
    .filter((m) => m.amount > 0);
  // amounts need more width than counts: on a phone the two amounts take a line each, the two counts share one
  const stat = (label: string, value: string, sub: string, color: string, title?: string, basis = 150) => (
    <div title={title} style={{ flex: `1 1 ${basis}px`, minWidth: 0, padding: '10px 14px', borderRadius: 10, background: 'var(--ps-color-surface)', border: '1px solid var(--ps-color-border)' }}>
      <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3, overflowWrap: 'anywhere' }}>{value}</div>
      <div style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)' }}>{sub}</div>
    </div>
  );
  return (
    <section
      aria-label="Total debt, all currencies"
      style={{
        minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16, padding: 'clamp(16px, 2.4vw, 22px) clamp(16px, 2.4vw, 24px)', borderRadius: 14,
        background: 'linear-gradient(var(--ps-color-accent-bg), var(--ps-color-accent-bg)), var(--ps-color-muted-bg)',
        border: '1px solid color-mix(in srgb, var(--ps-ccy-lyd) 35%, var(--ps-color-border))', borderLeft: '4px solid var(--ps-ccy-lyd)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 24px', alignItems: 'center' }}>
        <div style={{ flex: '1 1 280px', minWidth: 0 }} title={`${approx}${formatMoney(all.currency, all.openAmount)}. ${OPEN_INVOICES_NOTE}.`}>
          <h2 style={{ ...h2, margin: 0, fontSize: 15 }}>Total debt: all currencies ({all.currency} equivalent)</h2>
          <div style={{ fontSize: 'clamp(34px, 4.2vw, 46px)', fontWeight: 800, lineHeight: 1.15, marginTop: 6, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>
            {approx}
            {formatCompactMoney(all.currency, all.openAmount)}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
            {approx}
            {formatMoney(all.currency, all.openAmount)}
          </div>
        </div>
        <div style={{ flex: '2 1 460px', minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {stat('Overdue', `${approx}${formatCompactMoney(all.currency, all.overdueAmount)}`, `${pctLabel(all.overduePctOfOpen)} of total debt`, 'var(--ps-color-alert)', `${approx}${formatMoney(all.currency, all.overdueAmount)}`)}
          {stat('Not yet due', `${approx}${formatCompactMoney(all.currency, all.notDueAmount)}`, `${pctLabel(all.notDuePctOfOpen)} of total debt`, 'var(--ps-color-success)', `${approx}${formatMoney(all.currency, all.notDueAmount)}`)}
          {stat('Customers', formatNumber(all.customers), 'with an open invoice', 'var(--ps-color-text)', 'A customer owing in several currencies counts once', 100)}
          {stat('Invoices', formatNumber(all.openDocuments), 'with an amount due', 'var(--ps-color-text)', undefined, 100)}
        </div>
      </div>
      {mix.length > 0 ? (
        <div style={{ minWidth: 0 }}>
          <div
            role="img"
            aria-label={`Currency mix: ${mix.map((m) => `${m.currency} ${pctLabel(m.share)}`).join(', ')}`}
            style={{ display: 'flex', gap: 2, height: 10, borderRadius: 5, overflow: 'hidden' }}
          >
            {mix.map((m) => (
              <span key={m.currency} title={`${m.currency}: ${approx}${formatMoney(all.currency, m.amount)} (${pctLabel(m.share)})`} style={{ flex: `${m.share} 0 4px`, background: currencyTone(m.currency) }} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8, fontSize: 12.5, color: 'var(--ps-color-muted-text)' }}>
            {mix.map((m) => (
              <span key={m.currency} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: currencyTone(m.currency) }} />
                <strong style={{ color: 'var(--ps-color-text)' }}>{m.currency}</strong> {pctLabel(m.share)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {converted ? (
        <p style={{ ...note, margin: 0 }}>
          ≈ Converted to {all.currency} at Odoo&apos;s booked rate of each invoice&apos;s date (Odoo&apos;s Amount Due), snapshot of {formatDate(snapshotDate)}.
        </p>
      ) : null}
    </section>
  );
}

/**
 * One row of exactly five cards: Total debt, Customers, Invoices, Overdue, Not yet due. `lyd` = the same three amounts
 * in LYD (Odoo's own company-currency amounts), shown under each amount; null when the row already is in LYD.
 * `shareOfTotal` = the row's share of the grand total (its segment of the band's mix bar). The whole row is one
 * toggle button (2026-10-15): it sets / clears the page's currency filter.
 */
function DebtCards({
  currency,
  totals: t,
  lyd,
  shareOfTotal,
  selected,
  dimmed,
  onToggle,
}: {
  currency: string;
  totals: CardTotals;
  lyd: { open: number; overdue: number; notDue: number } | null;
  shareOfTotal: number | null;
  selected: boolean;
  dimmed: boolean;
  onToggle: () => void;
}) {
  // the second line is always the exact LYD figure: "≈ LYD ..." for a foreign currency, the exact amount otherwise
  const lydLine = (own: number, inLyd: number | undefined) =>
    lyd && currency !== LYD ? `≈ ${formatMoney(LYD, inLyd ?? 0)}` : formatMoney(currency, own);
  return (
    <section
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${currency} totals: ${selected ? `showing ${currency} only, press to show all currencies` : `press to show ${currency} only`}`}
      className="ps-ccy-row"
      data-dimmed={dimmed}
      style={{ '--ccy-tone': currencyTone(currency) } as React.CSSProperties}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px' }}>
        <CurrencyBadge currency={currency} />
        {shareOfTotal !== null ? <span style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)' }}>{pctLabel(shareOfTotal)} of total debt</span> : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
        <Kpi
          title={`${formatMoney(currency, t.openAmount)}. ${OPEN_INVOICES_NOTE}.`}
          label="Total debt"
          value={formatCompactMoney(currency, t.openAmount)}
          subValue={lydLine(t.openAmount, lyd?.open)}
          status="neutral"
        />
        <Kpi label="Customers" value={formatNumber(t.customers)} variance="with an open invoice" status="neutral" />
        <Kpi label="Invoices" value={formatNumber(t.openDocuments)} variance="posted invoices with an amount due" status="neutral" />
        <Kpi
          title={formatMoney(currency, t.overdueAmount)}
          label="Overdue"
          value={formatCompactMoney(currency, t.overdueAmount)}
          subValue={lydLine(t.overdueAmount, lyd?.overdue)}
          variance={`${pctLabel(t.overduePctOfOpen)} of total debt`}
          status="alert"
        />
        <Kpi
          title={formatMoney(currency, t.notDueAmount)}
          label="Not yet due"
          value={formatCompactMoney(currency, t.notDueAmount)}
          subValue={lydLine(t.notDueAmount, lyd?.notDue)}
          variance={`${pctLabel(t.notDuePctOfOpen)} of total debt`}
          status="success"
        />
      </div>
    </section>
  );
}

const LYD = 'LYD';

function Kpi({ title, ...props }: React.ComponentProps<typeof KpiTile> & { title?: string }) {
  return (
    <div title={title} style={{ display: 'grid', minWidth: 0 }}>
      <KpiTile {...props} />
    </div>
  );
}

function Field({ children, width = 160, title }: { children: React.ReactNode; width?: number; title?: string }) {
  return (
    <div title={title} style={{ width, flexShrink: 0, maxWidth: '100%' }}>
      {children}
    </div>
  );
}

function NoData() {
  return <p style={{ ...note, padding: '24px 0', textAlign: 'center' }}>No overdue amount for these filters.</p>;
}

function TooltipBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderRadius: 10, border: '1px solid var(--ps-color-border)', fontSize: 12, background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', padding: '10px 12px', minWidth: 200 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }} dir="auto">
        {title}
      </div>
      {children}
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--ps-color-muted-text)' }}>{label}</span>
      <span style={{ fontWeight: 600 }} dir="auto">
        {value}
      </span>
    </div>
  );
}
