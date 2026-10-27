'use client';
import React from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import type { RoiBlock, Status } from '../../../lib/marcom/types';
import { fmtKpiValue, fmtRatio, monthName } from '../../../lib/marcom/format';
import { RAG_COLOR, SERIES } from '../../../lib/marcom/palette';
import { t } from '../../../lib/marcom/text';
import { ChartBox, MarcomChartCard } from '../MarcomChartCard';
import { MarcomKpiCard } from '../MarcomKpiCard';
import { RagBadge, ragLabel } from '../RagBadge';
import { legendText, AXIS_TICK, CHART_MARGIN, Grid, GRID_STROKE, TooltipCard } from './chartKit';

/**
 * "ROI trend -- YTD vs LYTD": moved unchanged from the Spending page to Media Campaign Performance.
 * Visual id `campaigns.roiTrend`.
 */
export function RoiTrendCard({ roi, noLastYear, refreshing }: { roi: RoiBlock; noLastYear: boolean; refreshing?: boolean }) {
  const roiRows = roi.monthly.map((m) => ({ label: monthName(m.month), current: m.current, lastYear: noLastYear ? null : m.lastYear, status: m.currentStatus }));
  const { greenAbove, redBelow } = roi.bands;
  return (
    <MarcomChartCard
      visual="campaigns.roiTrend" title={t('p1.roiTrend')} refreshing={refreshing} minWidth={Math.max(480, roiRows.length * 70)}
      summary={`${t('p1.roiYtd')} ${fmtKpiValue(roi.ytd)}, ${ragLabel(roi.ytd.status)}${roi.lytd ? `, ${t('p1.roiLytd')} ${fmtKpiValue(roi.lytd)}` : `, ${t('state.noLastYear')}`}`}
      table={{ caption: t('p1.roiTrend'), columns: [t('generic.month'), t('p1.roiCurrent'), t('generic.status'), t('p1.roiLastYear')], rows: roiRows.map((r) => [r.label, fmtRatio(r.current), ragLabel(r.status), noLastYear ? t('generic.na') : fmtRatio(r.lastYear)]) }}
      footer={<>{t('p1.roiBandGreen', { v: greenAbove })} · {t('p1.roiBandRed', { v: redBelow })}</>}
    >
      <Grid min={240} gap={12}>
        <MarcomKpiCard testId="kpi-roi-ytd" label={t('p1.roiYtd')} kpi={roi.ytd} sparkline={roiRows.map((r) => r.current)} hint={roi.lytd ? <span data-testid="roi-lytd">{t('p1.roiLytd')}: <strong>{fmtKpiValue(roi.lytd)}</strong> <RagBadge status={roi.lytd.status} size="sm" /></span> : undefined} />
        {!roi.lytd && (
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
                dot={(p: { cx?: number; cy?: number; payload?: { status: Status; current: number | null }; index?: number }) => (
                  // Months without data (e.g. future months on the campaigns page) get no dot.
                  p.payload?.current === null || p.payload?.current === undefined || p.cy === undefined || p.cy === null
                    ? <g key={p.index} />
                    : <circle key={p.index} cx={p.cx} cy={p.cy} r={5} fill={RAG_COLOR[p.payload?.status ?? 'na']} stroke="var(--ps-color-surface)" strokeWidth={1.5} />
                )} />
              {!noLastYear && <Line isAnimationActive={false} dataKey="lastYear" name={t('p1.roiLastYear')} stroke={SERIES.reference} strokeWidth={2} strokeDasharray="2 3" dot={{ r: 3 }} />}
            </LineChart>
          )}
        </ChartBox>
      </div>
    </MarcomChartCard>
  );
}
