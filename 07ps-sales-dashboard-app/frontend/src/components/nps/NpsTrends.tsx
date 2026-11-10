import { vh } from '../../lib/visualHelp';
import React from 'react';
import { ChartPanel, ComboChart, EmptyState, ErrorState, LoadingSkeleton, type ComboChartPoint } from '@07ps/ui';
import type { NpsTrend, PeriodGranularity } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { GROUPS, GROUP_COLOR, RESPONDERS_TREND_INFO, TREND_INFO, fmt2, pct, trendPoints } from '../../lib/nps/view';
import { periodAxisLabel, periodWindowView } from '../../lib/periods';
import { PeriodTrendSelector } from '../PeriodTrendSelector';

export type TrendState = { data: NpsTrend | null; loading: boolean; error: string | null; retry: () => void };

/** The data of the granularity just asked for: a slower previous response never relabels the axis. */
function TrendBody({ state, granularity, children }: { state: TrendState; granularity: PeriodGranularity; children: (data: NpsTrend) => React.ReactNode }) {
  if (state.error) return <ErrorState message={state.error} onRetry={state.retry} />;
  if (!state.data || state.loading || state.data.granularity !== granularity) return <LoadingSkeleton variant="chart" />;
  if (!state.data.points.some((p) => p.measured && p.responders > 0)) return <EmptyState message="No ratings in this period for these filters." />;
  return <>{children(state.data)}</>;
}

/** Tooltip title ("Wk of 03 Oct 2026", "Not surveyed yet" before the first rating) and the in-progress period. */
function periodProps(data: NpsTrend) {
  const win = periodWindowView(data.granularity);
  const title = new Map(data.points.map((p) => [
    periodAxisLabel(p.period, data.granularity),
    p.measured ? win.title(p.period) : `${win.title(p.period)} · before the first rating`,
  ]));
  return {
    tooltipLabelFormatter: (label: string) => title.get(label) ?? label,
    inProgressLabel: win.inProgressLabel(data.points.map((p) => ({ start: p.period, inProgress: p.inProgress }))),
    connectNulls: false,
  };
}

export function NpsTrendChart({ state, granularity, onGranularityChange }: {
  state: TrendState; granularity: PeriodGranularity; onGranularityChange: (g: PeriodGranularity) => void;
}) {
  return (
    <ChartPanel {...vh("process.npsScore.satisfactionTrend")} title="Satisfaction Trend" wrapHeader
      headerActions={<PeriodTrendSelector value={granularity} onChange={onGranularityChange} label="Satisfaction Trend period" />}>
      <TrendBody state={state} granularity={granularity}>{(data) => (
        <ComboChart title="Satisfaction Trend" showTitle={false} points={trendPoints(data)} {...periodProps(data)}
          bars={[{ key: 'responders', name: 'Responders', color: 'var(--ps-color-last-year)' }]}
          lines={[
            { key: 'nps', name: 'NPS', color: 'var(--ps-color-accent)', yAxisId: 'right', labelFormatter: (v) => fmt2(v) },
            { key: 'npsSmall', name: `NPS (n < ${data.minResponders})`, color: 'var(--ps-color-neutral-text)', yAxisId: 'right' },
            { key: 'csat', name: 'CSAT', color: 'var(--ps-color-gold)', yAxisId: 'right' },
            { key: 'csatSmall', name: `CSAT (n < ${data.minResponders})`, color: 'var(--ps-color-muted-text)', yAxisId: 'right' },
          ]}
          leftAxisFormatter={(v) => formatNumber(v)} rightAxisFormatter={(v) => String(Math.round(v))} height={300} />
      )}</TrendBody>
    </ChartPanel>
  );
}

/**
 * Same style as the Satisfaction Trend, with its own Daily / Weekly / Monthly / Yearly selector: total responders as bars,
 * Promoters, Passives and Detractors as three lines on the same axis. Periods before the first rating are gaps.
 */
export function RespondersTrend({ state, granularity, onGranularityChange }: {
  state: TrendState; granularity: PeriodGranularity; onGranularityChange: (g: PeriodGranularity) => void;
}) {
  return (
    <ChartPanel {...vh("process.npsScore.respondersTrend")} title="Responders Trend" wrapHeader
      headerActions={<PeriodTrendSelector value={granularity} onChange={onGranularityChange} label="Responders Trend period" />}>
      <TrendBody state={state} granularity={granularity}>{(data) => {
        const points = data.points.map((p) => ({
          label: periodAxisLabel(p.period, data.granularity),
          responders: p.measured ? p.responders : null,
          promoters: p.measured ? p.promoters : null,
          passives: p.measured ? p.passives : null,
          detractors: p.measured ? p.detractors : null,
        }));
        return (
          <ComboChart title="Responders Trend" showTitle={false} points={points} {...periodProps(data)}
            bars={[{ key: 'responders', name: 'Responders', color: 'var(--ps-color-last-year)' }]}
            lines={GROUPS.map((g) => ({ key: g.key, name: g.label, color: GROUP_COLOR[g.key], yAxisId: 'left' as const }))}
            leftAxisFormatter={(v) => formatNumber(v)}
            tooltipFormatters={Object.fromEntries(GROUPS.map((g) => [g.key, (value: number, point?: ComboChartPoint) => {
              const total = Number(point?.responders ?? 0);
              return `${formatNumber(value)} (${pct(total ? 100 * value / total : 0)})`;
            }]))}
            height={300} />
        );
      }}</TrendBody>
    </ChartPanel>
  );
}
