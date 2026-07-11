import React from 'react';
import { Card } from './Card';

export type SemanticStatus = 'success' | 'watch' | 'alert' | 'neutral';

export interface KpiTileProps {
  /** Metric + Period, e.g. "YTD Value" - Section 3.26 naming convention */
  label: string;
  value: string;
  /** Signed variance, e.g. "+8.20%" - Section 3.6 Variance KPI cards */
  variance?: string;
  status?: SemanticStatus;
  loading?: boolean;
}

const statusColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

/**
 * Standards Section 3.6 - KPI Cards.
 * Value is large/bold (28-36px), label sits below in small muted grey (12-14px).
 * Color-coding follows the single semantic scale (3.9); KPIs with no target use neutral grey/white.
 * Color is never the only signal (Section 5.10) - the numeric value is always shown alongside it.
 */
export function KpiTile({ label, value, variance, status = 'neutral', loading }: KpiTileProps) {
  if (loading) {
    return (
      <Card aria-label={`${label} loading`}>
        <div className="ps-skeleton" style={{ width: '60%', height: 28, marginBottom: 8 }} />
        <div className="ps-skeleton" style={{ width: '40%', height: 14 }} />
      </Card>
    );
  }
  return (
    <Card aria-label={label}>
      <div
        style={{
          fontSize: 32,
          fontWeight: 700,
          color: statusColorVar[status],
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{label}</div>
      {variance && (
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            marginTop: 4,
            color: variance.trim().startsWith('-') ? 'var(--ps-color-alert)' : 'var(--ps-color-success)',
          }}
        >
          {variance}
        </div>
      )}
    </Card>
  );
}
