import React from 'react';
import type { SemanticStatus } from './KpiTile';

// Complete UI Redesign (v2) pass: wording aligned to the new reference mockup's exact status
// vocabulary ("On Track" / "Behind Target" / "Critical") - still the exact same SemanticStatus
// values driven by classifyVsTarget, never a second classification (see KpiCard.tsx).
const label: Record<SemanticStatus, string> = {
  success: 'On Track',
  watch: 'Behind Target',
  alert: 'Critical',
  neutral: 'No Target',
};

const colorVar: Record<SemanticStatus, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
};

/**
 * Standards Section 3.9 / 5.10 - semantic status pill.
 * Accessibility rule: "Color is never the only signal" - text label always accompanies the color.
 */
export function SemanticBadge({ status }: { status: SemanticStatus }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: colorVar[status],
        border: `1px solid ${colorVar[status]}`,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: '50%', background: colorVar[status], flexShrink: 0 }}
      />
      {label[status]}
    </span>
  );
}
