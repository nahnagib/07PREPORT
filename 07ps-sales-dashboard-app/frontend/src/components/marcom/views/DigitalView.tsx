'use client';
import React, { useState } from 'react';
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { DigitalData, Kpi } from '../../../lib/marcom/types';
import { fmtCompact, fmtInt, fmtKpiValue, fmtPct, minutesLong, monthName, monthYear } from '../../../lib/marcom/format';
import { CATEGORICAL_5, SERIES } from '../../../lib/marcom/palette';
import { t } from '../../../lib/marcom/text';
import { ChartBox, MarcomChartCard, Segmented } from '../MarcomChartCard';
import { MarcomKpiCard } from '../MarcomKpiCard';
import { ragLabel } from '../RagBadge';
import { legendText, AXIS_TICK, CHART_MARGIN, Grid, GRID_STROKE, TooltipCard } from './chartKit';

interface Props { data: DigitalData; refreshing?: boolean }

function KpiWithPlatforms({ visual, title, overall, byPlatform, refreshing, testId }: { visual: string; title: string; overall: Kpi; byPlatform: { platform: string; kpi: Kpi }[]; refreshing?: boolean; testId: string }) {
  return (
    <MarcomChartCard
      visual={visual} title={title} refreshing={refreshing} interactive
      summary={`${t('p3.overall')} ${fmtKpiValue(overall)}, ${ragLabel(overall.status)}; ${byPlatform.map((p) => `${p.platform} ${fmtKpiValue(p.kpi)} ${ragLabel(p.kpi.status)}`).join('; ')}`}
      table={{ caption: title, columns: [t('generic.platform'), t('generic.value'), t('generic.status')], rows: [[t('p3.overall'), fmtKpiValue(overall), ragLabel(overall.status)], ...byPlatform.map((p) => [p.platform, fmtKpiValue(p.kpi), ragLabel(p.kpi.status)])] }}
    >
      <MarcomKpiCard testId={testId} label={`${title} — ${t('p3.overall')}`} kpi={overall} />
      <div style={{ marginTop: 10 }}>
        <Grid min={150} gap={10}>
          {byPlatform.map((p) => <MarcomKpiCard key={p.platform} testId={`${testId}-${p.platform}`} label={p.platform} kpi={p.kpi} size="sm" />)}
        </Grid>
      </div>
    </MarcomChartCard>
  );
}

