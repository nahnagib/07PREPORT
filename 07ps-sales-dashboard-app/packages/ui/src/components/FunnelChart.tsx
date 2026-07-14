import React, { useRef } from 'react';
import { ResponsiveContainer, FunnelChart as RechartsFunnelChart, Funnel, Cell, LabelList, Tooltip } from 'recharts';

export interface FunnelStage {
  id: string;
  label: string;
  value: number;
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
 * Conversion funnel -- built for the Pipeline Health page's "Full Pipeline" chart (record counts
 * per CRM stage: Leads -> Opportunities -> Quotations -> Sales Orders -> Deliveries). Uses
 * Recharts' own Funnel/FunnelChart (already part of the recharts@2.12.7 dependency this package
 * already has, no new package needed). Same CSS-variable theming, "Export image" SVG->PNG button,
 * and legend-with-value-and-percentage-of-first-stage convention as DonutChart, so it reads as the
 * same chart family despite the different shape.
 */
export function FunnelChart({
  title,
  showTitle = true,
  stages,
  valueFormatter = defaultFormatter,
  height = 320,
  onStageClick,
}: FunnelChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const first = stages[0]?.value ?? 0;

  const handleExportImage = () => {
    const container = containerRef.current;
    if (!container) return;
    const svg = container.querySelector('svg');
    if (!svg) return;
    try {
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const bg = window.getComputedStyle(document.body).getPropertyValue('background-color') || '#ffffff';
      const serialized = new XMLSerializer().serializeToString(clone);
      const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const width = svg.clientWidth || 400;
        const heightPx = svg.clientHeight || 320;
        const canvas = document.createElement('canvas');
        canvas.width = width * 2;
        canvas.height = heightPx * 2;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(2, 2);
        ctx.fillStyle = bg || '#ffffff';
        ctx.fillRect(0, 0, width, heightPx);
        ctx.drawImage(img, 0, 0, width, heightPx);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (!blob) return;
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = `${(title ?? 'funnel-chart').replace(/\s+/g, '-').toLowerCase()}.png`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        });
      };
      img.src = url;
    } catch {
      // Export is a convenience action -- fail silently rather than surfacing a console-only error.
    }
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
          <RechartsFunnelChart>
            <Tooltip
              formatter={(value: number, name: string) => [valueFormatter(value), name]}
              contentStyle={{
                borderRadius: 10,
                border: '1px solid var(--ps-color-border)',
                fontSize: 12,
                background: 'var(--ps-color-surface)',
                color: 'var(--ps-color-text)',
              }}
            />
            <Funnel
              dataKey="value"
              nameKey="label"
              data={stages}
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
            <span style={{ color: 'var(--ps-color-text)', flex: 1 }}>{s.label}</span>
            <span style={{ color: 'var(--ps-color-muted-text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {valueFormatter(s.value)}
              {first > 0 && ` (${((s.value / first) * 100).toFixed(1)}%)`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
