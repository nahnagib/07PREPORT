import React from 'react';
import type { SemanticStatus } from './KpiTile';

export interface GaugeProps {
  /** Actual value the needle points to (e.g. YTD Value in LYD). */
  actual: number;
  /**
   * The grey to-date target marker (Tachometer manual: "Gray value -> To Date Target"). Null
   * renders the gauge with no target marker and no colored zones (a flat neutral track) --
   * matches classify.ts's NO_TARGET case, where there's nothing meaningful to compare against.
   */
  targetToDate: number | null;
  /**
   * Color status for the needle and the "achieved" zone boundary. This MUST come from the
   * backend's classifyVsTarget result (src/measures/classify.ts) -- the gauge never recomputes
   * the green/yellow/red threshold itself, per the Tachometer build instructions. This prop only
   * drives which color the needle/zone-boundary use; the zone geometry (0-90%/90-100%/100%+ of
   * target) is a fixed visual convention matching the manual's "Color Zones" definition, not a
   * second implementation of the classification logic.
   */
  status: SemanticStatus;
  size?: number;
  /** Accessible label, e.g. "YTD Value". */
  label?: string;
  /**
   * Formatted headline text (e.g. "LYD 531,584") rendered as the ONE authoritative value label
   * inside the gauge. See git history / status-report.md for the original overlap-bug writeup;
   * this is now the only place a value label renders for the gauge.
   */
  valueLabel?: string;
  /**
   * UI-improvements pass: formatted to-date-target text (e.g. "LYD 63.7M"), rendered next to the
   * grey marker line so the target is legible as a number, not just a tick mark. Falls back to a
   * plain toLocaleString of targetToDate if omitted. Also duplicated into a native SVG <title> on
   * the marker line itself, so hovering it always reveals the exact value even if the on-canvas
   * label had to be abbreviated for space.
   */
  targetLabel?: string;
  /**
   * UI-improvements pass: when the caller renders its own, larger headline value elsewhere (e.g.
   * GaugeCard now shows the current value as a standalone HTML line above the gauge, per the
   * requested Name -> Value -> Gauge -> Target -> Supporting hierarchy), the gauge's own internal
   * number becomes a redundant second copy of the same figure. Defaults to true (unchanged
   * behavior for any consumer that doesn't pass this) so this is purely additive.
   */
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

/**
 * Describes a semicircular arc from startAngle to endAngle (in the 0=right/90=top/180=left
 * convention), sweeping clockwise on screen -- i.e. left -> top -> right for startAngle=180,
 * endAngle=0. Used both for the full background track and for each colored zone segment.
 */
function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = Math.abs(startAngle - endAngle) <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

/** Maps a value (scaleMin..scaleMax) to an angle (180..0) along the semicircle. */
function valueToAngle(value: number, scaleMin: number, scaleMax: number): number {
  const clamped = Math.max(scaleMin, Math.min(scaleMax, value));
  const span = scaleMax - scaleMin;
  const ratio = span > 0 ? (clamped - scaleMin) / span : 0;
  return 180 - ratio * 180;
}

/** Short, unit-less axis label (e.g. "63.7K", "2.3M") - packages/ui has no access to
 * frontend/src/lib/format.ts's currency/volume-aware formatters, and axis labels don't need a
 * unit prefix anyway (the headline value already carries it). */
function compactAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// viewBox height: 150. The value label sits at y = cy + 42 = 142, an 8-unit margin from the
// bottom edge.
const VIEWBOX_WIDTH = 200;
const VIEWBOX_HEIGHT = 150;

/**
 * Semicircular needle gauge, per the Tachometer manual: "Needle position -> Actual performance.
 * Gray value -> To Date Target. Colored scale -> Performance vs target." Color zones: Green =
 * target achieved or exceeded, Yellow = within 10% below target, Red = more than 10% below target
 * (Standards Section 3.9 / manual "Color Zones") -- fixed visual geometry, not a second
 * implementation of classifyVsTarget (see the `status` prop's docstring above).
 *
 * UI-improvements pass, gauge scale: the manual didn't specify numeric scale bounds, so the gauge
 * used to size itself dynamically (max(actual, target) * 1.15). Per this pass's explicit request,
 * the *advertised* scale is now always Target x0.5 (left edge) .. Target x1.5 (right edge) when a
 * target exists - shown as small numbers at each end of the arc - which also has the nice property
 * that the target marker always sits at dead-center (top) of the gauge, since target is exactly
 * the midpoint of that range.
 *
 * One deliberate, disclosed safety net: if `actual` itself falls outside that x0.5..x1.5 window
 * (common for badly-missed targets in the real data - e.g. actual at 12% of target), the
 * *geometry* bounds (not the advertised labels) quietly extend just far enough to keep the needle
 * from being falsely pinned at an edge that would otherwise read as "half of target" when the real
 * number is much further off. The on-canvas scale labels always show the literal Target x0.5/x1.5
 * numbers regardless, so nothing is hidden - only the needle's invisible placement bounds adjust.
 */
export function Gauge({
  actual,
  targetToDate,
  status,
  size = 180,
  label,
  valueLabel,
  targetLabel,
  showValueLabel = true,
}: GaugeProps) {
  const cx = 100;
  const cy = 100;
  const r = 80;
  const trackWidth = 14;

  const hasTarget = targetToDate !== null && targetToDate > 0;

  const advertisedScaleMin = hasTarget ? (targetToDate as number) * 0.5 : null;
  const advertisedScaleMax = hasTarget ? (targetToDate as number) * 1.5 : null;

  let scaleMin = hasTarget ? (advertisedScaleMin as number) : 0;
  let scaleMax = hasTarget ? (advertisedScaleMax as number) : Math.max(actual, 1) * 1.15;
  if (hasTarget) {
    // Safety extension - see docstring above. Never shrinks the range, only grows it outward.
    if (actual < scaleMin) scaleMin = actual * 0.95;
    if (actual > scaleMax) scaleMax = actual * 1.05;
  }

  const yellowFloor = hasTarget ? (targetToDate as number) * 0.9 : 0;
  const needleAngle = valueToAngle(actual, scaleMin, scaleMax);
  const targetAngle = hasTarget ? valueToAngle(targetToDate as number, scaleMin, scaleMax) : null;

  const needleTip = polarToCartesian(cx, cy, r - trackWidth / 2 - 2, needleAngle);
  const markerInner = targetAngle !== null ? polarToCartesian(cx, cy, r - trackWidth - 4, targetAngle) : null;
  const markerOuter = targetAngle !== null ? polarToCartesian(cx, cy, r + 4, targetAngle) : null;
  // Target value label - placed inside the arc face (radius 50, well clear of both the colored
  // track at radius ~73-87 and the needle hub at radius 7) so it never gets clipped by the canvas
  // edge regardless of where the target marker angle falls.
  const targetLabelPos = targetAngle !== null ? polarToCartesian(cx, cy, 50, targetAngle) : null;
  const targetLabelAnchor: 'start' | 'middle' | 'end' =
    targetAngle === null ? 'middle' : targetAngle > 100 ? 'end' : targetAngle < 80 ? 'start' : 'middle';
  const targetLabelText = targetLabel ?? (hasTarget ? compactAxis(targetToDate as number) : '');

  const displayLabel = valueLabel ?? actual.toLocaleString(undefined, { maximumFractionDigits: 0 });

  const ariaLabel = label
    ? `${label}: ${actual.toLocaleString()}${
        hasTarget
          ? `, target-to-date ${(targetToDate as number).toLocaleString()}, gauge scale ${compactAxis(
              advertisedScaleMin as number,
            )} to ${compactAxis(advertisedScaleMax as number)}`
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

      {/* Grey to-date target marker -- a radial tick crossing the colored zones. Native <title>
          gives a hover tooltip fallback in addition to the always-visible text label below. */}
      {markerInner && markerOuter && (
        <line
          x1={markerInner.x}
          y1={markerInner.y}
          x2={markerOuter.x}
          y2={markerOuter.y}
          stroke="var(--ps-neutral-granite)"
          strokeWidth={3}
        >
          <title>{`To-date target: ${targetLabelText}`}</title>
        </line>
      )}

      {/* Target value label, inside the arc face (see targetLabelPos comment above). */}
      {targetLabelPos && targetLabelText && (
        <text
          x={targetLabelPos.x}
          y={targetLabelPos.y}
          textAnchor={targetLabelAnchor}
          fontSize="9"
          fontWeight={600}
          fill="var(--ps-neutral-granite)"
        >
          {targetLabelText}
        </text>
      )}

      {/* Scale min/max labels at each end of the arc - "the user should always know the gauge
          range." Only shown when there's a target, since the scale is defined as Target x0.5/x1.5. */}
      {hasTarget && (
        <>
          <text x={cx - r} y={cy + 16} textAnchor="start" fontSize="8.5" fill="var(--ps-color-muted-text)">
            {compactAxis(advertisedScaleMin as number)}
          </text>
          <text x={cx + r} y={cy + 16} textAnchor="end" fontSize="8.5" fill="var(--ps-color-muted-text)">
            {compactAxis(advertisedScaleMax as number)}
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
        strokeWidth={4}
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r={7} fill={needleColorVar[status]} />

      {/* The value label for this gauge - skippable via showValueLabel when the caller renders its
          own separate headline number (see the prop's docstring above). y = cy + 42 = 142, an
          8-unit margin inside the 150-unit viewBox. */}
      {showValueLabel && (
        <text
          x={cx}
          y={cy + 42}
          textAnchor="middle"
          fontSize="26"
          fontWeight={700}
          fill="var(--ps-color-text)"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {displayLabel}
        </text>
      )}
    </svg>
  );
}
