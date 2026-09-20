'use client';
import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import type { MarcomFilters } from '../../../lib/marcom/filters';
import type { StockBlock, TradeData } from '../../../lib/marcom/types';
import { fmtDate, fmtInt, fmtKpiValue, fmtPct, monthName, monthYear } from '../../../lib/marcom/format';
import { periodRange } from '../../../lib/marcom/gantt';
import { CATEGORICAL_8, LIFECYCLE, lifecycleColor, SERIES } from '../../../lib/marcom/palette';
import { t } from '../../../lib/marcom/text';
import { ChartBox, MarcomChartCard, Segmented } from '../MarcomChartCard';
import { MarcomKpiCard } from '../MarcomKpiCard';
import { RagBadge, ragLabel } from '../RagBadge';
import { GanttChart, GanttRow } from '../GanttChart';
import { legendText, AXIS_TICK, CHART_MARGIN, Grid, GRID_STROKE, Note, TooltipCard } from './chartKit';

interface Props {
  data: TradeData;
  refreshing?: boolean;
  filters?: MarcomFilters;
  /** Changes a filter (the events toggle calls the API with completedOnly). */
  setFilters?: (next: MarcomFilters) => void;
}

function StockCard({ visual, title, block, refreshing }: { visual: string; title: string; block: StockBlock; refreshing?: boolean }) {
  const h = block.headline;
  return (
    <MarcomChartCard
      visual={visual} title={title} refreshing={refreshing} interactive
      summary={`${title} ${fmtKpiValue(h)}, ${ragLabel(h.status)}; ${t('p4.average', { v: fmtKpiValue(block.average) })}`}
      table={{ caption: title, columns: [t('generic.month'), t('generic.value'), t('generic.status')], rows: block.series.map((s) => [monthName(s.month), fmtPct(s.value), ragLabel(s.status)]) }}
    >
      <MarcomKpiCard
        testId={`${visual}-kpi`} label={title} kpi={h} sparkline={block.series.map((s) => s.value)}
        hint={<>
          {h.asOf && <div>{t('p4.latest', { period: monthYear(h.asOf.year, h.asOf.month) })}</div>}
          <div data-testid={`${visual}-average`}>{t('p4.average', { v: fmtKpiValue(block.average) })} <RagBadge status={block.average.status} size="sm" /></div>
        </>}
      />
    </MarcomChartCard>
  );
}

