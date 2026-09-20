import { buildDemoDataset, DEMO_BRANDS } from '../../marcom/demo/demoData';
import { CAMPAIGN_STATUSES, PLATFORMS } from '../../marcom/templateConfig';
import { buildCampaigns, type CampaignRow } from '../campaigns';
import { buildDigital } from '../digital';
import { makeEnvelope } from '../envelope';
import { buildSpending } from '../spending';
import { buildTrade, type EventRow } from '../trade';
import { campaignExample, eventExample, socialExample, spendExample, tradeExample, webExample } from './fixtures';

/**
 * Deterministic API-shaped payloads for the FRONTEND tests (frontend/src/components/marcom/__fixtures__).
 * Built by the real, pure KPI builders + makeEnvelope -- exactly what the endpoints return -- so the
 * page tests can never drift from the backend. Regenerate with `npm run marcom:fixtures --workspace backend`;
 * fixtures.test.ts fails when the committed files differ from what this module produces.
 */
const TODAY = '2026-09-20';
const FRESH = { hasData: true, latestPeriod: { year: 2026, month: 8, label: 'August 2026' }, uploadedBy: 'Demo Admin', uploadedAt: '2026-09-20T09:00:00.000Z', batchId: 4 };
const NO_FRESH = { hasData: false };

const demo = buildDemoDataset();
const brands = DEMO_BRANDS.map((name, i) => ({ id: i + 1, name }));
const OPTIONS = { years: [2025, 2026], brands };

const filt = (year: number, fromMonth: number, toMonth: number, extra: Record<string, unknown> = {}) => ({ year, fromMonth, toMonth, ...extra });
const period = (f: { year: number; fromMonth: number; toMonth: number }) => ({ year: f.year, fromMonth: f.fromMonth, toMonth: f.toMonth });

function spending(cur: Parameters<typeof buildSpending>[0]['current'], prev: Parameters<typeof buildSpending>[0]['previous'], sel: typeof brands, from: number, to: number, fresh: unknown = FRESH, years = OPTIONS.years) {
  const f = filt(2026, from, to);
  return makeEnvelope('spending', { ...f, brands: sel }, { years, brands }, fresh, buildSpending({ ...period(f), current: cur, previous: prev, brands: sel }));
}

function campaigns(rows: CampaignRow[], media: Parameters<typeof buildCampaigns>[0]['media'], fresh: unknown = FRESH) {
  const f = filt(2026, 1, 12);
  return makeEnvelope('campaigns', { ...f, brands, statuses: [] }, { ...OPTIONS, statuses: CAMPAIGN_STATUSES }, fresh, buildCampaigns({ ...period(f), campaigns: rows, media, today: TODAY }));
}

function digital(social: Parameters<typeof buildDigital>[0]['social'], web: Parameters<typeof buildDigital>[0]['web'], platforms: string[], from: number, to: number, fresh: unknown = FRESH) {
  const f = filt(2026, from, to);
  return makeEnvelope('digital', { ...f, platforms }, { ...OPTIONS, platforms: PLATFORMS }, fresh, buildDigital({ ...period(f), social, web, platforms }));
}

function trade(rows: Parameters<typeof buildTrade>[0]['trade'], allEvents: EventRow[], from: number, to: number, opts: { completedOnly?: boolean; fresh?: unknown } = {}) {
  const f = filt(2026, from, to);
  // Like GET /marcom/kpi/trade: only events whose Planned Date falls inside the period.
  const events = allEvents.filter((e) => { const m = Number(e.planned.slice(5, 7)); return e.planned.startsWith('2026-') && m >= from && m <= to; });
  return makeEnvelope('trade', { ...f, brands, completedOnly: !!opts.completedOnly }, OPTIONS, opts.fresh ?? FRESH, buildTrade({ ...period(f), trade: rows, events, today: TODAY, completedOnly: !!opts.completedOnly }));
}

const y = <T extends { year: number; month: number }>(rows: T[], year: number, from: number, to: number): T[] => rows.filter((r) => r.year === year && r.month >= from && r.month <= to);

