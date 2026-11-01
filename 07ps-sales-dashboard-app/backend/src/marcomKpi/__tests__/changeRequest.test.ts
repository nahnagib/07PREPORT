import { describe, expect, it } from 'vitest';
import { buildSpending } from '../spending';
import { buildDigital, dropSupersededLegacy, NO_BRAND_LABEL } from '../digital';
import { mergeSpendRows, overlapDays, prorateCampaigns, ymKey } from '../totalSpend';
import { assertAllFinite, socialExample, spendExample, webExample } from './fixtures';
import { R } from '../rat';

/** Template 2.0 change request: Total MARCOM Spend = campaign + other, brand-level revenue, Digital per brand. */

const A = { id: 1, name: 'Xtreme', companyKey: 3, company: 'Tika' };
const B = { id: 2, name: 'Majaal', companyKey: 1, company: 'Majaal' };
const G = { id: 3, name: 'BMH', companyKey: null, company: null, kind: 'GROUP' as const };

describe('campaign spend is spread over its months by active days', () => {
  it('counts both ends inclusive', () => {
    expect(overlapDays('2026-02-01', '2026-03-15', 2026, 2)).toBe(28);
    expect(overlapDays('2026-02-01', '2026-03-15', 2026, 3)).toBe(15);
    expect(overlapDays('2026-02-01', '2026-03-15', 2026, 4)).toBe(0);
    expect(overlapDays('2026-05-05', '2026-05-05', 2026, 5)).toBe(1);
  });

  it('splits exactly and the parts add back to the campaign spend (no rounding loss)', () => {
    const cells = [1, 2, 3, 4].map((month) => ({ year: 2026, month }));
    const m = prorateCampaigns([{ brandId: 1, start: '2026-02-01', end: '2026-03-15', spend: 120000 }], cells);
    const feb = m.get(ymKey(2026, 2, 1))!;
    const mar = m.get(ymKey(2026, 3, 1))!;
    expect(feb.toNumber()).toBeCloseTo((120000 * 28) / 43, 9);
    expect(feb.add(mar).toNumber()).toBe(120000);
    expect(m.has(ymKey(2026, 1, 1))).toBe(false);
  });

  it('a campaign crossing the year boundary only contributes the requested months', () => {
    const m = prorateCampaigns([{ brandId: 1, start: '2025-12-17', end: '2026-01-15', spend: 30000 }], [{ year: 2026, month: 1 }]);
    expect(m.get(ymKey(2026, 1, 1))!.toNumber()).toBe(15000); // 15 of 30 days
  });
});

describe('mergeSpendRows: one row per Year + Month + Brand with spend = campaign + other', () => {
  const cells = [{ year: 2026, month: 9 }];
  const p1 = [spendExample({ year: 2026, month: 9, brandId: 1, brand: 'Xtreme', spend: 999, booked: 1000000 })];
  const campaigns = [{ brandId: 1, start: '2026-09-01', end: '2026-09-30', spend: 600000 }];
  const other = [
    { year: 2026, month: 9, brandId: 1, brand: 'Xtreme', category: 'Uniforms', description: 'Shirts', vendor: null, amount: 250000, notes: null },
    { year: 2026, month: 9, brandId: 1, brand: 'Xtreme', category: 'Gifts & Giveaways', description: 'Pens', vendor: null, amount: 100000, notes: null },
    { year: 2026, month: 9, brandId: 3, brand: 'BMH', category: 'Events & Sponsorships', description: 'Group gala', vendor: null, amount: 40000, notes: null },
  ];

  it('ignores the P1 row\'s own spend and adds brands that only have spend lines', () => {
    const rows = mergeSpendRows(p1, campaigns, other, cells, [A, B, G], null);
    expect(rows.map((r) => [r.brand, R(r.spend).toNumber()])).toEqual([['Xtreme', 950000], ['BMH', 40000]]);
    expect(rows[1]).toMatchObject({ kind: 'GROUP', brandRevenue: null });
  });

  it('respects the brand filter', () => {
    expect(mergeSpendRows(p1, campaigns, other, cells, [A, B, G], new Set([1])).map((r) => r.brand)).toEqual(['Xtreme']);
  });

  it('the request\'s example: 1,000,000 booked, 600,000 campaigns + 350,000 other -> 50,000 unallocated', () => {
    const rows = mergeSpendRows(p1, campaigns, other.slice(0, 2), cells, [A], null);
    const p = buildSpending({ year: 2026, fromMonth: 9, toMonth: 9, brands: [A], current: rows, previous: [], otherLines: other.slice(0, 2), categories: ['Uniforms', 'Gifts & Giveaways'] });
    expect(p.totals.spend.total).toBe(950000);
    expect(p.totals.campaignSpend.total).toBe(600000);
    expect(p.totals.otherSpend.total).toBe(350000);
    expect(p.totals.unallocated).toMatchObject({ total: 50000, booked: 1000000, rows: 1 });
    expect(p.reconciliation.rows).toEqual([{ month: 9, brandId: 1, brand: 'Xtreme', campaignSpend: 600000, otherSpend: 350000, totalSpend: 950000, booked: 1000000, unallocated: 50000 }]);
    expect(p.byCategory.categories.map((c) => [c.category, c.amount, c.lines])).toEqual([['Campaigns', 600000, null], ['Uniforms', 250000, 1], ['Gifts & Giveaways', 100000, 1]]);
    expect(p.byCategory.categories.reduce((s, c) => s + (c.share ?? 0), 0)).toBeCloseTo(100, 9);
    expect(p.otherLines).toHaveLength(2);
    assertAllFinite(p);
  });
});

