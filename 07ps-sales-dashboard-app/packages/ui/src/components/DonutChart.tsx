import React, { useRef } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { exportSvgAsImage } from '../chartExport';
import { chartTooltipProps } from '../chartTooltip';
import { useCanExport } from '../exportPermission';
import { DISPLAY_LOCALE } from '../locale';

export interface DonutSegment {
  id: string;
  label: string;
  value: number;
  color: string;
  /** Optional item count backing this segment's value (e.g. number of invoices) -- shown alongside
   * the percentage in the tooltip when present. Purely additive: omit for every existing caller
   * that has no such count to show. */
  count?: number;
  /** Optional extra line for the tooltip, e.g. "Expected revenue: LYD 1.2M" -- additive, omit for existing callers. */
  tooltipNote?: string;
}

export interface DonutChartProps {
  title?: string;
  /** Suppress the internal title text (still renders the Export image button) -- same convention
   * as TrendChart/ComboChart's showTitle, for callers whose surrounding chrome (e.g. ChartPanel)
   * already shows the title. Defaults to true. */
  showTitle?: boolean;
  segments: DonutSegment[];
  /** Formats both the tooltip's full-precision value and each legend row's value. */
  valueFormatter?: (value: number) => string;
  /** Small caption above the legend list, e.g. "Invoice Class (YTD)". */
  legendTitle?: string;
  height?: number;
  /** Segments (and their legend rows) become clickable and invoke this with the clicked segment's
   * `id`. Clicking the already-selected segment is the caller's responsibility to treat as
   * "clear" -- this just reports clicks, same convention as ComboChart's onCategoryClick. */
  onSegmentClick?: (id: string) => void;
  /** Full opacity + a highlighted ring on the matching segment/legend row, every other segment
   * dimmed -- the "this is the active page filter" affordance, same convention as ComboChart's
   * highlightedCategory. */
  selectedId?: string | null;
  /** Optional text centered in the ring's hole, e.g. "Today" or "12 / 26" -- opt-in (undefined
   * renders nothing extra, so every existing caller is unaffected). Built for Critical Number
   * page's Daily/Monthly/Yearly counters; generic enough for any donut that wants a headline
   * figure in the middle instead of only a surrounding legend. */
  centerLabel?: string;
  /** Small caption under centerLabel, e.g. "Working Days". Ignored if centerLabel is unset. */
  centerSubLabel?: string;
  /** Optional third, smaller line in the centre (e.g. "Win rate 64.0%"). Ignored if centerLabel is unset. */
  centerCaption?: string | null;
  /** Optional last legend row, e.g. { label: 'Total', value: '726 opportunities' } -- for a donut whose centre shows
   * something other than the total. */
  legendTotal?: { label: string; value: string };
  /** Legend label direction. 'auto' (default) follows each label's first strong character; 'ltr' draws every label
   * left-to-right with the label text isolated (Product pages: names mixing Arabic and Latin stay in their order). */
  labelDirection?: 'auto' | 'ltr';
  /** Renders each segment's share of the whole directly on the ring (outside small slices, with a
   * leader line, per Recharts' own label positioning) in addition to the existing legend
   * percentages. Opt-in -- defaults to false so every existing caller's ring stays exactly as
   * before. */
  showPercentLabels?: boolean;
  /** Set false to hide the "Export image" button for this chart (e.g. Critical Number page's
   * Daily/Monthly/Yearly counters). Defaults to true, so every existing caller is unaffected. */
  showExportButton?: boolean;
}

function defaultFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(DISPLAY_LOCALE, { maximumFractionDigits: 0 });
}

/* Outside % labels (2026-11-02 fix: labels touched the ring and the leader line ran through the text). The leader
 * line runs from just outside the ring to LINE_END; the text starts LABEL_GAP further out, anchored away from the ring:
 * left/right of it on the sides, above/below it near the top and bottom. A surface-coloured halo keeps it readable
 * over anything it overlaps, in both themes. */
const RADIAN = Math.PI / 180;
const LINE_START = 2;
const LINE_END = 10;
const LABEL_GAP = 14;

