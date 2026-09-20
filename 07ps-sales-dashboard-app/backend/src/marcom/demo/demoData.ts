import type { SpendRow } from '../../marcomKpi/spending';
import type { CampaignRow, MediaRow } from '../../marcomKpi/campaigns';
import type { SocialRow, WebRow } from '../../marcomKpi/digital';
import type { EventRow, TradeRow } from '../../marcomKpi/trade';

/**
 * DEV-ONLY dummy dataset for visual testing of the four MARCOM pages. Deterministic (no randomness)
 * and hand-designed so that, at some granularity, EVERY RAG KPI shows Green, Yellow and Red --
 * including exact-boundary values (ROI 5.0, CAC 3.0%, CPC 2.5, CTR 5.0%, ER 3.0%, session 3.0 / 1.0,
 * compliance 90% / 80%). Also: one brand over budget (Brand B), one with negative growth (Brand C),
 * a zero-spend campaign (=> "n/a"), overdue and future events, and a full 2025 backfill so LYTD works.
 *
 * All numbers are chosen so ratios are exact (integers / short decimals): the boundary cases must
 * land exactly on the boundary.
 */
export const DEMO_BRANDS = ['Brand A', 'Brand B', 'Brand C', 'Brand D'] as const;

export interface DemoDataset {
  spend: SpendRow[];
  social: SocialRow[];
  web: WebRow[];
  trade: TradeRow[];
  campaigns: CampaignRow[];
  media: MediaRow[];
  events: EventRow[];
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const round = Math.round;
/** Dollar-free money helper: exact to 2 dp. */
const cents = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- P1: MARCOM spending

interface BrandCfg {
  spend: number[];        // LYD thousands per month (Jan..Aug 2026)
  roi: number[];          // revenue attributed = spend * roi
  budgetFactor: number;   // budget = spend * factor
  cacLyd: number;         // LYD per new customer
  invoice: number;        // avg sales per invoice
  cpc: number;            // LYD per click
  clicksPerLyd: number;   // clicks = spend / this
  companyBase: number;    // company revenue, current year (monthly), LYD
  companyLyRatio: number; // LY revenue = current * ratio (=> growth = 1/ratio - 1)
}

const MONTH_FACTOR = [1.0, 1.02, 0.98, 1.03, 1.05, 1.0, 1.04, 1.06];

const BRAND_CFG: Record<(typeof DEMO_BRANDS)[number], BrandCfg> = {
  // Green ROI, CAC 2.5% (G), CPC 1.8 (G), +14.3% growth, ~91% of budget.
  'Brand A': {
    spend: [50, 52, 48, 55, 60, 58, 62, 65], roi: [6.8, 6.5, 6.2, 6.0, 6.4, 6.6, 6.1, 5.9],
    budgetFactor: 1.1, cacLyd: 125, invoice: 5000, cpc: 1.8, clicksPerLyd: 25, companyBase: 1_200_000, companyLyRatio: 0.875,
  },
  // Yellow ROI, CAC 4.2% (Y), CPC 3.5 (Y), +5% growth, OVER BUDGET (111%).
  'Brand B': {
    spend: [40, 42, 38, 45, 44, 46, 48, 50], roi: [4.6, 4.4, 4.2, 3.9, 4.1, 4.3, 4.0, 4.2],
    budgetFactor: 0.9, cacLyd: 250, invoice: 6000, cpc: 3.5, clicksPerLyd: 20, companyBase: 903_000, companyLyRatio: 1 / 1.05,
  },
  // Red ROI, CAC 7.5% (R), CPC 7.0 (R), NEGATIVE growth (-8%).
  'Brand C': {
    spend: [30, 32, 28, 35, 30, 33, 31, 29], roi: [2.6, 2.4, 2.2, 2.5, 2.3, 2.4, 2.1, 2.5],
    budgetFactor: 1.05, cacLyd: 600, invoice: 8000, cpc: 7, clicksPerLyd: 50, companyBase: 690_000, companyLyRatio: 1 / 0.92,
  },
  // Boundary brand: ROI exactly 5.0 (Y), CAC exactly 3.0% (G), CPC exactly 2.5 (Y), +20%, exactly on budget.
  'Brand D': {
    spend: [30, 36, 30, 24, 30, 36, 30, 24], roi: [5, 5, 5, 5, 5, 5, 5, 5],
    budgetFactor: 1.0, cacLyd: 600, invoice: 20_000, cpc: 2.5, clicksPerLyd: 12, companyBase: 600_000, companyLyRatio: 1 / 1.2,
  },
};

function spendRow(year: number, month: number, brandIdx: number, cfg: BrandCfg, mi: number, scale: number, roiShift: number): SpendRow {
  const brand = DEMO_BRANDS[brandIdx];
  const spend = round(cfg.spend[mi % 8] * 1000 * scale);
  const roi = cents(cfg.roi[mi % 8] + roiShift);
  const clicks = round(spend / cfg.clicksPerLyd);
  const company = round(cfg.companyBase * MONTH_FACTOR[mi % 8] * (year === 2026 ? 1 : 0.9));
  return {
    year, month, brandId: brandIdx + 1, brand,
    spend, revenue: round(spend * roi), budget: round(spend * cfg.budgetFactor),
    newCustomers: round(spend / cfg.cacLyd), avgInvoice: cfg.invoice,
    socialPostCost: round(clicks * cfg.cpc), clicks,
    companyCurrent: company, companyLy: round(company * cfg.companyLyRatio),
  };
}

function buildSpend(): SpendRow[] {
  const rows: SpendRow[] = [];
  DEMO_BRANDS.forEach((b, bi) => {
    const cfg = BRAND_CFG[b];
    // 2025 backfill (all 12 months, ~10% smaller, ROI ~1.2 lower) so LYTD/last-year lines exist.
    for (const m of range(1, 12)) rows.push(spendRow(2025, m, bi, cfg, m - 1, 0.9, -1.2));
    for (const m of range(1, 8)) rows.push(spendRow(2026, m, bi, cfg, m - 1, 1, 0));
  });
  return rows.sort((a, b) => a.year - b.year || a.month - b.month || a.brandId - b.brandId);
}

// ---------------------------------------------------------------- P3: digital

interface PlatformCfg { imp: number; ctr: number; er: number; followers: number; growth: number }
const PLATFORM_CFG: Record<string, PlatformCfg> = {
  Facebook:  { imp: 200_000, ctr: 0.06,  er: 0.065, followers: 40_000, growth: 800 },   // CTR G, ER G
  Instagram: { imp: 180_000, ctr: 0.05,  er: 0.0406, followers: 52_000, growth: 1_200 }, // CTR 5.0% exactly (Y), ER Y
  Google:    { imp: 300_000, ctr: 0.04,  er: 0.03,  followers: 8_000, growth: 150 },    // CTR Y, ER 3.0% exactly (Y)
  LinkedIn:  { imp: 60_000,  ctr: 0.025, er: 0.02,  followers: 15_000, growth: 300 },   // CTR R, ER R
  TikTok:    { imp: 400_000, ctr: 0.07,  er: 0.08,  followers: 20_000, growth: 2_500 }, // CTR G, ER G
};
const IMP_FACTOR = [0.9, 0.95, 1.0, 1.05, 1.1, 1.0, 1.15, 1.08];

function buildSocial(): SocialRow[] {
  const rows: SocialRow[] = [];
  for (const m of range(1, 8)) {
    for (const [platform, c] of Object.entries(PLATFORM_CFG)) {
      const impressions = round((c.imp * IMP_FACTOR[m - 1]) / 1000) * 1000;
      const clicks = round(impressions * c.ctr);
      const engagement = round(impressions * c.er);
      const paid = round(engagement * 0.55);
      rows.push({ year: 2026, month: m, platform, followers: c.followers + c.growth * m, impressions, clicks, paid, organic: engagement - paid });
    }
  }
  return rows;
}

const BOUNCE = [0.28, 0.30, 0.31, 0.33, 0.35, 0.36, 0.38, 0.40];
/** Average session minutes per month: G, Y(3.0 boundary), Y, Y, Y, Y(1.0 boundary), R, G. */
const SESSION_MIN = [3.5, 3.0, 2.6, 2.0, 1.5, 1.0, 0.8, 3.2];

function buildWeb(): WebRow[] {
  return range(1, 8).map((m) => {
    const totalVisitors = 12_000 + (m - 1) * 500;
    const sessions = 15_000 + (m - 1) * 300;
    return {
      year: 2026, month: m, totalVisitors, bounce: round(totalVisitors * BOUNCE[m - 1]),
      sessions, minutes: round(sessions * SESSION_MIN[m - 1] * 100) / 100,
    };
  });
}

// ---------------------------------------------------------------- P4: trade

const COMPLIANCE = [0.94, 0.92, 0.90, 0.88, 0.85, 0.80, 0.79, 0.94];   // Aug headline: Green
const GIVEAWAYS  = [0.95, 0.93, 0.91, 0.90, 0.88, 0.84, 0.78, 0.85];   // Aug headline: Yellow
const PRINTED    = [0.92, 0.90, 0.88, 0.85, 0.82, 0.79, 0.75, 0.72];   // Aug headline: Red
const ATTENDEES: [number, number][] = [[460, 500], [440, 500], [900, 1000], [820, 1000], [380, 500], [750, 1000], [300, 500], [850, 1000]];

function buildTrade(): TradeRow[] {
  return range(1, 8).map((m) => ({
    year: 2026, month: m,
    compliance: COMPLIANCE[m - 1].toFixed(4), giveaways: GIVEAWAYS[m - 1].toFixed(4), printed: PRINTED[m - 1].toFixed(4),
    actual: ATTENDEES[m - 1][0], expected: ATTENDEES[m - 1][1],
  }));
}

// ---------------------------------------------------------------- P2: campaigns + OOH

const B = (name: (typeof DEMO_BRANDS)[number]) => ({ brandId: DEMO_BRANDS.indexOf(name) + 1, brand: name });
const days = (a: string, b: string) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8))) / 86_400_000);
const camp = (name: string, brand: (typeof DEMO_BRANDS)[number], start: string, end: string, status: string, spend: number, revenue: number): CampaignRow =>
  ({ name, ...B(brand), status, start, end, durationDays: days(start, end), spend, revenue });

