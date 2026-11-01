'use client';
import React from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Tooltip, XAxis, YAxis } from 'recharts';
import type { SpendingData } from '../../../lib/marcom/types';
import { fmtCompact, fmtLyd, fmtPct } from '../../../lib/marcom/format';
import { CATEGORICAL_8, SERIES } from '../../../lib/marcom/palette';
import { t } from '../../../lib/marcom/text';
import { ChartBox, MarcomChartCard } from '../MarcomChartCard';
import { AXIS_TICK, CHART_MARGIN, GRID_STROKE, TooltipCard, truncate } from './chartKit';

/** Spend by category: campaigns as one bar next to the other-spend categories. Pure rendering of GET /marcom/kpi/spending. */
export function CategoryCard({ data, refreshing }: { data: SpendingData; refreshing?: boolean }) {
  const rows = data.byCategory.categories.filter((c) => c.amount > 0);
  return (
    <MarcomChartCard
      visual="spending.byCategory" title={t('p1.byCategory')} subtitle={t('p1.byCategorySub')} refreshing={refreshing}
      empty={rows.length === 0 ? true : undefined}
      summary={rows.map((c) => `${c.category} ${fmtLyd(c.amount)} (${fmtPct(c.share)})`).join(', ')}
      table={{ caption: t('p1.byCategory'), columns: [t('p1.category'), t('p1.amount'), t('p1.share'), t('p1.lines')], rows: data.byCategory.categories.map((c) => [c.category, fmtLyd(c.amount), fmtPct(c.share), c.lines ?? '—']) }}
    >
      <ChartBox height={Math.max(180, rows.length * 38 + 40)}>
        {({ width, height }) => (
          <BarChart layout="vertical" width={width} height={height} data={rows} margin={{ ...CHART_MARGIN, right: 110 }}>
            <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={AXIS_TICK} tickFormatter={fmtCompact} />
            <YAxis type="category" dataKey="category" width={150} tick={AXIS_TICK} tickFormatter={(v: string) => truncate(v, 22)} />
            <Tooltip content={({ active, payload }) => {
              const c = active && payload?.length ? (payload[0].payload as (typeof rows)[number]) : null;
              return c ? <TooltipCard title={c.category} lines={[{ label: t('p1.amount'), value: fmtLyd(c.amount) }, { label: t('p1.share'), value: fmtPct(c.share) }]} /> : null;
            }} />
            <Bar isAnimationActive={false} dataKey="amount" radius={[0, 4, 4, 0]}>
              {rows.map((c, i) => <Cell key={c.category} fill={c.isCampaigns ? SERIES.primary : CATEGORICAL_8[(i % 7) + 1]} />)}
              <LabelList dataKey="amount" position="right" formatter={(v: number) => fmtCompact(v)} style={{ fontSize: 11, fill: 'var(--ps-color-text)' }} />
            </Bar>
          </BarChart>
        )}
      </ChartBox>
    </MarcomChartCard>
  );
}
