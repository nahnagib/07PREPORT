import { describe, expect, it } from 'vitest';
import { buildDemoDataset, DEMO_BRANDS } from '../demo/demoData';
import { buildDemoWorkbooks, DEMO_LABEL } from '../demo/demoWorkbooks';
import { demoSeedRefusal } from '../demo/demoSeed';
import { parseMarcomWorkbook } from '../parser';
import { buildSpending } from '../../marcomKpi/spending';
import { buildCampaigns } from '../../marcomKpi/campaigns';
import { buildDigital } from '../../marcomKpi/digital';
import { buildTrade } from '../../marcomKpi/trade';
import { EVENT_TYPES, PLATFORMS } from '../templateConfig';
import { assertAllFinite } from '../../marcomKpi/__tests__/fixtures';

const data = buildDemoDataset();
const brands = DEMO_BRANDS.map((name, i) => ({ id: i + 1, name }));
const period = { year: 2026, fromMonth: 1, toMonth: 8 };
const statuses = (xs: { status: string }[]) => new Set(xs.map((x) => x.status));

/** Visual-test guarantees: every RAG KPI shows Green, Yellow AND Red somewhere; edge cases exist. */
describe('demo dataset coverage', () => {
  const rows = (year: number) => data.spend.filter((r) => r.year === year && r.month >= 1 && r.month <= 8);
  const forBrand = (i: number) => buildSpending({ ...period, brands: [brands[i]], current: rows(2026).filter((r) => r.brandId === i + 1), previous: rows(2025).filter((r) => r.brandId === i + 1) });
  const all = buildSpending({ ...period, brands, current: rows(2026), previous: rows(2025) });

  it('ROI: Green (Brand A), Yellow (B, and D exactly 5.0), Red (C); LYTD exists', () => {
    expect(forBrand(0).roi.ytd.status).toBe('green');
    expect(forBrand(1).roi.ytd.status).toBe('yellow');
    expect(forBrand(2).roi.ytd.status).toBe('red');
    expect(forBrand(3).roi.ytd).toMatchObject({ value: 5, status: 'yellow' });
    expect(all.roi.lytd).not.toBeNull();
    expect(all.meta.missing).toEqual([]);
    expect(all.roi.monthly.every((m) => m.lastYear !== null)).toBe(true);
  });
  it('CAC % of invoice: Green (A, and D exactly 3.0%), Yellow (B), Red (C)', () => {
    expect(all.cac.brands.map((b) => b.pctOfInvoice.status)).toEqual(['green', 'yellow', 'red', 'green']);
    expect(all.cac.brands[3].pctOfInvoice.value).toBe(3);
  });
  it('CPC: Green (A), Yellow (B and D exactly 2.5), Red (C)', () => {
    expect(all.cpc.brands.map((b) => b.status)).toEqual(['green', 'yellow', 'red', 'yellow']);
    expect(all.cpc.brands[3].value).toBe(2.5);
  });
  it('one brand over budget (B), one exactly on budget (D, not over), one with negative growth (C)', () => {
    expect(all.budgetUtilization.brands.map((b) => b.overBudget)).toEqual([false, true, false, false]);
    expect(all.budgetUtilization.brands[3].value).toBe(100);
    const growth = all.brandGrowth.brands.map((b) => b.value!);
    expect(growth[2]).toBeLessThan(0);
    expect(growth.filter((g) => g > 0)).toHaveLength(3);
    expect(growth[0]).toBeCloseTo(14.29, 1);
  });

  const digital = buildDigital({ ...period, platforms: [...PLATFORMS], social: data.social, web: data.web });
  it('CTR and engagement rate per platform: all three colours, with exact-boundary Instagram CTR and Google ER', () => {
    const ctr = Object.fromEntries(digital.ctr.byPlatform.map((p) => [p.platform, p.kpi]));
    const er = Object.fromEntries(digital.engagementRate.byPlatform.map((p) => [p.platform, p.kpi]));
    expect(new Set(Object.values(ctr).map((k) => k.status))).toEqual(new Set(['green', 'yellow', 'red']));
    expect(new Set(Object.values(er).map((k) => k.status))).toEqual(new Set(['green', 'yellow', 'red']));
    expect(ctr.Instagram).toMatchObject({ value: 5, status: 'yellow' });
    expect(er.Google).toMatchObject({ value: 3, status: 'yellow' });
    expect(ctr.LinkedIn.status).toBe('red');
  });
  it('avg session: monthly series has Green, Yellow and Red, including exactly 3.0 and 1.0 (Yellow)', () => {
    const s = digital.avgSession.series;
    expect(new Set(s.map((x) => x.status))).toEqual(new Set(['green', 'yellow', 'red']));
    expect(s.find((x) => x.value === 3)!.status).toBe('yellow');
    expect(s.find((x) => x.value === 1)!.status).toBe('yellow');
  });
  it('followers grow, five platforms, snapshot as of August', () => {
    expect(digital.followers.platforms.map((p) => p.asOf)).toEqual(PLATFORMS.map(() => ({ year: 2026, month: 8 })));
    const v = (name: string) => digital.followers.platforms.find((x) => x.platform === name)!.value!;
    expect(digital.followers.metaTotal).toBe(v('Facebook') + v('Instagram'));
  });

  const trade = buildTrade({ ...period, today: '2026-09-20', completedOnly: false, trade: data.trade, events: data.events });
  it('compliance / giveaways / printed / attendance series each contain Green, Yellow and Red; Aug headlines differ', () => {
    for (const block of [trade.compliance, trade.giveawaysStock, trade.printedStock]) {
      expect(new Set(block.series.map((x) => x.status))).toEqual(new Set(['green', 'yellow', 'red']));
    }
    expect(new Set(trade.attendance.series.map((x) => x.status))).toEqual(new Set(['green', 'yellow', 'red']));
    expect([trade.compliance.headline.status, trade.giveawaysStock.headline.status, trade.printedStock.headline.status]).toEqual(['green', 'yellow', 'red']);
    expect(trade.compliance.series.find((x) => x.value === 90)!.status).toBe('yellow'); // boundary
    expect(trade.compliance.series.find((x) => x.value === 80)!.status).toBe('yellow'); // boundary
  });
  it('events: all 8 types, all 4 statuses, overdue and future events', () => {
    expect(new Set(data.events.map((e) => e.type))).toEqual(new Set(EVENT_TYPES));
    expect(statuses(data.events)).toEqual(new Set(['Planned', 'Completed', 'Postponed', 'Cancelled']));
    expect(data.events).toHaveLength(20);
    expect(trade.eventsTimeline.filter((e) => e.overdue).length).toBeGreaterThanOrEqual(2);
    expect(data.events.some((e) => e.planned > '2026-09-20')).toBe(true);
  });

  const campaigns = buildCampaigns({ ...period, toMonth: 12, today: '2026-09-20', campaigns: data.campaigns, media: data.media });
  it('campaigns: ROI Green/Yellow/Red/na, all 4 statuses, all 5 media types', () => {
    expect(new Set(campaigns.roiByCampaign.campaigns.map((c) => c.roi.status))).toEqual(new Set(['green', 'yellow', 'red', 'na']));
    expect(statuses(data.campaigns)).toEqual(new Set(['Planned', 'Ongoing', 'Completed', 'On Hold']));
    expect(campaigns.coverageByType.types.every((t) => t.units > 0)).toBe(true);
    expect(campaigns.roiByCampaign.campaigns.find((c) => c.name === 'Spring Kitchens Promo')!.roi).toMatchObject({ value: 5, status: 'yellow' });
  });

  it('every payload is finite and complete', () => {
    for (const p of [all, digital, trade, campaigns]) assertAllFinite(p);
  });
});

