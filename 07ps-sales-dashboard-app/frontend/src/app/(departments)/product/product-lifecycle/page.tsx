'use client';
import { vh } from '../../../../lib/visualHelp';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useProductFilters } from '../../../../components/product/useProductFilters';
import { ValidationStatusBar } from '../../../../components/ValidationStatusBar';
import { RefreshFooter } from '../../../../components/RefreshFooter';
import { formatTimestamp } from '../../../../lib/format';
import { useAuth } from '../../../../lib/AuthProvider';
import { useProductDashboard, useRefreshStatus } from '../../../../lib/hooks';
import { PeriodNote } from '../../../../components/product/PeriodNote';
import {
  Card,
  ChartPanel,
  KpiTile,
  Select,
  Button,
  ComboChart,
  DataGrid,
  LoadingSkeleton,
  ErrorState,
  VisualInfoIcons,
  chartTooltipProps,
  type SelectOption,
  type DataGridColumn,
} from '@07ps/ui';
import {
  toProductFacts,
  fmtLYD,
  fmtNum,
  fmtPct,
  fmtDate,
  fmtUnits,
  fmtVolume,
  sum,
  distinctSorted,
  SEGMENT_COLOR,
  LIFECYCLE_SEGMENTS,
  type ProductFact,
} from '../../../../lib/materialsAnalogy/shared';
import { ProductName } from '../../../../components/product/ProductUi';
import { freshnessByCompany, freshnessTargets, inSentence, lifecycleConfig, maturePct, portfolioFreshness, segmentDefinitions, type CompanyFreshness } from '../../../../lib/product/lifecycle';

const SEGMENTS = LIFECYCLE_SEGMENTS;
interface TableRow extends ProductFact, Record<string, unknown> {
  /** Volume of the period vs the prior period, %; null = nothing sold before. */
  growth: number | null;
}

