'use client';
import React, { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import type { SpendingData, Status } from '../../../lib/marcom/types';
import { fmtCompact, fmtInt, fmtKpiValue, fmtLyd, fmtPct, fmtSignedPct, monthName } from '../../../lib/marcom/format';
import { RAG_COLOR, SERIES } from '../../../lib/marcom/palette';
import { t } from '../../../lib/marcom/text';
import { ChartBox, MarcomChartCard, Segmented } from '../MarcomChartCard';
import { MarcomKpiCard } from '../MarcomKpiCard';
import { RagBadge, ragLabel } from '../RagBadge';
import { legendText, AXIS_TICK, CHART_MARGIN, Grid, GRID_STROKE, plainKpi, TooltipCard, truncate } from './chartKit';

interface Props { data: SpendingData; refreshing?: boolean }

type GroupBy = 'brand' | 'company';

/** One bar row of the Budget / Growth cards, whichever level (brand or company) is shown. */
interface LevelRow { key: string; label: string; sub: string | null; value: number | null }

const BUDGET_COLOR = 'var(--ps-color-trend-target)';
const PCT_COLOR = '#009E73';

/** Two-line category tick: name, and the company underneath (brand view). */
function NameTick({ x, y, payload, rows }: { x?: number; y?: number; payload?: { value: string }; rows: LevelRow[] }) {
  const r = rows.find((row) => row.key === payload?.value);
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fontSize={11} fill="var(--ps-color-text)">{truncate(r?.label ?? '', 16)}</text>
      {r?.sub && <text x={0} y={0} dy={26} textAnchor="middle" fontSize={10} fill="var(--ps-color-muted-text)">{truncate(r.sub, 18)}</text>}
    </g>
  );
}

function SideTick({ x, y, payload, rows }: { x?: number; y?: number; payload?: { value: string }; rows: LevelRow[] }) {
  const r = rows.find((row) => row.key === payload?.value);
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text x={-6} y={r?.sub ? -2 : 4} textAnchor="end" fontSize={11} fill="var(--ps-color-text)">{truncate(r?.label ?? '', 18)}</text>
      {r?.sub && <text x={-6} y={11} textAnchor="end" fontSize={10} fill="var(--ps-color-muted-text)">{truncate(r.sub, 20)}</text>}
    </g>
  );
}

