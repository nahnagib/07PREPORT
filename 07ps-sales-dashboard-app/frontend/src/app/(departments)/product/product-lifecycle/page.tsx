'use client';
import React, { useMemo, useState } from 'react';
import { AppHeader } from '../../../../components/AppHeader';
import { BottomNavBar } from '../../../../components/BottomNavBar';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useAuth } from '../../../../lib/AuthProvider';
import {
  Card,
  ChartPanel,
  KpiTile,
  SemanticBadge,
  Select,
  Button,
  TextInput,
  ComboChart,
  DataTable,
  exportRowsAsPdf,
  PerformanceReportTable,
  type SelectOption,
  type Column,
  type PerformanceReportRow,
} from '@07ps/ui';
import {
  FACTS,
  fmtLYD,
  fmtPct,
  sum,
  distinctSorted,
  SEGMENT_COLOR,
  COMPANIES,
  type CompanyFilter,
  type MaterialsAnalogyFact,
} from '../../../../lib/materialsAnalogy/shared';

const SEGMENTS = ['Stars', 'Cash Cows', 'Strategic', 'Dogs', 'Mature', 'Discontinued'] as const;
type SortKey = 'total_value_YTD' | 'months_since_first_sale' | 'months_since_last_supply' | 'value_growth_pct';
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'total_value_YTD', label: 'Value YTD' },
  { value: 'months_since_first_sale', label: 'Months Since First Sale' },
  { value: 'months_since_last_supply', label: 'Months Since Supply' },
  { value: 'value_growth_pct', label: 'vs LYTD' },
];

interface TableRow extends MaterialsAnalogyFact, Record<string, unknown> {
  id: string;
}

// ---------------------------------------------------------------------------
// Executive Summary -- Mature/Discontinued/Freshness KPI tiles have no prior-period comparison in
// this page's data model (point-in-time portfolio counts), so they stay 'neutral', except
// Discontinued which reuses the same 'alert' status its own KpiTile above already uses. The top
// lifecycle-segment rows reuse each segment's own real Value YTD vs Value LYTD for a simple
// green/red read.
// ---------------------------------------------------------------------------

