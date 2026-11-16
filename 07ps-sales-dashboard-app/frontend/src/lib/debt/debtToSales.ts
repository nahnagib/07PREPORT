/**
 * Debt to YTD Sales % (2026-11-15) = Total debt (LYD equivalent) ÷ YTD sales (LYD) × 100. Colour bands come from the
 * backend config (config/finance.ts DEBT_TO_SALES_BANDS): below greenMax green, below yellowMax yellow, from it red.
 */
export type DebtToSalesTone = 'success' | 'watch' | 'alert' | 'neutral';

export function debtToSales(debt: number, ytdSales: number | null | undefined, bands: { greenMaxPct: number; yellowMaxPct: number }) {
  if (ytdSales === null || ytdSales === undefined || !(ytdSales > 0)) return { pct: null, tone: 'neutral' as DebtToSalesTone };
  const pct = (debt / ytdSales) * 100;
  const tone: DebtToSalesTone = pct < bands.greenMaxPct ? 'success' : pct < bands.yellowMaxPct ? 'watch' : 'alert';
  return { pct, tone };
}

export const TONE_COLOR: Record<DebtToSalesTone, string> = {
  success: 'var(--ps-color-success)',
  watch: 'var(--ps-color-watch)',
  alert: 'var(--ps-color-alert)',
  neutral: 'var(--ps-color-text)',
};
