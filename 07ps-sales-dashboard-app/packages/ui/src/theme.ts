/**
 * Design System Enforcement pass: a centralized JS-side theme configuration object.
 *
 * tokens.css already centralizes color/spacing/radius as CSS custom properties -- that remains the
 * single source of truth for anything a browser can express as a CSS value. This file exists for
 * the *other* category of value that was drifting across components: numbers that JS itself needs
 * to reason about (an SVG gauge's pixel size, a card's max-width, a font-size scale for a card's
 * internal hierarchy) which can't just be `var(--ps-space-3)`. Before this pass, KpiCard.tsx,
 * AspMiniCard.tsx, and the breakdown detail page each hand-picked their own numbers for these, which
 * is exactly how the two pages ended up visually inconsistent with each other. Every one of those
 * call sites now imports from here instead.
 *
 * Not exhaustive by design: values that are already single-sourced elsewhere (SemanticBadge's
 * colors, tokens.css's spacing/radius scale) are intentionally left where they are rather than
 * duplicated into a second config object.
 *
 * Relationship to packages/ui/src/tokens/ (colors.ts / spacing.ts / typography.ts): that directory
 * predates the dark-theme rebuild and has drifted out of sync with tokens.css (e.g. its cardRadius
 * is still '8px' against the CSS scale's current 14px, and its fontFamily still leads with Cairo
 * rather than Inter) -- nothing in this codebase currently imports from it. Left in place per this
 * session's "don't delete superseded work" convention rather than edited in-place, since rewriting
 * it to match current values while nothing consumes it would just be busywork; flagged in
 * status-report.md as a real inconsistency worth cleaning up (or removing) in a future pass. This
 * file is the one JS-side config new component code should actually import.
 */
export const theme = {
  /** The one shared "Primary Metric" card footprint (KpiCard's outer slot) -- used identically by
   * the summary page's CARD_BOX and the breakdown detail page's summary card, so a YTD Value card
   * is never a different size depending on which page it's rendered on. */
  metricCard: {
    maxWidth: 360,
    gaugeSize: 240,
    bulletWidth: 200,
    headlineFontSize: 26,
    tileValueFontSize: 12.5,
    tileLabelFontSize: 10,
  },
  /** Full-width variant for drill-down detail pages where the gauge should dominate the viewport. */
  metricCardFullWidth: {
    maxWidth: 'none',
    gaugeSize: 340,
    bulletWidth: 300,
    headlineFontSize: 32,
    tileValueFontSize: 13,
    tileLabelFontSize: 11,
  },
  /** The center ASP mini-card -- deliberately smaller/lighter than a full metric card, but its
   * padding/type scale is still centralized here (rather than re-picked per usage) so it stays in
   * proportion if the metric-card scale above ever changes again. */
  aspCard: {
    padding: '18px 20px',
    titleFontSize: 13,
    valueFontSize: 26,
    targetFontSize: 12,
  },
  /** PerformanceReportTable's type scale -- also reused by any other tabular breakdown (e.g. the
   * detail page's DataGrid wrapper) that wants to visually match it. */
  table: {
    titleFontSize: 14.5,
    bodyFontSize: 12.5,
    headerFontSize: 12,
  },
} as const;
