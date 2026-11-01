import { Rat, R } from './rat';
import { BrandRef, Num } from './common';
import type { SpendRow } from './spending';

/**
 * Total MARCOM Spend (template 2.0) = campaign spend + other (non-campaign) spend, per Year + Month + Brand.
 *
 * Campaigns have a start and an end date, not a month: each campaign's spend is spread over the months it runs in
 * proportion to its active days (both ends inclusive). A 1 Feb - 15 Mar campaign of 120,000 runs 28 + 15 = 43 days,
 * so February gets 120,000 x 28/43 and March 120,000 x 15/43. Exact fractions (Rat) -- nothing is lost to rounding.
 * The template's grey "Campaign Spend" column computes the same split with SUMPRODUCT.
 */

export interface CampaignSpendRow { brandId: number; start: string; end: string; spend: Num }
export interface OtherSpendRow {
  year: number; month: number; brandId: number; brand: string; category: string;
  description: string; vendor: string | null; amount: Num; notes: string | null;
}

const DAY = 86_400_000;
const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** Active days of [start, end] inside calendar month (year, month), both ends inclusive. */
export function overlapDays(start: string, end: string, year: number, month: number): number {
  const ms = Date.UTC(year, month - 1, 1);
  const me = Date.UTC(year, month, 0);
  const lo = Math.max(utc(start), ms);
  const hi = Math.min(utc(end), me);
  return hi < lo ? 0 : Math.round((hi - lo) / DAY) + 1;
}

export const ymKey = (year: number, month: number, brandId: number) => `${year}-${month}-${brandId}`;

/** Campaign spend per `ymKey`, for the given (year, month) cells only. */
export function prorateCampaigns(campaigns: CampaignSpendRow[], cells: { year: number; month: number }[]): Map<string, Rat> {
  const out = new Map<string, Rat>();
  for (const c of campaigns) {
    const duration = Math.round((utc(c.end) - utc(c.start)) / DAY) + 1;
    if (duration <= 0) continue;
    for (const { year, month } of cells) {
      const days = overlapDays(c.start, c.end, year, month);
      if (!days) continue;
      const share = R(c.spend).mul(Rat.of(BigInt(days), BigInt(duration)));
      const k = ymKey(year, month, c.brandId);
      out.set(k, (out.get(k) ?? Rat.ZERO).add(share));
    }
  }
  return out;
}

/** Other spend per `ymKey`. */
export function otherByKey(rows: OtherSpendRow[]): Map<string, Rat> {
  const out = new Map<string, Rat>();
  for (const r of rows) {
    const k = ymKey(r.year, r.month, r.brandId);
    out.set(k, (out.get(k) ?? Rat.ZERO).add(R(r.amount)));
  }
  return out;
}

/**
 * One SpendRow per Year + Month + Brand that has a P1 row, campaign spend or other spend in `cells`, with
 * spend = campaignSpend + otherSpend (P1 rows come in with their inputs; their own `spend` is ignored).
 * `allowed` = brand filter (null = all brands).
 */
export function mergeSpendRows(
  p1: SpendRow[], campaigns: CampaignSpendRow[], other: OtherSpendRow[], cells: { year: number; month: number }[],
  brands: BrandRef[], allowed: Set<number> | null,
): SpendRow[] {
  const campaignBy = prorateCampaigns(campaigns, cells);
  const otherBy = otherByKey(other);
  const brandById = new Map(brands.map((b) => [b.id, b]));
  const out = new Map<string, SpendRow>();
  for (const x of p1) out.set(ymKey(x.year, x.month, x.brandId), { ...x });
  for (const k of new Set([...campaignBy.keys(), ...otherBy.keys()])) {
    const [year, month, brandId] = k.split('-').map(Number);
    if ((allowed && !allowed.has(brandId)) || out.has(k)) continue;
    out.set(k, {
      year, month, brandId, brand: brandById.get(brandId)?.name ?? `#${brandId}`, kind: brandById.get(brandId)?.kind ?? 'BRAND',
      spend: 0, revenue: null, brandRevenue: null, brandRevenueLy: null, companyTotal: null, budget: null, booked: null,
      newCustomers: null, avgInvoice: null, socialPostCost: null, clicks: null,
    });
  }
  for (const [k, row] of out) {
    const c = campaignBy.get(k) ?? Rat.ZERO;
    const o = otherBy.get(k) ?? Rat.ZERO;
    row.campaignSpend = c;
    row.otherSpend = o;
    row.spend = c.add(o);
  }
  return [...out.values()].sort((x, y) => x.year - y.year || x.month - y.month || x.brandId - y.brandId);
}
