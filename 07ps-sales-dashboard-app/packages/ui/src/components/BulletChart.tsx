import React from 'react';
import type { SemanticStatus } from './KpiTile';

export interface BulletChartProps {
  /** Actual value (e.g. YTD ASP in LYD/ton). */
  actual: number;
  /** To-date target. Null renders a flat neutral track with no zones/tick, matching classify.ts's
   * NO_TARGET case. */
  targetToDate: number | null;
  /**
   * Color status for the measure bar's end-cap and accessible description. Comes from the
   * backend's classifyVsTarget result -- this component never recomputes the classification, only
   * renders it. The zone geometry (0-90%/90-100%/100%+ of target) is a fixed visual convention
   * matching the same rule the RadialGauge uses, so ASP cards read the same way as Value/Volume
   * cards at a glance.
   */
  status: SemanticStatus;
  width?: number;
  /** Accessible label, e.g. "YTD ASP". */
  label?: string;
  /** Formatted headline text (e.g. "LYD 137.5") rendered as the large value above the bar. */
  valueLabel?: string;
  /** Formatted to-date-target text (e.g. "LYD 130.0"), rendered as a caption and next to the tick. */
  targetLabel?: string;
  /** Hide the internal value/target text when the caller renders its own headline elsewhere.
   * Defaults to true, matching RadialGauge. */
  showValueLabel?: boolean;
}

const zoneColorVar: Record<'red' | 'yellow' | 'green', string> = {
  red: 'var(--ps-color-alert)',
  yellow: 'var(--ps-color-watch)',
  green: 'var(--ps-color-success)',
};

const statusColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

function compactAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

const VIEWBOX_WIDTH = 260;
const VIEWBOX_HEIGHT = 150;

/**
 * Complete UI Redesign pass: the ASP visualization, replacing the plain green ProgressBar. A
 * standard enterprise-BI "bullet chart" (Stephen Few pattern) -- a horizontal qualitative-range
 * track (the same red/90%/yellow/100%/green zone convention as RadialGauge, using the identical
 * Target x0.5..x1.5 scale so ASP cards are literally on the same measurement scale as Value/Volume
 * cards) with a solid dark "measure" bar showing the actual value and a tick showing the to-date
 * target. This is what lets ASP sit in a KpiCard slot with the exact same visual weight as a gauge,
 * per the redesign brief's explicit "same height, width, padding, typography" requirement.
 *
 * StatCard.tsx / ProgressBar.tsx are left in place, unused, per this session's convention of not
 * deleting superseded components.
 */
