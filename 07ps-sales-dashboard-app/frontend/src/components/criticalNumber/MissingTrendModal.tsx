'use client';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Brush,
  Label,
  type TooltipProps,
} from 'recharts';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, FileDown, FileSpreadsheet, Image as ImageIcon, TrendingDown, TrendingUp, X } from 'lucide-react';
import { ErrorState, LoadingSkeleton, exportRowsAsCsv, exportRowsAsPdf, exportRowsAsXlsx, exportSvgAsImage } from '@07ps/ui';
import type { MissingTrendGranularity, MissingTrendPeriod, TachometerFilters } from '../../lib/api';
import { useCriticalNumberMissingTrend } from '../../lib/hooks';
import { formatCompactCurrency, formatCurrency, formatVariance } from '../../lib/format';

export type MissingTrendMetric = 'value' | 'days';

export interface MissingTrendModalProps {
  metric: MissingTrendMetric;
  title: string;
  /** Headline as shown on the card (e.g. "-LYD 10.5M" / "-19 days") and its color. */
  headlineLabel: string;
  headlineFullLabel?: string;
  headlineColor: string;
  headlineCaption: string;
  trendPct: number | null;
  /** Formula explanation, same text as the card's description. */
  description: string;
  token: string | null;
  anchorDate: string;
  filters: TachometerFilters;
  authError: string | null;
  retryAuth: () => void;
  /** Active page filters as "Company: Majaal" style parts, shown under the title and in exports. */
  filterParts: string[];
  onClose: () => void;
}

const GRANULARITY_LABEL: Record<MissingTrendGranularity, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string): { y: string; m: string; d: string } {
  const [y, m, d] = iso.split('-');
  return { y, m: MONTHS[Number(m) - 1], d };
}

function periodLabel(p: MissingTrendPeriod, granularity: MissingTrendGranularity): string {
  const s = parts(p.start);
  if (granularity === 'monthly') return `${s.m} ${s.y}`;
  if (granularity === 'daily') return `${s.d} ${s.m} ${s.y}`;
  const e = parts(p.end);
  return `${s.d} ${s.m} – ${e.d} ${e.m} ${e.y}`;
}

function axisLabel(p: MissingTrendPeriod, granularity: MissingTrendGranularity): string {
  const s = parts(p.start);
  return granularity === 'monthly' ? s.m : `${s.d} ${s.m}`;
}

function signed(value: number, format: (abs: number) => string): string {
  if (Math.round(value * 100) === 0) return format(0);
  return `${value < 0 ? '-' : '+'}${format(Math.abs(value))}`;
}

const fmtDays = (abs: number) => `${abs.toFixed(1)} ${abs === 1 ? 'day' : 'days'}`;
const fmtLyd = (abs: number) => formatCurrency(abs);
const fmtLydCompact = (abs: number) => formatCompactCurrency(abs);

type SortKey = 'period' | 'workingDays' | 'target' | 'actual' | 'gapValue' | 'gapDays' | 'cumulative';

interface ChartDatum {
  axis: string;
  period: MissingTrendPeriod;
  complete: number | null;
  partial: number | null;
}

/**
 * Expanded view for the Critical Number page's Missing Value YTD / Missing Days YTD cards: a large
 * labelled trend chart of the cumulative gap vs pace, a Daily/Weekly/Monthly toggle, a sortable
 * breakdown table with totals, and image/PDF/Excel/CSV export. Data comes from
 * /critical-number/missing-trend with the page's own anchor date and filters, so it always
 * matches the card it was opened from.
 *
 * The current, still-trading day (when the anchor is today) is drawn as a dashed, hollow "in
 * progress" point: its expected pace is a full day but its actual is partial, so presenting it as a
 * finished point would show a false plunge at the end of every trend.
 */