function polar(cx: number, cy: number, r: number, midAngle: number): [number, number] {
  return [cx + r * Math.cos(-midAngle * RADIAN), cy + r * Math.sin(-midAngle * RADIAN)];
}

/** Recharts `<Pie label>` renderer: each segment's share of the whole, just outside the ring at that slice's midpoint. */
export function renderPercentLabel(props: any): React.ReactElement {
  const { cx, cy, midAngle, outerRadius, percent } = props;
  const cos = Math.cos(-midAngle * RADIAN);
  const sin = Math.sin(-midAngle * RADIAN);
  const [x, y] = polar(cx, cy, outerRadius + LABEL_GAP, midAngle);
  const nearVertical = Math.abs(cos) < 0.35;
  const textAnchor = nearVertical ? 'middle' : cos > 0 ? 'start' : 'end';
  // Near the top the text sits above its point, near the bottom below it, otherwise centred on it.
  const dominantBaseline = nearVertical ? (sin < 0 ? 'auto' : 'hanging') : 'central';
  return (
    <text
      x={x}
      y={y}
      textAnchor={textAnchor}
      dominantBaseline={dominantBaseline}
      data-testid="donut-pct-label"
      style={{
        fontSize: 11,
        fontWeight: 700,
        fill: 'var(--ps-color-text)',
        stroke: 'var(--ps-color-surface)',
        strokeWidth: 3,
        paintOrder: 'stroke',
        strokeLinejoin: 'round',
      }}
    >
      {`${(percent * 100).toFixed(1)}%`}
    </text>
  );
}

/** Leader line from the ring to just short of the label, so it never crosses the text. */
export function renderPercentLabelLine(props: any): React.ReactElement {
  const { cx, cy, midAngle, outerRadius } = props;
  const [x1, y1] = polar(cx, cy, outerRadius + LINE_START, midAngle);
  const [x2, y2] = polar(cx, cy, outerRadius + LINE_END, midAngle);
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ps-color-muted-text)" strokeWidth={1} />;
}

/**
 * Donut (ring) chart with an explicit label+value+percentage legend list, same
 * Recharts/CSS-variable-theming/"Export image" conventions as TrendChart/BreakdownChart/
 * ComboChart. Built for the Invoices Engine page's "Invoices Classification" chart, but generic --
 * any labeled-segments-of-a-whole breakdown can reuse it.
 */
