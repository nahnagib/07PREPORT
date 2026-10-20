import React from 'react';
import { Card } from './Card';
import { SemanticBadge } from './SemanticBadge';
import { LoadingSkeleton } from './LoadingSkeleton';
import { Sparkline } from './Sparkline';
import type { SemanticStatus } from './KpiTile';
import type { ReferenceMetric } from './GaugeCard';

export interface CompactKpiCardProps {
  title: string;
  icon?: React.ComponentType<{ size?: number | string }>;
  status: SemanticStatus;
  /** The headline value, already formatted (e.g. "LYD 87.75", "18.46%"). */
  valueLabel: string;
  /** Hover text of the headline value (e.g. the formula with its counts). */
  valueTitle?: string;
  /** The stat row under the value (e.g. Target / Variance); hidden when empty. */
  referenceMetrics: ReferenceMetric[];
  /** Small caption lines under the stat row (e.g. "since 03 Oct 2026"). */
  notes?: React.ReactNode[];
  /** Trend values, oldest first; the sparkline needs at least 2. */
  sparklineValues?: number[];
  sparklineLabel?: string;
  loading?: boolean;
  testId?: string;
}

/**
 * The narrow middle card of the Promotion tachometer page ("YTD Actual ASP"), moved here unchanged so other pages reuse
 * the exact card instead of a copy: icon + title + status pill, the headline value, a stat row (value over label) and a
 * sparkline pinned to the bottom. No gauge: for a figure without a natural min..max (ASP) or one shown as a rate.
 */
export function CompactKpiCard({
  title,
  icon: Icon,
  status,
  valueLabel,
  valueTitle,
  referenceMetrics,
  notes,
  sparklineValues,
  sparklineLabel,
  loading,
  testId,
}: CompactKpiCardProps) {
  if (loading) {
    return (
      <Card style={{ width: '100%' }}>
        <LoadingSkeleton variant="kpi" />
      </Card>
    );
  }
  return (
    <Card style={{ width: '100%', display: 'flex', flexDirection: 'column', padding: 'var(--ps-space-3, 16px)' }} data-testid={testId}>
      {/* Top row: title + status badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 'var(--ps-space-2, 8px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {Icon && (
            <span style={{ color: 'var(--ps-color-muted-text)', display: 'flex', flexShrink: 0 }}>
              <Icon size={16} />
            </span>
          )}
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-muted-text)' }}>{title}</span>
        </div>
        <SemanticBadge status={status} />
      </div>

      {/* Headline value */}
      <div title={valueTitle} style={{ fontSize: 32, fontWeight: 700, color: 'var(--ps-color-text)', marginBottom: 'var(--ps-space-3, 16px)' }}>
        {valueLabel}
      </div>

      {/* Stats row: Target + Variance */}
      {referenceMetrics.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${referenceMetrics.length}, 1fr)`,
            gap: 'var(--ps-space-2, 8px)',
            marginBottom: 'var(--ps-space-3, 16px)',
            borderTop: '1px solid var(--ps-color-border)',
            paddingTop: 'var(--ps-space-2, 8px)',
          }}
        >
          {referenceMetrics.map((m) => (
            <div key={m.label} style={{ textAlign: 'center' }} title={m.fullValue}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ps-color-text)' }}>{m.value}</div>
              <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 2 }}>{m.label}</div>
            </div>
          ))}
        </div>
      )}

      {notes && notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--ps-color-muted-text)' }}>
          {notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      )}

      {/* Sparkline - pinned to bottom, enlarged to fill width */}
      {sparklineValues && sparklineValues.length > 1 && (
        <div style={{ marginTop: 'auto', paddingTop: 'var(--ps-space-2, 8px)' }}>
          <Sparkline values={sparklineValues} status={status} label={sparklineLabel ?? `${title} trend`} width={200} height={40} />
        </div>
      )}
    </Card>
  );
}