/** Page 3 -- Digital Performance (visuals 1-6). */
export function DigitalView({ data, refreshing }: Props) {
  const [stacked, setStacked] = useState(true);
  const plats = data.followers.platforms;
  const asOfKeys = new Set(plats.filter((p) => p.asOf).map((p) => `${p.asOf!.year}-${p.asOf!.month}`));
  const showAsOf = asOfKeys.size > 1;
  const pieData = plats.map((p) => ({ name: p.platform, value: p.value ?? 0 }));
  const hasFollowers = plats.some((p) => p.value !== null);

  const combo = data.engagementMonthly.map((m) => ({ label: monthName(m.month), paid: m.paid, organic: m.organic, share: m.organicShare }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Grid min={440}>
        {/* 1 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="digital.followers" title={t('p3.followers')} refreshing={refreshing}
          empty={hasFollowers ? undefined : true}
          subtitle={data.followers.metaTotal !== null ? <span data-testid="meta-total">{t('p3.metaTotal', { v: fmtInt(data.followers.metaTotal) })}</span> : undefined}
          summary={`${plats.map((p) => `${p.platform} ${fmtInt(p.value)}`).join(', ')}; ${t('generic.total')} ${fmtInt(data.followers.total)}`}
          table={{ caption: t('p3.followers'), columns: [t('generic.platform'), t('generic.value'), t('generic.asOfHeader')], rows: plats.map((p) => [p.platform, fmtInt(p.value), p.asOf ? monthYear(p.asOf.year, p.asOf.month) : t('generic.na')]) }}
        >
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 240, height: 240, flex: 'none' }}>
              <ChartBox height={240}>
                {({ width, height }) => (
                  <PieChart width={Math.min(width, 240)} height={height}>
                    <Pie isAnimationActive={false} data={pieData} dataKey="value" nameKey="name" innerRadius={62} outerRadius={104} paddingAngle={2} stroke="var(--ps-color-surface)">
                      {pieData.map((p, i) => <Cell key={p.name} fill={CATEGORICAL_5[i % CATEGORICAL_5.length]} />)}
                    </Pie>
                    <Tooltip content={({ active, payload }) => active && payload?.length ? <TooltipCard title={String(payload[0].name)} lines={[{ label: t('generic.value'), value: fmtInt(payload[0].value as number) }]} /> : null} />
                  </PieChart>
                )}
              </ChartBox>
              <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <strong data-testid="followers-total" style={{ fontSize: 22 }}>{fmtInt(data.followers.total)}</strong>
                <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>{t('generic.total')}</span>
              </div>
            </div>
            <ul aria-label={t('gantt.legend')} style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, flex: 1, minWidth: 190 }}>
              {plats.map((p, i) => (
                <li key={p.platform} data-testid="followers-legend" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 3, background: CATEGORICAL_5[i % CATEGORICAL_5.length], flex: 'none' }} />
                  <span style={{ flex: 1 }}>{p.platform}{showAsOf && p.asOf ? <em style={{ color: 'var(--ps-color-muted-text)', fontStyle: 'normal', fontSize: 11.5 }}> · {t('generic.asOf', { period: monthYear(p.asOf.year, p.asOf.month) })}</em> : null}</span>
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtInt(p.value)}</strong>
                </li>
              ))}
            </ul>
          </div>
        </MarcomChartCard>

        <KpiWithPlatforms visual="digital.ctr" title={t('p3.ctr')} overall={data.ctr.overall} byPlatform={data.ctr.byPlatform} refreshing={refreshing} testId="kpi-ctr" />
        <KpiWithPlatforms visual="digital.engagementRate" title={t('p3.engagement')} overall={data.engagementRate.overall} byPlatform={data.engagementRate.byPlatform} refreshing={refreshing} testId="kpi-er" />
      </Grid>

      {/* 4 -------------------------------------------------------------------------------- */}
      <MarcomChartCard
        visual="digital.organicVsPaid" title={t('p3.organicVsPaid')} refreshing={refreshing} minWidth={Math.max(480, combo.length * 70)}
        actions={<Segmented value={stacked ? 'stacked' : 'grouped'} onChange={(v) => setStacked(v === 'stacked')} label={t('p3.organicVsPaid')} options={[{ value: 'stacked', label: t('p3.stacked') }, { value: 'grouped', label: t('p3.grouped') }]} />}
        summary={data.engagementMonthly.map((m) => `${monthName(m.month)}: ${t('p3.paid')} ${fmtInt(m.paid)}, ${t('p3.organic')} ${fmtInt(m.organic)}, ${fmtPct(m.organicShare)}`).join('; ')}
        table={{ caption: t('p3.organicVsPaid'), columns: [t('generic.month'), t('p3.paid'), t('p3.organic'), t('p3.organicShare')], rows: data.engagementMonthly.map((m) => [monthName(m.month), fmtInt(m.paid), fmtInt(m.organic), fmtPct(m.organicShare)]) }}
      >
        <ChartBox height={320}>
          {({ width, height }) => (
            <ComposedChart width={width} height={height} data={combo} margin={{ ...CHART_MARGIN, right: 24 }}>
              <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={AXIS_TICK} />
              <YAxis yAxisId="count" tick={AXIS_TICK} tickFormatter={fmtCompact} label={{ value: t('p3.paid') + ' / ' + t('p3.organic'), angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
              <YAxis yAxisId="share" orientation="right" tick={AXIS_TICK} tickFormatter={(v) => `${v}%`} domain={[0, 100]} label={{ value: t('p3.organicShare') + ' %', angle: 90, position: 'insideRight', fill: SERIES.text, fontSize: 11 }} />
              <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                <TooltipCard title={label} lines={payload.map((p) => ({ label: String(p.name), value: p.dataKey === 'share' ? fmtPct(p.value as number) : fmtInt(p.value as number), color: String(p.color) }))} />
              ) : null} />
              <Legend formatter={legendText} />
              <Bar isAnimationActive={false} yAxisId="count" dataKey="paid" name={t('p3.paid')} fill={SERIES.primary} stackId={stacked ? 'e' : undefined} />
              <Bar isAnimationActive={false} yAxisId="count" dataKey="organic" name={t('p3.organic')} fill={SERIES.secondary} stackId={stacked ? 'e' : undefined} />
              <Line isAnimationActive={false} yAxisId="share" dataKey="share" name={t('p3.organicShare')} stroke={SERIES.highlight} strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          )}
        </ChartBox>
      </MarcomChartCard>

      <Grid min={440}>
        {/* 5 ---------------------------------------------------------------------------- */}
        <MarcomChartCard
          visual="digital.bounceRate" title={t('p3.bounce')} refreshing={refreshing} interactive subtitle={t('p3.bounceNote')}
          summary={`${t('p3.bounce')} ${fmtKpiValue(data.bounceRate.kpi)}`}
          table={{ caption: t('p3.bounce'), columns: [t('generic.month'), '%'], rows: data.bounceRate.series.map((s) => [monthName(s.month), fmtPct(s.value)]) }}
        >
          <MarcomKpiCard testId="kpi-bounce" label={t('p3.bounce')} kpi={data.bounceRate.kpi} sparkline={data.bounceRate.series.map((s) => s.value)} />
        </MarcomChartCard>
        {/* 6 ---------------------------------------------------------------------------- */}
      <MarcomChartCard
        visual="digital.avgSession" title={t('p3.session')} refreshing={refreshing} interactive
        summary={`${t('p3.session')} ${fmtKpiValue(data.avgSession.kpi)}, ${ragLabel(data.avgSession.kpi.status)}`}
        table={{ caption: t('p3.session'), columns: [t('generic.month'), 'min', t('generic.status')], rows: data.avgSession.series.map((s) => [monthName(s.month), s.value === null ? null : `${s.value.toFixed(1)}`, ragLabel(s.status)]) }}
      >
        <MarcomKpiCard testId="kpi-session" label={t('p3.session')} kpi={data.avgSession.kpi} valueTitle={minutesLong(data.avgSession.kpi.value)} sparkline={data.avgSession.series.map((s) => s.value)} />
      </MarcomChartCard>
      </Grid>
    </div>
  );
}
