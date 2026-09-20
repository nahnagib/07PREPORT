'use client';
import React, { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Pie, PieChart, ReferenceLine, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import type { CampaignsData } from '../../../lib/marcom/types';
import { fmtCompact, fmtDate, fmtInt, fmtKpiValue, fmtLyd, fmtPct, fmtRatio } from '../../../lib/marcom/format';
import { periodRange } from '../../../lib/marcom/gantt';
import { CATEGORICAL_5, lifecycleColor, RAG_COLOR, SERIES } from '../../../lib/marcom/palette';
import { t } from '../../../lib/marcom/text';
import { ChartBox, MarcomChartCard, Segmented } from '../MarcomChartCard';
import { MarcomKpiCard } from '../MarcomKpiCard';
import { ragLabel } from '../RagBadge';
import { GanttChart, GanttRow } from '../GanttChart';
import { legendText, AXIS_TICK, CHART_MARGIN, Grid, GRID_STROKE, ringLabel, TooltipCard, truncate } from './chartKit';

interface Props { data: CampaignsData; refreshing?: boolean }

const shortType = (s: string) => s.replace(/^\d+-/, '');

/** Page 2 -- Media Campaign Performance (visuals 1-6). */
export function CampaignsView({ data, refreshing }: Props) {
  const [costView, setCostView] = useState<'bars' | 'bubbles'>('bars');
  const { greenAbove, redBelow } = data.roiByCampaign.bands;
  const n = data.spendVsRevenue.length;
  const roiRows = data.roiByCampaign.campaigns.filter((c) => c.roi.value !== null);
  const roiNa = data.roiByCampaign.campaigns.filter((c) => c.roi.value === null).map((c) => c.name);

  const ganttRows: GanttRow[] = data.timeline.map((c) => ({
    id: c.name, label: c.name, sublabel: c.brand, start: c.start, end: c.end, status: c.status, color: lifecycleColor(c.status),
    details: [
      { label: t('gantt.brand'), value: c.brand },
      { label: t('gantt.duration'), value: t('gantt.days', { n: c.durationDays }) },
      { label: t('gantt.spend'), value: fmtLyd(c.spend) },
      { label: t('gantt.revenue'), value: fmtLyd(c.revenue) },
      { label: t('gantt.roi'), value: `${fmtRatio(c.roi)} (${ragLabel(c.roiStatus)})` },
    ],
  }));
  const statuses = data.options.statuses ?? [...new Set(data.timeline.map((c) => c.status))];

  const types = data.coverageByType.types;
  const cost = data.costByType.types;
  const bubbles = cost.filter((c) => c.units > 0 && c.costPerUnit !== null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Grid min={440}>
        {/* 1 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="campaigns.spendVsRevenue" title={t('p2.spendVsRevenue')} refreshing={refreshing} minWidth={Math.max(420, n * 96)}
          summary={data.spendVsRevenue.map((c) => `${c.name}: ${fmtLyd(c.spend)} / ${fmtLyd(c.revenue)}`).join('; ')}
          table={{ caption: t('p2.spendVsRevenue'), columns: [t('generic.brand'), t('gantt.spend'), t('gantt.revenue')], rows: data.spendVsRevenue.map((c) => [c.name, fmtLyd(c.spend), fmtLyd(c.revenue)]) }}
        >
          <ChartBox height={340}>
            {({ width, height }) => (
              <BarChart width={width} height={height} data={data.spendVsRevenue} margin={{ ...CHART_MARGIN, bottom: 60, right: 40 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="name" interval={0} angle={-25} textAnchor="end" height={70} tick={AXIS_TICK} tickFormatter={(v) => truncate(String(v), 14)} />
                <YAxis tick={AXIS_TICK} tickFormatter={fmtCompact} label={{ value: t('unit.lyd'), angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
                <Tooltip content={({ active, payload }) => {
                  const c = active && payload?.length ? (payload[0].payload as (typeof data.spendVsRevenue)[number]) : null;
                  return c ? <TooltipCard title={c.name} lines={[{ label: t('gantt.brand'), value: c.brand }, { label: t('gantt.spend'), value: fmtLyd(c.spend), color: SERIES.primary }, { label: t('gantt.revenue'), value: fmtLyd(c.revenue), color: SERIES.secondary }]} /> : null;
                }} />
                <Legend verticalAlign="top" formatter={legendText} />
                <Bar isAnimationActive={false} dataKey="spend" name={t('gantt.spend')} fill={SERIES.primary} />
                <Bar isAnimationActive={false} dataKey="revenue" name={t('gantt.revenue')} fill={SERIES.secondary} />
              </BarChart>
            )}
          </ChartBox>
        </MarcomChartCard>

        {/* 2 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="campaigns.rate" title={t('p2.rate')} refreshing={refreshing} interactive subtitle={t('p2.rateNote')}
          summary={`${t('p2.rate')} ${fmtKpiValue(data.totals.rate)}; ${t('p2.totalSpend')} ${fmtLyd(data.totals.spend)}; ${t('p2.totalRevenue')} ${fmtLyd(data.totals.revenue)}`}
          table={{ caption: t('p2.rate'), columns: [t('generic.value'), ''], rows: [[t('p2.totalSpend'), fmtLyd(data.totals.spend)], [t('p2.totalRevenue'), fmtLyd(data.totals.revenue)], [t('p2.rate'), fmtKpiValue(data.totals.rate)]] }}
        >
          <MarcomKpiCard
            testId="kpi-rate" label={t('p2.rate')} kpi={data.totals.rate} hideStatus
            hint={<div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 4 }}>
              <div data-testid="rate-spend"><div style={{ fontSize: 11 }}>{t('p2.totalSpend')}</div><strong style={{ color: 'var(--ps-color-text)', fontSize: 15 }}>{fmtLyd(data.totals.spend)}</strong></div>
              <div data-testid="rate-revenue"><div style={{ fontSize: 11 }}>{t('p2.totalRevenue')}</div><strong style={{ color: 'var(--ps-color-text)', fontSize: 15 }}>{fmtLyd(data.totals.revenue)}</strong></div>
            </div>}
          />
        </MarcomChartCard>
      </Grid>

      {/* 3 -------------------------------------------------------------------------------- */}
      <MarcomChartCard
        visual="campaigns.roiByCampaign" title={t('p2.roiByCampaign')} refreshing={refreshing} minWidth={Math.max(480, roiRows.length * 96)}
        empty={roiRows.length === 0 ? true : undefined}
        summary={roiRows.map((c) => `${c.name}: ${fmtRatio(c.roi.value)}, ${ragLabel(c.roi.status)}`).join('; ')}
        table={{ caption: t('p2.roiByCampaign'), columns: [t('generic.brand'), 'ROI', t('generic.status')], rows: data.roiByCampaign.campaigns.map((c) => [c.name, fmtRatio(c.roi.value), ragLabel(c.roi.status)]) }}
        footer={roiNa.length ? t('p2.roiNa', { names: roiNa.join(', ') }) : undefined}
      >
        <ul aria-label={t('gantt.legend')} style={{ display: 'flex', gap: 14, flexWrap: 'wrap', listStyle: 'none', padding: 0, margin: '0 0 8px', fontSize: 12 }}>
          {([['green', t('p2.roiLegendGreen', { v: greenAbove })], ['yellow', t('p2.roiLegendYellow', { lo: redBelow, hi: greenAbove })], ['red', t('p2.roiLegendRed', { v: redBelow })]] as const).map(([s, label]) => (
            <li key={s} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
              <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 3, background: RAG_COLOR[s], display: 'inline-block' }} />
              {ragLabel(s)}: {label}
            </li>
          ))}
        </ul>
        <ChartBox height={320}>
          {({ width, height }) => (
            <BarChart width={width} height={height} data={roiRows.map((c) => ({ name: c.name, brand: c.brand, value: c.roi.value, status: c.roi.status }))} margin={{ ...CHART_MARGIN, bottom: 60, right: 72 }}>
              <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
              <XAxis dataKey="name" interval={0} angle={-25} textAnchor="end" height={70} tick={AXIS_TICK} tickFormatter={(v) => truncate(String(v), 14)} />
              <YAxis tick={AXIS_TICK} tickFormatter={(v) => fmtRatio(v as number)} label={{ value: '1 : X', angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
              <Tooltip content={({ active, payload }) => {
                const c = active && payload?.length ? (payload[0].payload as { name: string; brand: string; value: number; status: 'green' | 'yellow' | 'red' }) : null;
                return c ? <TooltipCard title={c.name} lines={[{ label: t('gantt.brand'), value: c.brand }, { label: 'ROI', value: fmtRatio(c.value), color: RAG_COLOR[c.status] }, { label: t('generic.status'), value: ragLabel(c.status) }]} /> : null;
              }} />
              <ReferenceLine y={greenAbove} stroke={RAG_COLOR.green} strokeDasharray="6 4" label={{ value: fmtRatio(greenAbove), fill: SERIES.text, fontSize: 11, position: 'right' }} />
              <ReferenceLine y={redBelow} stroke={RAG_COLOR.red} strokeDasharray="6 4" label={{ value: fmtRatio(redBelow), fill: SERIES.text, fontSize: 11, position: 'right' }} />
              <Bar isAnimationActive={false} dataKey="value" name="ROI">
                {roiRows.map((c) => <Cell key={c.name} fill={RAG_COLOR[c.roi.status]} />)}
                <LabelList dataKey="value" position="top" formatter={(v: number) => fmtRatio(v)} style={{ fontSize: 11, fill: 'var(--ps-color-text)' }} />
              </Bar>
            </BarChart>
          )}
        </ChartBox>
      </MarcomChartCard>

      {/* 4 -------------------------------------------------------------------------------- */}
      <MarcomChartCard
        visual="campaigns.timeline" title={t('p2.timeline')} refreshing={refreshing} interactive
        empty={data.timeline.length === 0 ? true : undefined}
        summary={data.timeline.map((c) => `${c.name} ${fmtDate(c.start)} – ${fmtDate(c.end)} (${c.status})`).join('; ')}
        table={{ caption: t('p2.timeline'), columns: [t('generic.brand'), t('gantt.from'), t('gantt.to'), t('generic.status'), t('gantt.spend'), t('gantt.revenue'), 'ROI'], rows: data.timeline.map((c) => [c.name, fmtDate(c.start), fmtDate(c.end), c.status, fmtLyd(c.spend), fmtLyd(c.revenue), fmtRatio(c.roi)]) }}
      >
        <GanttChart rows={ganttRows} range={periodRange(data.period)} today={data.today} ariaLabel={t('p2.timeline')} legend={statuses.map((s) => ({ label: s, color: lifecycleColor(s) }))} />
      </MarcomChartCard>

      <Grid min={440}>
        {/* 5 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="campaigns.coverage" title={t('p2.coverage')} refreshing={refreshing}
          summary={types.map((x) => `${shortType(x.mediaType)} ${fmtInt(x.units)}`).join(', ')}
          table={{ caption: t('p2.coverage'), columns: [t('generic.brand'), t('unit.units'), '%'], rows: types.map((x) => [shortType(x.mediaType), fmtInt(x.units), fmtPct(x.share)]) }}
        >
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 240, height: 240, flex: 'none' }}>
              <ChartBox height={240}>
                {({ width, height }) => (
                  <PieChart width={Math.min(width, 240)} height={height}>
                    <Pie isAnimationActive={false} data={types.map((x) => ({ name: shortType(x.mediaType), value: x.units, share: x.share }))} dataKey="value" nameKey="name" innerRadius={62} outerRadius={104} paddingAngle={types.filter((x) => x.units > 0).length > 1 ? 2 : 0} stroke="var(--ps-color-surface)"
                      label={(p) => ringLabel(p, (v) => fmtPct(v, 0))} labelLine={false}>
                      {types.map((x, i) => <Cell key={x.mediaType} fill={CATEGORICAL_5[i % CATEGORICAL_5.length]} />)}
                    </Pie>
                    <Tooltip content={({ active, payload }) => active && payload?.length ? <TooltipCard title={String(payload[0].name)} lines={[{ label: t('unit.units'), value: fmtInt(payload[0].value as number) }, { label: '%', value: fmtPct((payload[0].payload as { share: number | null }).share) }]} /> : null} />
                  </PieChart>
                )}
              </ChartBox>
              <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <strong data-testid="coverage-total" style={{ fontSize: 24 }}>{fmtInt(data.coverageByType.totalUnits)}</strong>
                <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>{t('p2.coverageCentre')}</span>
              </div>
            </div>
            <ul aria-label={t('gantt.legend')} style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, flex: 1, minWidth: 180 }}>
              {types.map((x, i) => (
                <li key={x.mediaType} data-testid="coverage-legend" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 3, background: CATEGORICAL_5[i % CATEGORICAL_5.length], flex: 'none' }} />
                  <span style={{ flex: 1 }}>{shortType(x.mediaType)}</span>
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtInt(x.units)}</strong>
                  <span style={{ color: 'var(--ps-color-muted-text)', minWidth: 44, textAlign: 'end' }}>{fmtPct(x.share)}</span>
                </li>
              ))}
            </ul>
          </div>
        </MarcomChartCard>

        {/* 6 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="campaigns.costByType" title={t('p2.cost')} refreshing={refreshing} minWidth={420}
          actions={<Segmented value={costView} onChange={setCostView} label={t('p2.cost')} options={[{ value: 'bars', label: t('p2.costBars') }, { value: 'bubbles', label: t('p2.costBubbles') }]} />}
          summary={cost.map((x) => `${shortType(x.mediaType)} ${fmtLyd(x.cost)}`).join(', ')}
          table={{ caption: t('p2.cost'), columns: [t('generic.brand'), t('unit.lyd'), t('p2.costUnits'), t('p2.costPerUnit')], rows: cost.map((x) => [shortType(x.mediaType), fmtLyd(x.cost), fmtInt(x.units), fmtLyd(x.costPerUnit)]) }}
          footer={costView === 'bubbles' && bubbles.length < cost.length ? `${t('generic.na')}: ${cost.filter((c) => !(c.units > 0)).map((c) => shortType(c.mediaType)).join(', ')}` : undefined}
        >
          <ChartBox height={320}>
            {({ width, height }) => costView === 'bars' ? (
              <BarChart width={width} height={height} data={cost.map((x) => ({ name: shortType(x.mediaType), cost: x.cost, units: x.units, cpu: x.costPerUnit }))} margin={CHART_MARGIN}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={AXIS_TICK} interval={0} />
                <YAxis tick={AXIS_TICK} tickFormatter={fmtCompact} label={{ value: t('unit.lyd'), angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
                <Tooltip content={({ active, payload }) => {
                  const c = active && payload?.length ? (payload[0].payload as { name: string; cost: number; units: number; cpu: number | null }) : null;
                  return c ? <TooltipCard title={c.name} lines={[{ label: t('unit.lyd'), value: fmtLyd(c.cost) }, { label: t('p2.costUnits'), value: fmtInt(c.units) }, { label: t('p2.costPerUnit'), value: fmtLyd(c.cpu) }]} /> : null;
                }} />
                <Bar isAnimationActive={false} dataKey="cost" name={t('unit.lyd')}>
                  {cost.map((x, i) => <Cell key={x.mediaType} fill={CATEGORICAL_5[i % CATEGORICAL_5.length]} />)}
                  <LabelList dataKey="cost" position="top" formatter={(v: number) => fmtCompact(v)} style={{ fontSize: 11, fill: 'var(--ps-color-text)' }} />
                </Bar>
              </BarChart>
            ) : (
              <ScatterChart width={width} height={height} margin={{ ...CHART_MARGIN, right: 40 }}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis type="number" dataKey="units" name={t('p2.costUnits')} tick={AXIS_TICK} label={{ value: t('p2.costUnits'), position: 'insideBottom', offset: -2, fill: SERIES.text, fontSize: 11 }} />
                <YAxis type="number" dataKey="cost" name={t('unit.lyd')} tick={AXIS_TICK} tickFormatter={fmtCompact} label={{ value: t('unit.lyd'), angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
                <ZAxis type="number" dataKey="cpu" range={[120, 900]} name={t('p2.costPerUnit')} />
                <Tooltip content={({ active, payload }) => {
                  const c = active && payload?.length ? (payload[0].payload as { name: string; cost: number; units: number; cpu: number }) : null;
                  return c ? <TooltipCard title={c.name} lines={[{ label: t('p2.costUnits'), value: fmtInt(c.units) }, { label: t('unit.lyd'), value: fmtLyd(c.cost) }, { label: t('p2.costPerUnit'), value: fmtLyd(c.cpu) }]} /> : null;
                }} />
                <Scatter isAnimationActive={false} name={t('p2.cost')} data={bubbles.map((x) => ({ name: shortType(x.mediaType), cost: x.cost, units: x.units, cpu: x.costPerUnit }))} fill={SERIES.primary} fillOpacity={0.6}>
                  {bubbles.map((x, i) => <Cell key={x.mediaType} fill={CATEGORICAL_5[cost.indexOf(x) % CATEGORICAL_5.length]} />)}
                  <LabelList dataKey="name" position="top" style={{ fontSize: 11, fill: 'var(--ps-color-text)' }} />
                </Scatter>
              </ScatterChart>
            )}
          </ChartBox>
        </MarcomChartCard>
      </Grid>
    </div>
  );
}
