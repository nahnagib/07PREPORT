import { describe, expect, it } from 'vitest';
import { buildSpending } from '../spending';
import { buildCampaigns } from '../campaigns';
import { companiesOf } from '../common';
import { KpiParamError, parseCompanyKeys } from '../params';
import { assertAllFinite, campaignExample, spendExample } from './fixtures';

const A = { id: 1, name: 'Brand A', companyKey: 10, company: 'Co X' };
const B = { id: 2, name: 'Brand B', companyKey: 10, company: 'Co X' };
const C = { id: 3, name: 'Brand C', companyKey: null, company: null };

describe('Total Spend vs Total Revenue: budget and spend % of revenue', () => {
  const p = buildSpending({
    year: 2026, fromMonth: 1, toMonth: 2, brands: [A], previous: [],
    current: [
      spendExample({ month: 1, spend: 100, revenue: 1000, budget: 200, companyCurrent: 10000 }),
      spendExample({ month: 2, spend: 900, revenue: 1000, budget: 800, companyCurrent: 10000 }),
    ],
  });
  it('target budget is summed per month and over the range', () => {
    expect(p.totals.budget.total).toBe(1000);
    expect(p.totals.budget.series.map((s) => s.value)).toEqual([200, 800]);
    expect(p.totals.budgetUsed.value).toBe(100);
  });
  it('spend % of revenue = Σspend ÷ Σrevenue (not the mean of monthly %), in percentage points', () => {
    expect(p.totals.spendPctOfRevenue.value).toBe(50); // 1000 / 2000; the mean of 10% and 90% is also 50 -> use unequal revenue below
    expect(p.totals.spendPctOfRevenue.series.map((s) => s.value)).toEqual([10, 90]);
    const q = buildSpending({
      year: 2026, fromMonth: 1, toMonth: 2, brands: [A], previous: [],
      current: [spendExample({ month: 1, spend: 100, revenue: 100 }), spendExample({ month: 2, spend: 100, revenue: 900 })],
    });
    expect(q.totals.spendPctOfRevenue.value).toBe(20); // 200 / 1000, not (100% + 11.1%) / 2
    expect(p.totals.spendPctOfCompanyRevenue.value).toBe(5);
  });
  it('zero revenue -> n/a, never Infinity', () => {
    const z = buildSpending({ year: 2026, fromMonth: 1, toMonth: 1, brands: [A], previous: [], current: [spendExample({ month: 1, revenue: 0, companyCurrent: 0 })] });
    expect(z.totals.spendPctOfRevenue).toMatchObject({ value: null, status: 'na' });
    assertAllFinite(z);
  });
  it('months without rows are null in the series', () => {
    const g = buildSpending({ year: 2026, fromMonth: 1, toMonth: 3, brands: [A], previous: [], current: [spendExample({ month: 2 })] });
    expect(g.totals.spendPctOfRevenue.series.map((s) => s.value === null)).toEqual([true, false, true]);
  });
});

describe('company level for Budget utilization and Brand growth', () => {
  const p = buildSpending({
    year: 2026, fromMonth: 8, toMonth: 8, brands: [A, B, C], previous: [],
    current: [
      spendExample({ brandId: 1, spend: 100, budget: 100, companyCurrent: 300, companyLy: 100 }),
      spendExample({ brandId: 2, brand: 'Brand B', spend: 300, budget: 100, companyCurrent: 100, companyLy: 100 }),
      spendExample({ brandId: 3, brand: 'Brand C', spend: 50, budget: 100, companyCurrent: 90, companyLy: 100 }),
    ],
  });
  it('company rows sum their brands first, then divide; unassigned brands go to "Unassigned" (last)', () => {
    expect(p.budgetUtilization.companies.map((c) => [c.company, c.companyKey, c.value, c.overBudget])).toEqual([
      ['Co X', 10, 200, true], // (100 + 300) / (100 + 100), not the mean of 100% and 300%
      ['Unassigned', null, 50, false],
    ]);
    expect(p.brandGrowth.companies.map((c) => c.value)).toEqual([100, -10]); // (400 - 200) / 200
  });
  it('brand rows carry their company', () => {
    expect(p.budgetUtilization.brands.map((b) => b.company)).toEqual(['Co X', 'Co X', null]);
    expect(p.cac.brands[0]).toMatchObject({ companyKey: 10, company: 'Co X' });
  });
  it('companiesOf orders by name with Unassigned last', () => {
    expect(companiesOf([C, { ...A, companyKey: 2, company: 'Zeta' }, B]).map((c) => c.name)).toEqual(['Co X', 'Zeta', 'Unassigned']);
  });
});

