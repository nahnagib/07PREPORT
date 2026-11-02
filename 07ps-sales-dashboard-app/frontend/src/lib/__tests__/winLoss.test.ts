import { describe, expect, it } from 'vitest';
import { winLossCentre } from '../winLoss';

describe('Opportunity by Status centre (Won/Lost ratio, win rate)', () => {
  it('Won ÷ Lost with 2 decimals, win rate = Won ÷ (Won + Lost) with 1 decimal', () => {
    expect(winLossCentre(279, 157)).toMatchObject({ main: '1.78', label: 'Won / Lost', caption: 'Win rate 64.0%' });
    expect(winLossCentre(1, 3)).toMatchObject({ main: '0.33', caption: 'Win rate 25.0%' });
  });

  it('no lost deals: "All won", never Infinity', () => {
    const c = winLossCentre(12, 0);
    expect(c).toMatchObject({ main: 'All won', label: 'Won / Lost', caption: 'Win rate 100.0%', ratio: null });
  });

  it('no won deals: ratio 0.00 and win rate 0.0%', () => {
    expect(winLossCentre(0, 5)).toMatchObject({ main: '0.00', caption: 'Win rate 0.0%' });
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
