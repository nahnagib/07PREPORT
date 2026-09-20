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
  /** Opt-in colored accent bar + icon/badge header row above the metric (e.g. one card per BCG
   * class, with that class's icon/color/name) -- omit for the plain card every other caller
   * already uses. All three of icon/accentColor/badgeLabel must be provided together to render
   * the header; providing only some is treated as "no header" rather than a partial one.
   *
   * This exists so a page that wants a class/category identity on its KPI cards (BCG Matrix) uses
   * the *same* KpiTile/Card as every plain card (Stock Velocity's 6-card row, etc.) instead of a
   * bespoke wrapper stacking a SECOND, independently-rounded Card inside an outer accent+header
   * wrapper -- that double-rounding is exactly what produced a corner-radius seam where the two
   * shapes met. Here there is still an outer wrapper (needed so the accent bar's own top corners
   * clip to the card's radius), but the Card underneath has its top corners squared off via
   * `borderTopLeftRadius`/`borderTopRightRadius: 0` so the two shapes are complementary -- wrapper
   * owns the top corners, Card owns the bottom ones -- rather than both independently rounding the
   * same region. */
  icon?: string;
  accentColor?: string;
  badgeLabel?: string;
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
export function KpiTile({ label, value, variance, status = 'neutral', loading, icon, accentColor, badgeLabel }: KpiTileProps) {
  const hasHeader = icon !== undefined && accentColor !== undefined && badgeLabel !== undefined;

  if (loading) {
    return (
      <Card aria-label={`${label} loading`}>
        <div className="ps-skeleton" style={{ width: '60%', height: 28, marginBottom: 8 }} />
        <div className="ps-skeleton" style={{ width: '40%', height: 14 }} />
      </Card>
    );
  }

  const body = (
    <Card
      aria-label={label}
      style={hasHeader ? { borderTopLeftRadius: 0, borderTopRightRadius: 0 } : undefined}
    >
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

  if (!hasHeader) return body;

  return (
    <div style={{ borderRadius: 'var(--ps-card-radius, 8px) var(--ps-card-radius, 8px) 0 0', overflow: 'hidden' }}>
      <div style={{ height: 3, background: accentColor }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--ps-card-bg)',
          padding: '10px 16px 0',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
            color: accentColor,
            background: `color-mix(in srgb, ${accentColor} 16%, transparent)`,
            padding: '3px 8px',
            borderRadius: 999,
          }}
        >
          {badgeLabel}
        </span>
      </div>
      {body}
    </div>
  );
}
