import React from 'react';
import type { SemanticStatus } from './KpiTile';

export interface ProgressBarProps {
  actual: number;
  targetToDate: number | null;
  status: SemanticStatus;
  /** Accessible label, e.g. "62% of to-date target". Auto-generated if omitted. */
  label?: string;
}

const fillColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

/**
 * A second view of the SAME actual-vs-target ratio the Gauge already shows -- not a second
 * calculation. Deliberately takes the identical `actual`/`targetToDate`/`status` props as Gauge so
 * the two can never silently disagree (both are driven by one classifyVsTarget result upstream).
 *
 * Standards Section 3.9 - reuses the single semantic color scale, never an ad hoc gradient.
 */
export function ProgressBar({ actual, targetToDate, status, label }: ProgressBarProps) {
  const hasTarget = targetToDate !== null && targetToDate > 0;
  const ratio = hasTarget ? Math.max(0, Math.min(1, actual / (targetToDate as number))) : 0;
  const pct = Math.round(ratio * 100);
  const ariaLabel = label ?? (hasTarget ? `${pct}% of to-date target` : 'No target set');

  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={hasTarget ? pct : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        width: '100%',
        height: 6,
        borderRadius: 999,
        background: 'var(--ps-color-border)',
        overflow: 'hidden',
      }}
    >
      {hasTarget && (
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 999,
            background: fillColorVar[status],
            transition: 'width 0.2s ease-out',
          }}
        />
      )}
    </div>
  );
}