const CAMPAIGNS: CampaignRow[] = [
  camp('Ramadan Lighting Campaign', 'Brand A', '2026-02-01', '2026-03-15', 'Completed', 120_000, 650_000), // 5.42 G
  camp('Spring Kitchens Promo', 'Brand B', '2026-03-10', '2026-04-30', 'Completed', 80_000, 400_000),      // 5.00 Y (boundary)
  camp('Summer Outdoor Push', 'Brand A', '2026-06-01', '2026-08-31', 'Completed', 150_000, 1_050_000),      // 7.00 G
  camp('Eid Billboard Wave', 'Brand C', '2026-04-15', '2026-05-31', 'Completed', 100_000, 299_000),         // 2.99 R
  camp('Back To School', 'Brand D', '2026-08-15', '2026-10-15', 'Ongoing', 90_000, 270_000),                // 3.00 Y (boundary)
  camp('Autumn Refresh', 'Brand B', '2026-09-01', '2026-11-30', 'Ongoing', 60_000, 240_000),                // 4.00 Y
  camp('National Day Lights', 'Brand C', '2026-09-10', '2026-09-25', 'On Hold', 50_000, 75_000),            // 1.50 R
  camp('Year-End Mega Sale', 'Brand D', '2026-11-15', '2026-12-31', 'Planned', 0, 0),                        // n/a (zero spend)
];