describe('demo workbooks', () => {
  it('parse with zero errors through the real parser, and carry every row', async () => {
    const chunks = await buildDemoWorkbooks(data);
    expect(chunks.map((c) => c.filename.startsWith(DEMO_LABEL))).toEqual([true, true, true, true]);
    const totals = { spend: 0, campaigns: 0, media: 0, social: 0, web: 0, trade: 0, events: 0 };
    for (const c of chunks) {
      const r = await parseMarcomWorkbook(c.buffer, c.filename);
      expect(r.issues.filter((i) => i.severity === 'error'), c.label).toEqual([]);
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r.tables[k].rows.length;
    }
    expect(totals).toEqual({ spend: data.spend.length, campaigns: 8, media: 13, social: 40, web: 8, trade: 8, events: 20 });
    expect(data.spend).toHaveLength(80); // 4 brands x (12 months of 2025 + 8 months of 2026)
  });
});

describe('demo seed guard', () => {
  it.each([
    [{ NODE_ENV: 'production', DB_HOST: 'localhost', DB_NAME: 'marcom_test' }, false, /production/],
    [{ NODE_ENV: 'PRODUCTION', DB_HOST: '127.0.0.1', DB_NAME: 'dev_db' }, true, /production/],
    [{ DB_HOST: 'db.example.com', DB_NAME: 'marcom_test' }, true, /not this machine/],
    [{ DB_HOST: '10.0.0.5', DB_NAME: 'app_dev' }, false, /not this machine/],
    [{ DB_HOST: 'localhost', DB_NAME: 'powerBI_Data' }, false, /does not look like a dev database/],
  ] as [Record<string, string>, boolean, RegExp][])('refuses %j (ack=%s)', (env, ack, why) => {
    expect(demoSeedRefusal(env, ack)).toMatch(why);
  });
  it.each([
    [{ DB_HOST: 'localhost', DB_NAME: 'marcom_test' }, false],
    [{ NODE_ENV: 'development', DB_HOST: '127.0.0.1', DB_NAME: 'ps_dev' }, false],
    [{ DB_HOST: 'localhost', DB_NAME: 'powerBI_Data' }, true], // explicit acknowledgement
  ] as [Record<string, string>, boolean][])('allows %j (ack=%s)', (env, ack) => {
    expect(demoSeedRefusal(env, ack)).toBeNull();
  });
});
