import { DISPLAY_LOCALE } from './format';

/** Centre of the Opportunity by Status donut: Won/Lost ratio and win rate. Pending is in neither. */
export interface WinLossCentre {
  /** "1.78", "All won" or "—". */
  main: string;
  /** "Won / Lost", or "No closed deals". */
  label: string;
  /** "Win rate 64.0%", or null when there are no closed deals. */
  caption: string | null;
  ratio: number | null;
  winRate: number | null;
}

export function winLossCentre(won: number, lost: number): WinLossCentre {
  const w = Number.isFinite(won) && won > 0 ? won : 0;
  const l = Number.isFinite(lost) && lost > 0 ? lost : 0;
  if (w + l === 0) return { main: '—', label: 'No closed deals', caption: null, ratio: null, winRate: null };
  const winRate = w / (w + l);
  const caption = `Win rate ${(winRate * 100).toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  if (l === 0) return { main: 'All won', label: 'Won / Lost', caption, ratio: null, winRate };
  const ratio = w / l;
  return {
    main: ratio.toLocaleString(DISPLAY_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    label: 'Won / Lost',
    caption,
    ratio,
    winRate,
  };
}