export function DonutChart({
  title,
  showTitle = true,
  segments,
  valueFormatter = defaultFormatter,
  legendTitle,
  height = 280,
  onSegmentClick,
  selectedId = null,
  centerLabel,
  centerSubLabel,
  centerCaption,
  legendTotal,
  showPercentLabels = false,
  showExportButton = true,
  labelDirection = 'auto',
}: DonutChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  const canExport = useCanExport() && showExportButton;
  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, (title ?? 'donut-chart').replace(/\s+/g, '-').toLowerCase());
  };

  if (segments.length === 0 || total === 0) {
    return <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No data to chart.</p>;
  }

  return (
    <div style={{ width: '100%' }}>
      {(showTitle || canExport) && (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: showTitle ? 'space-between' : 'flex-end',
          marginBottom: 'var(--ps-space-2, 8px)',
        }}
      >
        {showTitle && <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ps-color-text)' }}>{title}</span>}
        {canExport && (
        <button
          type="button"
          onClick={handleExportImage}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--ps-color-muted-text)',
            background: 'var(--ps-color-muted-bg)',
            border: '1px solid var(--ps-color-border)',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
          }}
        >
          Export image
        </button>
        )}
      </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--ps-space-2, 8px)' }}>
        <div ref={containerRef} style={{ width: '100%', position: 'relative' }}>
          {centerLabel && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                textAlign: 'center',
              }}
            >
              <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--ps-color-text)', lineHeight: 1.15 }}>{centerLabel}</span>
              {centerSubLabel && (
                <span style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{centerSubLabel}</span>
              )}
              {centerCaption && (
                <span data-testid="donut-center-caption" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ps-color-muted-text)', marginTop: 3 }}>
                  {centerCaption}
                </span>
              )}
            </div>
          )}
          <ResponsiveContainer width="100%" height={height}>
            <PieChart>
              <Pie
                data={segments}
                dataKey="value"
                nameKey="label"
                innerRadius="60%"
                outerRadius={showPercentLabels ? '72%' : '88%'}
                paddingAngle={2}
                isAnimationActive={false}
                onClick={onSegmentClick ? (d: any) => onSegmentClick(d?.id ?? d?.payload?.id) : undefined}
                label={showPercentLabels ? renderPercentLabel : undefined}
                labelLine={showPercentLabels ? renderPercentLabelLine : false}
              >
                {segments.map((s) => {
                  const isSelected = selectedId === s.id;
                  const dimmed = selectedId != null && !isSelected;
                  return (
                    <Cell
                      key={s.id}
                      fill={s.color}
                      fillOpacity={dimmed ? 0.35 : 1}
                      stroke={isSelected ? 'var(--ps-color-gold)' : 'var(--ps-color-surface)'}
                      strokeWidth={isSelected ? 3 : 2}
                      style={{ cursor: onSegmentClick ? 'pointer' : 'default' }}
                    />
                  );
                })}
              </Pie>
              <Tooltip {...chartTooltipProps}
                formatter={(value: number, name: string, entry: any) => {
                  const count = entry?.payload?.count;
                  const pct = `${((value / total) * 100).toFixed(2)}%`;
                  const countText = typeof count === 'number' ? ` (${count.toLocaleString(DISPLAY_LOCALE)} invoice${count === 1 ? '' : 's'})` : '';
                  const note = entry?.payload?.tooltipNote;
                  return [`${valueFormatter(value)} -- ${pct}${countText}${note ? ` · ${note}` : ''}`, name];
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div style={{ width: '100%' }}>
          {legendTitle && (
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ps-color-muted-text)', marginBottom: 6 }}>
              {legendTitle}
            </div>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {segments.map((s) => {
              const isSelected = selectedId === s.id;
              const dimmed = selectedId != null && !isSelected;
              const rowStyle: React.CSSProperties = {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                width: '100%',
                border: 'none',
                background: isSelected ? 'var(--ps-color-muted-bg)' : 'none',
                borderRadius: 6,
                padding: onSegmentClick ? '3px 4px' : 0,
                margin: 0,
                cursor: onSegmentClick ? 'pointer' : 'default',
                font: 'inherit',
                textAlign: 'left',
                opacity: dimmed ? 0.55 : 1,
              };
              const rowContent = (
                <>
                  <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                  <span dir={labelDirection} title={s.label} style={{ color: 'var(--ps-color-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', unicodeBidi: labelDirection === 'ltr' ? 'isolate' : undefined }}>
                    {s.label}
                  </span>
                  <span style={{ color: 'var(--ps-color-muted-text)', fontWeight: 600, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {valueFormatter(s.value)} ({((s.value / total) * 100).toFixed(2)}%{typeof s.count === 'number' ? `, ${s.count.toLocaleString(DISPLAY_LOCALE)}` : ''})
                  </span>
                </>
              );
              return (
                <li key={s.id}>
                  {onSegmentClick ? (
                    <button type="button" onClick={() => onSegmentClick(s.id)} aria-pressed={isSelected} style={rowStyle}>
                      {rowContent}
                    </button>
                  ) : (
                    <div style={rowStyle}>{rowContent}</div>
                  )}
                </li>
              );
            })}
            {legendTotal && (
              <li
                data-testid="donut-legend-total"
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: onSegmentClick ? '5px 4px 0' : '4px 0 0', borderTop: '1px solid var(--ps-color-border)', marginTop: 2 }}
              >
                <span aria-hidden style={{ width: 9, flexShrink: 0 }} />
                <span style={{ color: 'var(--ps-color-text)', fontWeight: 700, flex: 1 }}>{legendTotal.label}</span>
                <span style={{ color: 'var(--ps-color-text)', fontWeight: 700, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{legendTotal.value}</span>
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
