import React from 'react';
import { Card } from './Card';
import { RadialGauge } from './RadialGauge';
import { BulletChart } from './BulletChart';
import { ProgressBar } from './ProgressBar';
import { Sparkline } from './Sparkline';
import { SemanticBadge } from './SemanticBadge';
import { LoadingSkeleton } from './LoadingSkeleton';
import { ErrorState } from './ErrorState';
import { theme } from '../theme';
import type { SemanticStatus } from './KpiTile';
// Reused, not redeclared, to avoid a duplicate-export ambiguity in index.ts's `export *` barrel --
// GaugeCard.tsx (left in place, unused, per this session's convention) already defines the
// identical shape.
import type { ReferenceMetric } from './GaugeCard';
export type { ReferenceMetric };

export interface KpiTrend {
  direction: 'up' | 'down' | 'flat';
  /** e.g. "+4.2% vs LY" */
  label: string;
}

export interface KpiCardProps {
  title: string;
  actual: number;
  targetToDate: number | null;
  status: SemanticStatus;
  /** Formatted actual value (e.g. "LYD 40.4M") - the card's single, largest headline number. */
  actualLabel: string;
  /** Full-precision headline value for the hover tooltip. */
  actualFullValue?: string;
  /** Formatted to-date-target value, threaded into the gauge/bullet's own target label/tooltip. */
  targetLabel?: string;
  /** Which center visualization to render. 'gauge' for Value/Volume metrics, 'bullet' for ASP --
   * both share the exact same Card shell, header, and bottom-row layout, so ASP cards are now
   * visually identical in every dimension except the center visual itself. */
  variant?: 'gauge' | 'bullet';
  icon?: React.ComponentType<{ size?: number | string }>;
  /** Bottom-row reference tiles (e.g. Target / Variance / Last Year). */
  referenceMetrics: ReferenceMetric[];
  /** Optional trend indicator rendered as its own bottom-row tile (arrow + label), per the redesign
   * brief's "Target, Variance, Last Year, Trend indicator" bottom-row spec. */
  trend?: KpiTrend;
  /** Recent values (oldest first) for a small inline sparkline next to the headline value --
   * Tachometer rebuild (dark-theme pass)'s "discrete trend sparkline" ask. Optional and purely
   * additive; omitted entirely when not provided. */
  sparklineValues?: number[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  /** Optional click handler - makes the whole card an interactive, keyboard-accessible control
   * (used for the Tachometer drill-down feature). */
  onClick?: () => void;
  /** When true, uses the full-width metric card theme (larger gauge, no maxWidth constraint) for
   * drill-down detail pages where the gauge should dominate the viewport. */
  fullWidth?: boolean;
}

const trendColorVar: Record<KpiTrend['direction'], string> = {
  up: 'var(--ps-color-success)',
  down: 'var(--ps-color-alert)',
  flat: 'var(--ps-color-muted-text)',
};

function TrendArrow({ direction }: { direction: KpiTrend['direction'] }) {
  const color = trendColorVar[direction];
  if (direction === 'up') {
    return (
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 17 L11 9 L15 13 L20 6" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 6 H20 V12" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (direction === 'down') {
    return (
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 7 L11 15 L15 11 L20 18" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 18 H20 V12" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 12 H20" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
    </svg>
  );
}

/**
 * Complete UI Redesign pass: the single KPI card component, replacing both GaugeCard.tsx and
 * StatCard.tsx. Per the redesign brief's explicit complaint ("ASP cards currently look completely
 * different... same height/width/padding/typography/visual weight"), every metric -- Value,
 * Volume, or ASP -- now goes through this one component and this one Card shell; only the `variant`
 * prop changes which visual (RadialGauge vs BulletChart) fills the center slot, both of which share
 * the same width and a comparable footprint so no card looks structurally different from another.
 *
 * Layout (per the redesign brief):
 *   Top row    - icon + title (left), status badge (right)
 *   Center     - large headline value, then the gauge/bullet visual (which itself renders the
 *                to-date target marker/label -- no separate duplicate target line here)
 *   Bottom row - reference-metric tiles (Target / Variance / Last Year / ...) plus an optional
 *                trend-arrow tile, pinned to the card's bottom edge via marginTop: 'auto' so cards
 *                in the same row line up regardless of the grid cell's stretched height.
 *
 * classifyVsTarget is still the single source of truth: `status` always arrives from the backend
 * classification and is never recomputed here -- it only drives which color the badge/needle/
 * measure-bar/decorative wave use.
 *
 * GaugeCard.tsx and StatCard.tsx are left in place, unused, per this session's convention of not
 * deleting superseded components.
 */
export function KpiCard({
  title,
  actual,
  targetToDate,
  status,
  actualLabel,
  actualFullValue,
  targetLabel,
  variant = 'gauge',
  icon: Icon,
  referenceMetrics,
  trend,
  sparklineValues,
  loading,
  error,
  onRetry,
  onClick,
  fullWidth = false,
}: KpiCardProps) {
  // Use full-width theme values when rendering on a detail page, else use standard metric card theme
  const activeTheme = fullWidth ? theme.metricCardFullWidth : theme.metricCard;
  if (loading) {
    return (
      <Card aria-label={`${title} loading`} style={{ width: '100%', height: '100%' }}>
        <LoadingSkeleton variant="chart" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card aria-label={`${title} error`} style={{ width: '100%', height: '100%' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <ErrorState message={error} onRetry={onRetry} />
      </Card>
    );
  }

  const clickableProps = onClick
    ? {
        onClick,
        role: 'button' as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        },
        className: 'ps-card-clickable',
      }
    : {};

  const tileCount = referenceMetrics.length + (trend ? 1 : 0);
  const hasTarget = targetToDate !== null && targetToDate > 0;
  const achievementPct = hasTarget ? Math.round((actual / (targetToDate as number)) * 100) : null;

  return (
    <Card
      aria-label={onClick ? `${title}, view breakdown by dimension` : title}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        cursor: onClick ? 'pointer' : undefined,
        // Goldilocks-size pass: the compact-cards pass's 8px-vertical padding went a step too far
        // once the gauge/fonts below were also shrunk -- eased back up to a mid-point pad that
        // still avoids the original oversized dead air.
        padding: 'var(--ps-space-3, 16px) var(--ps-space-4, 24px)',
      }}
      {...clickableProps}
    >
      {/* Top row: icon + title (left), status badge (right). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--ps-space-2, 8px)',
          gap: 'var(--ps-space-2, 8px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {Icon && (
            <span aria-hidden style={{ color: 'var(--ps-color-muted-text)', display: 'flex', flexShrink: 0 }}>
              <Icon size={16} />
            </span>
          )}
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--ps-color-muted-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
        </div>
        <SemanticBadge status={status} />
      </div>

      {/* Center: headline value (single largest number on the card). Design System Enforcement
          pass: font size now reads from theme.metricCard.headlineFontSize (shared with the
          breakdown detail page's summary card) instead of a locally-picked literal. */}
      <div
        title={actualFullValue}
        style={{
          fontSize: activeTheme.headlineFontSize,
          fontWeight: 700,
          color: 'var(--ps-color-text)',
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'center',
          lineHeight: 1.1,
        }}
      >
        {actualLabel}
      </div>

      {/* Center: gauge or bullet visual - self-contained (renders its own target marker/label),
          so nothing here duplicates the headline value or the target. Design System Enforcement
          pass: size now reads from theme.metricCard (gaugeSize/bulletWidth) -- the single place
          that controls "how big is a primary metric card's visual" for every KpiCard everywhere,
          so Standardize gauge components across the app just falls out of using one component.
          marginTop was -4px (pulling the gauge up against the headline value) -- RadialGauge's own
          grey target label now sits near the top of its arc (tracking the target's tick mark, not
          the needle), which put it right up against the headline text above with almost no gap.
          A few px of positive top margin here restores clear separation between the two values,
          without touching RadialGauge's internal geometry (which has very little spare vertical
          room before the colored track begins). */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: '0 1 auto', marginTop: 6, marginBottom: -4 }}>
        {variant === 'bullet' ? (
          <BulletChart
            actual={actual}
            targetToDate={targetToDate}
            status={status}
            label={title}
            showValueLabel={false}
            targetLabel={targetLabel}
            width={activeTheme.bulletWidth}
          />
        ) : (
          <RadialGauge
            actual={actual}
            targetToDate={targetToDate}
            status={status}
            label={title}
            showValueLabel={false}
            targetLabel={targetLabel}
            size={activeTheme.gaugeSize}
          />
        )}
      </div>

      {/* Achievement progress bar + readout - a second view of the same actual/targetToDate ratio
          the gauge/bullet already shows above, never a second calculation, plus an optional inline
          sparkline (Tachometer rebuild, dark-theme pass). */}
      {(hasTarget || (sparklineValues && sparklineValues.length > 1)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 'var(--ps-space-2, 8px)' }}>
          {hasTarget && (
            <div style={{ flex: 1 }}>
              <ProgressBar actual={actual} targetToDate={targetToDate} status={status} />
            </div>
          )}
          {hasTarget && (
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color:
                  status === 'success'
                    ? 'var(--ps-color-success)'
                    : status === 'watch'
                      ? 'var(--ps-color-watch)'
                      : status === 'alert'
                        ? 'var(--ps-color-alert)'
                        : 'var(--ps-color-muted-text)',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {achievementPct}%
            </div>
          )}
          {sparklineValues && sparklineValues.length > 1 && (
            <Sparkline values={sparklineValues} status={status} label={`${title} trend`} />
          )}
        </div>
      )}

      {/* Bottom row: reference-metric tiles + optional trend indicator, pinned to the bottom edge
          via marginTop: 'auto' so cards line up across a stretched grid row. Design consistency
          fix: removed DecorativeWave (status-tinted background wash). Status is now communicated
          only via the SemanticBadge pill and gauge/bullet colors. */}
      <div
        style={{
          marginTop: 'auto',
          display: 'grid',
          gridTemplateColumns: `repeat(${tileCount || 1}, 1fr)`,
          gap: 'var(--ps-space-2, 8px)',
          borderTop: '1px solid var(--ps-color-border)',
          paddingTop: 'var(--ps-space-2, 8px)',
          borderRadius: '0 0 var(--ps-card-radius, 8px) var(--ps-card-radius, 8px)',
        }}
      >
        {referenceMetrics.map((m) => (
          <div key={m.label} style={{ textAlign: 'center', position: 'relative' }}>
            <div
              title={m.fullValue}
              style={{
                fontSize: activeTheme.tileValueFontSize,
                fontWeight: 600,
                color: 'var(--ps-color-text)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {m.value}
            </div>
            <div style={{ fontSize: activeTheme.tileLabelFontSize, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>
              {m.label}
            </div>
          </div>
        ))}
        {trend && (
          <div style={{ textAlign: 'center', position: 'relative' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                fontSize: activeTheme.tileValueFontSize,
                fontWeight: 600,
                color: trendColorVar[trend.direction],
              }}
            >
              <TrendArrow direction={trend.direction} />
              {trend.label}
            </div>
            <div style={{ fontSize: activeTheme.tileLabelFontSize, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>
              Trend
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