export function MissingTrendModal({
  metric,
  title,
  headlineLabel,
  headlineFullLabel,
  headlineColor,
  headlineCaption,
  trendPct,
  description,
  token,
  anchorDate,
  filters,
  authError,
  retryAuth,
  filterParts,
  onClose,
}: MissingTrendModalProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [granularity, setGranularity] = useState<MissingTrendGranularity>('weekly');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'period', dir: 'asc' });
  const [exportingPdf, setExportingPdf] = useState(false);
  const trend = useCriticalNumberMissingTrend(token, anchorDate, filters, authError, retryAuth, true);

  // Esc closes; body scroll is locked while open; focus moves into the dialog and is restored on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const isValue = metric === 'value';
  const periods = useMemo(() => trend.data?.[granularity] ?? [], [trend.data, granularity]);
  const cumulativeOf = (p: MissingTrendPeriod) => (isValue ? p.cumulativeGap : p.cumulativeGapDays);
  const fmtCumulative = (v: number) => signed(v, isValue ? fmtLyd : fmtDays);

  const chartData: ChartDatum[] = useMemo(() => {
    const lastComplete = periods.map((p) => !p.inProgress).lastIndexOf(true);
    return periods.map((p, i) => {
      const y = isValue ? p.cumulativeGap : p.cumulativeGapDays;
      return {
        axis: axisLabel(p, granularity),
        period: p,
        complete: p.inProgress ? null : y,
        // The dashed segment runs from the last finished period into the in-progress one.
        partial: p.inProgress || (i === lastComplete && periods.some((q) => q.inProgress)) ? y : null,
      };
    });
  }, [periods, granularity, isValue]);

  const hasInProgress = periods.some((p) => p.inProgress);

  const sortedRows = useMemo(() => {
    const value = (p: MissingTrendPeriod): number | string => {
      switch (sort.key) {
        case 'period':
          return p.start;
        case 'cumulative':
          return cumulativeOf(p);
        default:
          return p[sort.key];
      }
    };
    const rows = [...periods];
    rows.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, sort, isValue]);

  const totals = useMemo(() => {
    const last = periods[periods.length - 1];
    return {
      workingDays: periods.reduce((s, p) => s + p.workingDays, 0),
      target: periods.reduce((s, p) => s + p.target, 0),
      actual: periods.reduce((s, p) => s + p.actual, 0),
      gapValue: periods.reduce((s, p) => s + p.gapValue, 0),
      gapDays: periods.reduce((s, p) => s + p.gapDays, 0),
      cumulative: last ? cumulativeOf(last) : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, isValue]);

  const cumulativeHeader = isValue ? 'Cumulative Gap (LYD)' : 'Cumulative Gap (Days)';
  const exportHeaders = ['Period', 'Start', 'End', 'Working Days', 'Target (pace) LYD', 'Actual LYD', 'Gap LYD', 'Gap Days', cumulativeHeader, 'Status'];
  const fileBase = `${title.toLowerCase().replace(/\s+/g, '-')}-${granularity}-${anchorDate}`;

  function exportRows(): (string | number)[][] {
    return sortedRows.map((p) => [
      periodLabel(p, granularity),
      p.start,
      p.end,
      p.workingDays,
      Math.round(p.target),
      Math.round(p.actual),
      Math.round(p.gapValue),
      Number(p.gapDays.toFixed(2)),
      isValue ? Math.round(p.cumulativeGap) : Number(p.cumulativeGapDays.toFixed(2)),
      p.inProgress ? 'In progress' : '',
    ]);
  }

  function totalsRow(): (string | number)[] {
    return [
      'Total',
      periods[0]?.start ?? '',
      periods[periods.length - 1]?.end ?? '',
      totals.workingDays,
      Math.round(totals.target),
      Math.round(totals.actual),
      Math.round(totals.gapValue),
      Number(totals.gapDays.toFixed(2)),
      isValue ? Math.round(totals.cumulative) : Number(totals.cumulative.toFixed(2)),
      '',
    ];
  }

  async function handleExportPdf() {
    setExportingPdf(true);
    try {
      await exportRowsAsPdf({
        title: `${title} — ${GRANULARITY_LABEL[granularity]}`,
        subtitle: `${headlineLabel} (${headlineCaption.toLowerCase()}) as of ${anchorDate}`,
        columns: [
          { header: 'Period' },
          { header: 'Working Days', align: 'right' },
          { header: 'Target (pace)', align: 'right' },
          { header: 'Actual', align: 'right' },
          { header: 'Gap LYD', align: 'right' },
          { header: 'Gap Days', align: 'right' },
          { header: cumulativeHeader, align: 'right' },
        ],
        rows: [
          ...sortedRows.map((p) => [
            `${periodLabel(p, granularity)}${p.inProgress ? ' (in progress)' : ''}`,
            String(p.workingDays),
            formatCurrency(p.target),
            formatCurrency(p.actual),
            signed(p.gapValue, fmtLyd),
            signed(p.gapDays, fmtDays),
            fmtCumulative(cumulativeOf(p)),
          ]),
          [
            'Total',
            String(totals.workingDays),
            formatCurrency(totals.target),
            formatCurrency(totals.actual),
            signed(totals.gapValue, fmtLyd),
            signed(totals.gapDays, fmtDays),
            fmtCumulative(totals.cumulative),
          ],
        ],
        fileName: fileBase,
      });
    } catch (err) {
      console.error('PDF export failed:', err);
    } finally {
      setExportingPdf(false);
    }
  }

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'period' ? 'asc' : 'desc' }));

  const improving = trendPct != null && trendPct <= 0;
  const TrendIcon = improving ? TrendingDown : TrendingUp;
  const canExport = !trend.loading && !trend.error && periods.length > 0;

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="ps-cn-modal-scrim"
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="ps-cn-modal">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--ps-color-text)' }}>
              {title}
            </h2>
            <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 4 }} dir="auto">
              As of {anchorDate}
              {filterParts.length > 0 ? ` · ${filterParts.join(' · ')}` : ' · No filters applied'}
            </div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="ps-cn-icon-btn">
            <X size={18} />
          </button>
        </div>

        {/* Headline + formula */}
        <div className="ps-cn-modal-headline">
          <div>
            <div style={{ fontSize: 32, fontWeight: 700, color: headlineColor, lineHeight: 1.1 }} title={headlineFullLabel}>
              {headlineLabel}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{headlineCaption}</div>
            {trendPct != null && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  fontWeight: 600,
                  marginTop: 8,
                  color: improving ? 'var(--ps-color-success)' : 'var(--ps-color-alert)',
                }}
              >
                <TrendIcon size={13} />
                {improving ? 'Improving' : 'Worsening'} {formatVariance(trendPct)}
              </div>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 4 }}>How it&apos;s calculated</div>
            {description}
            {trend.data && (
              <div style={{ marginTop: 6 }}>
                Daily Critical Number for this selection: <strong style={{ color: 'var(--ps-color-text)' }}>{formatCurrency(trend.data.dailyCriticalNumber)}</strong>
              </div>
            )}
          </div>
        </div>

        {/* Toolbar: period toggle + exports */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, margin: '16px 0 8px' }}>
          <div role="radiogroup" aria-label="Period" className="ps-cn-segmented">
            {(['daily', 'weekly', 'monthly'] as const).map((g) => (
              <button key={g} type="button" role="radio" aria-checked={granularity === g} onClick={() => setGranularity(g)} data-active={granularity === g}>
                {GRANULARITY_LABEL[g]}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <ExportButton icon={ImageIcon} label="Export image" disabled={!canExport} onClick={() => exportSvgAsImage(chartRef.current, fileBase)} />
            <ExportButton icon={FileDown} label={exportingPdf ? 'Exporting...' : 'Export PDF'} disabled={!canExport || exportingPdf} onClick={handleExportPdf} />
            <ExportButton
              icon={FileSpreadsheet}
              label="Export Excel"
              disabled={!canExport}
              onClick={() => exportRowsAsXlsx({ headers: exportHeaders, rows: [...exportRows(), totalsRow()], fileName: fileBase, sheetName: GRANULARITY_LABEL[granularity] })}
            />
            <ExportButton
              icon={Download}
              label="Export CSV"
              disabled={!canExport}
              onClick={() => exportRowsAsCsv({ headers: exportHeaders, rows: [...exportRows(), totalsRow()], fileName: fileBase })}
            />
          </div>
        </div>

        {trend.loading ? (
          <LoadingSkeleton variant="chart" />
        ) : trend.error ? (
          <ErrorState message={trend.error} onRetry={trend.retry} />
        ) : periods.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--ps-color-muted-text)', fontSize: 13 }}>No data for this selection.</div>
        ) : (
          <>
            {/* Chart */}
            <div ref={chartRef} dir="ltr">
              <ResponsiveContainer width="100%" height={340}>
                <ComposedChart data={chartData} margin={{ top: 12, right: 16, left: 12, bottom: 24 }}>
                  <CartesianGrid stroke="var(--ps-color-border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="axis"
                    tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
                    axisLine={{ stroke: 'var(--ps-color-border)' }}
                    tickLine={false}
                    minTickGap={16}
                  >
                    <Label
                      value={granularity === 'daily' ? 'Date' : granularity === 'weekly' ? 'Week (Sat–Fri), start date' : 'Month'}
                      position="insideBottom"
                      offset={-16}
                      style={{ fontSize: 12, fill: 'var(--ps-color-muted-text)' }}
                    />
                  </XAxis>
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
                    axisLine={false}
                    tickLine={false}
                    width={isValue ? 80 : 56}
                    tickFormatter={(v: number) => (isValue ? signed(v, (a) => formatCompactCurrency(a).replace('LYD ', '')) : signed(v, (a) => a.toFixed(0)))}
                  >
                    <Label
                      value={isValue ? 'Cumulative gap vs pace (LYD)' : 'Cumulative gap vs pace (days)'}
                      angle={-90}
                      position="insideLeft"
                      style={{ fontSize: 12, fill: 'var(--ps-color-muted-text)', textAnchor: 'middle' }}
                    />
                  </YAxis>
                  <ReferenceLine y={0} stroke="var(--ps-color-muted-text)" strokeDasharray="4 4" />
                  <Tooltip content={<GapTooltip granularity={granularity} />} />
                  <Line
                    type="monotone"
                    dataKey="complete"
                    name="Cumulative gap"
                    stroke="var(--ps-color-accent)"
                    strokeWidth={2.5}
                    dot={granularity === 'daily' ? false : { r: 3 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                  {hasInProgress && (
                    <Line
                      type="monotone"
                      dataKey="partial"
                      name="In progress"
                      stroke="var(--ps-color-watch)"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      dot={(props: { cx?: number; cy?: number; index?: number; payload?: ChartDatum }) =>
                        props.payload?.period.inProgress && props.cx != null && props.cy != null ? (
                          <circle key={`ip-${props.index}`} cx={props.cx} cy={props.cy} r={5} fill="var(--ps-color-surface)" stroke="var(--ps-color-watch)" strokeWidth={2} />
                        ) : (
                          <g key={`ip-${props.index}`} />
                        )
                      }
                      activeDot={{ r: 5 }}
                      isAnimationActive={false}
                      connectNulls={false}
                    />
                  )}
                  {granularity === 'daily' && <Brush dataKey="axis" height={20} stroke="var(--ps-color-accent)" travellerWidth={8} />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {hasInProgress && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid var(--ps-color-watch)', flexShrink: 0 }} />
                Dashed / hollow point = in progress: today is still trading, so its actual is partial while its pace target is a full day.
              </div>
            )}

            {/* Details table */}
            <div className="ps-cn-table-wrap">
              <table className="ps-cn-table">
                <thead>
                  <tr>
                    <SortHeader label="Period" k="period" sort={sort} onSort={toggleSort} align="start" />
                    <SortHeader label="Working Days" k="workingDays" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Target (pace)" k="target" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Actual" k="actual" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Gap LYD" k="gapValue" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Gap Days" k="gapDays" sort={sort} onSort={toggleSort} />
                    <SortHeader label={cumulativeHeader} k="cumulative" sort={sort} onSort={toggleSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((p) => (
                    <tr key={p.key} className="ps-datatable-row">
                      <td style={{ textAlign: 'start', whiteSpace: 'nowrap' }}>
                        {periodLabel(p, granularity)}
                        {p.inProgress && <span className="ps-cn-chip">In progress</span>}
                      </td>
                      <td>{p.workingDays}</td>
                      <td title={formatCurrency(p.target)}>{formatCompactCurrency(p.target)}</td>
                      <td title={formatCurrency(p.actual)}>{formatCompactCurrency(p.actual)}</td>
                      <td title={signed(p.gapValue, fmtLyd)} style={{ color: gapColor(p.gapValue) }}>
                        {signed(p.gapValue, fmtLydCompact)}
                      </td>
                      <td style={{ color: gapColor(p.gapDays) }}>{signed(p.gapDays, fmtDays)}</td>
                      <td style={{ color: gapColor(cumulativeOf(p)), fontWeight: 600 }} title={fmtCumulative(cumulativeOf(p))}>
                        {signed(cumulativeOf(p), isValue ? fmtLydCompact : fmtDays)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ textAlign: 'start' }}>Total</td>
                    <td>{totals.workingDays}</td>
                    <td title={formatCurrency(totals.target)}>{formatCompactCurrency(totals.target)}</td>
                    <td title={formatCurrency(totals.actual)}>{formatCompactCurrency(totals.actual)}</td>
                    <td style={{ color: gapColor(totals.gapValue) }} title={signed(totals.gapValue, fmtLyd)}>
                      {signed(totals.gapValue, fmtLydCompact)}
                    </td>
                    <td style={{ color: gapColor(totals.gapDays) }}>{signed(totals.gapDays, fmtDays)}</td>
                    <td style={{ color: gapColor(totals.cumulative) }} title={fmtCumulative(totals.cumulative)}>
                      {signed(totals.cumulative, isValue ? fmtLydCompact : fmtDays)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function gapColor(v: number): string {
  if (Math.round(v * 100) === 0) return 'var(--ps-color-text)';
  return v < 0 ? 'var(--ps-color-alert)' : 'var(--ps-color-success)';
}

function GapTooltip({
  active,
  payload,
  granularity,
}: TooltipProps<number, string> & { granularity: MissingTrendGranularity }) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload as ChartDatum | undefined;
  if (!datum) return null;
  const p = datum.period;
  const row = (label: string, value: string, color?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ color: 'var(--ps-color-muted-text)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: color ?? 'var(--ps-color-text)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
  return (
    <div
      style={{
        background: 'var(--ps-color-surface)',
        border: '1px solid var(--ps-color-border)',
        borderRadius: 10,
        padding: '8px 12px',
        fontSize: 12,
        minWidth: 240,
        boxShadow: 'var(--ps-card-shadow)',
      }}
    >
      <div style={{ fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 6 }}>
        {periodLabel(p, granularity)}
        {p.inProgress && <span className="ps-cn-chip">In progress</span>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>Year to date, through {p.end}</div>
      {row('Expected pace (Working Days × DCN)', formatCurrency(p.cumulativeTarget))}
      {row('Actual', formatCurrency(p.cumulativeActual))}
      {row('Gap (LYD)', signed(p.cumulativeGap, fmtLyd), gapColor(p.cumulativeGap))}
      {row('Gap (days)', signed(p.cumulativeGapDays, fmtDays), gapColor(p.cumulativeGapDays))}
    </div>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  align = 'end',
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (k: SortKey) => void;
  align?: 'start' | 'end';
}) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th style={{ textAlign: align }} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(k)} className="ps-cn-sort-btn" style={{ justifyContent: align === 'start' ? 'flex-start' : 'flex-end' }}>
        {label}
        <Icon size={12} style={{ opacity: active ? 1 : 0.4 }} />
      </button>
    </th>
  );
}

function ExportButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ComponentType<{ size?: number | string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="ps-cn-export-btn">
      <Icon size={13} />
      {label}
    </button>
  );
}
