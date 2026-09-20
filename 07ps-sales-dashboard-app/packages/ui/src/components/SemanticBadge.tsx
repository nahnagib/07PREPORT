import React from 'react';
import type { SemanticStatus } from './KpiTile';

// Complete UI Redesign (v2) pass: wording aligned to the new reference mockup's exact status
// vocabulary ("On Track" / "Behind Target" / "Critical") - still the exact same SemanticStatus
// values driven by classifyVsTarget, never a second classification (see KpiCard.tsx).
// Exported (name prefixed to stay collision-safe under this package's `export *` barrel) so
// anything that needs this exact wording outside a live badge -- e.g. DataGrid's PDF export,
// which rasterizes a detached, off-screen DOM tree rather than mounting <SemanticBadge> -- stays
// byte-for-byte in sync with what the dashboard itself shows, instead of a second copy that can
// drift.
export const SEMANTIC_STATUS_LABEL: Record<SemanticStatus, string> = {
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

/** Same statuses, resolved to their LIGHT-theme hex value (tokens.css) instead of a CSS var.
 * PDF export always rasterizes onto a fixed white page regardless of the viewer's current
 * light/dark theme (see DataGrid's exportPdf/pdfExport.ts's own hardcoded #ffffff background), so
 * the export needs a color it can bake into that fixed-white layout directly -- a dark-theme CSS
 * var would still resolve (custom properties inherit into the detached export container), but
 * could resolve to a dark-theme color ill-suited to a white page. */
export const SEMANTIC_STATUS_PDF_COLOR: Record<SemanticStatus, string> = {
  success: '#2e7d32',
  watch: '#b8860b',
  alert: '#cc0033',
  neutral: '#666666',
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
      {SEMANTIC_STATUS_LABEL[status]}
    </span>
  );
}
