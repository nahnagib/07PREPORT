import React, { useRef } from 'react';
import { ResponsiveContainer, FunnelChart as RechartsFunnelChart, Funnel, Cell, LabelList, Tooltip } from 'recharts';
import { exportSvgAsImage } from '../chartExport';

export interface FunnelStage {
  id: string;
  label: string;
  value: number;
  /** Optional secondary figure for this stage (e.g. its total monetary value alongside `value`'s
   * count) -- shown in the tooltip/legend next to the primary value when `secondaryValueFormatter`
   * is also provided. Omit for a chart with no secondary figure (behaves exactly as before). */
  secondaryValue?: number;
  /** Fill color for this stage -- callers assign from existing design-system tokens (e.g.
   * var(--ps-color-accent), var(--ps-color-gold)), same "borrow a few brand/semantic hues for a
   * category dimension with no dedicated token" convention as Invoices Engine's
   * INVOICE_CLASS_COLOR. This component has no color opinion of its own. */
  color: string;
}

export interface FunnelChartProps {
  title?: string;
  /** Suppress the internal title text (still renders the Export image button) -- same convention
   * as every other chart in this package. Defaults to true. */
  showTitle?: boolean;
  stages: FunnelStage[];
  valueFormatter?: (value: number) => string;
  /** Formats each stage's `secondaryValue` (e.g. currency) for the tooltip/legend. Omit to hide
   * the secondary figure entirely, even if stages carry one. */
  secondaryValueFormatter?: (value: number) => string;
  height?: number;
  /** Segments become clickable and invoke this with the clicked stage's `id` -- same convention as
   * DonutChart's onSegmentClick. Optional: Pipeline Health's funnel isn't specified as interactive,
   * but the hook is here for consistency/reuse by any future caller. */
  onStageClick?: (id: string) => void;
}

function defaultFormatter(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * A real funnel's *shape* narrows (or holds steady) top to bottom by definition -- it never gets
 * wider than the stage above it. Real CRM conversion data frequently doesn't behave that way (e.g.
 * one opportunity spawning several quotation revisions, or one sales order producing several
 * partial deliveries -- a later stage's row count can legitimately, and by a wide margin, exceed an
 * earlier one's). Sizing each trapezoid directly off `value` in that case produces an hourglass,
 * not a funnel; capping each stage's width at the minimum of itself and the stage above (the other
 * common fix) turns out no better here -- when *every* later stage is larger than the one before
 * it, that cap never actually decreases, so it collapses into a stack of equal-width blocks with
 * no visible taper at all, not the "wide at top, progressively narrower" shape a funnel needs.
 *
 * So the shape is deliberately rank-based, not magnitude-based: each stage gets a fixed,
 * evenly-decreasing width purely from its position (1st stage widest, last stage narrowest),
 * completely decoupled from `value` -- which still drives every number actually shown (legend,
 * tooltip, click payload). The shape always reads as a clean funnel silhouette regardless of how
 * the underlying counts relate to each other; the data displayed is never altered or hidden, only
 * the geometry is normalized.
 */
function computeDisplayWidths(stageCount: number): number[] {
  if (stageCount === 0) return [];
  if (stageCount === 1) return [1];
  const minWidth = 0.32;
  const step = (1 - minWidth) / (stageCount - 1);
  return Array.from({ length: stageCount }, (_, i) => 1 - i * step);
}

/** Same "count (percentage of first stage) · value" string in both the tooltip and the legend
 * below the chart, computed once so the two can never drift apart. The secondary value segment is
 * only appended when both a formatter and a value are present, so charts with no secondary figure
 * render exactly as before. */
function stageValueLabel(
  stage: FunnelStage,
  first: number,
  valueFormatter: (v: number) => string,
  secondaryValueFormatter?: (v: number) => string,
): string {
  const pct = first > 0 ? ` (${((stage.value / first) * 100).toFixed(1)}%)` : '';
  const secondary =
    secondaryValueFormatter && stage.secondaryValue != null ? ` · ${secondaryValueFormatter(stage.secondaryValue)}` : '';
  return `${valueFormatter(stage.value)}${pct}${secondary}`;
}