describe('ROI trend on the Media Campaign Performance payload', () => {
  it('same shape and values as the Spending payload', () => {
    const cur = [spendExample({ month: 1, spend: 100, revenue: 400 })];
    const prev = [spendExample({ year: 2025, month: 1, spend: 100, revenue: 300 })];
    const s = buildSpending({ year: 2026, fromMonth: 1, toMonth: 1, current: cur, previous: prev, brands: [A] });
    const c = buildCampaigns({ year: 2026, fromMonth: 1, toMonth: 1, campaigns: [campaignExample()], media: [], today: '2026-09-20', roiRows: { current: cur, previous: prev } });
    expect(c.roi).toEqual(s.roi);
    expect(c.meta.missing).not.toContain('lastYearData');
  });
  it('no spend rows: ROI n/a and lastYearData missing; spend without campaigns still counts as data', () => {
    const c = buildCampaigns({ year: 2026, fromMonth: 1, toMonth: 2, campaigns: [], media: [], today: '2026-09-20' });
    expect(c.roi.ytd).toMatchObject({ value: null, status: 'na' });
    expect(c.meta.missing).toContain('lastYearData');
    expect(c.hasData).toBe(false);
    const d = buildCampaigns({ year: 2026, fromMonth: 1, toMonth: 1, campaigns: [], media: [], today: '2026-09-20', roiRows: { current: [spendExample({ month: 1 })], previous: [] } });
    expect(d.hasData).toBe(true);
  });
});

describe('companyKeys parameter', () => {
  it('accepts repeated / bracketed / comma forms; unknown or non-numeric keys are 400s', () => {
    expect(parseCompanyKeys({ companyKeys: ['10', '20'] }, [10, 20])).toEqual([10, 20]);
    expect(parseCompanyKeys({ 'companyKeys[]': ['20'] }, [10, 20])).toEqual([20]);
    expect(parseCompanyKeys({ companyKeys: '10,10' }, [10, 20])).toEqual([10]);
    expect(parseCompanyKeys({}, [10])).toBeUndefined();
    expect(() => parseCompanyKeys({ companyKeys: '99' }, [10])).toThrow(KpiParamError);
    expect(() => parseCompanyKeys({ companyKeys: 'x' }, [10])).toThrow(/whole numbers/);
  });
});

describe('city map (template 1.1)', () => {
  const base = { year: 2026, fromMonth: 1, toMonth: 12, campaigns: [campaignExample()], today: '2026-09-20' };
  it('cost and units per city, summed first, largest cost first, with the media-type breakdown', () => {
    const c = buildCampaigns({ ...base, media: [
      { campaignName: 'Ramadan Lighting Campaign', mediaType: '1-Street Lights', city: 'Benghazi', units: 10, cost: 5000 },
      { campaignName: 'Ramadan Lighting Campaign', mediaType: '1-Street Lights', city: 'Tripoli', units: 20, cost: 10000 },
      { campaignName: 'Ramadan Lighting Campaign', mediaType: '2-Mega Billboards', city: 'Tripoli', units: 2, cost: 15000 },
    ] });
    expect(c.coverageByCity.totalCost).toBe(30000);
    expect(c.coverageByCity.cities.map((x) => [x.city, x.cost, x.units])).toEqual([['Tripoli', 25000, 22], ['Benghazi', 5000, 10]]);
    expect(c.coverageByCity.cities[0].share).toBeCloseTo(83.333, 3);
    expect(c.coverageByCity.cities[1].share).toBeCloseTo(16.667, 3);
    expect(c.coverageByCity.cities[0].byType).toEqual([
      { mediaType: '1-Street Lights', units: 20, cost: 10000 }, { mediaType: '2-Mega Billboards', units: 2, cost: 15000 },
    ]);
  });
  it('rows from before the City column show as "No city"; a campaign re-uploaded with cities drops its old city-less rows', () => {
    const c = buildCampaigns({ ...base, media: [
      { campaignName: 'Old Campaign', mediaType: '3-Billboards', city: '', units: 4, cost: 4000 },
      { campaignName: 'Ramadan Lighting Campaign', mediaType: '1-Street Lights', city: '', units: 45, cost: 30000 }, // superseded by the city rows below
      { campaignName: 'Ramadan Lighting Campaign', mediaType: '1-Street Lights', city: 'Tripoli', units: 45, cost: 30000 },
    ] });
    expect(c.coverageByCity.cities.map((x) => [x.city, x.cost])).toEqual([['Tripoli', 30000], ['No city', 4000]]);
    expect(c.costByType.totalCost).toBe(34000); // not 64000
  });
  it('no media: empty cities, zero totals, never NaN', () => {
    const c = buildCampaigns({ ...base, media: [] });
    expect(c.coverageByCity).toEqual({ totalCost: 0, totalUnits: 0, cities: [] });
    assertAllFinite(c);
  });
});
