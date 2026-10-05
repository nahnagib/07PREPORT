'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { DebtDrilldownModal, type DebtDrillTarget } from '../../../../components/debt/DebtDrilldownModal';
import { useAuth } from '../../../../lib/AuthProvider';
import { useDebtReport } from '../../../../lib/hooks';
import type { DebtCurrencyOverview, DebtCustomerRow, DebtCustomers, DebtDrilldown, DebtDrillKind, DebtMeta, DebtOverview, DebtTrend } from '../../../../lib/api';
import { formatCompactMoney, formatDate, formatMoney, formatNumber, formatTimestamp } from '../../../../lib/format';
import {
  DEFAULT_DEBT_FILTERS,
  SIZE_TIER_HINT,
  agingColors,
  isDefaultFilters,
  optLabel,
  pctLabel,
  tierLabel,
  toScope,
  type DebtPageFilters,
  type LabelLang,
} from '../../../../lib/debt/view';
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
  TextInput,
  type DataGridColumn,
  type GroupedBarChartPoint,
  type SelectOption,
} from '@07ps/ui';

/**
 * Debt Report (Price / Finance department): open customer receivables from the daily snapshot taken by the finance ETL
 * at 06:30 (fact_finance_receivable_snapshot). Default view: the latest snapshot, customer debt only (customer invoices,
 * credit notes, receipts, inbound customer payments), inter-company excluded -- the v_finance_* views. The two toggles
 * add the other receivable entries and the inter-company balances.
 *
 * The whole page leaves out the excluded segments and sales teams (warehouse table cfg_finance_report_exclusion,
 * applied by the API to every number; listed in the strip from GET /debt-report/meta). Every amount is in its own
 * currency -- never added across currencies, never converted: the KPI cards show one group per currency, the charts
 * and the trend show the currency picked in the selector, the customer table one row per company + customer +
 * currency. Clicking a chart bar or a table row opens the lines behind it (GET /debt-report/drilldown), which add up to
 * the figure clicked.
 *
 * Every label comes from GET /debt-report/meta: Odoo's own labels (English or Arabic, the page's "Odoo labels" switch;
 * the app itself is English-only), our scope and aging-bucket names, and the size-tier thresholds from the backend
 * config. The freshness strip shows the FINANCE refresh, never the sales one. Access and the salesperson scope are
 * enforced by the API (routes/debtReport.ts); this page only mirrors them.
 */
