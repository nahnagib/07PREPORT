import type React from 'react';

/**
 * One tooltip theme for every chart and hover card (2026-11-02 dark-mode fix). Recharts' default tooltip paints each
 * line in the series colour, or #000 when a series has none (the Full Pipeline funnel), so in dark mode the text came
 * out black on the dark card. Every <Tooltip> spreads `chartTooltipProps`, and every custom tooltip box uses
 * `tooltipBoxStyle`; both read the --ps-tooltip-* tokens in styles/tokens.css, so a theme switch restyles an open
 * page at once (CSS variables, no re-render needed) and a new visual inherits the theme by using these.
 *
 * TOOLTIP_TOKENS mirrors the token values in tokens.css (a test keeps the two in step and checks WCAG AA contrast).
 */
export const TOOLTIP_TOKENS = {
  light: { bg: '#ffffff', fg: '#1a1a1a', muted: '#595959', border: '#d4d4d4' },
  dark: { bg: '#222b40', fg: '#f2f2f2', muted: '#c2c8d4', border: '#3b4661' },
} as const;

export type TooltipThemeMode = keyof typeof TOOLTIP_TOKENS;

/** Resolved tooltip colours for a theme -- for code that cannot use CSS variables (and for tests). */
export function tooltipColors(mode: TooltipThemeMode): (typeof TOOLTIP_TOKENS)[TooltipThemeMode] {
  return TOOLTIP_TOKENS[mode];
}

/** Box style for any custom tooltip / hover card. Muted text inside it (--ps-color-muted-text) switches to the
 * tooltip's own muted colour, which keeps AA contrast on the tooltip background. */
export const tooltipBoxStyle: React.CSSProperties = {
  background: 'var(--ps-tooltip-bg)',
  color: 'var(--ps-tooltip-fg)',
  border: '1px solid var(--ps-tooltip-border)',
  borderRadius: 10,
  boxShadow: 'var(--ps-tooltip-shadow)',
  fontSize: 12,
  ['--ps-color-muted-text' as string]: 'var(--ps-tooltip-muted)',
};

/** Spread onto every Recharts <Tooltip>: themed box, label and item text (never the series colour or #000). */
export const chartTooltipProps = {
  contentStyle: { ...tooltipBoxStyle, padding: '8px 10px' } as React.CSSProperties,
  labelStyle: { color: 'var(--ps-tooltip-fg)', fontWeight: 700, marginBottom: 2 } as React.CSSProperties,
  itemStyle: { color: 'var(--ps-tooltip-fg)', padding: '1px 0' } as React.CSSProperties,
  wrapperStyle: { outline: 'none', zIndex: 20 } as React.CSSProperties,
  /** Hover band behind a bar: a theme surface step, not Recharts' light-grey #ccc (glaring in dark mode). Line charts
   * keep their default thin cursor line. A chart can still pass its own `cursor` after the spread. */
  cursor: { fill: 'var(--ps-color-muted-bg)' },
};
