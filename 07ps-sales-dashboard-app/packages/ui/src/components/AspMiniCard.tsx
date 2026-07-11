import React from 'react';
import { Card } from './Card';
import { SemanticBadge } from './SemanticBadge';
import { LoadingSkeleton } from './LoadingSkeleton';
import { Sparkline } from './Sparkline';
import { theme } from '../theme';
import type { SemanticStatus } from './KpiTile';
// Reused from KpiCard to avoid duplication
import type { ReferenceMetric } from './GaugeCard';

export interface AspMiniCardProps {
  title: string;
  /** Formatted actual ASP value (e.g. "LYD 87.75"). */
  actualLabel: string;
  actualFullValue?: string;
  /** Formatted target ASP value (e.g. "LYD 73.65"), shown as a small caption. */
  targetLabel?: string;
  status: SemanticStatus;
  /** Bottom-row reference tiles (Target / Variance / Last Year). */
  referenceMetrics?: ReferenceMetric[];
  /** Recent values (oldest first) for a small inline sparkline. Optional. */
  sparklineValues?: number[];
  loading?: boolean;
}

/**
 * Tachometer rebuild (Option B - lighter-weight secondary metric type): compact ASP card for
 * the middle column between the Value/Volume KpiCard columns. Per the design consistency fix:
 *
 * - Removed status-tinted background wash. Status now communicated only via the SemanticBadge
 *   pill, matching all other cards.
 * - Shares the same neutral Card wrapper as KpiCard to ensure consistent visual depth and
 *   grid alignment.
 * - Lighter-weight than KpiCard (no gauge/bullet visual), but includes the same reference
 *   metrics row and optional sparkline at the bottom, keeping structural consistency.
 * - Fills its grid cell entirely with no dead space, aligning uniformly in height with
 *   Value/Volume cards.
 *
 * The mockup's example showing a "green highlighted pill" is illustrative of the on-track
 * case. This component always colors the pill from the real `status` prop (classifyVsTarget's
 * result, passed down unchanged), so a Behind Target or Critical ASP renders with its true
 * watch/alert color, never a fake green.
 */
export function AspMiniCard({
  title,
  actualLabel,
  actualFullValue,
  targetLabel,
  status,
  referenceMetrics = [],
  sparklineValues,
  loading,
}: AspMiniCardProps) {
  if (loading) {
    return (
      <Card style={{ width: '100%', height: '100%' }}>
        <LoadingSkeleton variant="kpi" />
      </Card>
    );
  }

  const tileCount = referenceMetrics.length + (sparklineValues && sparklineValues.length > 1 ? 1 : 0);
  const hasMetricsOrSparkline = tileCount > 0;

  return (
    <Card
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: theme.aspCard.padding,
      }}
    >
      {/* Top row: title (left), status badge (right) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 'var(--ps-space-2, 8px)',
        }}
      >
        <span style={{ fontSize: theme.aspCard.titleFontSize, fontWeight: 700, color: 'var(--ps-color-muted-text)', letterSpacing: 0.2 }}>
          {title}
        </span>
        <SemanticBadge status={status} />
      </div>

      {/* Headline value */}
      <div
        title={actualFullValue}
        style={{
          fontSize: theme.aspCard.valueFontSize,
          fontWeight: 700,
          color: 'var(--ps-color-text)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.15,
          marginBottom: targetLabel ? 4 : 'var(--ps-space-2, 8px)',
        }}
      >
        {actualLabel}
      </div>

      {/* Target label if provided */}
      {targetLabel && (
        <div style={{ fontSize: theme.aspCard.targetFontSize, color: 'var(--ps-color-muted-text)', marginBottom: 'var(--ps-space-2, 8px)' }}>
          Target: {targetLabel}
        </div>
      )}

      {/* Bottom row: reference metrics + optional sparkline, pinned to bottom via marginTop: auto */}
      {hasMetricsOrSparkline && (
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
            <div key={m.label} style={{ textAlign: 'center' }}>
              <div
                title={m.fullValue}
                style={{
                  fontSize: theme.metricCard.tileValueFontSize,
                  fontWeight: 600,
                  color: 'var(--ps-color-text)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {m.value}
              </div>
              <div style={{ fontSize: theme.metricCard.tileLabelFontSize, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>
                {m.label}
              </div>
            </div>
          ))}
          {sparklineValues && sparklineValues.length > 1 && (
            <div style={{ textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkline values={sparklineValues} status={status} label={`${title} trend`} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
