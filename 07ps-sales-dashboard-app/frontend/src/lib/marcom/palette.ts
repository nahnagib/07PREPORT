/**
 * Non-RAG colours for charts. RAG colours (green/yellow/red) are used ONLY where the API supplies a
 * status; everything else takes these theme-token series colours or the categorical palettes below.
 * The categorical palettes are colour-blind-safe (Okabe-Ito based) and readable on the light and
 * dark surfaces; every use is paired with a legend or text label.
 */
export const SERIES = {
  primary: 'var(--ps-color-accent)',
  /** Not the theme's --ps-color-trend-y1 orange: that is 2.2:1 on the light card (contrast.test.ts). */
  secondary: '#D55E00',
  reference: 'var(--ps-color-last-year)',
  highlight: 'var(--ps-color-trend-target)',
  grid: 'var(--ps-color-border)',
  text: 'var(--ps-color-muted-text)',
} as const;

/** Eight distinguishable colours for the event types (index = position in the API's byType keys). */
export const CATEGORICAL_8 = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#7A5195', '#8C8C8C'] as const;
export const CATEGORICAL_5 = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9'] as const;

/** Lifecycle statuses (campaigns and events). Deliberately not the RAG colours. */
export const LIFECYCLE: Record<string, string> = {
  Planned: '#56B4E9',
  Ongoing: '#0072B2',
  Completed: '#7A5195',
  'On Hold': '#E69F00',
  Postponed: '#E69F00',
  Cancelled: '#8C8C8C',
};
export const lifecycleColor = (status: string): string => LIFECYCLE[status] ?? '#8C8C8C';

export const RAG_COLOR = {
  green: 'var(--ps-color-success)',
  yellow: 'var(--ps-color-watch)',
  red: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-neutral-text)',
  na: 'var(--ps-color-neutral-text)',
} as const;

export const RAG_BG = {
  green: 'var(--ps-color-success-bg)',
  yellow: 'var(--ps-color-watch-bg)',
  red: 'var(--ps-color-alert-bg)',
  neutral: 'var(--ps-color-muted-bg)',
  na: 'var(--ps-color-muted-bg)',
} as const;
