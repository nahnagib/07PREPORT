import React from 'react';
import type { SemanticStatus } from './KpiTile';

export interface BarChartRow {
  id: string;
  label: string;
  actual: number;
  targetToDate: number | null;
  status: SemanticStatus;
  /** Pre-formatted value text (e.g. "LYD 40.4M") - packages/ui has no currency/volume-aware
   * formatter, same convention as Gauge's valueLabel/targetLabel. */
  valueLabel: string;
  targetLabel?: string;
}

const statusColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

/**
 * Horizontal bar chart for the Tachometer drill-down page's "large interactive chart" requirement.
 * Hand-rolled (div/CSS bars, not SVG or a charting library) - consistent with this package's
 * existing approach of building visuals directly rather than taking on a charting-library
 * dependency for something this shape-simple (see Gauge.tsx, also hand-rolled). Each bar's length
 * is proportional to `actual` relative to the largest actual/target in the visible set; a thin tick
 * marks the to-date target on top of the bar, same "grey marker" language as the Gauge.
 *
 * This is the primary visual for the breakdown (same rows as the interactive table below it), not
 * a second, disconnected data source -- it renders exactly the rows passed in, already sorted and
 * classified upstream.
 */
export function BreakdownBarChart({ rows }: { rows: BarChartRow[] }) {
  const maxScale = Math.max(1, ...rows.map((r) => Math.max(r.actual, r.targetToDate ?? 0)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map((r) => {
        const barPct = Math.min(100, (Math.max(r.actual, 0) / maxScale) * 100);
        const targetPct = r.targetToDate != null ? Math.min(100, (r.targetToDate / maxScale) * 100) : null;
        return (
          <div key={r.id}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                fontSize: 12,
                marginBottom: 4,
                gap: 8,
              }}
            >
              <span
                style={{
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.label}
              </span>
              <span
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--ps-color-muted-text)',
                  flexShrink: 0,
                }}
              >
                {r.valueLabel}
              </span>
            </div>
            <div
              style={{
                position: 'relative',
                height: 18,
                background: 'var(--ps-color-muted-bg)',
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${barPct}%`,
                  background: statusColorVar[r.status],
                  borderRadius: 6,
                  transition: 'width 0.2s ease',
                }}
              />
              {targetPct !== null && (
                <div
                  title={r.targetLabel ? `To-date target: ${r.targetLabel}` : undefined}
                  style={{
                    position: 'absolute',
                    top: -2,
                    bottom: -2,
                    left: `${targetPct}%`,
                    width: 2,
                    background: 'var(--ps-neutral-granite)',
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
      {rows.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>No rows to chart.</p>
      )}
    </div>
  );
}