const m = (campaignName: string, mediaType: string, units: number, cost: number): MediaRow => ({ campaignName, mediaType, units, cost });
const MEDIA: MediaRow[] = [
  m('Ramadan Lighting Campaign', '1-Street Lights', 45, 30_000), m('Ramadan Lighting Campaign', '2-Mega Billboards', 6, 45_000),
  m('Spring Kitchens Promo', '3-Billboards', 10, 12_000),
  m('Summer Outdoor Push', '3-Billboards', 20, 25_000), m('Summer Outdoor Push', '4-Bridge Banners', 8, 18_000), m('Summer Outdoor Push', '5-Light Screen', 4, 22_000),
  m('Eid Billboard Wave', '1-Street Lights', 30, 20_000), m('Eid Billboard Wave', '3-Billboards', 10, 32_000),
  m('Back To School', '2-Mega Billboards', 12, 60_000), m('Back To School', '4-Bridge Banners', 6, 9_000),
  m('Autumn Refresh', '5-Light Screen', 15, 30_000),
  m('National Day Lights', '1-Street Lights', 25, 15_000), m('National Day Lights', '2-Mega Billboards', 3, 21_000),
];

// ---------------------------------------------------------------- P4-B: events (all 8 types, all 4 statuses)

const ev = (name: string, type: string, brand: (typeof DEMO_BRANDS)[number], planned: string, status: string, completion: string | null): EventRow =>
  ({ name, type, ...B(brand), planned, completion, status });

