'use client';
import React, { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import type { SpendingData, Status } from '../../../lib/marcom/types';
import { fmtCompact, fmtKpiValue, fmtLyd, fmtPct, fmtRatio, fmtSignedPct, monthName } from '../../../lib/marcom/format';
import { RAG_COLOR, SERIES } from '../../../lib/marcom/palette';
import { t } from '../../../lib/marcom/text';
import { ChartBox, MarcomChartCard } from '../MarcomChartCard';
import { MarcomKpiCard } from '../MarcomKpiCard';
import { RagBadge, ragLabel } from '../RagBadge';
import { legendText, AXIS_TICK, CHART_MARGIN, Grid, GRID_STROKE, plainKpi, TooltipCard } from './chartKit';

interface Props { data: SpendingData; refreshing?: boolean }

const th: React.CSSProperties = { textAlign: 'start', padding: '6px 8px', fontSize: 12, color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)' };
const td: React.CSSProperties = { padding: '6px 8px', fontSize: 13, borderBottom: '1px solid var(--ps-color-border)', fontVariantNumeric: 'tabular-nums' };

/** Page 1 -- MARCOM Spending (visuals 1-6). Pure rendering of GET /marcom/kpi/spending. */
export function SpendingView({ data, refreshing }: Props) {
  const [overlay, setOverlay] = useState(false);
  const noLastYear = data.meta.missing.includes('lastYearData');
  const months = data.totals.spend.series.map((s) => s.month);

  // ---- 1. spend vs revenue -----------------------------------------------------------------
  const flow = months.map((m, i) => ({
    label: monthName(m),
    spend: data.totals.spend.series[i].value,
    revenue: data.totals.revenueAttributed.series[i].value,
    company: data.totals.companyRevenue.series[i].value,
  }));

  // ---- 2. ROI trend ------------------------------------------------------------------------
  const roiRows = data.roi.monthly.map((m) => ({ label: monthName(m.month), current: m.current, lastYear: noLastYear ? null : m.lastYear, status: m.currentStatus }));
  const { greenAbove, redBelow } = data.roi.bands;

  // ---- 3/4. per brand ----------------------------------------------------------------------
  const budgetRows = data.budgetUtilization.brands.filter((b) => b.value !== null);
  const budgetNa = data.budgetUtilization.brands.filter((b) => b.value === null).map((b) => b.brand);
  const budgetMax = Math.ceil(Math.max(120, ...budgetRows.map((b) => (b.value ?? 0) * 1.15)) / 20) * 20;
  const growthRows = data.brandGrowth.brands.filter((b) => b.value !== null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1 ------------------------------------------------------------------------------ */}
      <MarcomChartCard
        visual="spending.spendVsRevenue" title={t('p1.spendVsRevenue')} refreshing={refreshing} minWidth={Math.max(480, months.length * 70)}
        summary={`${t('p1.spend')} ${fmtLyd(data.totals.spend.total)}, ${t('p1.revenue')} ${fmtLyd(data.totals.revenueAttributed.total)}`}
        table={{ caption: t('p1.spendVsRevenue'), columns: [t('generic.month'), t('p1.spend'), t('p1.revenue'), t('p1.companyRevenue')], rows: flow.map((r) => [r.label, fmtLyd(r.spend), fmtLyd(r.revenue), fmtLyd(r.company)]) }}
        actions={<label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />{t('p1.showCompany')}</label>}
      >
        <Grid min={220} gap={12}>
          <MarcomKpiCard testId="kpi-spend" label={t('p1.spend')} kpi={plainKpi('lyd', data.totals.spend.total)} valueText={fmtLyd(data.totals.spend.total)} hideStatus sparkline={flow.map((r) => r.spend)} />
          <MarcomKpiCard testId="kpi-revenue" label={t('p1.revenue')} kpi={plainKpi('lyd', data.totals.revenueAttributed.total)} valueText={fmtLyd(data.totals.revenueAttributed.total)} hideStatus sparkline={flow.map((r) => r.revenue)} />
        </Grid>
        <div style={{ marginTop: 12 }}>
          <ChartBox height={300}>
            {({ width, height }) => (
              <ComposedChart width={width} height={height} data={flow} margin={CHART_MARGIN}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={AXIS_TICK} />
                <YAxis tick={AXIS_TICK} tickFormatter={fmtCompact} label={{ value: t('unit.lyd'), angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
                <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                  <TooltipCard title={label} lines={payload.map((p) => ({ label: String(p.name), value: fmtLyd(p.value as number), color: String(p.color) }))} />
                ) : null} />
                <Legend formatter={legendText} />
                <Bar isAnimationActive={false} dataKey="spend" name={t('p1.spend')} fill={SERIES.primary} />
                <Bar isAnimationActive={false} dataKey="revenue" name={t('p1.revenue')} fill={SERIES.secondary} />
                {overlay && <Line isAnimationActive={false} dataKey="company" name={t('p1.companyRevenue')} stroke={SERIES.reference} strokeWidth={2} dot={{ r: 3 }} />}
              </ComposedChart>
            )}
          </ChartBox>
        </div>
      </MarcomChartCard>

      {/* 2 ------------------------------------------------------------------------------ */}
      <MarcomChartCard
        visual="spending.roiTrend" title={t('p1.roiTrend')} refreshing={refreshing} minWidth={Math.max(480, months.length * 70)}
        summary={`${t('p1.roiYtd')} ${fmtKpiValue(data.roi.ytd)}, ${ragLabel(data.roi.ytd.status)}${data.roi.lytd ? `, ${t('p1.roiLytd')} ${fmtKpiValue(data.roi.lytd)}` : `, ${t('state.noLastYear')}`}`}
        table={{ caption: t('p1.roiTrend'), columns: [t('generic.month'), t('p1.roiCurrent'), t('generic.status'), t('p1.roiLastYear')], rows: roiRows.map((r) => [r.label, fmtRatio(r.current), ragLabel(r.status), noLastYear ? t('generic.na') : fmtRatio(r.lastYear)]) }}
        footer={<>{t('p1.roiBandGreen', { v: greenAbove })} · {t('p1.roiBandRed', { v: redBelow })}</>}
      >
        <Grid min={240} gap={12}>
          <MarcomKpiCard testId="kpi-roi-ytd" label={t('p1.roiYtd')} kpi={data.roi.ytd} sparkline={roiRows.map((r) => r.current)} hint={data.roi.lytd ? <span data-testid="roi-lytd">{t('p1.roiLytd')}: <strong>{fmtKpiValue(data.roi.lytd)}</strong> <RagBadge status={data.roi.lytd.status} size="sm" /></span> : undefined} />
          {!data.roi.lytd && (
            <div data-testid="no-last-year" style={{ border: '1px dashed var(--ps-color-border)', borderRadius: 10, padding: 14, fontSize: 13 }}>
              <strong>{t('state.noLastYear')}</strong>
              <div style={{ color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{t('state.noLastYearHint')}</div>
            </div>
          )}
        </Grid>
        <div style={{ marginTop: 12 }}>
          <ChartBox height={300}>
            {({ width, height }) => (
              <LineChart width={width} height={height} data={roiRows} margin={{ ...CHART_MARGIN, right: 64 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={AXIS_TICK} />
                <YAxis tick={AXIS_TICK} tickFormatter={(v) => fmtRatio(v as number)} label={{ value: '1 : X', angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
                <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                  <TooltipCard title={label} lines={payload.map((p) => ({ label: String(p.name), value: fmtRatio(p.value as number), color: String(p.color) }))} />
                ) : null} />
                <Legend formatter={legendText} />
                <ReferenceLine y={greenAbove} stroke={RAG_COLOR.green} strokeDasharray="6 4" label={{ value: fmtRatio(greenAbove), fill: SERIES.text, fontSize: 11, position: 'right' }} />
                <ReferenceLine y={redBelow} stroke={RAG_COLOR.red} strokeDasharray="6 4" label={{ value: fmtRatio(redBelow), fill: SERIES.text, fontSize: 11, position: 'right' }} />
                <Line isAnimationActive={false} dataKey="current" name={t('p1.roiCurrent')} stroke={SERIES.primary} strokeWidth={2}
                  dot={(p: { cx?: number; cy?: number; payload?: { status: Status }; index?: number }) => (
                    <circle key={p.index} cx={p.cx} cy={p.cy} r={5} fill={RAG_COLOR[p.payload?.status ?? 'na']} stroke="var(--ps-color-surface)" strokeWidth={1.5} />
                  )} />
                {!noLastYear && <Line isAnimationActive={false} dataKey="lastYear" name={t('p1.roiLastYear')} stroke={SERIES.reference} strokeWidth={2} strokeDasharray="2 3" dot={{ r: 3 }} />}
              </LineChart>
            )}
          </ChartBox>
        </div>
      </MarcomChartCard>

      <Grid min={440}>
        {/* 3 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="spending.budgetUtilization" title={t('p1.budget')} refreshing={refreshing}
          empty={budgetRows.length === 0 ? true : undefined}
          summary={budgetRows.map((b) => `${b.brand} ${fmtPct(b.value)}${b.overBudget ? ` ${t('generic.overBudget')}` : ''}`).join(', ')}
          table={{ caption: t('p1.budget'), columns: [t('generic.brand'), '%', t('p1.spend'), 'Budget', t('generic.status')], rows: data.budgetUtilization.brands.map((b) => [b.brand, fmtPct(b.value), fmtLyd(b.spend), fmtLyd(b.budget), b.overBudget ? t('generic.overBudget') : '—']) }}
          footer={budgetNa.length ? `${t('generic.na')}: ${budgetNa.join(', ')}` : undefined}
        >
          <ChartBox height={Math.max(200, budgetRows.length * 56 + 60)}>
            {({ width, height }) => (
              <BarChart layout="vertical" width={width} height={height} data={budgetRows} margin={{ ...CHART_MARGIN, right: 120 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" domain={[0, budgetMax]} tick={AXIS_TICK} tickFormatter={(v) => `${Math.round(Number(v))}%`} />
                <YAxis type="category" dataKey="brand" tick={AXIS_TICK} width={90} />
                <Tooltip content={({ active, payload }) => {
                  const b = active && payload?.length ? (payload[0].payload as (typeof budgetRows)[number]) : null;
                  return b ? <TooltipCard title={b.brand} lines={[{ label: '%', value: fmtPct(b.value) }, { label: '', value: t('p1.budgetTip', { spent: fmtLyd(b.spend), budget: fmtLyd(b.budget) }) }, ...(b.overBudget ? [{ label: '', value: t('generic.overBudget') }] : [])]} /> : null;
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
          empty={growthRows.length === 0 ? true : undefined}
          summary={growthRows.map((b) => `${b.brand} ${fmtSignedPct(b.value)}`).join(', ')}
          table={{ caption: t('p1.growth'), columns: [t('generic.brand'), '%', 'Current', 'Last year'], rows: data.brandGrowth.brands.map((b) => [b.brand, fmtSignedPct(b.value), fmtLyd(b.revenueCurrent), fmtLyd(b.revenueLastYear)]) }}
        >
          <ChartBox height={280}>
            {({ width, height }) => (
              <BarChart width={width} height={height} data={growthRows} margin={CHART_MARGIN}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="brand" tick={AXIS_TICK} />
                {/* headroom below/above the bars so the signed labels never collide with the axis text */}
                <YAxis tick={AXIS_TICK} domain={[(min: number) => Math.min(0, Math.floor(min * 1.5)), (max: number) => Math.max(0, Math.ceil(max * 1.2))]} tickFormatter={(v) => `${Math.round(Number(v))}%`} label={{ value: '%', angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
                <Tooltip content={({ active, payload }) => {
                  const b = active && payload?.length ? (payload[0].payload as (typeof growthRows)[number]) : null;
                  return b ? <TooltipCard title={b.brand} lines={[{ label: '%', value: fmtSignedPct(b.value) }, { label: '', value: t('p1.growthTip', { cur: fmtLyd(b.revenueCurrent), ly: fmtLyd(b.revenueLastYear) }) }]} /> : null;
                }} />
                <ReferenceLine y={0} stroke={SERIES.text} />
                <Bar isAnimationActive={false} dataKey="value" name="%">
                  {growthRows.map((b) => <Cell key={b.brandId} fill={(b.value ?? 0) >= 0 ? SERIES.primary : SERIES.secondary} />)}
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
          table={{ caption: t('p1.cac'), columns: [t('generic.brand'), 'CAC', t('p1.cacInvoice'), t('generic.status')], rows: data.cac.brands.map((b) => [b.brand, fmtKpiValue(b), fmtKpiValue(b.pctOfInvoice), ragLabel(b.pctOfInvoice.status)]) }}
        >
          <MarcomKpiCard testId="kpi-cac" label="CAC" kpi={data.cac.overall} hint={<span data-testid="cac-pct">{t('p1.cacPct', { v: fmtKpiValue(data.cac.overall.pctOfInvoice) })}</span>} />
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }} aria-label={t('p1.cac')}>
            <thead><tr><th style={th}>{t('generic.brand')}</th><th style={th}>CAC</th><th style={th}>{t('p1.cacInvoice')}</th><th style={th}>{t('generic.status')}</th></tr></thead>
            <tbody>
              {data.cac.brands.map((b) => (
                <tr key={b.brandId} data-testid="cac-row">
                  <td style={td}>{b.brand}</td><td style={td}>{fmtKpiValue(b)}</td><td style={td}>{fmtKpiValue(b.pctOfInvoice)}</td>
                  <td style={td}><RagBadge status={b.pctOfInvoice.status} size="sm" /></td>
                </tr>
              ))}
            </tbody>
          </table>
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