export function BulletChart({
  actual,
  targetToDate,
  status,
  width = 260,
  label,
  valueLabel,
  targetLabel,
  showValueLabel = true,
}: BulletChartProps) {
  const hasTarget = targetToDate !== null && targetToDate > 0;

  const advertisedScaleMin = hasTarget ? (targetToDate as number) * 0.5 : null;
  const advertisedScaleMax = hasTarget ? (targetToDate as number) * 1.5 : null;

  let scaleMin = hasTarget ? (advertisedScaleMin as number) : 0;
  let scaleMax = hasTarget ? (advertisedScaleMax as number) : Math.max(actual, 1) * 1.15;
  if (hasTarget) {
    // Safety extension, same convention as RadialGauge: never shrinks the range, only grows it
    // outward when the actual value itself falls outside the advertised x0.5..x1.5 window.
    if (actual < scaleMin) scaleMin = actual * 0.95;
    if (actual > scaleMax) scaleMax = actual * 1.05;
  }

  const span = scaleMax - scaleMin;
  const toX = (v: number) => {
    const clamped = Math.max(scaleMin, Math.min(scaleMax, v));
    const ratio = span > 0 ? (clamped - scaleMin) / span : 0;
    return barX0 + ratio * (barX1 - barX0);
  };

  const barX0 = 24;
  const barX1 = VIEWBOX_WIDTH - 24;
  const barY = 74;
  const barHeight = 28;
  const measureHeight = 12;

  const yellowFloor = hasTarget ? (targetToDate as number) * 0.9 : 0;
  const targetX = hasTarget ? toX(targetToDate as number) : null;
  const measureX = toX(actual);

  const targetLabelText = targetLabel ?? (hasTarget ? compactAxis(targetToDate as number) : '');
  const displayLabel = valueLabel ?? actual.toLocaleString(undefined, { maximumFractionDigits: 0 });

  const ariaLabel = label
    ? `${label}: ${actual.toLocaleString()}${
        hasTarget
          ? `, target-to-date ${(targetToDate as number).toLocaleString()}, scale ${compactAxis(
              advertisedScaleMin as number,
            )} to ${compactAxis(advertisedScaleMax as number)} (50% to 150% of target)`
          : ''
      }`
    : `${actual.toLocaleString()}`;

  return (
    <svg
      width={width}
      height={width * (VIEWBOX_HEIGHT / VIEWBOX_WIDTH)}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      role="img"
      aria-label={ariaLabel}
    >
      {showValueLabel && (
        <text
          x={VIEWBOX_WIDTH / 2}
          y={34}
          textAnchor="middle"
          fontSize="28"
          fontWeight={700}
          fill="var(--ps-color-text)"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {displayLabel}
        </text>
      )}
      {showValueLabel && hasTarget && (
        <text x={VIEWBOX_WIDTH / 2} y={54} textAnchor="middle" fontSize="12" fill="var(--ps-color-muted-text)">
          Target: {targetLabelText}
        </text>
      )}

      {/* Qualitative range track - same red/yellow/green convention as RadialGauge. */}
      {!hasTarget && (
        <rect x={barX0} y={barY} width={barX1 - barX0} height={barHeight} rx={6} fill="var(--ps-color-muted-bg)" />
      )}
      {hasTarget && (
        <>
          <rect
            x={barX0}
            y={barY}
            width={toX(yellowFloor) - barX0}
            height={barHeight}
            fill={zoneColorVar.red}
            opacity={0.85}
          />
          <rect
            x={toX(yellowFloor)}
            y={barY}
            width={toX(targetToDate as number) - toX(yellowFloor)}
            height={barHeight}
            fill={zoneColorVar.yellow}
            opacity={0.85}
          />
          <rect
            x={toX(targetToDate as number)}
            y={barY}
            width={barX1 - toX(targetToDate as number)}
            height={barHeight}
            fill={zoneColorVar.green}
            opacity={0.85}
          />
          {/* rounded end-caps drawn on top so the composite track still reads as one pill shape */}
          <rect x={barX0} y={barY} width={barX1 - barX0} height={barHeight} rx={6} fill="none" stroke="var(--ps-color-surface)" strokeOpacity={0} />
        </>
      )}

      {/* Measure bar: the actual value, as a solid dark bar centered within the track (classic
          bullet-chart "measure"). */}
      <rect
        x={barX0}
        y={barY + (barHeight - measureHeight) / 2}
        width={Math.max(measureX - barX0, 2)}
        height={measureHeight}
        rx={3}
        fill="var(--ps-neutral-charcoal)"
        opacity={0.82}
      />
      {/* Status-colored end cap on the measure bar, so the status reads at a glance without
          needing to compare against the tick. */}
      <circle cx={measureX} cy={barY + barHeight / 2} r={6} fill={statusColorVar[status]}>
        <title>{`Actual: ${displayLabel}`}</title>
      </circle>

      {/* Target tick - a vertical line crossing the full track height, per the bullet-chart
          "comparative measure" convention. */}
      {targetX !== null && (
        <line
          x1={targetX}
          y1={barY - 6}
          x2={targetX}
          y2={barY + barHeight + 6}
          stroke="var(--ps-neutral-granite)"
          strokeWidth={3}
        >
          <title>{`To-date target: ${targetLabelText}`}</title>
        </line>
      )}

      {/* Scale min/max, with the same "% of Target" captions RadialGauge uses. */}
      {hasTarget && (
        <>
          <text x={barX0} y={barY + barHeight + 22} textAnchor="start" fontSize="12" fontWeight={700} fill="var(--ps-color-text)">
            {compactAxis(advertisedScaleMin as number)}
          </text>
          <text x={barX0} y={barY + barHeight + 36} textAnchor="start" fontSize="8.5" fill="var(--ps-color-muted-text)">
            Min · 50% of Target
          </text>
          <text x={barX1} y={barY + barHeight + 22} textAnchor="end" fontSize="12" fontWeight={700} fill="var(--ps-color-text)">
            {compactAxis(advertisedScaleMax as number)}
          </text>
          <text x={barX1} y={barY + barHeight + 36} textAnchor="end" fontSize="8.5" fill="var(--ps-color-muted-text)">
            Max · 150% of Target
          </text>
        </>
      )}
    </svg>
  );
}