const EVENTS: EventRow[] = [
  ev('Architects Breakfast', '2-Architects/Designers', 'Brand A', '2026-01-20', 'Completed', '2026-01-20'),
  ev('Contractors Meetup', '1-Professionals', 'Brand B', '2026-02-11', 'Completed', '2026-02-11'),
  ev('Corporate Showroom Tour', '3-Corporate', 'Brand A', '2026-02-25', 'Completed', '2026-02-25'),
  ev('Ramadan Charity Iftar', '4-CSR', 'Brand C', '2026-03-05', 'Completed', '2026-03-05'),
  ev('Brand Launch Night', '6-Launch & Opening', 'Brand A', '2026-03-18', 'Completed', '2026-03-18'),
  ev('Training Day Q1', '7-Internal/Trainings', 'Brand D', '2026-03-28', 'Completed', '2026-03-28'),
  ev('Cityscape Exhibition', '8-Exhibitions', 'Brand B', '2026-04-14', 'Completed', '2026-04-16'),
  ev('Live Music Evening', '5-Entertainment', 'Brand D', '2026-04-22', 'Cancelled', null),
  ev('Designers Roundtable', '2-Architects/Designers', 'Brand C', '2026-05-09', 'Completed', '2026-05-09'),
  ev('Professional Workshop', '1-Professionals', 'Brand A', '2026-05-20', 'Postponed', null),
  ev('Corporate Partner Day', '3-Corporate', 'Brand B', '2026-06-04', 'Completed', '2026-06-04'),
  ev('Summer CSR Drive', '4-CSR', 'Brand D', '2026-06-18', 'Completed', '2026-06-18'),
  ev('New Range Opening', '6-Launch & Opening', 'Brand C', '2026-07-02', 'Completed', '2026-07-03'),
  ev('Sales Team Training', '7-Internal/Trainings', 'Brand A', '2026-07-16', 'Planned', null),          // overdue
  ev('Build Expo', '8-Exhibitions', 'Brand B', '2026-07-28', 'Completed', '2026-07-28'),
  ev('Beach Festival Activation', '5-Entertainment', 'Brand D', '2026-08-08', 'Completed', '2026-08-08'),
  ev('Architects Forum', '2-Architects/Designers', 'Brand A', '2026-08-21', 'Planned', null),          // overdue
  ev('Autumn Contractors Fair', '1-Professionals', 'Brand C', '2026-09-24', 'Planned', null),           // future
  ev('Year-End Corporate Gala', '3-Corporate', 'Brand D', '2026-11-12', 'Planned', null),
  ev('Holiday Expo', '8-Exhibitions', 'Brand B', '2026-12-05', 'Planned', null),
];

export function buildDemoDataset(): DemoDataset {
  return { spend: buildSpend(), social: buildSocial(), web: buildWeb(), trade: buildTrade(), campaigns: CAMPAIGNS, media: MEDIA, events: EVENTS };
}
