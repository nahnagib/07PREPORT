'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import { useDebtReport } from '../../../../lib/hooks';
import type { DebtCustomerRow, DebtCustomers, DebtDocumentRow, DebtDocuments, DebtMeta, DebtOverview, DebtTrend } from '../../../../lib/api';
import { formatCompactCurrency, formatCurrencyFull, formatDate, formatNumber, formatTimestamp } from '../../../../lib/format';
import {
  DEFAULT_DEBT_FILTERS,
  agingColors,
  changeCell,
  changeLine,
  isDefaultFilters,
  optLabel,
  pickLabel,
  safeOdooUrl,
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
 * add the other receivable entries and the inter-company balances; with both on the totals are Odoo's Aged Receivable.
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
  const [selected, setSelected] = useState<DebtCustomerRow | null>(null);
  const [showAllPeople, setShowAllPeople] = useState(false);
  const drillRef = useRef<HTMLDivElement>(null);

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
  const drillExtra = useMemo<Record<string, string | number>>(() => {
    const extra: Record<string, string | number> = {};
    if (selected) extra.customerKey = selected.customerKey;
    return extra;
  }, [selected]);
  const drillScope = useMemo(() => (selected ? { ...scope, companyKeys: [selected.companyKey] } : scope), [scope, selected]);
  const documents = useDebtReport<DebtDocuments>(token, authError, retryAuth, 'documents', drillScope, drillExtra, allowed && selected !== null);

  // a drill-down belongs to the filters it was opened with
  useEffect(() => setSelected(null), [scope]);
  useEffect(() => {
    if (selected) drillRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);

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

  const k = overview.data?.kpis;
  const snapshotDate = overview.data?.snapshotDate ?? meta.data?.snapshotDate ?? null;
  const colors = useMemo(() => agingColors(overview.data?.aging ?? []), [overview.data?.aging]);

  const groupPoints = (list: DebtOverview['topCustomers'] | undefined, limit?: number): GroupedBarChartPoint[] =>
    (list ?? []).slice(0, limit).map((g) => ({ label: g.label, overdue: g.overdue, _pct: g.pctOfOverdue, _open: g.open, _detail: g.detail ?? null }));
  const groupTooltip = (p: GroupedBarChartPoint) => (
    <TooltipBox title={String(p.label)}>
      {p._detail ? <TooltipRow label="Company" value={String(p._detail)} /> : null}
      <TooltipRow label="Overdue" value={formatCurrencyFull(Number(p.overdue))} />
      <TooltipRow label="% of total overdue" value={p._pct === null || p._pct === undefined ? '—' : `${(Number(p._pct) * 100).toFixed(1)}%`} />
      <TooltipRow label="Open (net)" value={formatCurrencyFull(Number(p._open))} />
    </TooltipBox>
  );
  const barHeight = (n: number) => Math.max(220, n * 30 + 50);
  const peopleLimit = showAllPeople ? undefined : 15;

  const agingPoints: GroupedBarChartPoint[] = (overview.data?.aging ?? []).map((a) => ({
    label: a.label,
    amount: a.amount,
    _key: a.agingBucketKey,
    _n: a.lineCount,
    _overdue: a.isOverdue ? 1 : 0,
  }));
  const trendPoints = (trend.data?.points ?? []).map((p) => ({ label: formatDate(p.snapshotDate), open: p.open, overdue: p.overdue }));

  const customerColumns: DataGridColumn<CustomerGridRow>[] = [
    { key: 'company', header: 'Company', width: 90 },
    { key: 'customer', header: 'Customer', width: 230, render: (r) => <span dir="auto">{r.customer}</span> },
    money('open', 'Open'),
    money('overdue', 'Overdue'),
    money('overdue90Plus', '90+ days'),
    { key: 'creditLimit', header: 'Credit limit', align: 'right', width: 140, rawValue: (r) => r.creditLimit ?? '', render: (r) => (r.creditLimit === null ? '—' : formatCurrencyFull(r.creditLimit)) },
    { key: 'overLimit', header: 'Over limit', width: 95, render: (r) => (r.overLimit === 'Yes' ? <Flag text="Over limit" /> : r.creditLimit === null ? '—' : 'No') },
    { key: 'oldestOverdueDays', header: 'Oldest overdue (days)', align: 'right', width: 120, rawValue: (r) => r.oldestOverdueDays ?? '', render: (r) => (r.oldestOverdueDays === null ? '—' : formatNumber(r.oldestOverdueDays)) },
    money('salesLast90d', `Sales last ${meta.data?.salesWindowDays ?? 90} days`),
    { key: 'dsoDays', header: 'DSO (days)', align: 'right', width: 95, rawValue: (r) => r.dsoDays ?? '', render: (r) => (r.dsoDays === null ? '—' : formatNumber(Math.round(r.dsoDays))) },
    { key: 'change7d', header: 'Change 7d', align: 'right', width: 140, rawValue: (r) => r.change7d ?? '', render: (r) => changeCell(r.change7d) },
    { key: 'change30d', header: 'Change 30d', align: 'right', width: 140, rawValue: (r) => r.change30d ?? '', render: (r) => changeCell(r.change30d) },
  ];
  const customerRows: CustomerGridRow[] = (customers.data?.rows ?? []).map((r) => ({ ...r, id: `${r.companyKey}:${r.customerKey}`, overLimit: r.overCreditLimit ? 'Yes' : 'No' }));

  const documentColumns: DataGridColumn<DocumentGridRow>[] = [
    { key: 'document', header: 'Document', width: 150 },
    { key: 'typeLabel', header: 'Document type', width: 170, render: (r) => <span dir="auto">{r.typeLabel}</span> },
    { key: 'invoiceDate', header: 'Invoice date', width: 110, rawValue: (r) => r.invoiceDate ?? '', render: (r) => formatDate(r.invoiceDate) },
    { key: 'dueDate', header: 'Due date', width: 110, rawValue: (r) => r.dueDate ?? '', render: (r) => formatDate(r.dueDate) },
    { key: 'daysPastDue', header: 'Days past due', align: 'right', width: 95, render: (r) => formatNumber(r.daysPastDue) },
    { key: 'agingBucket', header: 'Aging bucket', width: 120 },
    { key: 'residualCompanyCcy', header: 'Residual (company currency)', align: 'right', width: 160, render: (r) => formatCurrencyFull(r.residualCompanyCcy) },
    {
      key: 'residualDocCcy', header: 'Residual (document currency)', align: 'right', width: 170, rawValue: (r) => r.residualDocCcy ?? '',
      render: (r) => (r.residualDocCcy === null ? '—' : `${r.docCurrency ?? ''} ${formatNumber(r.residualDocCcy, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`),
    },
    { key: 'paymentTerm', header: 'Payment term', width: 130, render: (r) => <span dir="auto">{r.paymentTerm ?? '—'}</span> },
    { key: 'salesperson', header: 'Salesperson', width: 150 },
    { key: 'salespersonSource', header: 'Salesperson source', width: 120 },
    { key: 'salesTeam', header: 'Team', width: 150, render: (r) => <span dir="auto">{r.salesTeam ?? '—'}</span> },
    { key: 'deliveryLabel', header: 'Delivery status', width: 140, render: (r) => <span dir="auto">{r.deliveryLabel}</span> },
    {
      key: 'odooUrl', header: 'Odoo', width: 80, rawValue: (r) => r.odooUrl,
      render: (r) => {
        const href = safeOdooUrl(r.odooUrl);
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--ps-color-accent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Open <ExternalLink size={12} aria-hidden />
          </a>
        ) : '—';
      },
    },
  ];
  const documentRows: DocumentGridRow[] = (documents.data?.rows ?? []).map((d) => ({
    ...d,
    id: String(d.lineId),
    typeLabel: [pickLabel(d.documentTypeLabelEn, d.documentTypeLabelAr, lang), pickLabel(d.journalEn, d.journalAr, lang)].filter((x) => x && x !== '—').join(' / '),
    deliveryLabel: d.deliveryStatus === null ? '—' : pickLabel(d.deliveryStatusLabelEn, d.deliveryStatusLabelAr, lang),
  }));

  const freshness = meta.data?.freshness;
  const nothing = overview.data && overview.data.kpis.lineCount === 0;
  const trendNote =
    trend.data && trend.data.snapshotCount < 2
      ? `The trend needs at least 2 snapshots. History started on ${formatDate(meta.data?.snapshots[0]?.date ?? snapshotDate)} and grows by one snapshot a day (06:30).`
      : null;

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
              <Field width={190}>
                <Select
                  label="Invoice size"
                  options={(o?.sizeTiers ?? []).map((t) => ({ value: t.value, label: tierLabel(t, lang) }))}
                  value={filters.invoiceTiers}
                  onChange={(v) => set('invoiceTiers', v as DebtPageFilters['invoiceTiers'])}
                  multiSelect
                  placeholder="All"
                />
              </Field>
              <Field width={190}>
                <Select
                  label="Customer size"
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
                <Kpi title={formatCurrencyFull(k?.openAmount)} label="Open debt (net)" value={formatCompactCurrency(k?.openAmount ?? 0)} variance={`${formatNumber(k?.lineCount ?? 0)} open lines`} status="neutral" />
                <Kpi
                  title={formatCurrencyFull(k?.overdueAmount)}
                  label="Overdue amount"
                  value={formatCompactCurrency(k?.overdueAmount ?? 0)}
                  variance={k?.overduePctOfOpen === null || k?.overduePctOfOpen === undefined ? '— of open' : `${(k.overduePctOfOpen * 100).toFixed(1)}% of open`}
                  status="alert"
                />
                <Kpi label="Overdue documents" value={formatNumber(k?.overdueDocuments ?? 0)} variance="with an overdue balance" status="watch" />
                <Kpi label="Customers with overdue balance" value={formatNumber(k?.customersOverdue ?? 0)} variance="per company" status="watch" />
                <Kpi title={formatCurrencyFull(k?.overdue90Plus)} label="Overdue 90+ days" value={formatCompactCurrency(k?.overdue90Plus ?? 0)} variance={k && k.overdueAmount ? `${((k.overdue90Plus / k.overdueAmount) * 100).toFixed(1)}% of overdue` : undefined} status="alert" />
                <Kpi
                  label="Customers over credit limit"
                  value={formatNumber(k?.customersOverCreditLimit ?? 0)}
                  variance={k?.customersWithCreditLimit ? `of ${formatNumber(k.customersWithCreditLimit)} with a credit limit` : 'no customer has a credit limit > 0'}
                  status="neutral"
                />
                <Kpi
                  label="Change in overdue"
                  value={k?.overdueChange[0]?.change === null || k?.overdueChange[0] === undefined ? '—' : changeLine(k.overdueChange[0]).replace(/^\d+d: /, '')}
                  variance={(k?.overdueChange ?? []).map(changeLine).join(' · ')}
                  status="neutral"
                />
              </div>

              <div style={grid2}>
                <ChartPanel
                  title="Overdue by customer"
                  infoText={`Top ${meta.data?.topCustomers ?? 15} customers by overdue amount (company currency); % of the total overdue`}
                  tableColumns={[{ key: 'label', header: 'Customer' }, { key: 'overdueLabel', header: 'Overdue', align: 'right' }, { key: 'pctLabel', header: '% of total', align: 'right' }]}
                  tableRows={(overview.data?.topCustomers ?? []).map((g) => ({ ...g, overdueLabel: formatCurrencyFull(g.overdue), pctLabel: g.pctOfOverdue === null ? '—' : `${(g.pctOfOverdue * 100).toFixed(1)}%` }))}
                  getRowId={(r) => r.key}
                >
                  {overview.data?.topCustomers.length ? (
                    <GroupedBarChart
                      showTitle={false}
                      points={groupPoints(overview.data.topCustomers)}
                      bars={[{ key: 'overdue', name: 'Overdue', color: 'var(--ps-color-alert)' }]}
                      valueFormatter={(v) => formatCompactCurrency(v)}
                      tooltipContent={groupTooltip}
                      height={barHeight(overview.data.topCustomers.length)}
                      yAxisWidth={170}
                    />
                  ) : (
                    <NoData />
                  )}
                </ChartPanel>

                <ChartPanel
                  title="Aging distribution"
                  infoText="Open amount per aging bucket (days past the line's own due date). Not due in blue, overdue in red; due today is not overdue"
                  tableColumns={[{ key: 'label', header: 'Bucket' }, { key: 'amountLabel', header: 'Open amount', align: 'right' }, { key: 'lineCount', header: 'Lines', align: 'right' }]}
                  tableRows={(overview.data?.aging ?? []).map((a) => ({ ...a, id: String(a.agingBucketKey), amountLabel: formatCurrencyFull(a.amount) }))}
                  getRowId={(r) => r.id}
                >
                  <GroupedBarChart
                    showTitle={false}
                    points={agingPoints}
                    bars={[{ key: 'amount', name: 'Open amount', color: 'var(--ps-color-accent)' }]}
                    colorForPoint={(p) => colors.get(Number(p._key))}
                    valueFormatter={(v) => formatCompactCurrency(v)}
                    tooltipContent={(p) => (
                      <TooltipBox title={String(p.label)}>
                        <TooltipRow label="Open amount" value={formatCurrencyFull(Number(p.amount))} />
                        <TooltipRow label="Lines" value={formatNumber(Number(p._n))} />
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
                    ['Overdue by salesperson', overview.data?.bySalesperson, 'Salesperson of the invoice (else the customer of record)'],
                    ['Overdue by team', overview.data?.byTeam, 'Team of the invoice (else the salesperson’s team), Excel org'],
                  ] as const
                ).map(([title, list, info]) => (
                  <ChartPanel
                    key={title}
                    title={title}
                    infoText={info}
                    tableColumns={[{ key: 'label', header: 'Name' }, { key: 'overdueLabel', header: 'Overdue', align: 'right' }, { key: 'pctLabel', header: '% of total', align: 'right' }]}
                    tableRows={(list ?? []).map((g) => ({ ...g, overdueLabel: formatCurrencyFull(g.overdue), pctLabel: g.pctOfOverdue === null ? '—' : `${(g.pctOfOverdue * 100).toFixed(1)}%` }))}
                    getRowId={(r) => r.key}
                    headerActions={
                      (list?.length ?? 0) > 15 ? (
                        <Button variant="ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setShowAllPeople((s) => !s)}>
                          {showAllPeople ? 'Top 15' : `All ${list?.length}`}
                        </Button>
                      ) : null
                    }
                  >
                    {list?.length ? (
                      <GroupedBarChart
                        showTitle={false}
                        points={groupPoints(list, peopleLimit)}
                        bars={[{ key: 'overdue', name: 'Overdue', color: 'var(--ps-color-alert)' }]}
                        valueFormatter={(v) => formatCompactCurrency(v)}
                        tooltipContent={groupTooltip}
                        height={barHeight(Math.min(list.length, peopleLimit ?? list.length))}
                        yAxisWidth={150}
                      />
                    ) : (
                      <NoData />
                    )}
                  </ChartPanel>
                ))}
              </div>

              <ChartPanel title="Trend: open vs overdue" infoText="Open and overdue amounts per snapshot date, with the same filters">
                {trend.error ? (
                  <ErrorState message={trend.error} onRetry={trend.retry} />
                ) : (
                  <>
                    {trendNote ? <p style={note}>{trendNote}</p> : null}
                    <ComboChart
                      showTitle={false}
                      points={trendPoints}
                      bars={[
                        { key: 'open', name: 'Open (net)', color: 'var(--ps-color-accent)' },
                        { key: 'overdue', name: 'Overdue', color: 'var(--ps-color-alert)' },
                      ]}
                      leftAxisFormatter={(v) => formatCompactCurrency(v)}
                      tooltipFormatters={{ open: (v) => formatCurrencyFull(v), overdue: (v) => formatCurrencyFull(v) }}
                      height={280}
                    />
                  </>
                )}
              </ChartPanel>
            </>
          )}

          <section style={{ minWidth: 0 }}>
            <h2 style={h2}>Customer exposure</h2>
            <p style={note}>
              One row per company and customer, sorted by overdue amount. Click a customer to see their open documents. Sales and DSO: the customer’s
              invoiced sales in the {meta.data?.salesWindowDays ?? 90} days up to the snapshot (DSO = open ÷ sales × {meta.data?.salesWindowDays ?? 90}).
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
                fileName={`debt-customer-exposure-${snapshotDate ?? 'latest'}`}
                pageSize={15}
                maxBodyHeight={520}
                onRowClick={(r) => setSelected(r)}
              />
            )}
          </section>

          {selected ? (
            <section ref={drillRef} style={{ minWidth: 0, scrollMarginTop: 16 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
                <h2 style={h2}>
                  Documents of <span dir="auto">{selected.customer}</span> · {selected.company}
                </h2>
                <button type="button" onClick={() => setSelected(null)} style={linkButton}>
                  Close
                </button>
              </div>
              <p style={note}>
                Open {formatCurrencyFull(selected.open)} · overdue {formatCurrencyFull(selected.overdue)}. Each line is aged by its own due date (an
                instalment’s own maturity).
              </p>
              {documents.error ? (
                <ErrorState message={documents.error} onRetry={documents.retry} />
              ) : documents.loading && !documents.data ? (
                <LoadingSkeleton variant="table" />
              ) : (
                <DataGrid<DocumentGridRow>
                  columns={documentColumns}
                  rows={documentRows}
                  getRowId={(r) => r.id}
                  fileName={`debt-documents-${selected.customerKey}-${snapshotDate ?? 'latest'}`}
                  pageSize={20}
                  maxBodyHeight={560}
                />
              )}
            </section>
          ) : null}
        </main>

        <BottomNavBar active="Debt Report" />
      </div>
    </PermissionGuard>
  );
}