describe('spend-based KPIs use Total MARCOM Spend; revenue KPIs use brand-level revenue', () => {
  const rows = [
    spendExample({ month: 9, spend: 950000, campaignSpend: 600000, otherSpend: 350000, revenue: 450000, brandRevenue: 3000000, brandRevenueLy: 2400000, companyTotal: 8000000, budget: 1000000, newCustomers: 100 }),
    spendExample({ brandId: 3, brand: 'BMH', kind: 'GROUP', month: 9, spend: 50000, revenue: null, brandRevenue: null, brandRevenueLy: null, budget: 50000, newCustomers: 0 }),
  ];
  const p = buildSpending({ year: 2026, fromMonth: 9, toMonth: 9, brands: [A, G], current: rows, previous: [] });

  it('ROI, budget utilization and CAC divide by campaign + other (group spend included)', () => {
    expect(p.roi.ytd.value).toBeCloseTo(450000 / 1000000, 12);
    expect(p.budgetUtilization.overall.value).toBeCloseTo(100 * 1000000 / 1050000, 9);
    expect(p.budgetUtilization.brands.find((b) => b.brand === 'Xtreme')).toMatchObject({ spend: 950000, campaignSpend: 600000, otherSpend: 350000 });
    expect(p.cac.overall.value).toBe(10000); // 1,000,000 / 100
  });

  it('growth, attributed % and brand share are brand-level; the group entry has no growth row', () => {
    expect(p.brandGrowth.overall.value).toBe(25);
    expect(p.brandGrowth.overall.attributedPct.value).toBe(15);
    expect(p.brandGrowth.overall.brandShare.value).toBe(37.5);
    expect(p.brandGrowth.brands.map((b) => b.brand)).toEqual(['Xtreme']);
    expect(p.totals.spendPctOfBrandRevenue.value).toBeCloseTo(100 * 1000000 / 3000000, 9);
  });

  it('rows from template 1.x (company totals, flagged) stay out of the revenue KPIs and are reported', () => {
    const legacy = spendExample({ month: 8, spend: 0, brandRevenue: null, brandRevenueLy: null, revenue: 8000000, needsReview: true });
    const q = buildSpending({ year: 2026, fromMonth: 8, toMonth: 9, brands: [A], current: [legacy, rows[0]], previous: [] });
    expect(q.brandGrowth.overall.value).toBe(25);
    expect(q.meta).toMatchObject({ missing: expect.arrayContaining(['revenueNeedsReview']), revenueNeedsReview: 1 });
  });

  it('no booked total anywhere -> unallocated is null, not 0', () => {
    expect(p.totals.unallocated.total).toBeNull();
  });
});

describe('Digital Performance per brand', () => {
  const social = [
    socialExample({ month: 9, brandId: 1, brand: 'Xtreme', platform: 'Facebook', followers: 1000, impressions: 100000, clicks: 6000, paid: 2000, organic: 3000 }),
    socialExample({ month: 9, brandId: 2, brand: 'Majaal', platform: 'Facebook', followers: 500, impressions: 100000, clicks: 2000, paid: 1000, organic: 1000 }),
    socialExample({ month: 8, brandId: 1, brand: 'Xtreme', platform: 'Facebook', followers: 900, impressions: 1, clicks: 0, paid: 0, organic: 0 }),
  ];
  const web = [webExample({ month: 9, brandId: 1, brand: 'Xtreme' }), webExample({ month: 9, brandId: 2, brand: 'Majaal', bounce: 600, totalVisitors: 1000, sessions: 1000, minutes: 1000 })];

  it('All = combined totals plus a side-by-side comparison by brand', () => {
    const d = buildDigital({ year: 2026, fromMonth: 9, toMonth: 9, platforms: ['Facebook'], social, web, brands: [A, B] });
    expect(d.ctr.overall.value).toBe(4); // (6000 + 2000) / 200000
    expect(d.followers.platforms[0].value).toBe(1500); // latest per brand, then added
    expect(d.byBrand.map((b) => [b.brand, b.ctr.value, b.ctr.status, b.engagementRate.value, b.followers, b.bounceRate.value])).toEqual([
      ['Xtreme', 6, 'green', 5, 1000, expect.closeTo(28.333, 2)],
      ['Majaal', 2, 'red', 2, 500, 60],
    ]);
  });

  it('pre-2.0 rows without a brand: dropped where branded rows exist for the cell, otherwise shown as "needs review"', () => {
    const legacy = [
      socialExample({ month: 9, brandId: null, brand: null, platform: 'Facebook', impressions: 999999 }), // superseded by branded Sep FB rows
      socialExample({ month: 9, brandId: null, brand: null, platform: 'Instagram', impressions: 10000, clicks: 100 }), // still alone
    ];
    expect(dropSupersededLegacy([...social, ...legacy])).toHaveLength(4);
    const d = buildDigital({ year: 2026, fromMonth: 9, toMonth: 9, platforms: ['Facebook', 'Instagram'], social: [...social, ...legacy], web, brands: [A, B] });
    expect(d.byBrand.map((b) => b.brand)).toEqual(['Xtreme', 'Majaal', NO_BRAND_LABEL]);
    expect(d.byBrand[2]).toMatchObject({ needsReview: true, impressions: 10000 });
    expect(d.meta).toMatchObject({ missing: ['brandNeedsReview'], brandNeedsReview: 1 });
    expect(d.ctr.overall.value).toBeCloseTo(100 * 8100 / 210000, 9);
  });
});
