import React, { useMemo, useRef } from 'react';
import { ResponsiveContainer, ScatterChart, Scatter, Cell, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import { exportSvgAsImage } from '../chartExport';
import { useCanExport } from '../exportPermission';

export interface BubblePoint {
  id: string;
  label: string;
  x: number;
  /** Null means "no meaningful Y value" (e.g. no prior-period baseline to compute growth
   * against) -- NOT zero. Points with a null y are excluded from the plot entirely (their count
   * is reported in a caption instead) rather than plotted at a false/misleading position. */
  y: number | null;
  /** Bubble-size driver (e.g. revenue, or a pre-normalized size score -- see BubbleScatterChartProps.zDomain
   * if the caller has already banded this per-group rather than leaving it a raw shared-scale value). */
  z: number;
  color: string;
  /** Opaque passthrough for whatever the caller wants available in a custom `tooltipContent`
   * renderer (e.g. the full source row) -- unused by this component otherwise. */
  data?: unknown;
}

export interface BubbleScatterChartProps {
  title?: string;
  /** Suppress the internal title text (still renders the Export image button) -- same convention
   * as every other chart in this package. Defaults to true. */
  showTitle?: boolean;
  points: BubblePoint[];
  xLabel?: string;
  yLabel?: string;
  xFormatter?: (value: number) => string;
  yFormatter?: (value: number) => string;
  zFormatter?: (value: number) => string;
  /** Dashed reference line at this X value (e.g. median ASP) -- omit for no vertical divider. */
  xReferenceLine?: number;
  /** Dashed reference line at this Y value (e.g. 0% growth) -- omit for no horizontal divider. */
  yReferenceLine?: number;
  /** Corner labels overlaid on the plot area (e.g. quadrant names) -- purely presentational, drawn
   * over whichever bubbles happen to be there, same convention a real BCG-matrix chart uses.
   * Positioned in the chart's own margin bands (see CHART_MARGIN below), not over the plot data
   * area, specifically so they can never collide with axis tick text. */
  cornerLabels?: { topLeft?: string; topRight?: string; bottomLeft?: string; bottomRight?: string };
  /** Bubble radius range in pixels, passed straight to ZAxis. */
  zRange?: [number, number];
  /** Forces ZAxis's domain instead of letting it auto-fit to the actual min/max of `z` in the
   * data. Needed when the caller has already normalized `z` into a shared 0-1 "size score" with
   * per-group bands reserved within it (e.g. class-based bubble sizing) -- without an explicit
   * domain, ZAxis would auto-fit to whatever sub-range of [0,1] actually occurs and stretch it
   * back out to the full zRange, silently undoing the caller's banding. */
  zDomain?: [number, number];
  height?: number;
  /** 'log' for a long-tail X distribution spanning multiple orders of magnitude. Requires every
   * x > 0; points with x <= 0 are dropped with an on-chart note rather than breaking the log
   * scale for everyone else. Defaults to 'linear' -- prefer linear whenever a percentile-clipped
   * domain already keeps the visible range narrow enough to read (round tick numbers, much more
   * legible), and only reach for 'log' when even a clipped domain still spans multiple orders of
   * magnitude. */
  xScale?: 'linear' | 'log';
  /** [lo, hi] percentile band (0-100) used to compute the visible X view -- not a data filter,
   * every point is still in the dataset (see the "N products beyond chart range" caption for
   * whatever falls outside it). The low end is ignored for a price-like axis (domain always
   * starts at 0); only the high end shapes the view. Defaults to [0, 95]. */
  xDomainPercentile?: [number, number];
  /** Same idea for Y, both ends used since Y can be legitimately negative. Defaults to [2, 90]. */
  yDomainPercentile?: [number, number];
  /** Caption for the count of points excluded from the plot because their y is null (see
   * BubblePoint.y). Receives the excluded count; return null/empty to suppress. */
  excludedYCaption?: (excludedCount: number) => string | null;
  /** Custom tooltip body for a hovered point -- replaces the default label/x/y/z list entirely
   * when provided, so a caller needing more fields (e.g. class, movement, GP%) than the plotted
   * x/y/z can render its own layout using `point.data` (see BubblePoint.data). */
  tooltipContent?: (point: BubblePoint) => React.ReactNode;
}

function defaultFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Standard "nice round numbers" tick algorithm (same idea as d3.ticks): pick a step from the
 * 1/2/2.5/5/10 family closest to (span / targetCount), then emit every multiple of that step
 * inside the domain. Computed and passed explicitly -- Recharts' own automatic tick generation
 * produced tick VALUES that didn't reflect the actual domain in this chart's specific
 * scatter+controlled-domain+allowDataOverflow configuration (reproduced even after a full clean
 * rebuild) -- passing ticks explicitly sidesteps that entirely instead of depending on it. */
function niceTicks(domain: [number, number], targetCount = 5): number[] {
  const [lo, hi] = domain;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const span = hi - lo;
  const rawStep = span / Math.max(targetCount, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  const start = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks.length > 0 ? ticks : [lo, hi];
}

// Fixed chart margins (not just cosmetic): corner labels are positioned relative to these same
// numbers, so the label-clearance math and the actual rendered plot area can never drift apart.
const CHART_MARGIN = { top: 44, right: 16, left: 8, bottom: 40 };
const Y_AXIS_WIDTH = 64;

/**
 * Bubble/scatter chart on a single shared coordinate plane -- same Recharts/CSS-variable-theming/
 * "Export image" conventions as ComboChart/GroupedBarChart/DonutChart, extended with ZAxis-driven
 * bubble sizing, optional dashed reference lines + corner labels for a BCG-matrix-style read, and
 * optional log scale + percentile-clipped domain for long-tail real data. No zoom/pan -- the
 * percentile clip plus the "N products beyond chart range" caption is the whole legibility
 * strategy; a prior revision had wheel-zoom/drag-pan/+/-/Reset controls, removed once the clipped
 * domain alone made the chart readable (see git history if that interaction layer is ever wanted
 * back).
 */
export function BubbleScatterChart({
  title,
  showTitle = true,
  points,
  xLabel,
  yLabel,
  xFormatter = defaultFormatter,
  yFormatter = defaultFormatter,
  zFormatter = defaultFormatter,
  xReferenceLine,
  yReferenceLine,
  cornerLabels,
  zRange = [8, 46],
  zDomain,
  height = 420,
  xScale = 'linear',
  xDomainPercentile = [0, 95],
  yDomainPercentile = [2, 90],
  excludedYCaption,
  tooltipContent,
}: BubbleScatterChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const canExport = useCanExport();
  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, (title ?? 'bubble-chart').replace(/\s+/g, '-').toLowerCase());
  };

  // Log scale needs x > 0 for every plotted point -- drop non-positive x rather than let d3-scale
  // throw/produce a broken axis for everyone else on the chart. Points with a null y (no
  // comparison baseline) are excluded from the plot entirely -- see BubblePoint.y.
  const plottable = useMemo(
    () => points.filter((p) => p.y !== null && (xScale !== 'log' || p.x > 0)) as (BubblePoint & { y: number })[],
    [points, xScale],
  );
  const droppedForScale = xScale === 'log' ? points.filter((p) => p.y !== null && p.x <= 0).length : 0;
  const excludedForNullY = points.length - plottable.length - droppedForScale;

  const xDomain = useMemo<[number, number]>(() => {
    const xs = plottable.map((p) => p.x).sort((a, b) => a - b);
    if (xScale === 'log') {
      const xsPositive = xs.filter((v) => v > 0);
      const lo = Math.max(percentile(xsPositive, xDomainPercentile[0]), (xsPositive[0] ?? 0.1) * 0.9);
      const hi = percentile(xsPositive, xDomainPercentile[1]);
      return [lo > 0 ? lo : 0.1, hi > lo ? hi : lo + 1];
    }
    // Linear price-like axis: always start at 0, only the high percentile shapes the view.
    const hi = percentile(xs, xDomainPercentile[1]);
    return [0, hi * 1.05];
  }, [plottable, xDomainPercentile, xScale]);

  const yDomain = useMemo<[number, number]>(() => {
    const ys = plottable.map((p) => p.y).sort((a, b) => a - b);
    if (ys.length === 0) return [-1, 1];
    const lo = percentile(ys, yDomainPercentile[0]);
    const hi = percentile(ys, yDomainPercentile[1]);
    const pad = (hi - lo) * 0.08 || 1;
    return [lo - pad, hi + pad];
  }, [plottable, yDomainPercentile]);

  const outOfRangeCount = useMemo(() => {
    return plottable.filter((p) => p.x < xDomain[0] || p.x > xDomain[1] || p.y < yDomain[0] || p.y > yDomain[1]).length;
  }, [plottable, xDomain, yDomain]);

  const xTicks = useMemo(() => {
    if (xScale === 'log') {
      const [lo, hi] = xDomain;
      if (lo <= 0) return undefined;
      const startPow = Math.floor(Math.log10(lo));
      const endPow = Math.ceil(Math.log10(hi));
      const out: number[] = [];
      for (let k = startPow; k <= endPow; k += 1) {
        const v = Math.pow(10, k);
        if (v >= lo && v <= hi) out.push(v);
      }
      return out.length >= 2 ? out : undefined;
    }
    return niceTicks(xDomain);
  }, [xDomain, xScale]);
  const yTicks = useMemo(() => niceTicks(yDomain), [yDomain]);

  if (points.length === 0) {
    return <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No data to chart.</p>;
  }

  const cornerLabelStyle: React.CSSProperties = {
    position: 'absolute',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: 'var(--ps-color-muted-text)',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  };

  const excludedCaption = excludedYCaption?.(excludedForNullY);

  return (
    <div style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--ps-space-2, 8px)',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        {showTitle ? <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span> : <span />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {outOfRangeCount > 0 && (
            <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
              {outOfRangeCount} product{outOfRangeCount === 1 ? '' : 's'} beyond chart range
            </span>
          )}
          {canExport && (
          <button
            type="button"
            onClick={handleExportImage}
            style={{
              fontSize: 11, fontWeight: 600, color: 'var(--ps-color-muted-text)',
              background: 'var(--ps-color-muted-bg)', border: '1px solid var(--ps-color-border)',
              borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
            }}
          >
            Export image
          </button>
          )}
        </div>
      </div>

      <div ref={containerRef} style={{ width: '100%', position: 'relative' }}>
        {cornerLabels?.topLeft && <span style={{ ...cornerLabelStyle, top: 6, left: CHART_MARGIN.left + Y_AXIS_WIDTH + 10 }}>{cornerLabels.topLeft}</span>}
        {cornerLabels?.topRight && <span style={{ ...cornerLabelStyle, top: 6, right: CHART_MARGIN.right + 6 }}>{cornerLabels.topRight}</span>}
        {cornerLabels?.bottomLeft && <span style={{ ...cornerLabelStyle, bottom: 4, left: CHART_MARGIN.left + Y_AXIS_WIDTH + 10 }}>{cornerLabels.bottomLeft}</span>}
        {cornerLabels?.bottomRight && <span style={{ ...cornerLabelStyle, bottom: 4, right: CHART_MARGIN.right + 6 }}>{cornerLabels.bottomRight}</span>}

        <ResponsiveContainer width="100%" height={height}>
          <ScatterChart margin={CHART_MARGIN}>
            <CartesianGrid stroke="var(--ps-color-border)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name={xLabel}
              scale={xScale === 'log' ? 'log' : 'linear'}
              domain={xDomain}
              ticks={xTicks}
              allowDataOverflow
              tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
              axisLine={{ stroke: 'var(--ps-color-border)' }}
              tickLine={false}
              tickFormatter={xFormatter}
              label={xLabel ? { value: xLabel, position: 'bottom', offset: 6, fontSize: 11, fill: 'var(--ps-color-muted-text)' } : undefined}
            />
            <YAxis
              type="number"
              dataKey="y"
              name={yLabel}
              domain={yDomain}
              ticks={yTicks}
              allowDataOverflow
              tick={{ fontSize: 11, fill: 'var(--ps-color-muted-text)' }}
              axisLine={{ stroke: 'var(--ps-color-border)' }}
              tickLine={false}
              tickFormatter={yFormatter}
              width={Y_AXIS_WIDTH}
            />
            <ZAxis type="number" dataKey="z" range={zRange} domain={zDomain} />
            {xReferenceLine !== undefined && <ReferenceLine x={xReferenceLine} stroke="var(--ps-color-muted-text)" strokeDasharray="4 4" />}
            {yReferenceLine !== undefined && <ReferenceLine y={yReferenceLine} stroke="var(--ps-color-muted-text)" strokeDasharray="4 4" />}
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as BubblePoint;
                if (tooltipContent) return <>{tooltipContent(p)}</>;
                return (
                  <div
                    style={{
                      borderRadius: 10,
                      border: '1px solid var(--ps-color-border)',
                      fontSize: 12,
                      background: 'var(--ps-color-surface)',
                      color: 'var(--ps-color-text)',
                      padding: '8px 10px',
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{p.label}</div>
                    <div>{xLabel ?? 'X'}: {xFormatter(p.x)}</div>
                    <div>{yLabel ?? 'Y'}: {p.y === null ? '—' : yFormatter(p.y)}</div>
                    <div>{zFormatter(p.z)}</div>
                  </div>
                );
              }}
            />
            <Scatter data={plottable} isAnimationActive={false}>
              {plottable.map((p) => (
                <Cell key={p.id} fill={p.color} fillOpacity={0.75} stroke={p.color} strokeWidth={1} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {/* Deliberately OUTSIDE the position:relative wrapper above: the corner labels inside that
          wrapper anchor to ITS bottom edge, so captions rendered inside it would push (or get
          pushed into) the bottom corner labels every time their text wraps to a different line
          count. Rendering them as siblings after the wrapper closes keeps the corner labels
          anchored to the plot itself, never to how much caption text happens to follow it. */}
      {excludedCaption && (
        <div style={{ fontSize: 10.5, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{excludedCaption}</div>
      )}
      {droppedForScale > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>
          {droppedForScale} product{droppedForScale === 1 ? '' : 's'} with a non-positive X value omitted (incompatible with log scale).
        </div>
      )}
    </div>
  );
}
