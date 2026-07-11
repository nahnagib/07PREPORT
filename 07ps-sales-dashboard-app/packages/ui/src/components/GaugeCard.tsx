import React from 'react';
import { Card } from './Card';
import { Gauge } from './Gauge';
import { ProgressBar } from './ProgressBar';
import { SemanticBadge } from './SemanticBadge';
import { LoadingSkeleton } from './LoadingSkeleton';
import { ErrorState } from './ErrorState';
import { DecorativeWave } from './DecorativeWave';
import type { SemanticStatus } from './KpiTile';

export interface ReferenceMetric {
  label: string;
  value: string;
  /** Full-precision value (e.g. "LYD 30,701,258") shown as a native tooltip when `value` is a
   * compact/abbreviated string (e.g. "LYD 30.7M") - nothing is ever thrown away, just deferred to
   * hover. Optional so existing callers that already pass full precision strings don't need to
   * change. */
  fullValue?: string;
}

export interface GaugeCardProps {
  title: string;
  actual: number;
  targetToDate: number | null;
  status: SemanticStatus;
  /** Formatted actual value (e.g. "LYD 40.4M") - the card's single, largest headline number. */
  actualLabel: string;
  /** Full-precision headline value for the hover tooltip (e.g. "LYD 40,401,670"). */
  actualFullValue?: string;
  /** Formatted to-date-target value (e.g. "LYD 63.7M"), threaded into the Gauge's own target
   * label/tooltip - see Gauge.tsx. */
  targetLabel?: string;
  /** Line-style icon (Standards Section 3.11) - decorative only, paired with the text title next
   * to it, never the sole carrier of meaning. */
  icon?: React.ComponentType<{ size?: number | string }>;
  /** Reference-metric tiles under the gauge -- LYTD/LMTD, FLY/FLM, FY/FM Target, per the manual. */
  referenceMetrics: ReferenceMetric[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  /**
   * Optional click handler. When provided, the whole card becomes an interactive,
   * keyboard-accessible control (Enter/Space activate it, same as a native button) -- used for the
   * Tachometer drill-down feature (clicking a gauge card navigates to a breakdown-by-dimension
   * detail page for that metric). Purely additive: a card without onClick renders and behaves
   * exactly as before.
   */
  onClick?: () => void;
}

/**
 * Composite Tachometer gauge card. Information hierarchy (UI-improvements pass, explicit request):
 * 1. KPI name (icon + title + status pill header row)
 * 2. Current value - the single largest number on the card, its own HTML line above the gauge
 * 3. Gauge - now a pure visual (needle/zones/target marker/scale), no longer duplicating the
 *    headline number inside its own SVG (see Gauge's `showValueLabel={false}` below) - avoids
 *    showing the same number twice in an already-tight square card
 * 4. Target - surfaced by the gauge itself (grey marker + on-arc target label + hover tooltip,
 *    see Gauge.tsx), not a second separate text line, so the card doesn't repeat information
 * 5. Supporting numbers (LYTD/FLY/FY Target reference tiles), pinned to the bottom via
 *    `marginTop: 'auto'` so they stay anchored to the card's bottom edge regardless of how tall
 *    the stretched grid cell is (see the `aspectRatio` wrapper each card is rendered inside on the
 *    Tachometer page, for uniform square-ish card dimensions across the whole grid)
 *
 * The status pill and the gauge's needle/zone color are guaranteed to agree because both are
 * driven by the same `status` prop from one classifyVsTarget call upstream - there is no second
 * classification anywhere in this component.
 */
export function GaugeCard({
  title,
  actual,
  targetToDate,
  status,
  actualLabel,
  actualFullValue,
  targetLabel,
  icon: Icon,
  referenceMetrics,
  loading,
  error,
  onRetry,
  onClick,
}: GaugeCardProps) {
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

  return (
    <Card
      aria-label={onClick ? `${title}, view breakdown by dimension` : title}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        cursor: onClick ? 'pointer' : undefined,
      }}
      {...clickableProps}
    >
      {/* 1. KPI name - icon + label (left) / status pill (right) - Standards Section 3.11. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 4,
          gap: 8,
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

      {/* 2. Current value - the largest number on the card, its own line above the gauge. */}
      <div
        title={actualFullValue}
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: 'var(--ps-color-text)',
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'center',
          lineHeight: 1.15,
        }}
      >
        {actualLabel}
      </div>

      {/* 3 + 4. Gauge (visual) + Target (marker/label/tooltip inside the gauge itself). */}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '-4px 0' }}>
        <Gauge
          actual={actual}
          targetToDate={targetToDate}
          status={status}
          label={title}
          showValueLabel={false}
          targetLabel={targetLabel}
          size={132}
        />
      </div>

      <div style={{ marginBottom: 8 }}>
        <ProgressBar actual={actual} targetToDate={targetToDate} status={status} />
      </div>

      {/* 5. Supporting numbers - pinned to the bottom of the (stretched) card via marginTop:auto,
          so cards of different intrinsic content height still line up visually across a row. */}
      <div
        style={{
          position: 'relative',
          marginTop: 'auto',
          display: 'grid',
          gridTemplateColumns: `repeat(${referenceMetrics.length}, 1fr)`,
          gap: 8,
          borderTop: '1px solid var(--ps-color-border)',
          paddingTop: 8,
          overflow: 'hidden',
          borderRadius: '0 0 var(--ps-card-radius, 8px) var(--ps-card-radius, 8px)',
        }}
      >
        <DecorativeWave status={status} />
        {referenceMetrics.map((m) => (
          <div key={m.label} style={{ textAlign: 'center', position: 'relative' }}>
            <div
              title={m.fullValue}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--ps-color-text)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {m.value}
            </div>
            <div style={{ fontSize: 9, color: 'var(--ps-color-muted-text)', marginTop: 1 }}>{m.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