type CustomerGridRow = DebtCustomerRow & { id: string; overLimit: 'Yes' | 'No' } & Record<string, unknown>;
type DocumentGridRow = DebtDocumentRow & { id: string; typeLabel: string; deliveryLabel: string } & Record<string, unknown>;

function money<T extends Record<string, unknown>>(key: keyof T & string, header: string): DataGridColumn<T> {
  return { key, header, align: 'right', width: 150, rawValue: (r) => Number(r[key] ?? 0), render: (r) => formatCurrencyFull(Number(r[key] ?? 0)) };
}

const pill: React.CSSProperties = { padding: '6px 12px', fontSize: 12.5 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 440px), 1fr))', gap: 'var(--ps-space-3, 16px)' };
const strip: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 20px', padding: '6px clamp(16px, 3vw, 24px)', fontSize: 12,
  color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)',
};
const note: React.CSSProperties = { margin: '0 0 12px', fontSize: 12, color: 'var(--ps-color-muted-text)' };
const h2: React.CSSProperties = { margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: 'var(--ps-color-text)' };
const linkButton: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--ps-color-accent)', fontWeight: 600, cursor: 'pointer', fontSize: 12 };

function Kpi({ title, ...props }: React.ComponentProps<typeof KpiTile> & { title?: string }) {
  return (
    <div title={title} style={{ display: 'grid', minWidth: 0 }}>
      <KpiTile {...props} />
    </div>
  );
}

function Field({ children, width = 160 }: { children: React.ReactNode; width?: number }) {
  return <div style={{ width, flexShrink: 0, maxWidth: '100%' }}>{children}</div>;
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

function Flag({ text }: { text: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ps-color-alert)', background: 'var(--ps-color-alert-bg)', padding: '2px 8px', borderRadius: 999 }}>{text}</span>
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