export default function ProductLifecyclePage() {
  const { user, token, error: authError, retryAuth, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const refresh = useRefreshStatus(token, authError, retryAuth);
  const { anchorDate, onAnchorDateChange, scope, companyLabel, filterBarProps, withLocalReset } = useProductFilters(refresh.data);

  // Company view (one company) or all companies side by side; a product is always one Odoo product in one company.
  const overview = useProductDashboard(token, authError, retryAuth, 'product-lifecycle', scope);
  const facts = useMemo(() => toProductFacts(overview.data), [overview.data]);
  const [category, setCategory] = useState<string[]>([]);
  const [segment, setSegment] = useState<'All' | (typeof SEGMENTS)[number]>('All');

  const categoryOptions: SelectOption[] = useMemo(
    () => distinctSorted(facts.map((r) => r.Category)).map((c) => ({ value: c, label: c })),
    [facts],
  );

  const filtered = useMemo(
    () =>
      facts.filter(
        (r) => (category.length === 0 || (r.Category !== null && category.includes(r.Category))) && (segment === 'All' || r.lifecycle === segment),
      ),
    [facts, category, segment],
  );
  // ---- KPIs (segments computed by the API for the Date filter's period vs the prior period: measures/productLifecycle.ts) ----
  const matureRows = filtered.filter((r) => r.lifecycle === 'Mature');
  const discRows = filtered.filter((r) => r.lifecycle === 'Discontinued');
  // Portfolio Freshness (2026-11-15): Active + Non Active only (lib/product/lifecycle.ts portfolioFreshness)
  const fresh = portfolioFreshness(filtered);
  // Freshness vs each company's own target (2026-11-15, backend config/productTargets.ts): never one blended number
  const freshByCompany = freshnessByCompany(filtered, freshnessTargets(overview.data?.thresholds));
  const lc = lifecycleConfig(overview.data?.thresholds, overview.data?.lifecycleBenchmark);
  const segDef = segmentDefinitions(lc);
  // The benchmark in every label: "Last 12 months" / "Prior 12 months" (or the dates of a custom range)
  const periodLabel = lc.label;
  const priorText = inSentence(lc.priorLabel);
  const unitsLabel = `Units sold (${periodLabel})`;
  const withFormula = (entry: ReturnType<typeof vh>, formula: string) => (entry.help ? { ...entry.help, formula } : undefined);
  const kpiHelp = {
    mature: withFormula(vh('product.productLifecycle.kpiMature'), `Units ${inSentence(segDef.Mature)} of the ${priorText} · % = Mature ÷ portfolio`),
    discontinued: withFormula(vh('product.productLifecycle.kpiDiscontinued'), `${segDef.Discontinued} · sub-line = units sold in the ${priorText}`),
    pareto: withFormula(vh('product.productLifecycle.pareto'),
      `New ≤ ${lc.newDays} d · Growing / Declining = units ${inSentence(periodLabel)} vs the ${priorText} ±${lc.growthPct}% · Discontinued = no sale in ${lc.noSalesDays} d`),
    freshness: withFormula(vh('product.productLifecycle.kpiFreshness'),
      `Freshness = SKUs first sold ≤ ${lc.newDays} d ÷ (Active + Non Active), per company · On Track at or above the company target${
        freshByCompany.some((c) => c.target !== null) ? ` (${freshByCompany.filter((c) => c.target !== null).map((c) => `${c.company} ≥ ${c.target}%`).join(', ')})` : ''}`),
  };

  // ---- Pareto on volume: units sold in the period per lifecycle segment (added up as Unit), the same period last year,
  // and the cumulative share of the units ----
  const bySeg = new Map<string, { units: number; unitsLY: number; n: number }>();
  SEGMENTS.forEach((s) => bySeg.set(s, { units: 0, unitsLY: 0, n: 0 }));
  filtered.forEach((r) => {
    const o = bySeg.get(r.lifecycle);
    if (!o) return;
    o.units += r.volume;
    o.unitsLY += r.volumePrior;
    o.n += 1;
  });
  const segEntries = [...bySeg.entries()].filter(([, o]) => o.n > 0).sort((a, b) => b[1].units - a[1].units);
  const totalUnits = segEntries.reduce((a, [, o]) => a + Math.max(0, o.units), 0) || 1;
  let cum = 0;
  const paretoPoints = segEntries.map(([label, o]) => {
    cum += Math.max(0, o.units);
    return { label, skus: o.n, units: o.units, unitsLY: o.unitsLY, cumPct: (cum / totalUnits) * 100 };
  });
  // The hover (2026-11-16): the segment, its SKUs (the same rows the bar adds up), then the three series
  const paretoTooltip = ({ active, label }: { active?: boolean; label?: unknown }) => {
    const p = active ? paretoPoints.find((x) => x.label === label) : undefined;
    if (!p) return null;
    const rows: [string, string, string][] = [
      ['SKUs', p.skus.toLocaleString('en-US'), 'var(--ps-tooltip-fg)'],
      [unitsLabel, fmtNum(p.units), 'var(--ps-color-accent)'],
      [lc.priorLabel, fmtNum(p.unitsLY), 'var(--ps-color-last-year)'],
      ['Cumulative %', `${p.cumPct.toFixed(0)}%`, 'var(--ps-color-gold)'],
    ];
    return (
      <div style={chartTooltipProps.contentStyle} data-testid="pareto-tooltip">
        <div style={chartTooltipProps.labelStyle}>{p.label}</div>
        {rows.map(([name, value, color]) => (
          <div key={name} style={{ ...chartTooltipProps.itemStyle, color }}>{name} : {value}</div>
        ))}
      </div>
    );
  };

  // ---- Product Detail: the app's standard grid (sort, search, column filters, pinning, paging, CSV / Excel / PDF,
  // copy), volume first, highest volume first ----
  const tableRows: TableRow[] = filtered
    .map((r) => ({ ...r, growth: r.volumePrior > 0 ? ((r.volume - r.volumePrior) / r.volumePrior) * 100 : null }))
    .sort((a, b) => b.volume - a.volume);
  const columns: DataGridColumn<TableRow>[] = [
    { key: 'ProductName', header: 'Product Name', width: 260, render: (row) => <ProductName name={row.ProductName} href={row.odooUrl} />, rawValue: (row) => row.ProductName },
    { key: 'volume', header: `Volume (${periodLabel})`, align: 'right', render: (row) => <strong>{fmtVolume(row)}</strong>, rawValue: (row) => row.volume },
    {
      key: 'growth',
      header: `Volume vs ${priorText}`,
      align: 'right',
      rawValue: (row) => (row.growth === null ? '' : Math.round(row.growth * 10) / 10),
      sortValue: (row) => row.growth ?? Number.NEGATIVE_INFINITY,
      render: (row) =>
        row.growth === null ? (
          <span style={{ color: 'var(--ps-color-muted-text)' }}>—</span>
        ) : (
          <span style={{ color: row.growth >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', fontWeight: 700 }}>{fmtPct(row.growth)}</span>
        ),
    },
    { key: 'Company', header: 'Company', rawValue: (row) => row.Company },
    { key: 'Category', header: 'Category', render: (row) => <ProductName name={row.Category ?? '—'} />, rawValue: (row) => row.Category ?? '' },
    { key: 'lifecycle', header: 'Lifecycle', render: (row) => <span style={{ color: SEGMENT_COLOR[row.lifecycle], fontWeight: 700 }}>{row.lifecycle}</span>, rawValue: (row) => row.lifecycle },
    { key: 'firstSaleDate', header: 'First Sale', align: 'right', render: (row) => fmtDate(row.firstSaleDate), rawValue: (row) => row.firstSaleDate ?? '' },
    {
      key: 'daysSinceLastSale',
      header: 'Days Since Last Sale',
      align: 'right',
      render: (row) => (row.daysSinceLastSale === null ? 'never sold' : String(row.daysSinceLastSale)),
      rawValue: (row) => (row.daysSinceLastSale === null ? 'never sold' : row.daysSinceLastSale),
      sortValue: (row) => row.daysSinceLastSale ?? Number.POSITIVE_INFINITY,
    },
    { key: 'value', header: `Value (${periodLabel})`, align: 'right', render: (row) => fmtLYD(row.value), rawValue: (row) => row.value },
  ];

  return (
    <PermissionGuard pageKey="product_lifecycle">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar
          {...filterBarProps}
          {...withLocalReset(() => {
            setCategory([]);
            setSegment('All');
          }, category.length === 0 && segment === 'All')}
          secondRow={
            <>
              <div style={{ width: 200 }}>
                <Select label="Category" options={categoryOptions} value={category} onChange={setCategory} multiSelect searchable placeholder="All Categories" />
              </div>
              <PillField label="Lifecycle Segment">
                {(['All', ...SEGMENTS] as const).map((s) => (
                  <Button key={s} variant={segment === s ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setSegment(s)}>
                    {s}
                  </Button>
                ))}
              </PillField>
            </>
          }
        />

        <ValidationStatusBar
          isStale={refresh.data?.isStale}
          isInverted={refresh.data?.isInverted}
          refreshCheck={refresh.data?.refreshCheck}
          lastRefreshTime={refresh.data ? formatTimestamp(refresh.data.lastRefreshTime) : undefined}
        />

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>

          <PeriodNote period={overview.data?.period} />
          {overview.loading && !overview.data ? (
            <LoadingSkeleton variant="chart" />
          ) : overview.error ? (
            <ErrorState message={overview.error} onRetry={overview.retry} />
          ) : (
          <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
            <KpiTile
              label="Mature SKUs"
              value={String(matureRows.length)}
              variance={(() => { const pct = maturePct(filtered); return pct === null ? undefined : `${pct.toFixed(1)}% of portfolio`; })()}
              status="neutral"
              help={kpiHelp.mature}
            />
            <KpiTile
              label="Discontinued"
              value={String(discRows.length)}
              variance={`${fmtUnits(sum(discRows, (r) => r.volumePrior))} sold in the ${priorText}`}
              status="alert"
              help={kpiHelp.discontinued}
            />
            <FreshnessCard companies={freshByCompany} fallback={fresh} help={kpiHelp.freshness} />
          </div>

          <ChartPanel {...vh("product.productLifecycle.pareto")}
            help={kpiHelp.pareto}
            title={`Segment Volume — Pareto · ${periodLabel} vs ${priorText}`}
            style={{ minHeight: 420 }}
          >
            <ComboChart
              showTitle={false}
              points={paretoPoints}
              bars={[{ key: 'units', name: unitsLabel, color: 'var(--ps-color-accent)' }]}
              leftAxisFormatter={(v) => fmtNum(v)}
              lines={[
                { key: 'unitsLY', name: lc.priorLabel, color: 'var(--ps-color-last-year)', yAxisId: 'left' },
                { key: 'cumPct', name: 'Cumulative %', color: 'var(--ps-color-gold)', yAxisId: 'right' },
              ]}
              rightAxisFormatter={(v) => `${v.toFixed(0)}%`}
              tooltipContent={paretoTooltip}
              height={360}
            />
            <dl data-testid="lifecycle-segment-definitions" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: '6px 16px', margin: '12px 0 0', fontSize: 12 }}>
              {SEGMENTS.map((s) => (
                <div key={s} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <dt style={{ fontWeight: 700, color: SEGMENT_COLOR[s], whiteSpace: 'nowrap' }}>{s}</dt>
                  <dd style={{ margin: 0, color: 'var(--ps-color-muted-text)' }}>{segDef[s]}</dd>
                </div>
              ))}
            </dl>
          </ChartPanel>

          <Card>
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>
                Product Detail <VisualInfoIcons title="Product Detail" {...vh('product.productLifecycle.productDetail')} />
              </span>
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>Highest volume first</div>
            </div>
            <div data-testid="lifecycle-product-grid">
              <DataGrid key={`${periodLabel}|${lc.priorLabel}`} columns={columns} rows={tableRows} getRowId={(row) => row.id} fileName="product-lifecycle-detail" filtersSummary={`${companyLabel} · Lifecycle: ${periodLabel} vs ${priorText}`} />
            </div>
          </Card>

          </>
          )}
        </main>

        <RefreshFooter
          lastUpdate={formatTimestamp(refresh.data?.lastUpdate ?? null)}
          lastOrderCreated={formatTimestamp(refresh.data?.lastOrderCreated ?? null)}
          lastRefreshTime={formatTimestamp(refresh.data?.lastRefreshTime ?? null)}
        />
        <BottomNavBar active="Product Lifecycle" />
      </div>
    </PermissionGuard>
  );
}

/** Same FilterBar.extraFields pill-field wrapper duplicated across every Materials Analogy page
 * (see bcg-matrix/page.tsx) -- matches FilterBar's own field-label/height conventions so a
 * page-specific pill group sits flush with the built-in Select fields in the same row. */
function PillField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>{label}</span>
      <div style={{ display: 'flex', gap: 6, height: 38, alignItems: 'center' }}>{children}</div>
    </div>
  );
}

