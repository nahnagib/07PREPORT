/**
 * Design tokens - Standards Section 3.9 (Color System) + Section 7 of tech-stack-decision.md
 * (tokens derived from BMH/Majaal/Tika logo assets, not invented placeholder hex values).
 *
 * Light/dark pairs per Section 3.19 - Dark Mode Strategy: "Color tokens are defined as
 * light/dark pairs from the start ... so no dashboard needs bespoke dark-mode work."
 */

export const neutral = {
  white: '#FFFFFF',
  ashGrey: '#B0B0B0',
  graniteGrey: '#666666',
  ironGrey: '#333333',
  charcoal: '#1A1A1A',
  black: '#000000',
} as const;

export const businessUnitAccent = {
  all: neutral.charcoal,
  majaal: neutral.charcoal, // Section 7: consistent with Majaal's own ratified grayscale brand guide
  tika: '#003366', // Section 7: extracted from tikalogo.png navy wordmark
} as const;

/** Section 3.9: green/amber/red thresholds - on target / within 10% / beyond 10%. Brand-independent. */
export const semantic = {
  successGreen: '#2E7D32', // at/above target
  watchAmber: '#B8860B', // within 10% below target
  alertRed: '#CC0033', // more than 10% below target (aligned to Tika logo's red mark - Section 7)
  lastYearGrey: '#8C8C8C', // historical comparison series only - Section 3.7
} as const;

/** Section 3.7: Actual = blue / Last Year = grey / Target = red, fixed across every chart. */
export const chartSeries = {
  actual: businessUnitAccent.tika,
  lastYear: semantic.lastYearGrey,
  target: semantic.alertRed,
} as const;

export type BusinessUnit = 'all' | 'majaal' | 'tika';
