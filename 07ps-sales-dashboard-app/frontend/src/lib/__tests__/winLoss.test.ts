import { describe, expect, it } from 'vitest';
import { formatWinLossRatio, winLossCentre } from '../winLoss';
import { formatPercent, formatVariance } from '../format';

describe('Opportunity by Status centre (Won/Lost ratio, win rate)', () => {
  it('Won ÷ Lost with 2 decimals, win rate = Won ÷ (Won + Lost) with 1 decimal', () => {
    expect(winLossCentre(279, 157)).toMatchObject({ main: '1.78 : 1', label: 'Won / Lost', caption: 'Win rate 64.0%' });
    expect(winLossCentre(1, 3)).toMatchObject({ main: '0.33 : 1', caption: 'Win rate 25.0%' });
  });

  it('no lost deals: "All won", never Infinity', () => {
    const c = winLossCentre(12, 0);
    expect(c).toMatchObject({ main: 'All won', label: 'Won / Lost', caption: 'Win rate 100.0%', ratio: null });
  });

  it('no won deals: ratio 0.00 and win rate 0.0%', () => {
    expect(winLossCentre(0, 5)).toMatchObject({ main: '0.00 : 1', caption: 'Win rate 0.0%' });
  });

  it('no closed deals: "—" with "No closed deals", never NaN', () => {
    const c = winLossCentre(0, 0);
    expect(c).toEqual({ main: '—', label: 'No closed deals', caption: null, ratio: null, winRate: null });
    for (const bad of [NaN, -1, Infinity]) {
      const text = JSON.stringify(winLossCentre(bad, bad));
      expect(text).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe('formatWinLossRatio (shared by Pipeline Health and Pipeline Trend)', () => {
  it('"X : 1" with 2 decimals; Lost = 0 -> "All won"; both 0 -> "—"; never NaN or Infinity', () => {
    expect(formatWinLossRatio(1252, 63)).toBe('19.87 : 1');
    expect(formatWinLossRatio(279, 157)).toBe('1.78 : 1');
    expect(formatWinLossRatio(5, 0)).toBe('All won');
    expect(formatWinLossRatio(0, 0)).toBe('—');
    expect(formatWinLossRatio(0, 4)).toBe('0.00 : 1');
    for (const bad of [NaN, Infinity, -3]) expect(formatWinLossRatio(bad, bad)).not.toMatch(/NaN|Infinity/);
  });
});

describe('percentages that are not changes carry no "+"', () => {
  it('formatPercent has no sign; formatVariance keeps it for increases', () => {
    expect(formatPercent(0.7409)).toBe('74.09%');
    expect(formatPercent(null)).toBeUndefined();
    expect(formatVariance(0.05)).toBe('+5.00%');
  });
});