/** Page 1 -- MARCOM Spending. Pure rendering of GET /marcom/kpi/spending. */
export function SpendingView({ data, refreshing }: Props) {
  const [overlay, setOverlay] = useState(false);
  const [budgetBy, setBudgetBy] = useState<GroupBy>('brand');
  const [growthBy, setGrowthBy] = useState<GroupBy>('brand');
  const months = data.totals.spend.series.map((s) => s.month);
  const tot = data.totals;

  // ---- 1. spend vs revenue (+ target budget, spend % of revenue) ----------------------------
  const flow = months.map((m, i) => ({
    label: monthName(m),
    spend: tot.spend.series[i].value,
    revenue: tot.revenueAttributed.series[i].value,
    budget: tot.budget.series[i]?.value ?? null,
    pct: tot.spendPctOfRevenue.series[i]?.value ?? null,
    company: tot.companyRevenue.series[i].value,
  }));

  // ---- 3/4. per brand or per company -------------------------------------------------------
  const budgetSrc = budgetBy === 'brand'
    ? data.budgetUtilization.brands.map((b) => ({ key: `b${b.brandId}`, label: b.brand, sub: b.company ?? null, ...b }))
    : data.budgetUtilization.companies.map((c) => ({ key: `c${c.companyKey ?? 'none'}`, label: c.company, sub: null, ...c }));
  const budgetRows = budgetSrc.filter((b) => b.value !== null);
  const budgetNa = budgetSrc.filter((b) => b.value === null).map((b) => b.label);
  const budgetMax = Math.ceil(Math.max(120, ...budgetRows.map((b) => (b.value ?? 0) * 1.15)) / 20) * 20;

  const growthSrc = growthBy === 'brand'
    ? data.brandGrowth.brands.map((b) => ({ key: `b${b.brandId}`, label: b.brand, sub: b.company ?? null, ...b }))
    : data.brandGrowth.companies.map((c) => ({ key: `c${c.companyKey ?? 'none'}`, label: c.company, sub: null, ...c }));
  const growthRows = growthSrc.filter((b) => b.value !== null);

  const groupToggle = (value: GroupBy, onChange: (v: GroupBy) => void) => (
    <Segmented label={t('p1.groupBy')} value={value} onChange={onChange} options={[{ value: 'brand', label: t('p1.byBrand') }, { value: 'company', label: t('p1.byCompany') }]} />
  );
  const levelHeader = (by: GroupBy) => (by === 'brand' ? t('generic.brand') : t('filter.company'));

  // ---- 5. CAC ------------------------------------------------------------------------------
  const cacBands = data.cac.bands;
  const cacScaleMax = Math.max(cacBands.redAbove * 1.6, ...data.cac.brands.map((b) => (b.pctOfInvoice.value ?? 0) * 1.1));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1 ------------------------------------------------------------------------------ */}
      <MarcomChartCard
        visual="spending.spendVsRevenue" title={t('p1.spendVsRevenue')} refreshing={refreshing} minWidth={Math.max(520, months.length * 70)}
        summary={`${t('p1.spend')} ${fmtLyd(tot.spend.total)}, ${t('p1.revenue')} ${fmtLyd(tot.revenueAttributed.total)}, ${t('p1.budgetTarget')} ${fmtLyd(tot.budget.total)}, ${t('p1.spendPct')} ${fmtKpiValue(tot.spendPctOfRevenue)}`}
        table={{
          caption: t('p1.spendVsRevenue'),
          columns: [t('generic.month'), t('p1.spend'), t('p1.revenue'), t('p1.budgetTarget'), t('p1.spendPct'), t('p1.companyRevenue')],
          rows: flow.map((r) => [r.label, fmtLyd(r.spend), fmtLyd(r.revenue), fmtLyd(r.budget), fmtPct(r.pct), fmtLyd(r.company)]),
        }}
        actions={<label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />{t('p1.showCompany')}</label>}
      >
        <Grid min={320} gap={12}>
          <MarcomKpiCard
            testId="kpi-spend" label={t('p1.spend')} kpi={plainKpi('lyd', tot.spend.total)} valueText={fmtLyd(tot.spend.total)} hideStatus sparkline={flow.map((r) => r.spend)}
            hint={
              <SecondaryStat testId="kpi-budget" label={t('p1.budgetTarget')} value={fmtLyd(tot.budget.total)}
                note={<span data-testid="budget-used">{t('p1.budgetUsed', { v: fmtKpiValue(tot.budgetUsed) })}</span>}
                meter={tot.budgetUsed.value} />
            }
          />
          <MarcomKpiCard
            testId="kpi-revenue" label={t('p1.revenue')} kpi={plainKpi('lyd', tot.revenueAttributed.total)} valueText={fmtLyd(tot.revenueAttributed.total)} hideStatus sparkline={flow.map((r) => r.revenue)}
            hint={
              <>
                <span>{t('p1.revenueSub')}</span>
                <SecondaryStat testId="kpi-spend-pct" label={t('p1.spendPct')} value={fmtKpiValue(tot.spendPctOfRevenue)}
                  note={<span data-testid="spend-pct-company">{t('p1.spendPctCompany', { v: fmtKpiValue(tot.spendPctOfCompanyRevenue) })}</span>} />
              </>
            }
          />
        </Grid>
        <div style={{ marginTop: 12 }}>
          <ChartBox height={320}>
            {({ width, height }) => (
              <ComposedChart width={width} height={height} data={flow} margin={{ ...CHART_MARGIN, right: 8 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={AXIS_TICK} />
                <YAxis yAxisId="lyd" tick={AXIS_TICK} tickFormatter={fmtCompact} label={{ value: t('unit.lyd'), angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
                <YAxis yAxisId="pct" orientation="right" tick={AXIS_TICK} tickFormatter={(v) => `${Math.round(Number(v))}%`} label={{ value: t('p1.pctAxis'), angle: 90, position: 'insideRight', fill: SERIES.text, fontSize: 11 }} />
                <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                  <TooltipCard title={label} lines={payload.map((p) => ({ label: String(p.name), value: p.dataKey === 'pct' ? fmtPct(p.value as number) : fmtLyd(p.value as number), color: String(p.color) }))} />
                ) : null} />
                <Legend formatter={legendText} />
                <Bar yAxisId="lyd" isAnimationActive={false} dataKey="spend" name={t('p1.spend')} fill={SERIES.primary} radius={[3, 3, 0, 0]} />
                <Bar yAxisId="lyd" isAnimationActive={false} dataKey="revenue" name={t('p1.revenue')} fill={SERIES.secondary} radius={[3, 3, 0, 0]} />
                <Line yAxisId="lyd" isAnimationActive={false} dataKey="budget" name={t('p1.budgetTarget')} stroke={BUDGET_COLOR} strokeWidth={2} strokeDasharray="6 4" dot={{ r: 3 }} connectNulls />
                <Line yAxisId="pct" isAnimationActive={false} dataKey="pct" name={t('p1.spendPct')} stroke={PCT_COLOR} strokeWidth={2} dot={{ r: 3 }} />
                {overlay && <Line yAxisId="lyd" isAnimationActive={false} dataKey="company" name={t('p1.companyRevenue')} stroke={SERIES.reference} strokeWidth={2} dot={{ r: 3 }} />}
              </ComposedChart>
            )}
          </ChartBox>
        </div>
      </MarcomChartCard>

      <Grid min={440}>
        {/* 3 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="spending.budgetUtilization" title={t('p1.budget')} refreshing={refreshing}
          actions={groupToggle(budgetBy, setBudgetBy)}
          empty={budgetRows.length === 0 ? true : undefined}
          summary={budgetRows.map((b) => `${b.label} ${fmtPct(b.value)}${b.overBudget ? ` ${t('generic.overBudget')}` : ''}`).join(', ')}
          table={{
            caption: t('p1.budget'),
            columns: budgetBy === 'brand' ? [t('generic.brand'), t('filter.company'), '%', t('p1.spend'), t('p1.budgetTarget'), t('generic.status')] : [t('filter.company'), '%', t('p1.spend'), t('p1.budgetTarget'), t('generic.status')],
            rows: budgetSrc.map((b) => [...(budgetBy === 'brand' ? [b.label, b.sub ?? '—'] : [b.label]), fmtPct(b.value), fmtLyd(b.spend), fmtLyd(b.budget), b.overBudget ? t('generic.overBudget') : '—']),
          }}
          footer={budgetNa.length ? `${t('generic.na')}: ${budgetNa.join(', ')}` : undefined}
        >
          <ChartBox height={Math.max(200, budgetRows.length * 56 + 60)}>
            {({ width, height }) => (
              <BarChart layout="vertical" width={width} height={height} data={budgetRows} margin={{ ...CHART_MARGIN, top: 24, right: 120 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, budgetMax]} tick={AXIS_TICK} tickFormatter={(v) => `${Math.round(Number(v))}%`} />
                <YAxis type="category" dataKey="key" width={120} tick={(p: { x?: number; y?: number; payload?: { value: string } }) => <SideTick {...p} rows={budgetRows} />} />
                <Tooltip content={({ active, payload }) => {
                  const b = active && payload?.length ? (payload[0].payload as (typeof budgetRows)[number]) : null;
                  return b ? <TooltipCard title={b.sub ? `${b.label} · ${b.sub}` : b.label} lines={[{ label: '%', value: fmtPct(b.value) }, { label: '', value: t('p1.budgetTip', { spent: fmtLyd(b.spend), budget: fmtLyd(b.budget) }) }, ...(b.overBudget ? [{ label: '', value: t('generic.overBudget') }] : [])]} /> : null;
                }} />
                <ReferenceLine x={100} stroke={SERIES.highlight} strokeDasharray="6 4" label={{ value: t('p1.budgetLine'), fill: SERIES.text, fontSize: 11, position: 'top' }} />
                <Bar isAnimationActive={false} dataKey="value" fill={SERIES.primary} radius={[0, 4, 4, 0]}>
                  <LabelList dataKey="value" content={(p) => {
                    const b = budgetRows[p.index as number];
                    if (!b) return null;
                    const x = (Number(p.x) || 0) + (Number(p.width) || 0) + 6;
                    return <text x={x} y={(Number(p.y) || 0) + (Number(p.height) || 0) / 2 + 4} fontSize={11} fill="var(--ps-color-text)" fontWeight={b.overBudget ? 700 : 400}>{fmtPct(b.value)}{b.overBudget ? ` ⚠ ${t('generic.overBudget')}` : ''}</text>;
                  }} />
                </Bar>
              </BarChart>
            )}
          </ChartBox>
        </MarcomChartCard>

        {/* 4 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="spending.brandGrowth" title={t('p1.growth')} refreshing={refreshing} minWidth={Math.max(360, growthRows.length * 90)}
          actions={groupToggle(growthBy, setGrowthBy)}
          empty={growthRows.length === 0 ? true : undefined}
          summary={growthRows.map((b) => `${b.label} ${fmtSignedPct(b.value)}`).join(', ')}
          table={{
            caption: t('p1.growth'),
            columns: [levelHeader(growthBy), ...(growthBy === 'brand' ? [t('filter.company')] : []), '%', 'Current', 'Last year'],
            rows: growthSrc.map((b) => [b.label, ...(growthBy === 'brand' ? [b.sub ?? '—'] : []), fmtSignedPct(b.value), fmtLyd(b.revenueCurrent), fmtLyd(b.revenueLastYear)]),
          }}
        >
          <ChartBox height={290}>
            {({ width, height }) => (
              <BarChart width={width} height={height} data={growthRows} margin={{ ...CHART_MARGIN, bottom: 16 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="key" interval={0} height={growthBy === 'brand' ? 40 : 24} tick={(p: { x?: number; y?: number; payload?: { value: string } }) => <NameTick {...p} rows={growthRows} />} />
                {/* headroom below/above the bars so the signed labels never collide with the axis text */}
                <YAxis tick={AXIS_TICK} domain={[(min: number) => Math.min(0, Math.floor(min * 1.5)), (max: number) => Math.max(0, Math.ceil(max * 1.2))]} tickFormatter={(v) => `${Math.round(Number(v))}%`} label={{ value: '%', angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
                <Tooltip content={({ active, payload }) => {
                  const b = active && payload?.length ? (payload[0].payload as (typeof growthRows)[number]) : null;
                  return b ? <TooltipCard title={b.sub ? `${b.label} · ${b.sub}` : b.label} lines={[{ label: '%', value: fmtSignedPct(b.value) }, { label: '', value: t('p1.growthTip', { cur: fmtLyd(b.revenueCurrent), ly: fmtLyd(b.revenueLastYear) }) }]} /> : null;
                }} />
                <ReferenceLine y={0} stroke={SERIES.text} />
                <Bar isAnimationActive={false} dataKey="value" name="%" radius={[3, 3, 0, 0]}>
                  {growthRows.map((b) => <Cell key={b.key} fill={(b.value ?? 0) >= 0 ? SERIES.primary : SERIES.secondary} />)}
                  <LabelList dataKey="value" position="top" formatter={(v: number) => `${v >= 0 ? '▲' : '▼'} ${fmtSignedPct(v)}`} style={{ fontSize: 11, fill: 'var(--ps-color-text)' }} />
                </Bar>
              </BarChart>
            )}
          </ChartBox>
        </MarcomChartCard>
      </Grid>

      <Grid min={440}>
        {/* 5 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="spending.cac" title={t('p1.cac')} refreshing={refreshing} interactive
          summary={`CAC ${fmtKpiValue(data.cac.overall)}, ${t('p1.cacInvoice')} ${fmtKpiValue(data.cac.overall.pctOfInvoice)}, ${ragLabel(data.cac.overall.status)}`}
          table={{ caption: t('p1.cac'), columns: [t('generic.brand'), t('filter.company'), 'CAC', t('p1.cacInvoice'), t('p1.cacNewCustomers'), t('generic.status')], rows: data.cac.brands.map((b) => [b.brand, b.company ?? '—', fmtKpiValue(b), fmtKpiValue(b.pctOfInvoice), fmtInt(b.newCustomers), ragLabel(b.pctOfInvoice.status)]) }}
          footer={t('p1.cacScale', { g: cacBands.greenAtMost, y: cacBands.redAbove })}
        >
          <CacHeadline overall={data.cac.overall} />
          <ul aria-label={t('p1.cac')} style={{ listStyle: 'none', padding: 0, margin: '14px 0 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.cac.brands.map((b) => {
              const v = b.pctOfInvoice.value;
              const status: Status = b.pctOfInvoice.status;
              return (
                <li key={b.brandId} data-testid="cac-row" data-status={status} title={`${b.brand}: ${fmtKpiValue(b)} — ${fmtKpiValue(b.pctOfInvoice)} (${ragLabel(status)})`}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 1.1fr) 2fr 56px 84px', gap: 10, alignItems: 'center', fontSize: 13 }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.brand}</span>
                    {b.company && <span style={{ display: 'block', fontSize: 11, color: 'var(--ps-color-muted-text)' }}>{b.company}</span>}
                  </span>
                  <span aria-hidden="true" style={{ position: 'relative', height: 8, borderRadius: 999, background: 'var(--ps-color-muted-bg)' }}>
                    <span style={{ position: 'absolute', insetInlineStart: 0, top: 0, bottom: 0, borderRadius: 999, width: `${v === null ? 0 : Math.max(2, Math.min(100, (v / cacScaleMax) * 100))}%`, background: RAG_COLOR[status] }} />
                    {[cacBands.greenAtMost, cacBands.redAbove].map((tick) => (
                      <span key={tick} style={{ position: 'absolute', top: -3, bottom: -3, width: 1, insetInlineStart: `${(tick / cacScaleMax) * 100}%`, background: 'var(--ps-color-muted-text)', opacity: 0.45 }} />
                    ))}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'end', fontWeight: 600 }}>{fmtKpiValue(b.pctOfInvoice)}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'end', color: 'var(--ps-color-muted-text)' }}>{fmtKpiValue(b)}</span>
                </li>
              );
            })}
          </ul>
        </MarcomChartCard>

        {/* 6 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="spending.cpc" title={t('p1.cpc')} refreshing={refreshing} interactive
          summary={`CPC ${fmtKpiValue(data.cpc.overall)}, ${ragLabel(data.cpc.overall.status)}`}
          table={{ caption: t('p1.cpcPerBrand'), columns: [t('generic.brand'), 'CPC', t('generic.status')], rows: data.cpc.brands.map((b) => [b.brand, fmtKpiValue(b), ragLabel(b.status)]) }}
        >
          <MarcomKpiCard testId="kpi-cpc" label="CPC" kpi={data.cpc.overall} />
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={t('p1.cpcPerBrand')}>
            {(() => {
              const max = Math.max(0, ...data.cpc.brands.map((b) => b.value ?? 0));
              return data.cpc.brands.map((b) => (
                <li key={b.brandId} data-testid="cpc-row" data-status={b.status} title={`${b.brand}: ${fmtKpiValue(b)} — ${ragLabel(b.status)}`} style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto auto', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <span>{b.brand}</span>
                  <span aria-hidden="true" style={{ background: 'var(--ps-color-muted-bg)', borderRadius: 4, height: 12, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: `${max > 0 && b.value !== null ? Math.max(2, (b.value / max) * 100) : 0}%`, background: RAG_COLOR[b.status] }} />
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtKpiValue(b)}</span>
                  <RagBadge status={b.status} size="sm" />
                </li>
              ));
            })()}
          </ul>
        </MarcomChartCard>
      </Grid>
    </div>
  );
}

/**
 * Second figure inside a KPI box (Budget under Total Spend, Spend % of Revenue under Total Revenue):
 * label + value on one line, a small note, and an optional "% used" meter (over 100% shows full, in the alert colour).
 */
function SecondaryStat({ label, value, note, meter, testId }: { label: string; value: string; note?: React.ReactNode; meter?: number | null; testId?: string }) {
  return (
    <div data-testid={testId} style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--ps-color-border)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>{label}</div>
      {/* The second figure reads as a real number, not a footnote: large, full text colour, its own line. */}
      <div data-testid="secondary-value" style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.15, marginTop: 2, color: 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {meter !== undefined && meter !== null && (
        <span aria-hidden="true" style={{ display: 'block', height: 5, borderRadius: 999, background: 'var(--ps-color-muted-bg)', marginTop: 6, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, meter))}%`, borderRadius: 999, background: meter > 100 ? 'var(--ps-color-alert)' : 'var(--ps-color-accent)' }} />
        </span>
      )}
      {note && <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{note}</div>}
    </div>
  );
}

/** CAC headline: the LYD figure large with its status, and the three numbers behind it. */
function CacHeadline({ overall }: { overall: SpendingData['cac']['overall'] }) {
  const stat = (label: string, value: string, testId?: string) => (
    <div data-testid={testId} style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
    </div>
  );
  return (
    <div data-testid="kpi-cac" data-status={overall.status} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 24 }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', textTransform: 'uppercase', letterSpacing: 0.4 }}>CAC</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
          <span style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{fmtKpiValue(overall)}</span>
          <RagBadge status={overall.status} size="sm" />
        </div>
      </div>
      {stat(t('p1.cacInvoice'), fmtKpiValue(overall.pctOfInvoice), 'cac-pct')}
      {stat(t('p1.cacNewCustomers'), fmtInt(overall.newCustomers))}
      {stat(t('p1.cacAvgInvoice'), fmtLyd(overall.weightedAvgInvoice))}
    </div>
  );
}
