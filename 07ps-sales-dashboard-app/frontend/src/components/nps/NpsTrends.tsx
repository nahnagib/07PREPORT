import React from 'react';
import { Button, ChartPanel, ComboChart, EmptyState, ErrorState, LoadingSkeleton, type ComboChartPoint } from '@07ps/ui';
import type { NpsGrain, NpsTrend } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { GROUPS, GROUP_COLOR, RESPONDERS_TREND_INFO, TREND_INFO, fmt2, pct, periodLabel, trendPoints } from '../../lib/nps/view';

export type TrendState = { data: NpsTrend | null; loading: boolean; error: string | null; retry: () => void };
const GRAIN_LABEL: Record<NpsGrain, string> = { week: 'Weekly', month: 'Monthly', year: 'Yearly' };

function TrendBody({ state, children }: { state: TrendState; children: (data: NpsTrend) => React.ReactNode }) {
  if (state.error) return <ErrorState message={state.error} onRetry={state.retry} />;
  if (!state.data || state.loading) return <LoadingSkeleton variant="chart" />;
  if (!state.data.points.length) return <EmptyState message="No ratings for these filters and dates." />;
  return <>{children(state.data)}</>;
}

function GrainSwitch({ grain, onGrainChange, label }: { grain: NpsGrain; onGrainChange: (grain: NpsGrain) => void; label: string }) {
  return (
    <div className="ps-nps-switch" role="group" aria-label={label}>
      {(Object.keys(GRAIN_LABEL) as NpsGrain[]).map((g) => (
        <Button key={g} variant={grain === g ? 'primary' : 'secondary'} onClick={() => onGrainChange(g)} aria-pressed={grain === g}>
          {GRAIN_LABEL[g]}
        </Button>
      ))}
    </div>
  );
}

export function NpsTrendChart({ state, grain, onGrainChange }: {
  state: TrendState; grain: NpsGrain; onGrainChange: (grain: NpsGrain) => void;
}) {
  return (
    <ChartPanel title="Satisfaction Trend" wrapHeader infoText={TREND_INFO}
      headerActions={<GrainSwitch grain={grain} onGrainChange={onGrainChange} label="Satisfaction Trend period" />}>
      <TrendBody state={state}>{(data) => (
        <ComboChart title="Satisfaction Trend" showTitle={false} points={trendPoints(data)}
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
 * Same style as the Satisfaction Trend, with its own Weekly / Monthly / Yearly switch: total responders as bars,
 * Promoters, Passives and Detractors as three lines on the same axis.
 */
export function RespondersTrend({ state, grain, onGrainChange }: {
  state: TrendState; grain: NpsGrain; onGrainChange: (grain: NpsGrain) => void;
}) {
  return (
    <ChartPanel title="Responders Trend" wrapHeader infoText={RESPONDERS_TREND_INFO}
      headerActions={<GrainSwitch grain={grain} onGrainChange={onGrainChange} label="Responders Trend period" />}>
      <TrendBody state={state}>{(data) => {
        const points = data.points.map((p) => ({
          label: periodLabel(p.period), responders: p.responders,
          promoters: p.promoters, passives: p.passives, detractors: p.detractors,
        }));
        return (
          <ComboChart title="Responders Trend" showTitle={false} points={points}
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