function toExecutiveSummaryRows(
  matureCount: number,
  filteredCount: number,
  discCount: number,
  discValueAtRiskLytd: number,
  freshPct: number,
  newCount: number,
  segEntries: [string, { value: number; valueLY: number; n: number }][],
): PerformanceReportRow[] {
  const rows: PerformanceReportRow[] = [
    {
      id: 'matureSkus',
      metric: 'Mature SKUs',
      actualLabel: String(matureCount),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${matureCount} SKUs (${filteredCount ? ((matureCount / filteredCount) * 100).toFixed(1) : '0'}% of the filtered portfolio) are Mature.`,
    },
    {
      id: 'discontinued',
      metric: 'Discontinued / No Supply',
      actualLabel: String(discCount),
      actualFullValue: fmtLYD(discValueAtRiskLytd),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'alert',
      takeaway: `${discCount} SKUs are discontinued or have no supply, representing ${fmtLYD(discValueAtRiskLytd)} of LYTD value at risk.`,
    },
    {
      id: 'freshness',
      metric: 'Portfolio Freshness',
      actualLabel: `${freshPct.toFixed(1)}%`,
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: null,
      status: 'neutral',
      takeaway: `${freshPct.toFixed(1)}% of the portfolio (${newCount} SKUs) is newly classified this year.`,
    },
  ];

  const topSegments = segEntries.slice(0, 3);
  for (const [label, o] of topSegments) {
    const varianceLy = o.valueLY > 0 ? (o.value - o.valueLY) / o.valueLY : null;
    rows.push({
      id: `segment-${label}`,
      metric: `${label} Segment Value (YTD)`,
      actualLabel: fmtLYD(o.value),
      targetLabel: '—',
      variancePct: null,
      varianceLyPct: varianceLy,
      status: varianceLy == null ? 'neutral' : varianceLy < 0 ? 'alert' : 'success',
      takeaway: `${label} segment is ${fmtLYD(o.value)} YTD across ${o.n} SKUs${varianceLy != null ? ` (${fmtPct(varianceLy * 100)} vs last year)` : ''}.`,
    });
  }

  return rows;
}

export default function ProductLifecyclePage() {
  const { user, logout } = useAuth();
  const roleLabel = user?.role.label ?? user?.fullName;
  const [anchorDate, setAnchorDate] = useState('');

  const [company, setCompany] = useState<CompanyFilter>('All');
  const [category, setCategory] = useState<string[]>([]);
  const [segment, setSegment] = useState<'All' | (typeof SEGMENTS)[number]>('All');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('total_value_YTD');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [limit, setLimit] = useState(20);

  const categoryOptions: SelectOption[] = useMemo(() => {
    const pool = FACTS.filter((r) => company === 'All' || r.Company === company);
    return distinctSorted(pool.map((r) => r.Category)).map((c) => ({ value: c, label: c }));
  }, [company]);

  const filtered = useMemo(
    () =>
      FACTS.filter(
        (r) =>
          (company === 'All' || r.Company === company) &&
          (category.length === 0 || category.includes(r.Category)) &&
          (segment === 'All' || r.lifecycle_segment === segment),
      ),
    [company, category, segment],
  );
  // ---- KPIs ----
  const matureRows = filtered.filter((r) => r.lifecycle_segment === 'Mature');
  const discRows = filtered.filter((r) => r.lifecycle_segment === 'Discontinued');
  const newRows = filtered.filter((r) => r.bcg_movement === 'New');
  const freshPct = filtered.length ? (newRows.length / filtered.length) * 100 : 0;

  // ---- Pareto ----
  const bySeg = new Map<string, { value: number; valueLY: number; n: number }>();
  SEGMENTS.forEach((s) => bySeg.set(s, { value: 0, valueLY: 0, n: 0 }));
  filtered.forEach((r) => {
    const o = bySeg.get(r.lifecycle_segment);
    if (!o) return;
    o.value += r.total_value_YTD;
    o.valueLY += r.total_value_LYTD;
    o.n += 1;
  });
  const segEntries = [...bySeg.entries()].filter(([, o]) => o.n > 0).sort((a, b) => b[1].value - a[1].value);
  const totalValue = segEntries.reduce((a, [, o]) => a + o.value, 0) || 1;
  let cum = 0;
  const paretoPoints = segEntries.map(([label, o]) => {
    cum += o.value;
    return { label, value: o.value, valueLY: o.valueLY, cumPct: (cum / totalValue) * 100 };
  });

  // ---- Table ----
  const searched = search ? filtered.filter((r) => r.ProductName.toLowerCase().includes(search.toLowerCase())) : filtered;
  const sorted: TableRow[] = [...searched]
    .sort((a, b) => sortDir * ((a[sortKey] as number) - (b[sortKey] as number)))
    .map((r) => ({ ...r, id: r.ProductKey }));
  const visibleRows = sorted.slice(0, limit);

  const columns: Column<TableRow>[] = [
    { key: 'ProductName', header: 'Product Name' },
    { key: 'Company', header: 'Company' },
    { key: 'Category', header: 'Category' },
    {
      key: 'bcg_class_YTD',
      header: 'BCG Class',
      render: (row) => <span style={{ color: SEGMENT_COLOR[row.bcg_class_YTD], fontWeight: 700 }}>{row.bcg_class_YTD}</span>,
    },
    {
      key: 'lifecycle_segment',
      header: 'Lifecycle',
      render: (row) =>
        row.is_discontinued ? (
          <SemanticBadge status="alert" />
        ) : row.is_mature ? (
          <span style={{ color: 'var(--ps-color-last-year)', fontWeight: 600 }}>Mature</span>
        ) : (
          <span style={{ color: 'var(--ps-color-muted-text)' }}>Active</span>
        ),
    },
    { key: 'months_since_first_sale', header: 'Mo. Since First Sale', align: 'right' },
    { key: 'months_since_last_supply', header: 'Mo. Since Supply', align: 'right' },
    { key: 'total_value_YTD', header: 'Value YTD', align: 'right', render: (row) => fmtLYD(row.total_value_YTD) },
    {
      key: 'value_growth_pct',
      header: 'vs LYTD',
      align: 'right',
      render: (row) => (
        <span style={{ color: row.value_growth_pct >= 0 ? 'var(--ps-color-success)' : 'var(--ps-color-alert)', fontWeight: 700 }}>
          {fmtPct(row.value_growth_pct)}
        </span>
      ),
    },
  ];

  const handleExportPdf = () =>
    exportRowsAsPdf({
      title: 'Product Lifecycle — Product Detail',
      subtitle: `${company} · sorted by ${SORT_OPTIONS.find((o) => o.value === sortKey)?.label}`,
      columns: [
        { header: 'Product' },
        { header: 'Company' },
        { header: 'BCG Class' },
        { header: 'Lifecycle' },
        { header: 'Value YTD', align: 'right' },
        { header: 'vs LYTD', align: 'right' },
      ],
      rows: sorted.map((r) => [
        r.ProductName,
        r.Company,
        r.bcg_class_YTD,
        r.is_discontinued ? 'Discontinued' : r.is_mature ? 'Mature' : 'Active',
        fmtLYD(r.total_value_YTD),
        fmtPct(r.value_growth_pct),
      ]),
      fileName: 'product-lifecycle-detail',
    });

  return (
    <PermissionGuard pageKey="product_lifecycle">
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', paddingBottom: 64 }}>
        <AppHeader
          pageTitle="Product Dashboard"
          anchorDate={anchorDate}
          onAnchorDateChange={setAnchorDate}
          roleLabel={roleLabel}
          onLogout={logout}
          showDateInput={false}
        />

        <FilterBar
          onReset={() => {
            setCompany('All');
            setCategory([]);
            setSegment('All');
          }}
          isPristine={company === 'All' && category.length === 0 && segment === 'All'}
          showDateRange={false}
          showCompanyDimension={false}
          showTransactionDimensions={false}
          showLastOrderInfo={false}
          extraFields={
            <>
              <PillField label="Company">
                {COMPANIES.map((c) => (
                  <Button key={c} variant={company === c ? 'primary' : 'secondary'} style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => setCompany(c)}>
                    {c}
                  </Button>
                ))}
              </PillField>
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

        <main style={{ flex: 1, padding: 'var(--ps-space-4, 24px)', display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--ps-space-3, 16px)' }}>
            <KpiTile
              label="Mature SKUs"
              value={String(matureRows.length)}
              variance={filtered.length ? `${((matureRows.length / filtered.length) * 100).toFixed(1)}% of filtered portfolio` : undefined}
              status="neutral"
            />
            <KpiTile
              label="Discontinued / No Supply"
              value={String(discRows.length)}
              variance={fmtLYD(sum(discRows, (r) => r.total_value_LYTD)) + ' LYTD value at risk'}
              status="alert"
            />
            <KpiTile label="Portfolio Freshness" value={`${freshPct.toFixed(1)}%`} variance={`${newRows.length} SKUs classified New`} status="neutral" />
          </div>

          <ChartPanel
            title="Segment Value — Pareto"
            infoText="Bars = Value YTD by lifecycle segment (sorted desc) · line = Value LYTD · gold line = cumulative %"
            style={{ minHeight: 420 }}
          >
            <ComboChart
              showTitle={false}
              points={paretoPoints}
              bars={[{ key: 'value', name: 'Value YTD', color: 'var(--ps-color-accent)' }]}
              lines={[
                { key: 'valueLY', name: 'Value LYTD', color: 'var(--ps-color-last-year)', yAxisId: 'left' },
                { key: 'cumPct', name: 'Cumulative %', color: 'var(--ps-color-gold)', yAxisId: 'right' },
              ]}
              rightAxisFormatter={(v) => `${v.toFixed(0)}%`}
              height={360}
            />
          </ChartPanel>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>Product Detail</span>
                <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>Sorted by {SORT_OPTIONS.find((o) => o.value === sortKey)?.label} ({sortDir === -1 ? 'desc' : 'asc'})</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ width: 220 }}>
                  <TextInput placeholder="Search product name…" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(20); }} style={{ marginBottom: 0 }} />
                </div>
                <div style={{ width: 200 }}>
                  <Select
                    label=""
                    options={SORT_OPTIONS}
                    value={[sortKey]}
                    onChange={(v) => setSortKey((v[0] as SortKey) ?? 'total_value_YTD')}
                    placeholder="Sort by"
                  />
                </div>
                <Button variant="secondary" style={{ padding: '8px 12px', fontSize: 12.5 }} onClick={() => setSortDir((d) => (d === -1 ? 1 : -1))}>
                  {sortDir === -1 ? 'Desc' : 'Asc'}
                </Button>
                <button
                  type="button"
                  onClick={handleExportPdf}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--ps-color-muted-text)',
                    background: 'var(--ps-color-muted-bg)',
                    border: '1px solid var(--ps-color-border)',
                    borderRadius: 6,
                    padding: '4px 10px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Export as PDF
                </button>
              </div>
            </div>

            <DataTable columns={columns} rows={visibleRows} getRowId={(row) => row.id} />

            <div style={{ textAlign: 'center', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
              {sorted.length > limit && (
                <Button variant="secondary" style={{ padding: '8px 20px', fontSize: 12 }} onClick={() => setLimit((l) => l + 20)}>
                  Show more
                </Button>
              )}
              <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
                Showing {visibleRows.length} of {sorted.length}
              </span>
            </div>
          </Card>

          <PerformanceReportTable
            title="Performance Details"
            rows={toExecutiveSummaryRows(
              matureRows.length,
              filtered.length,
              discRows.length,
              sum(discRows, (r) => r.total_value_LYTD),
              freshPct,
              newRows.length,
              segEntries,
            )}
            showStatus
            showTakeaway
          />
        </main>

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
