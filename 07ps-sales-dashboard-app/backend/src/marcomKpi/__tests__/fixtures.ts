import type { SpendRow } from '../spending';
import type { SocialRow, WebRow } from '../digital';
import type { TradeRow, EventRow } from '../trade';
import type { CampaignRow } from '../campaigns';

/** The template's shipped example values (the acceptance-test data set). */
export const spendExample = (o: Partial<SpendRow> = {}): SpendRow => ({
  year: 2026, month: 8, brandId: 1, brand: 'Brand A',
  spend: 50000, revenue: 280000, companyCurrent: 1200000, companyLy: 1050000, budget: 55000,
  newCustomers: 120, avgInvoice: 900, socialPostCost: 8000, clicks: 3500, ...o,
});

export const socialExample = (o: Partial<SocialRow> = {}): SocialRow => ({
  year: 2026, month: 8, platform: 'Instagram', followers: 52000, impressions: 180000, clicks: 9500, paid: 4200, organic: 3100, ...o,
});

export const webExample = (o: Partial<WebRow> = {}): WebRow => ({
  year: 2026, month: 8, bounce: 3400, totalVisitors: 12000, sessions: 15500, minutes: 54250, ...o,
});

export const tradeExample = (o: Partial<TradeRow> = {}): TradeRow => ({
  year: 2026, month: 8, compliance: '0.9400', giveaways: '0.8800', printed: '0.9100', actual: 460, expected: 500, ...o,
});

export const campaignExample = (o: Partial<CampaignRow> = {}): CampaignRow => ({
  name: 'Ramadan Lighting Campaign', brandId: 1, brand: 'Brand A', status: 'Completed',
  start: '2026-02-01', end: '2026-03-15', durationDays: 42, spend: 120000, revenue: 650000, ...o,
});

export const eventExample = (o: Partial<EventRow> = {}): EventRow => ({
  name: 'Product Launch Night - Brand A', type: '6-Launch & Opening', brandId: 1, brand: 'Brand A',
  planned: '2026-08-10', completion: '2026-08-10', status: 'Completed', ...o,
});

/** Walks any payload and fails on NaN / Infinity anywhere. */
export function assertAllFinite(v: unknown, path = '$'): void {
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`non-finite number at ${path}`);
  if (Array.isArray(v)) v.forEach((x, i) => assertAllFinite(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertAllFinite(x, `${path}.${k}`);
}
