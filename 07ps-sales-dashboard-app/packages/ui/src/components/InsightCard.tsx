import React from 'react';
import { Card } from './Card';
import type { SemanticStatus } from './KpiTile';

export interface InsightCardProps {
  icon?: React.ComponentType<{ size?: number | string }>;
  /** e.g. "KPIs On Target" */
  label: string;
  /** e.g. "4 / 6" */
  value: string;
  /** Optional secondary line under the value, e.g. "66% of tracked metrics". */
  caption?: string;
  /** Drives the icon-badge color and (unless accentBg=false) a soft tinted card background, using
   * the redesign pass's --ps-color-success-bg/-watch-bg/-alert-bg tokens (see tokens.css) rather
   * than a heavy saturated fill. */
  status?: SemanticStatus;
  /** Set false to render on the plain card background (still keeps the colored icon badge). */
  accentBg?: boolean;
  loading?: boolean;
}

const statusColorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-accent)',
};

const statusBgVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success-bg)',
  watch: 'var(--ps-color-watch-bg)',
  alert: 'var(--ps-color-alert-bg)',
  neutral: 'var(--ps-color-accent-bg)',
};

const statusBorderVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success-border)',
  watch: 'var(--ps-color-watch-border)',
  alert: 'var(--ps-color-alert-border)',
  neutral: 'var(--ps-color-border)',
};

/**
 * Complete UI Redesign pass: a compact, icon-led summary tile for the new Performance Summary
 * section (KPIs On Target, Critical KPIs, Average Achievement %, Best/Worst Performer, Health
 * Score) and the breakdown page's Quick Insights panel. Distinct from KpiTile (the older, plain
 * value/label/variance card still used elsewhere) in that it always leads with an icon in a soft
 * status-tinted badge and optionally tints its own background the same way -- "visually attractive
 * summary cards," per the redesign brief, without resorting to heavy saturated fills.
 */
export function InsightCard({
  icon: Icon,
  label,
  value,
  caption,
  status = 'neutral',
  accentBg = true,
  loading,
}: InsightCardProps) {
  if (loading) {
    return (
      <Card aria-label={`${label} loading`}>
        <div className="ps-skeleton" style={{ width: 32, height: 32, borderRadius: 8, marginBottom: 10 }} />
        <div className="ps-skeleton" style={{ width: '60%', height: 24, marginBottom: 6 }} />
        <div className="ps-skeleton" style={{ width: '40%', height: 12 }} />
      </Card>
    );
  }

  return (
    <Card
      aria-label={label}
      style={{
        background: accentBg ? statusBgVar[status] : 'var(--ps-card-bg)',
        border: `1px solid ${accentBg ? statusBorderVar[status] : 'var(--ps-color-border)'}`,
        height: '100%',
      }}
    >
      {Icon && (
        <div
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: 'var(--ps-card-radius-sm, 10px)',
            background: statusBgVar[status],
            color: statusColorVar[status],
            marginBottom: 'var(--ps-space-2, 8px)',
          }}
        >
          <Icon size={17} />
        </div>
      )}
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: 'var(--ps-color-text)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.15,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ps-color-muted-text)', marginTop: 3 }}>{label}</div>
      {caption && (
        <div style={{ fontSize: 11, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>{caption}</div>
      )}
    </Card>
  );
}
