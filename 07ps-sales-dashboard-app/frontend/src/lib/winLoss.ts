import { DISPLAY_LOCALE } from './format';

const clean = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * The one Won/Lost ratio format (2026-11-03): "1.77 : 1" (2 decimals), "All won" with no lost deals, "—" with neither.
 * Never NaN or Infinity. Used by Pipeline Health's Opportunity by Status centre and Pipeline Trend's Won/Lost Ratio YTD.
 */
export function formatWinLossRatio(won: number, lost: number): string {
  const w = clean(won);
  const l = clean(lost);
  if (w + l === 0) return '—';
  if (l === 0) return 'All won';
  return `${(w / l).toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} : 1`;
}

/** Centre of the Opportunity by Status donut: Won/Lost ratio and win rate. Pending is in neither. */
export interface WinLossCentre {
  /** "1.78 : 1", "All won" or "—". */
  main: string;
  /** "Won / Lost", or "No closed deals". */
  label: string;
  /** "Win rate 64.0%", or null when there are no closed deals. */
  caption: string | null;
  ratio: number | null;
  winRate: number | null;
}

export function winLossCentre(won: number, lost: number): WinLossCentre {
  const w = clean(won);
  const l = clean(lost);
  if (w + l === 0) return { main: '—', label: 'No closed deals', caption: null, ratio: null, winRate: null };
  const winRate = w / (w + l);
  const caption = `Win rate ${(winRate * 100).toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  return { main: formatWinLossRatio(w, l), label: 'Won / Lost', caption, ratio: l === 0 ? null : w / l, winRate };
}
