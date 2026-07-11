import React from 'react';
import { Card } from './Card';
import { ProgressBar } from './ProgressBar';
import { SemanticBadge } from './SemanticBadge';
import { LoadingSkeleton } from './LoadingSkeleton';
import { ErrorState } from './ErrorState';
import { DecorativeWave } from './DecorativeWave';
import type { SemanticStatus } from './KpiTile';
import type { ReferenceMetric } from './GaugeCard';

export interface StatCardProps {
  title: string;
  actual: number;
  targetToDate: number | null;
  status: SemanticStatus;
  /** Formatted headline number (e.g. "LYD 137.5") - same convention as GaugeCard's actualLabel. */
  actualLabel: string;
  /** Full-precision headline value for the hover tooltip, paired with actualLabel. */
  actualFullValue?: string;
  /** Formatted to-date-target value (e.g. "LYD 130.0") - StatCard has no gauge to embed a target
   * marker/label into, so this renders as its own small line instead (see GaugeCard, where the
   * equivalent information comes from the gauge itself). */
  targetLabel?: string;
  icon?: React.ComponentType<{ size?: number | string }>;
  referenceMetrics: ReferenceMetric[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onClick?: () => void;
}

/**
 * Compact, non-gauge KPI card - same information hierarchy as GaugeCard (name -> value -> [gauge
 * substitute] -> target -> supporting numbers), built for metrics that don't need the full
 * semicircular needle (e.g. ASP, placed as a column between two gauge columns). Deliberately
 * composed from the exact same shared primitives as GaugeCard (Card, ProgressBar, SemanticBadge,
 * LoadingSkeleton, ErrorState, DecorativeWave) so it stays visually and behaviorally consistent.
 */
export function StatCard({
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
}: StatCardProps) {
  if (loading) {
    return (
      <Card aria-label={`${title} loading`} style={{ width: '100%', height: '100%' }}>
        <LoadingSkeleton variant="kpi" />
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
      {/* 1. KPI name */}
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

      {/* 2. Current value - the largest number on the card. */}
      <div
        title={actualFullValue}
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: 'var(--ps-color-text)',
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'center',
          lineHeight: 1.15,
          margin: '4px 0',
        }}
      >
        {actualLabel}
      </div>

      {/* 3. Gauge-equivalent visual: the progress bar (StatCard has no dial). */}
      <div style={{ marginBottom: 4 }}>
        <ProgressBar actual={actual} targetToDate={targetToDate} status={status} />
      </div>

      {/* 4. Target - StatCard has no gauge to embed a target marker/label into, so it gets its own
          small line (GaugeCard's equivalent lives inside the Gauge SVG itself). */}
      {targetLabel && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--ps-color-muted-text)',
            textAlign: 'center',
            marginBottom: 8,
          }}
        >
          Target: <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{targetLabel}</span>
        </div>
      )}

      {/* 5. Supporting numbers - pinned to the bottom, same as GaugeCard. */}
      <div
        style={{
          position: 'relative',
          marginTop: 'auto',
          display: 'grid',
          gridTemplateColumns: `repeat(${referenceMetrics.length || 1}, 1fr)`,
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
