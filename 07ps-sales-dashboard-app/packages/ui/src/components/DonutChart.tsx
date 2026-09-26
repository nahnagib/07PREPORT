import React, { useRef } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { exportSvgAsImage } from '../chartExport';
import { useCanExport } from '../exportPermission';

export interface DonutSegment {
  id: string;
  label: string;
  value: number;
  color: string;
  /** Optional item count backing this segment's value (e.g. number of invoices) -- shown alongside
   * the percentage in the tooltip when present. Purely additive: omit for every existing caller
   * that has no such count to show. */
  count?: number;
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
  /** Renders each segment's share of the whole directly on the ring (outside small slices, with a
   * leader line, per Recharts' own label positioning) in addition to the existing legend
   * percentages. Opt-in -- defaults to false so every existing caller's ring stays exactly as
   * before. */
  showPercentLabels?: boolean;
}

function defaultFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Recharts `<Pie label>` renderer: each segment's share of the whole, placed just outside the
 * ring at that slice's midpoint angle -- same polar-coordinate approach Recharts' own docs use for
 * outside pie labels. Kept as a plain function (not a component) since Recharts calls it directly
 * with its own props shape rather than mounting it as JSX. */
function renderPercentLabel(props: any): React.ReactElement {
  const { cx, cy, midAngle, outerRadius, percent } = props;
  const RADIAN = Math.PI / 180;
  const radius = outerRadius + 16;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text
      x={x}
      y={y}
      textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central"
      style={{ fontSize: 11, fontWeight: 700, fill: 'var(--ps-color-text)' }}
    >
      {`${(percent * 100).toFixed(1)}%`}
    </text>
  );
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
  showPercentLabels = false,
}: DonutChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  const canExport = useCanExport();
  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, (title ?? 'donut-chart').replace(/\s+/g, '-').toLowerCase());
  };

  if (segments.length === 0 || total === 0) {
    return <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No data to chart.</p>;
  }

  return (
    <div style={{ width: '100%' }}>
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
            </div>
          )}
          <ResponsiveContainer width="100%" height={height}>
            <PieChart>
              <Pie
                data={segments}
                dataKey="value"
                nameKey="label"
                innerRadius="60%"
                outerRadius={showPercentLabels ? '76%' : '88%'}
                paddingAngle={2}
                isAnimationActive={false}
                onClick={onSegmentClick ? (d: any) => onSegmentClick(d?.id ?? d?.payload?.id) : undefined}
                label={showPercentLabels ? renderPercentLabel : undefined}
                labelLine={showPercentLabels ? { stroke: 'var(--ps-color-muted-text)' } : false}
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
              <Tooltip
                formatter={(value: number, name: string, entry: any) => {
                  const count = entry?.payload?.count;
                  const pct = `${((value / total) * 100).toFixed(2)}%`;
                  const countText = typeof count === 'number' ? ` (${count.toLocaleString()} invoice${count === 1 ? '' : 's'})` : '';
                  return [`${valueFormatter(value)} -- ${pct}${countText}`, name];
                }}
                contentStyle={{
                  borderRadius: 10,
                  border: '1px solid var(--ps-color-border)',
                  fontSize: 12,
                  background: 'var(--ps-color-surface)',
                  color: 'var(--ps-color-text)',
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
                  <span style={{ color: 'var(--ps-color-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.label}
                  </span>
                  <span style={{ color: 'var(--ps-color-muted-text)', fontWeight: 600, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {valueFormatter(s.value)} ({((s.value / total) * 100).toFixed(2)}%{typeof s.count === 'number' ? `, ${s.count.toLocaleString()}` : ''})
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
          </ul>
        </div>
      </div>
    </div>
  );
}
