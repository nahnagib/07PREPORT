import React, { useId } from 'react';
import type { SemanticStatus } from './KpiTile';

export interface RadialGaugeProps {
  /** Actual value the needle points to (e.g. YTD Value in LYD). */
  actual: number;
  /**
   * The grey to-date target marker (Tachometer manual: "Gray value -> To Date Target"). Null
   * renders the gauge with no target marker and no colored zones (a flat neutral track) -- matches
   * classify.ts's NO_TARGET case, where there's nothing meaningful to compare against.
   */
  targetToDate: number | null;
  /**
   * Color status for the needle and the "achieved" zone boundary. This MUST come from the
   * backend's classifyVsTarget result (src/measures/classify.ts) -- this component never
   * recomputes the green/yellow/red threshold itself. This prop only drives which color the
   * needle/zone-boundary use; the zone geometry (0-90%/90-100%/100%+ of target) is a fixed visual
   * convention matching the manual's "Color Zones" definition, not a second implementation of the
   * classification logic.
   */
  status: SemanticStatus;
  size?: number;
  /** Accessible label, e.g. "YTD Value". */
  label?: string;
  /** Formatted headline text (e.g. "LYD 531.6K") rendered as the large value inside the gauge. */
  valueLabel?: string;
  /** Formatted to-date-target text (e.g. "LYD 63.7M"), rendered both next to the grey marker and
   * as a "Target: X" caption below the value. Falls back to a plain compact number if omitted. */
  targetLabel?: string;
  /** Hide the large internal value line when the caller renders its own headline elsewhere.
   * Defaults to true (shows the value) -- unlike the legacy Gauge, RadialGauge is meant to be the
   * single, self-contained KPI visual, so most consumers should leave this on. */
  showValueLabel?: boolean;
}

const zoneColorVar: Record<'red' | 'yellow' | 'green', string> = {
  red: 'var(--ps-color-alert)',
  yellow: 'var(--ps-color-watch)',
  green: 'var(--ps-color-success)',
};

const needleColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = Math.abs(startAngle - endAngle) <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function valueToAngle(value: number, scaleMin: number, scaleMax: number): number {
  const clamped = Math.max(scaleMin, Math.min(scaleMax, value));
  const span = scaleMax - scaleMin;
  const ratio = span > 0 ? (clamped - scaleMin) / span : 0;
  return 180 - ratio * 180;
}

/** Short, unit-less axis label (e.g. "63.7K", "2.3M"). */
function compactAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

const VIEWBOX_WIDTH = 260;
const VIEWBOX_HEIGHT = 214;

/**
 * Complete UI Redesign pass: a larger, clearer replacement for the legacy Gauge.tsx. Same
 * underlying math (polar geometry, Target x0.5/x1.5 scale, safety-extension for badly-missed
 * targets) -- reused rather than re-derived, per "keep the existing... calculations." What's new
 * is presentation: a bigger arc with a soft drop-shadow, explicit "50% of Target" / "150% of
 * Target" captions under the scale-end numbers (so the scale formula is legible at a glance, not
 * just inferable), end-cap and target-marker dots for a cleaner modern look, and a self-contained
 * value + "Target: X" caption so this component can be the single visual in a KpiCard slot.
 *
 * Legacy Gauge.tsx is left in place, unused, per this session's convention of not deleting
 * superseded components.
 */
