import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';

vi.mock('../../db/pool', () => ({ pool: {} }));
vi.mock('../../measures/tachometer', () => ({ computeYtdCard: vi.fn() }));
import { computeYtdCard } from '../../measures/tachometer';
import { dateOnlyUTC, parseAnchorDate } from '../../measures/filters';
import { ytdSalesFor } from '../debtReport';

describe('Debt to YTD Sales % (2026-11-15): YTD sales = the Tachometer\'s YTD Value', () => {
  it('calls the Tachometer\'s computeYtdCard with the same anchor date and filters and returns its actual', async () => {
    vi.mocked(computeYtdCard).mockResolvedValue({ actual: 149154453.98 } as never);
    const db = {} as Pool;
    const anchor = parseAnchorDate('2026-11-15');
    const filters = { companyKeys: [3], segmentKeys: [1, 2] };
    const out = await ytdSalesFor(anchor, filters, db);
    expect(computeYtdCard).toHaveBeenCalledWith(db, dateOnlyUTC(2026, 11, 15), filters, 'value');
    expect(out).toEqual({ from: '2026-01-01', to: '2026-11-15', value: 149154453.98, currency: 'LYD', bands: { greenMaxPct: 10, yellowMaxPct: 20 } });
  });

  it('the Tachometer\'s anchor rule: no / bad anchorDate = today (never the receivables snapshot)', () => {
    const now = new Date();
    expect(parseAnchorDate(undefined)).toEqual(dateOnlyUTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()));
    expect(parseAnchorDate('15/11/2026')).toEqual(parseAnchorDate(null));
  });

  it('a failing sales query never fails the debt overview: no value', async () => {
    vi.mocked(computeYtdCard).mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await ytdSalesFor(parseAnchorDate('2026-11-15'), {}, {} as Pool)).value).toBeNull();
  });
});