/**
 * Conversion funnel -- built for the Pipeline Health page's "Full Pipeline" chart (record counts
 * per CRM stage: Opportunities -> Quotations -> Sales Orders -> Deliveries). Uses Recharts' own
 * Funnel/FunnelChart (already part of the recharts@2.12.7 dependency this package already has, no
 * new package needed). Same CSS-variable theming, "Export image" SVG->PNG button, and legend-with-
 * value-and-percentage-of-first-stage convention as DonutChart, so it reads as the same chart
 * family despite the different shape.
 */
export function FunnelChart({
  title,
  showTitle = true,
  stages,
  valueFormatter = defaultFormatter,
  secondaryValueFormatter,
  height = 320,
  onStageClick,
}: FunnelChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const first = stages[0]?.value ?? 0;
  const displayWidths = computeDisplayWidths(stages.length);
  const chartData = stages.map((s, i) => ({ ...s, displayWidth: displayWidths[i] }));

  const handleExportImage = () => {
    exportSvgAsImage(containerRef.current, (title ?? 'funnel-chart').replace(/\s+/g, '-').toLowerCase());
  };

  if (stages.length === 0) {
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
      </div>

      <div ref={containerRef} style={{ width: '100%' }}>
        <ResponsiveContainer width="100%" height={height}>
          {/* margin.right reserves room for the right-side stage-name LabelList below. Recharts'
              Funnel.getRealWidthHeight subtracts left/right margin TWICE (once already applied by
              generateCategoricalChart's offset calc, then again inside Funnel itself) -- confirmed
              by reading node_modules/recharts's source and reproducing empirically, since a large
              margin (110px right, previously) collapsed the funnel to a razor-thin sliver instead of
              reserving label space. Keep this margin small: right=40 reserves ~80px of *effective*
              width (doubled) plus Recharts' own hardcoded 50px internal buffer -- enough for the
              longest stage name ("Sales Order → Delivery"-length labels) without re-triggering the
              collapse. left stays 0 since no room is needed on that side. */}
          <RechartsFunnelChart margin={{ top: 0, right: 40, bottom: 0, left: 0 }}>
            <Tooltip
              // The shape is driven by the synthetic `displayWidth`, not the real value -- pull the
              // real value back off the hovered stage's own payload so the tooltip always shows the
              // actual count/percentage/value, matching the legend below exactly (see stageValueLabel).
              formatter={(_value: number, name: string, entry: any) => {
                const stage: FunnelStage | undefined = entry?.payload;
                return [stage ? stageValueLabel(stage, first, valueFormatter, secondaryValueFormatter) : '', name];
              }}
              contentStyle={{
                borderRadius: 10,
                border: '1px solid var(--ps-color-border)',
                fontSize: 12,
                background: 'var(--ps-color-surface)',
                color: 'var(--ps-color-text)',
              }}
            />
            <Funnel
              dataKey="displayWidth"
              nameKey="label"
              data={chartData}
              isAnimationActive={false}
              onClick={onStageClick ? (d: any) => onStageClick(d?.id ?? d?.payload?.id) : undefined}
            >
              <LabelList position="right" dataKey="label" fill="var(--ps-color-text)" stroke="none" fontSize={12} />
              {stages.map((s) => (
                <Cell key={s.id} fill={s.color} style={{ cursor: onStageClick ? 'pointer' : 'default' }} />
              ))}
            </Funnel>
          </RechartsFunnelChart>
        </ResponsiveContainer>
      </div>

      <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {stages.map((s) => (
          <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--ps-color-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.label}>
              {s.label}
            </span>
            <span style={{ color: 'var(--ps-color-muted-text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0, whiteSpace: 'nowrap' }}>
              {stageValueLabel(s, first, valueFormatter, secondaryValueFormatter)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