export function RadialGauge({
  actual,
  targetToDate,
  status,
  size = 220,
  label,
  valueLabel,
  targetLabel,
  showValueLabel = true,
}: RadialGaugeProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const shadowId = `rg-shadow-${rawId}`;

  const cx = 130;
  const cy = 128;
  const r = 100;
  const trackWidth = 22;

  const hasTarget = targetToDate !== null && targetToDate > 0;

  const advertisedScaleMin = hasTarget ? (targetToDate as number) * 0.5 : null;
  const advertisedScaleMax = hasTarget ? (targetToDate as number) * 1.5 : null;

  let scaleMin = hasTarget ? (advertisedScaleMin as number) : 0;
  let scaleMax = hasTarget ? (advertisedScaleMax as number) : Math.max(actual, 1) * 1.15;
  if (hasTarget) {
    // Safety extension - see Gauge.tsx's original docstring. Never shrinks the range, only grows
    // it outward, and never changes the advertised on-canvas labels.
    if (actual < scaleMin) scaleMin = actual * 0.95;
    if (actual > scaleMax) scaleMax = actual * 1.05;
  }

  const yellowFloor = hasTarget ? (targetToDate as number) * 0.9 : 0;
  const needleAngle = valueToAngle(actual, scaleMin, scaleMax);
  const targetAngle = hasTarget ? valueToAngle(targetToDate as number, scaleMin, scaleMax) : null;

  const needleTip = polarToCartesian(cx, cy, r - trackWidth / 2 - 4, needleAngle);
  const markerInner = targetAngle !== null ? polarToCartesian(cx, cy, r - trackWidth - 6, targetAngle) : null;
  const markerOuter = targetAngle !== null ? polarToCartesian(cx, cy, r + 6, targetAngle) : null;
  const markerDot = targetAngle !== null ? polarToCartesian(cx, cy, r + 13, targetAngle) : null;
  // Target label sits right next to the grey tick/dot marker -- same targetAngle those use (NOT
  // needleAngle -- the needle is a separate, independent marker for the actual value; conflating
  // the two was the bug in the previous pass). Radius is just past markerDot's own radius (r + 13)
  // so the label reads as "attached to" the tick, not the needle, regardless of where actual falls.
  const targetLabelPos = targetAngle !== null ? polarToCartesian(cx, cy, r + 18, targetAngle) : null;
  const targetLabelAnchor: 'start' | 'middle' | 'end' =
    targetAngle === null ? 'middle' : targetAngle > 100 ? 'end' : targetAngle < 80 ? 'start' : 'middle';
  const targetLabelText = targetLabel ?? (hasTarget ? compactAxis(targetToDate as number) : '');

  const displayLabel = valueLabel ?? actual.toLocaleString(undefined, { maximumFractionDigits: 0 });

  const ariaLabel = label
    ? `${label}: ${actual.toLocaleString()}${
        hasTarget
          ? `, target-to-date ${(targetToDate as number).toLocaleString()}, gauge scale ${compactAxis(
              advertisedScaleMin as number,
            )} to ${compactAxis(advertisedScaleMax as number)} (50% to 150% of target)`
          : ''
      }`
    : `${actual.toLocaleString()}`;

  return (
    <svg
      width={size}
      height={size * (VIEWBOX_HEIGHT / VIEWBOX_WIDTH)}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <filter id={shadowId} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.18" />
        </filter>
      </defs>

      <g filter={`url(#${shadowId})`}>
        {!hasTarget && (
          <path
            d={describeArc(cx, cy, r, 180, 0)}
            fill="none"
            stroke="var(--ps-color-border)"
            strokeWidth={trackWidth}
            strokeLinecap="round"
          />
        )}
        {hasTarget && (
          <>
            {/* Red zone: scale min -> 90% of target */}
            <path
              d={describeArc(cx, cy, r, 180, valueToAngle(yellowFloor, scaleMin, scaleMax))}
              fill="none"
              stroke={zoneColorVar.red}
              strokeWidth={trackWidth}
              strokeLinecap="round"
            />
            {/* Yellow zone: 90% -> 100% of target */}
            <path
              d={describeArc(
                cx,
                cy,
                r,
                valueToAngle(yellowFloor, scaleMin, scaleMax),
                valueToAngle(targetToDate as number, scaleMin, scaleMax),
              )}
              fill="none"
              stroke={zoneColorVar.yellow}
              strokeWidth={trackWidth}
            />
            {/* Green zone: 100% of target -> scale max */}
            <path
              d={describeArc(cx, cy, r, valueToAngle(targetToDate as number, scaleMin, scaleMax), 0)}
              fill="none"
              stroke={zoneColorVar.green}
              strokeWidth={trackWidth}
              strokeLinecap="round"
            />
          </>
        )}
      </g>

      {/* Grey to-date target marker: a radial tick crossing the colored zones, capped with a small
          dot just outside the track so it reads clearly even at a glance. Native <title> gives a
          hover tooltip in addition to the always-visible text label below. */}
      {markerInner && markerOuter && (
        <>
          <line
            x1={markerInner.x}
            y1={markerInner.y}
            x2={markerOuter.x}
            y2={markerOuter.y}
            stroke="var(--ps-neutral-granite)"
            strokeWidth={3.5}
          >
            <title>{`To-date target: ${targetLabelText}`}</title>
          </line>
          {markerDot && (
            <circle cx={markerDot.x} cy={markerDot.y} r={3.5} fill="var(--ps-neutral-granite)">
              <title>{`To-date target: ${targetLabelText}`}</title>
            </circle>
          )}
        </>
      )}

      {/* Scale min/max numbers stay always-visible; the "50%/150% of Target" explanation moves into
          a native hover tooltip on each number (via <title>) instead of permanent caption text
          underneath, keeping the space below the arc clean. Only shown when there's a target. */}
      {hasTarget && (
        <>
          <text x={cx - r + 4} y={cy + 26} textAnchor="start" fontSize="13" fontWeight={700} fill="var(--ps-color-text)" style={{ cursor: 'help' }}>
            {compactAxis(advertisedScaleMin as number)}
            <title>{`Min · 50% of Target (${targetLabelText})`}</title>
          </text>
          <text x={cx + r - 4} y={cy + 26} textAnchor="end" fontSize="13" fontWeight={700} fill="var(--ps-color-text)" style={{ cursor: 'help' }}>
            {compactAxis(advertisedScaleMax as number)}
            <title>{`Max · 150% of Target (${targetLabelText})`}</title>
          </text>
        </>
      )}

      {/* Needle: actual performance. */}
      <line
        x1={cx}
        y1={cy}
        x2={needleTip.x}
        y2={needleTip.y}
        stroke={needleColorVar[status]}
        strokeWidth={5}
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r={9} fill={needleColorVar[status]} />
      <circle cx={cx} cy={cy} r={3.5} fill="var(--ps-color-surface)" />

      {/* Target value label -- attached to the grey tick/dot marker (targetAngle), not the needle.
          Rendered after the needle so it still paints on top in the (rare) case the needle happens
          to point near the same angle as the target. */}
      {targetLabelPos && targetLabelText && (
        <text
          x={targetLabelPos.x}
          y={targetLabelPos.y}
          textAnchor={targetLabelAnchor}
          fontSize="11"
          fontWeight={700}
          fill="var(--ps-neutral-granite)"
        >
          {targetLabelText}
        </text>
      )}

      {/* Large current-value line, with a smaller "Target: X" caption directly beneath it, so the
          gauge is a fully self-contained KPI visual (no external value line required). */}
      {showValueLabel && (
        <>
          <text
            x={cx}
            y={cy + 66}
            textAnchor="middle"
            fontSize="30"
            fontWeight={700}
            fill="var(--ps-color-text)"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {displayLabel}
          </text>
          {hasTarget && (
            <text x={cx} y={cy + 86} textAnchor="middle" fontSize="12" fill="var(--ps-color-muted-text)">
              Target: {targetLabelText}
            </text>
          )}
        </>
      )}
    </svg>
  );
}