/** Portfolio Freshness (2026-11-15): one company = its % against its target with On Track / Below Target; "All" = one
 * line per company against its own target ("Tika 8.1% / 10% · Majaal 22.4% / 20%"), never a blended number. */
function FreshnessCard({ companies, fallback, help }: {
  companies: CompanyFreshness[]; fallback: ReturnType<typeof portfolioFreshness>; help: React.ComponentProps<typeof KpiTile>['help'];
}) {
  const pill = (c: CompanyFreshness) => c.onTrack === null ? null : (
    <span data-testid={`freshness-status-${c.company}`} style={{ fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 999, whiteSpace: 'nowrap',
      color: c.onTrack ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', border: `1px solid ${c.onTrack ? 'var(--ps-color-success)' : 'var(--ps-color-alert)'}` }}>
      {c.onTrack ? 'On Track' : 'Below Target'}
    </span>
  );
  if (companies.length === 1) {
    const c = companies[0];
    return (
      <KpiTile label="Portfolio Freshness" value={`${c.pct.toFixed(1)}%`}
        variance={`${c.target !== null ? `Target ≥ ${c.target}% · ${c.onTrack ? 'On Track' : 'Below Target'} · ` : ''}${c.fresh} new of ${c.portfolio} SKUs`}
        status={c.onTrack === null ? 'neutral' : c.onTrack ? 'success' : 'alert'} help={help} />
    );
  }
  if (companies.length === 0) {
    return <KpiTile label="Portfolio Freshness" value={`${fallback.pct.toFixed(1)}%`} status="neutral" help={help} />;
  }
  return (
    <Card data-testid="freshness-by-company" role="group" aria-label="Portfolio Freshness" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
        Portfolio Freshness {help && <VisualInfoIcons title="Portfolio Freshness" help={help} size={13} />}
      </div>
      {companies.map((c) => (
        <div key={c.company} data-testid={`freshness-${c.company}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 56 }}>{c.company}</span>
          <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
            color: c.onTrack === null ? 'var(--ps-color-text)' : c.onTrack ? 'var(--ps-color-success)' : 'var(--ps-color-alert)' }}>
            {c.pct.toFixed(1)}%
          </span>
          {c.target !== null && <span style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>/ {c.target}%</span>}
          {pill(c)}
        </div>
      ))}
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
        {companies.map((c) => `${c.company} ${c.fresh} new of ${c.portfolio}`).join(' · ')}
      </div>
    </Card>
  );
}