export default function DebtReportPage() {
  const { user, token, error: authError, retryAuth, logout, isSalesperson, canView } = useAuth();
  const allowed = canView('debt_report');
  const roleLabel = user?.role.label ?? user?.fullName;
  const [filters, setFilters] = useState<DebtPageFilters>(DEFAULT_DEBT_FILTERS);
  const [search, setSearch] = useState('');
  const [lang, setLang] = useState<LabelLang>('en');
  const [pickedCurrency, setPickedCurrency] = useState<string | null>(null);
  const [drill, setDrill] = useState<DebtDrillTarget | null>(null);
  const [showAllPeople, setShowAllPeople] = useState(false);

  // customer search: debounced into the filters
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.customerSearch === search ? f : { ...f, customerSearch: search })), 350);
    return () => clearTimeout(t);
  }, [search]);

  const scope = useMemo(() => toScope(filters, isSalesperson), [filters, isSalesperson]);
  // filter options depend on the snapshot and the scope toggles only
  const metaScope = useMemo(
    () => ({ snapshotDate: filters.snapshotDate, includeOther: filters.includeOther, includeIntercompany: filters.includeIntercompany }),
    [filters.snapshotDate, filters.includeOther, filters.includeIntercompany],
  );
  const meta = useDebtReport<DebtMeta>(token, authError, retryAuth, 'meta', metaScope, undefined, allowed);
  const overview = useDebtReport<DebtOverview>(token, authError, retryAuth, 'overview', scope, undefined, allowed);
  const trend = useDebtReport<DebtTrend>(token, authError, retryAuth, 'trend', scope, undefined, allowed);
  const customers = useDebtReport<DebtCustomers>(token, authError, retryAuth, 'customers', scope, undefined, allowed);
  const drillExtra = useMemo<Record<string, string | number>>(
    () => {
      const extra: Record<string, string | number> = {};
      if (drill) Object.assign(extra, { kind: drill.kind, key: drill.key, currency: drill.currency });
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
  // the charts' currency: the one picked, else the first (most lines -- LYD); a pick that has no line any more falls back
  const currency = currencies.find((c) => c.currency === pickedCurrency)?.currency ?? currencies[0]?.currency ?? null;
  const cur: DebtCurrencyOverview | undefined = currencies.find((c) => c.currency === currency);
  const colors = useMemo(() => agingColors(cur?.aging ?? []), [cur?.aging]);
  const compact = (v: number) => formatCompactMoney(currency ?? '', v);
  const full = (v: number) => formatMoney(currency ?? '', v);

  const openDrill = (kind: DebtDrillKind, key: string, label: string, expected: number) => {
    if (currency) setDrill({ kind, key, label, currency, expected });
  };

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
  const trendPoints = (trend.data?.points ?? [])
    .filter((p) => p.currency === currency)
    .map((p) => ({ label: formatDate(p.snapshotDate), total: p.open, overdue: p.overdue, notDue: p.notDue }));

  // ---- customer table ------------------------------------------------------------------------------------------------
  const customerRows: CustomerGridRow[] = (customers.data?.rows ?? []).map((r) => ({
    ...r,
    id: `${r.companyKey}:${r.customerKey}:${r.currency}`,
    salespersonList: r.salespersons.join(', '),
    teamList: r.salesTeams.join(', '),
    segmentList: r.segments.join(', '),
  }));
  const distinctOptions = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
  const rowMoney = (key: 'invoiceAmount' | 'open' | 'overdue', header: string): DataGridColumn<CustomerGridRow> => ({
    key, header, align: 'right', width: 160, rawValue: (r) => r[key], render: (r) => formatMoney(r.currency, r[key]),
  });
  const customerColumns: DataGridColumn<CustomerGridRow>[] = [
    { key: 'company', header: 'Company', width: 90, filterOptions: distinctOptions(customerRows.map((r) => r.company)) },
    { key: 'customer', header: 'Customer', width: 230, render: (r) => <span dir="auto">{r.customer}</span> },
    { key: 'currency', header: 'Currency', width: 90, filterOptions: distinctOptions(customerRows.map((r) => r.currency)) },
    { key: 'openDocuments', header: 'Open documents', align: 'right', width: 110, render: (r) => formatNumber(r.openDocuments) },
    rowMoney('invoiceAmount', 'Total invoices amount'),
    rowMoney('open', 'Total debt'),
    rowMoney('overdue', 'Due debt'),
    listColumn('salespersonList', 'Salesperson', 180, distinctOptions(customerRows.flatMap((r) => r.salespersons)), (r) => r.salespersons),
    listColumn('teamList', 'Team', 180, distinctOptions(customerRows.flatMap((r) => r.salesTeams)), (r) => r.salesTeams),
    listColumn('segmentList', 'Segment', 110, distinctOptions(customerRows.flatMap((r) => r.segments)), (r) => r.segments),
  ];

  const freshness = meta.data?.freshness;
  const nothing = overview.data && overview.data.lineCount === 0;
  const firstSnapshot = meta.data?.snapshots[0]?.date ?? null;
  const trendNote =
    `Snapshot history started on ${formatDate(firstSnapshot ?? snapshotDate)} and grows by one snapshot a day (06:30).` +
    (trend.data && trend.data.snapshotCount < 2 ? ' The trend needs at least 2 snapshots.' : '');
  const exclusionText = exclusions
    ? [
        exclusions.segments.length ? `segments ${exclusions.segments.join(', ')}` : null,
        exclusions.salesTeams.length ? `teams ${exclusions.salesTeams.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('; ')
    : null;
  const exclusionTitle = exclusions?.teams.map((t) => `${t.salesTeamKey} ${t.salesTeam} (${t.segment ?? '—'})`).join('\n');

  return (
    <PermissionGuard pageKey="debt_report">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader pageTitle="Debt Report" anchorDate="" onAnchorDateChange={() => {}} roleLabel={roleLabel} onLogout={logout} showDateInput={false} />

        <FilterBar
          onReset={() => {
            setFilters(DEFAULT_DEBT_FILTERS);
            setSearch('');
          }}
          isPristine={isDefaultFilters(filters) && search === ''}
          showDateRange={false}
          showCompanyDimension={false}
          showTransactionDimensions={false}
          showLastOrderInfo={false}
          extraFields={
            <>
              <PillField label="Company">
                <Button variant={filters.companyKeys.length === 0 ? 'primary' : 'secondary'} style={pill} disabled={isSalesperson} onClick={() => set('companyKeys', [])}>
                  Both
                </Button>
                {(o?.companies ?? []).map((c) => (
                  <Button
                    key={c.value}
                    variant={filters.companyKeys.length === 1 && filters.companyKeys[0] === Number(c.value) ? 'primary' : 'secondary'}
                    style={pill}
                    disabled={isSalesperson}
                    onClick={() => set('companyKeys', [Number(c.value)])}
                  >
                    {c.labelEn}
                  </Button>
                ))}
              </PillField>
              <Field width={170}>
                <Select
                  label="Snapshot date"
                  options={[...(meta.data?.snapshots ?? [])].reverse().map((s) => ({ value: s.date, label: formatDate(s.date) }))}
                  value={[filters.snapshotDate ?? meta.data?.snapshotDate ?? ''].filter(Boolean)}
                  onChange={(v) => set('snapshotDate', v[0] && v[0] !== meta.data?.snapshots[meta.data.snapshots.length - 1]?.date ? v[0] : null)}
                  loading={meta.loading}
                />
              </Field>
              <Field>
                <Select label="Salesperson" options={opts(o?.salespersons)} value={filters.salespersonKeys.map(String)} onChange={(v) => set('salespersonKeys', v.map(Number))} multiSelect searchable disabled={isSalesperson} lockedReason={lockedReason} placeholder="All" />
              </Field>
              <Field>
                <Select label="Team" options={opts(o?.salesTeams)} value={filters.salesTeamKeys} onChange={(v) => set('salesTeamKeys', v)} multiSelect searchable disabled={isSalesperson} lockedReason={lockedReason} placeholder="All" />
              </Field>
              <Field width={200}>
                <TextInput label="Customer" placeholder="Name or Odoo id" value={search} onChange={(e) => setSearch(e.target.value)} dir="auto" />
              </Field>
              <PillField label="Overdue status">
                {(['all', 'overdue', 'not_due'] as const).map((s) => (
                  <Button key={s} variant={filters.overdueStatus === s ? 'primary' : 'secondary'} style={pill} onClick={() => set('overdueStatus', s)}>
                    {s === 'all' ? 'All' : s === 'overdue' ? 'Overdue' : 'Not due'}
                  </Button>
                ))}
              </PillField>
              <Field>
                <Select label="Aging bucket" options={opts(o?.agingBuckets)} value={filters.agingBucketKeys.map(String)} onChange={(v) => set('agingBucketKeys', v.map(Number))} multiSelect placeholder="All" />
              </Field>
              <Field>
                <Select label="Delivery status" options={opts(o?.deliveryStatuses)} value={filters.deliveryStatuses} onChange={(v) => set('deliveryStatuses', v)} multiSelect placeholder="All" />
              </Field>
              <Field>
                <Select label="Payment term" options={opts(o?.paymentTerms)} value={filters.paymentTermKeys.map(String)} onChange={(v) => set('paymentTermKeys', v.map(Number))} multiSelect searchable placeholder="All" />
              </Field>
              <Field width={190}>
                <Select label="Document type" options={opts(o?.documentTypes)} value={filters.documentTypeKeys} onChange={(v) => set('documentTypeKeys', v)} multiSelect placeholder="All" />
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
              <Field width={190} title={SIZE_TIER_HINT}>
                <Select
                  label="Customer size ⓘ"
                  options={(o?.sizeTiers ?? []).map((t) => ({ value: t.value, label: tierLabel(t, lang) }))}
                  value={filters.customerTiers}
                  onChange={(v) => set('customerTiers', v as DebtPageFilters['customerTiers'])}
                  multiSelect
                  placeholder="All"
                />
              </Field>
              <PillField label="Include">
                <Toggle checked={filters.includeOther} onChange={(v) => set('includeOther', v)} label={`Include ${otherScope ? optLabel(otherScope, 'en').toLowerCase() : 'other receivable entries'}`} />
                <Toggle checked={filters.includeIntercompany} onChange={(v) => set('includeIntercompany', v)} label="Include inter-company" />
              </PillField>
              <PillField label="Odoo labels">
                <Button variant={lang === 'en' ? 'primary' : 'secondary'} style={pill} onClick={() => setLang('en')}>
                  English
                </Button>
                <Button variant={lang === 'ar' ? 'primary' : 'secondary'} style={pill} onClick={() => setLang('ar')}>
                  العربية
                </Button>
              </PillField>
            </>
          }
        />

        <div style={strip} role="status">
          <span>
            Receivables snapshot <strong style={{ color: 'var(--ps-color-text)' }}>{formatDate(snapshotDate)}</strong>
          </span>
          <span>
            Finance refresh <strong style={{ color: 'var(--ps-color-text)' }}>{formatTimestamp(freshness?.lastSuccessUtc ?? null)}</strong>
          </span>
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
          <span>Amounts per currency, never converted</span>
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
              {currencies.map((c) => (
                <section key={c.currency} aria-label={`${c.currency} totals`} style={{ minWidth: 0 }}>
                  <h2 style={h2}>{c.currency}</h2>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
                    <Kpi title={formatMoney(c.currency, c.kpis.openAmount)} label="Open debt" value={formatCompactMoney(c.currency, c.kpis.openAmount)} variance="overdue + not yet due" status="neutral" />
                    <Kpi label="Open documents" value={formatNumber(c.kpis.openDocuments)} variance="invoices, credit notes, payments" status="neutral" />
                    <Kpi label="Customers" value={formatNumber(c.kpis.customers)} variance="with an open balance" status="neutral" />
                    <Kpi
                      title={formatMoney(c.currency, c.kpis.overdueAmount)}
                      label="Overdue"
                      value={formatCompactMoney(c.currency, c.kpis.overdueAmount)}
                      variance={`${pctLabel(c.kpis.overduePctOfOpen)} of open debt`}
                      status="alert"
                    />
                    <Kpi
                      title={formatMoney(c.currency, c.kpis.notDueAmount)}
                      label="Not yet due"
                      value={formatCompactMoney(c.currency, c.kpis.notDueAmount)}
                      variance={`${pctLabel(c.kpis.notDuePctOfOpen)} of open debt`}
                      status="success"
                    />
                  </div>
                </section>
              ))}

              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                <PillField label="Charts currency">
                  {currencies.map((c) => (
                    <Button key={c.currency} variant={c.currency === currency ? 'primary' : 'secondary'} style={pill} onClick={() => setPickedCurrency(c.currency)}>
                      {c.currency}
                    </Button>
                  ))}
                </PillField>
                <p style={{ ...note, margin: 0 }}>The charts and the trend below show {currency ?? '—'} only. Click a bar to see the invoices behind it.</p>
              </div>

              <ChartPanel title={`Trend: open debt · ${currency ?? ''}`} infoText="Total open debt per snapshot date (line), split into overdue and not yet due (stacked bars), with the same filters">
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
                      lines={[{ key: 'total', name: 'Total open debt', color: 'var(--ps-color-text)', yAxisId: 'left', labelFormatter: compact }]}
                      leftAxisFormatter={compact}
                      tooltipFormatters={{ total: full, overdue: full, notDue: full }}
                      height={300}
                    />
                  </>
                )}
              </ChartPanel>

              <div style={grid2}>
                {(() => {
                  const points = groupPoints(cur?.topCustomers);
                  return (
                    <ChartPanel
                      title={`Overdue by customer · ${currency ?? ''}`}
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
                  title={`Distribution · ${currency ?? ''}`}
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
                    ['team', 'Overdue by team', cur?.byTeam, 'Team of the invoice (else the salesperson’s team), Excel org. Click a bar for its overdue invoices'],
                  ] as const
                ).map(([kind, title, list, info]) => {
                  const points = groupPoints(list, peopleLimit);
                  return (
                    <ChartPanel
                      key={kind}
                      title={`${title} · ${currency ?? ''}`}
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
            <h2 style={h2}>Customers</h2>
            <p style={note}>
              One row per company, customer and currency, sorted by due debt. Total invoices amount = the original amounts of the open documents
              (credit notes and payments negative). Salesperson, team and segment list every value on the customer’s lines. Click a row for its
              open documents.
            </p>
            {customers.error ? (
              <ErrorState message={customers.error} onRetry={customers.retry} />
            ) : customers.loading && !customers.data ? (
              <LoadingSkeleton variant="table" />
            ) : (
              <DataGrid<CustomerGridRow>
                columns={customerColumns}
                rows={customerRows}
                getRowId={(r) => r.id}
                fileName={`debt-customers-${snapshotDate ?? 'latest'}`}
                pageSize={15}
                maxBodyHeight={520}
                onRowClick={(r) => setDrill({ kind: 'account', key: `${r.companyKey}:${r.customerKey}`, label: `${r.customer} · ${r.company}`, currency: r.currency, expected: r.open })}
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

        <BottomNavBar active="Debt Report" />
      </div>
    </PermissionGuard>
  );
}

type CustomerGridRow = DebtCustomerRow & { id: string; salespersonList: string; teamList: string; segmentList: string } & Record<string, unknown>;

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

const pill: React.CSSProperties = { padding: '6px 12px', fontSize: 12.5 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 'var(--ps-space-3, 16px)' };
const strip: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 20px', padding: '6px clamp(16px, 3vw, 24px)', fontSize: 12,
  color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)',
};
const note: React.CSSProperties = { margin: '0 0 12px', fontSize: 12, color: 'var(--ps-color-muted-text)' };
const h2: React.CSSProperties = { margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)' };

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

function PillField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '100%' }}>
      <span style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 38, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ps-color-text)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
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