/** 30 events with awful names, no completion dates, one spanning the period end. */
function stressEvents(): EventRow[] {
  const long = 'An Extraordinarily Long Event Name That Keeps Going To Prove The Label Column Truncates Properly';
  return Array.from({ length: 30 }, (_, i) => eventExample({
    name: `${long} ${i + 1}`, type: `${(i % 8) + 1}-Type`, brand: brands[i % 4].name, brandId: (i % 4) + 1,
    planned: `2026-${String((i % 8) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
    completion: i % 3 === 0 ? `2026-${String((i % 8) + 1).padStart(2, '0')}-28` : null,
    status: ['Planned', 'Completed', 'Postponed', 'Cancelled'][i % 4],
  }));
}

/** 24 campaigns incl. very long names and ones crossing the year boundary on both sides. */
function stressCampaigns(): CampaignRow[] {
  const mk = (name: string, start: string, end: string, status: string, i: number): CampaignRow => campaignExample({ name, start, end, status, brand: brands[i % 4].name, brandId: (i % 4) + 1, spend: 10000 * (i + 1), revenue: 25000 * (i + 1) - (i % 5) * 20000, durationDays: 30 });
  const rows = Array.from({ length: 20 }, (_, i) => mk(`Campaign ${i + 1} with a very very long descriptive name for the label column`, `2026-${String((i % 11) + 1).padStart(2, '0')}-05`, `2026-${String((i % 11) + 2).padStart(2, '0')}-20`, CAMPAIGN_STATUSES[i % 4], i));
  rows.push(mk('Crosses into next year', '2026-11-15', '2027-02-10', 'Ongoing', 20));
  rows.push(mk('Started last year', '2025-11-20', '2026-02-15', 'Completed', 21));
  rows.push(mk('Spans both years', '2025-06-01', '2027-06-01', 'Ongoing', 22));
  rows.push(mk('Single day campaign', '2026-05-05', '2026-05-05', 'Planned', 23));
  return rows;
}

export function buildFrontendFixtures(): Record<string, unknown> {
  const spendCur = y(demo.spend, 2026, 1, 8);
  const spendPrev = y(demo.spend, 2025, 1, 8);
  const gold = { spend: [spendExample()], prev: [] as never[], A: [brands[0]] };
  const oneBrand = (id: number) => spendCur.filter((r) => r.brandId === id);

  return {
    // The template's example rows as real data: the acceptance values.
    'golden.spending': spending(gold.spend, gold.prev, gold.A, 8, 8),
    'golden.campaigns': campaigns([campaignExample()], [{ campaignName: 'Ramadan Lighting Campaign', mediaType: '1-Street Lights', units: 45, cost: 30000 }]),
    'golden.digital': digital([socialExample()], [webExample()], ['Instagram'], 8, 8),
    'golden.trade': trade([tradeExample()], [eventExample()], 8, 8),

    // The dev demo seed: every RAG colour, over-budget and negative-growth brands, LYTD.
    'demo.spending': spending(spendCur, spendPrev, brands, 1, 8),
    'demo.campaigns': campaigns(demo.campaigns, demo.media),
    'demo.digital': digital(demo.social, demo.web, [...PLATFORMS], 1, 8),
    'demo.trade': trade(demo.trade, demo.events, 1, 8),
    'demo.tradeCompletedOnly': trade(demo.trade, demo.events, 1, 8, { completedOnly: true }),

    // Edge cases.
    'noLastYear.spending': spending(spendCur, [], brands, 1, 8, FRESH, [2026]),
    'oneMonth.spending': spending(y(demo.spend, 2026, 8, 8), y(demo.spend, 2025, 8, 8), brands, 8, 8),
    'oneMonth.trade': trade(y(demo.trade, 2026, 8, 8), demo.events.filter((e) => e.planned.startsWith('2026-08')), 8, 8),
    'brandNoRows.spending': spending(oneBrand(1), [], brands, 1, 8), // brands 2-4 have no rows -> n/a rows
    'allNull.spending': spending([spendExample({ spend: 0, budget: 0, newCustomers: 0, clicks: 0, companyLy: 0 })], [], [brands[0]], 8, 8),
    'stress.campaigns': campaigns(stressCampaigns(), demo.media),
    'stress.trade': trade(demo.trade, stressEvents(), 1, 8),

    // Empty states.
    'filtered.spending': spending([], [], brands, 1, 3),
    'empty.spending': spending([], [], [], 1, 12, NO_FRESH, []),
    'empty.campaigns': campaigns([], [], NO_FRESH),
    'empty.digital': digital([], [], [...PLATFORMS], 1, 12, NO_FRESH),
    'empty.trade': trade([], [], 1, 12, { fresh: NO_FRESH }),
  };
}

export const FIXTURE_DIR_FROM_BACKEND = '../../../../../frontend/src/components/marcom/__fixtures__';