/** Page 4 -- Trade Marketing & Retail (visuals 1-6). */
export function TradeView({ data, refreshing, filters, setFilters }: Props) {
  const [timelineView, setTimelineView] = useState<'gantt' | 'table'>('gantt');
  const completedOnly = filters?.completedOnly ?? data.meta.eventsFilter === 'completedOnly';
  const typeKeys = Object.keys(data.eventsByTypeMonthly[0]?.byType ?? {});
  const stackData = data.eventsByTypeMonthly.map((m) => ({ label: monthName(m.month), ...m.byType }));
  const present = [...new Set(data.eventsTimeline.map((e) => e.status))];
  const legend = Object.keys(LIFECYCLE).filter((s) => present.includes(s)).map((s) => ({ label: s, color: lifecycleColor(s) }));

  const ganttRows: GanttRow[] = data.eventsTimeline.map((e, i) => ({
    id: `${e.name}|${e.brandId}|${i}`, label: e.name, sublabel: `${e.type} · ${e.brand}`, start: e.planned, end: e.completion, status: e.status,
    color: lifecycleColor(e.status), overdue: e.overdue,
    details: [
      { label: t('p4.type'), value: e.type }, { label: t('gantt.brand'), value: e.brand },
      { label: t('gantt.planned'), value: fmtDate(e.planned) }, { label: t('gantt.completion'), value: e.completion ? fmtDate(e.completion) : t('gantt.notCompleted') },
    ],
  }));

  const th: React.CSSProperties = { textAlign: 'start', padding: '6px 8px', fontSize: 12, color: 'var(--ps-color-muted-text)', borderBottom: '1px solid var(--ps-color-border)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 8px', fontSize: 13, borderBottom: '1px solid var(--ps-color-border)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1-3 ------------------------------------------------------------------------------ */}
      <Grid min={300}>
        <StockCard visual="trade.compliance" title={t('p4.compliance')} block={data.compliance} refreshing={refreshing} />
        <StockCard visual="trade.giveaways" title={t('p4.giveaways')} block={data.giveawaysStock} refreshing={refreshing} />
        <StockCard visual="trade.printed" title={t('p4.printed')} block={data.printedStock} refreshing={refreshing} />
      </Grid>

      {/* 4 -------------------------------------------------------------------------------- */}
      <MarcomChartCard
        visual="trade.eventsByType" title={t('p4.eventsByType')} refreshing={refreshing} minWidth={Math.max(480, stackData.length * 70)}
        actions={setFilters && filters ? (
          <Segmented value={completedOnly ? 'completed' : 'planned'} onChange={(v) => setFilters({ ...filters, completedOnly: v === 'completed' })} label={t('p4.eventsByType')}
            options={[{ value: 'planned', label: t('p4.includePlanned') }, { value: 'completed', label: t('p4.completedOnly') }]} />
        ) : undefined}
        summary={data.eventsByTypeMonthly.map((m) => `${monthName(m.month)}: ${m.total}`).join(', ')}
        table={{ caption: t('p4.eventsByType'), columns: [t('generic.month'), ...typeKeys, t('generic.total')], rows: data.eventsByTypeMonthly.map((m) => [monthName(m.month), ...typeKeys.map((k) => m.byType[k]), m.total]) }}
        footer={t('p4.cancelledNote')}
      >
        <ChartBox height={320}>
          {({ width, height }) => (
            <BarChart width={width} height={height} data={stackData} margin={CHART_MARGIN}>
              <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={AXIS_TICK} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} label={{ value: '#', angle: -90, position: 'insideLeft', fill: SERIES.text, fontSize: 11 }} />
              <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                <TooltipCard title={label} lines={payload.filter((p) => Number(p.value) > 0).map((p) => ({ label: String(p.name), value: String(p.value), color: String(p.color) }))} />
              ) : null} />
              <Legend formatter={legendText} />
              {typeKeys.map((k, i) => <Bar isAnimationActive={false} key={k} dataKey={k} name={k} stackId="events" fill={CATEGORICAL_8[i % CATEGORICAL_8.length]} stroke="var(--ps-color-surface)" strokeWidth={1} />)}
            </BarChart>
          )}
        </ChartBox>
      </MarcomChartCard>

      {/* 5 -------------------------------------------------------------------------------- */}
      <MarcomChartCard
        visual="trade.eventsTimeline" title={t('p4.eventsTimeline')} refreshing={refreshing} interactive
        empty={data.eventsTimeline.length === 0 ? true : undefined}
        actions={<Segmented value={timelineView} onChange={setTimelineView} label={t('p4.eventsTimeline')} options={[{ value: 'gantt', label: t('p4.viewGantt') }, { value: 'table', label: t('p4.viewTable') }]} />}
        summary={`${data.eventsTimeline.length} events; ${data.eventsTimeline.filter((e) => e.overdue).length} ${t('generic.overdue')}`}
        table={{ caption: t('p4.eventsTimeline'), columns: [t('p4.event'), t('p4.type'), t('generic.brand'), t('p4.plannedDate'), t('p4.completionDate'), t('generic.status')], rows: data.eventsTimeline.map((e) => [e.name, e.type, e.brand, fmtDate(e.planned), e.completion ? fmtDate(e.completion) : '—', e.overdue ? `${e.status} · ${t('generic.overdue')}` : e.status]) }}
      >
        <div data-testid="events-summary" role="table" aria-label={t('p4.eventsTimeline')} style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 8 }}>
          {data.eventsMonthlySummary.map((m) => (
            <div key={m.month} role="row" data-testid="summary-cell" style={{ flex: 'none', minWidth: 96, border: '1px solid var(--ps-color-border)', borderRadius: 8, padding: '6px 8px', fontSize: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>{monthName(m.month)}</div>
              <div>{t('p4.summaryPlanned')}: <strong>{m.planned}</strong></div>
              <div>{t('p4.summaryCompleted')}: <strong>{m.completed}</strong></div>
              <div>{t('p4.summaryPct')}: <strong>{fmtPct(m.completionPct, 0)}</strong></div>
            </div>
          ))}
        </div>

        {timelineView === 'gantt' ? (
          <GanttChart rows={ganttRows} range={periodRange(data.period)} today={data.today} ariaLabel={t('p4.eventsTimeline')} legend={legend} />
        ) : (
          <div style={{ overflow: 'auto', maxHeight: 420 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label={t('p4.eventsTimeline')}>
              <thead><tr>{[t('p4.event'), t('p4.type'), t('generic.brand'), t('p4.plannedDate'), t('p4.completionDate'), t('generic.status')].map((c) => <th key={c} style={th}>{c}</th>)}</tr></thead>
              <tbody>
                {data.eventsTimeline.map((e, i) => (
                  <tr key={i} data-testid="events-row">
                    <td style={td}>{e.name}</td><td style={td}>{e.type}</td><td style={td}>{e.brand}</td><td style={td}>{fmtDate(e.planned)}</td><td style={td}>{e.completion ? fmtDate(e.completion) : '—'}</td>
                    <td style={td}>{e.status}{e.overdue && <span data-testid="table-overdue" style={{ marginInlineStart: 6, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, border: '1px solid var(--ps-color-alert)', background: 'var(--ps-color-alert-bg)', borderRadius: 999, padding: '0 6px' }}><AlertTriangle size={11} aria-hidden="true" style={{ color: 'var(--ps-color-alert)' }} />{t('generic.overdue')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MarcomChartCard>

      {/* 6 -------------------------------------------------------------------------------- */}
      <MarcomChartCard
        visual="trade.attendance" title={t('p4.attendance')} refreshing={refreshing} interactive
        summary={`${t('p4.attendance')} ${fmtKpiValue(data.attendance.kpi)}, ${ragLabel(data.attendance.kpi.status)}; ${t('p4.actual')} ${fmtInt(data.attendance.actual)} / ${t('p4.expected')} ${fmtInt(data.attendance.expected)}`}
        table={{ caption: t('p4.attendance'), columns: [t('generic.month'), t('p4.actual'), t('p4.expected'), '%', t('generic.status')], rows: data.attendance.series.map((s) => [monthName(s.month), fmtInt(s.actual), fmtInt(s.expected), fmtPct(s.value), ragLabel(s.status)]) }}
      >
        <MarcomKpiCard
          testId="kpi-attendance" label={t('p4.attendance')} kpi={data.attendance.kpi} sparkline={data.attendance.series.map((s) => s.value)}
          hint={<div style={{ display: 'flex', gap: 24, marginTop: 4 }}>
            <div data-testid="attendance-actual"><div style={{ fontSize: 11 }}>{t('p4.actual')}</div><strong style={{ color: 'var(--ps-color-text)', fontSize: 15 }}>{fmtInt(data.attendance.actual)}</strong></div>
            <div data-testid="attendance-expected"><div style={{ fontSize: 11 }}>{t('p4.expected')}</div><strong style={{ color: 'var(--ps-color-text)', fontSize: 15 }}>{fmtInt(data.attendance.expected)}</strong></div>
          </div>}
        />
      </MarcomChartCard>
      {refreshing && <Note>{t('filter.refreshing')}</Note>}
    </div>
  );
}
