import { combineSpendRows, type CampaignCost, type OtherCost } from './spendCompatibility';
import { DateTime } from 'luxon';
import { getAppTimezone } from '../lib/timezone';
import { getFreshness } from '../marcom/service';
import { BRAND_JOIN, availableYears, listBrands, latestMonth, runCurrent, where } from './db';
import { applyDefaults, parseBool, parseBrandIds, parseCommonRaw, parseCompanyKeys, parsePlatforms, parseStatuses } from './params';
import { BrandRef, CompanyRef } from './common';
import type { RoiRow } from './roi';
import { makeEnvelope, Options } from './envelope';
import { CAMPAIGN_STATUSES, PLATFORMS } from '../marcom/templateConfig';
import { SpendRow, buildSpending } from './spending';
import { CampaignRow, MediaRow, buildCampaigns } from './campaigns';
import { SocialRow, WebRow, buildDigital } from './digital';
import { EventRow, TradeRow, buildTrade } from './trade';

type Raw = Record<string, unknown>;

/** Same zone as lib/timezone.ts (the business timezone every date in this app is read in). */
export const businessToday = (): string => DateTime.now().setZone(getAppTimezone()).toISODate()!;

const pad = (n: number) => String(n).padStart(2, '0');
const monthStart = (y: number, m: number) => `${y}-${pad(m)}-01`;
const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;

/**
 * Resolves year/month defaults, validates brand ids and company keys and echoes what was applied.
 * Effective brands = brands of the selected companies, intersected with the selected brands when both are
 * given. `brandFilter` is what the SQL filters by (undefined = no brand/company filter = every brand).
 */
async function resolve(raw: Raw) {
  const common = parseCommonRaw(raw);
  const brands: BrandRef[] = await listBrands();
  const companies: CompanyRef[] = [...new Map(
    brands.filter((b) => b.companyKey !== null && b.companyKey !== undefined).map((b) => [b.companyKey as number, { key: b.companyKey as number, name: b.company ?? `#${b.companyKey}` }]),
  ).values()].sort((a, b) => a.name.localeCompare(b.name));
  const brandIds = parseBrandIds(raw, brands);
  const companyKeys = parseCompanyKeys(raw, companies.map((c) => c.key));
  // Only hit the latest-period queries when a default is actually needed.
  const needsLatest = common.year === undefined || common.toMonth === undefined;
  const latest = needsLatest ? await latestMonth(common.year) : null;
  const applied = applyDefaults(common, latest, Number(businessToday().slice(0, 4)));
  let brandFilter: number[] | undefined = brandIds;
  if (companyKeys) {
    const ofCompanies = brands.filter((b) => b.companyKey !== null && b.companyKey !== undefined && companyKeys.includes(b.companyKey)).map((b) => b.id);
    brandFilter = brandIds ? ofCompanies.filter((id) => brandIds.includes(id)) : ofCompanies;
  }
  const selected: BrandRef[] = brandFilter ? brands.filter((b) => brandFilter!.includes(b.id)) : brands;
  const selectedCompanies = companyKeys ? companies.filter((c) => companyKeys.includes(c.key)) : [];
  return { ...applied, brands, companies, brandIds, brandFilter, selected, selectedCompanies };
}

type Resolved = Awaited<ReturnType<typeof resolve>>;

/** Spend rows of `year` and `year - 1`, months fromMonth..toMonth, for the effective brands. */
async function spendRows(r: Resolved): Promise<SpendRow[]> {
  const select = `t.year AS year, t.month AS month, t.brand_id AS brandId, b.name AS brand,
    t.spend AS spend, t.revenue_attributed AS revenue, t.company_revenue_current AS companyCurrent,
    t.company_revenue_ly AS companyLy, t.budget AS budget, t.new_customers AS newCustomers,
    t.avg_invoice AS avgInvoice, t.social_post_cost AS socialPostCost, t.clicks AS clicks`;
  const query = { select, joins: [BRAND_JOIN], where: [where.in('t.year', [r.year,r.year-1]), where.between('t.month',r.fromMonth,r.toMonth), r.brandFilter ? where.in('t.brand_id',r.brandFilter) : null], orderBy: 't.year, t.month, t.brand_id' };
  try { return await runCurrent<SpendRow>('spend', query); }
  catch (error) {
    if ((error as {code?:string}).code !== 'ER_BAD_FIELD_ERROR' || !String((error as Error).message).includes('spend')) throw error;
  }
  // The revised schema retains the old company inputs for review; do not substitute brand revenue for them.
  const [monthly,campaigns,other] = await Promise.all([
    runCurrent<SpendRow>('spend',{...query,select:select.replace('t.spend AS spend','0 AS spend').replace('t.company_revenue_current','t.legacy_company_revenue_current').replace('t.company_revenue_ly','t.legacy_company_revenue_ly')}),
    runCurrent<CampaignCost>('campaigns',{select:"t.brand_id AS brandId, DATE_FORMAT(t.start_date, '%Y-%m-%d') AS start, DATE_FORMAT(t.end_date, '%Y-%m-%d') AS end, t.spend AS spend",where:[where.lte('t.start_date',monthEnd(r.year,r.toMonth)),where.gte('t.end_date',monthStart(r.year-1,r.fromMonth)),r.brandFilter?where.in('t.brand_id',r.brandFilter):null]}),
    runCurrent<OtherCost>('other',{select:'t.year AS year, t.month AS month, t.brand_id AS brandId, t.amount_lyd AS amount',where:query.where}),
  ]);
  return combineSpendRows(monthly,campaigns,other,[r.year-1,r.year],r.fromMonth,r.toMonth,r.selected);
}

async function envelope<T extends { hasData: boolean; meta: { missing: string[] } }>(
  page: string, filters: Record<string, unknown>, r: Resolved, payload: T, extra: Pick<Options, 'platforms' | 'statuses'> = {},
) {
  const [freshness, years] = await Promise.all([getFreshness(), availableYears()]);
  return makeEnvelope(page, filters, { years, brands: r.brands, companies: r.companies, ...extra }, freshness, payload);
}

// ---------------------------------------------------------------------------------------------

export async function spendingPage(raw: Raw) {
  const r = await resolve(raw);
  const rows = await spendRows(r);
  const payload = buildSpending({
    year: r.year, fromMonth: r.fromMonth, toMonth: r.toMonth, brands: r.selected,
    current: rows.filter((x) => x.year === r.year),
    previous: rows.filter((x) => x.year === r.year - 1),
  });
  return envelope('spending', { year: r.year, fromMonth: r.fromMonth, toMonth: r.toMonth, brands: r.selected, companies: r.selectedCompanies }, r, payload);
}

export async function campaignsPage(raw: Raw) {
  const r = await resolve(raw);
  const statuses = parseStatuses(raw);
  const start = monthStart(r.year, r.fromMonth);
  const end = monthEnd(r.year, r.toMonth);
  const campaigns = await runCurrent<CampaignRow>('campaigns', {
    select: `t.name AS name, t.brand_id AS brandId, b.name AS brand, t.status AS status,
             DATE_FORMAT(t.start_date, '%Y-%m-%d') AS start, DATE_FORMAT(t.end_date, '%Y-%m-%d') AS end,
             DATEDIFF(t.end_date, t.start_date) AS durationDays, t.spend AS spend, t.revenue_attributed AS revenue`,
    joins: [BRAND_JOIN],
    // Overlap with the selected period: starts before it ends and ends after it starts.
    where: [where.lte('t.start_date', end), where.gte('t.end_date', start), r.brandFilter ? where.in('t.brand_id', r.brandFilter) : null, statuses ? where.in('t.status', statuses) : null],
    orderBy: 't.start_date, t.name',
  });
  // ROI trend -- YTD vs LYTD (moved here from the Spending page): monthly spend rows, same period and brands.
  const roiRows = await spendRows(r);
  const media = campaigns.length
    ? await runCurrent<MediaRow>('media', {
        select: 't.campaign_name AS campaignName, t.media_type AS mediaType, t.city AS city, t.units AS units, t.cost AS cost',
        where: [where.in('t.campaign_name', campaigns.map((c) => c.name))],
      })
    : [];
  const payload = buildCampaigns({
    year: r.year, fromMonth: r.fromMonth, toMonth: r.toMonth, campaigns, media, today: businessToday(),
    roiRows: { current: roiRows.filter((x) => x.year === r.year), previous: roiRows.filter((x) => x.year === r.year - 1) },
  });
  return envelope('campaigns', { year: r.year, fromMonth: r.fromMonth, toMonth: r.toMonth, brands: r.selected, companies: r.selectedCompanies, statuses: statuses ?? [] }, r, payload, { statuses: CAMPAIGN_STATUSES });
}

export async function digitalPage(raw: Raw) {
  const r = await resolve(raw);
  const platforms = parsePlatforms(raw);
  const selected = platforms ? PLATFORMS.filter((p) => platforms.includes(p)) : [...PLATFORMS];
  const [social, web] = await Promise.all([
    // months 1..toMonth: months before fromMonth only feed the follower snapshot.
    runCurrent<SocialRow>('social', {
      select: `t.year AS year, t.month AS month, t.platform AS platform, t.followers AS followers, t.impressions AS impressions,
               t.clicks AS clicks, t.engagement_paid AS paid, t.engagement_organic AS organic`,
      where: [where.eq('t.year', r.year), where.lte('t.month', r.toMonth), platforms ? where.in('t.platform', platforms) : null],
      orderBy: 't.month, t.platform',
    }),
    runCurrent<WebRow>('web', {
      select: `t.year AS year, t.month AS month, t.bounce_visitors AS bounce, t.total_visitors AS totalVisitors,
               t.sessions AS sessions, t.total_minutes AS minutes`,
      where: [where.eq('t.year', r.year), where.between('t.month', r.fromMonth, r.toMonth)],
      orderBy: 't.month',
    }),
  ]);
  const payload = buildDigital({ year: r.year, fromMonth: r.fromMonth, toMonth: r.toMonth, social, web, platforms: selected });
  return envelope('digital', { year: r.year, fromMonth: r.fromMonth, toMonth: r.toMonth, platforms: selected }, r, payload, { platforms: PLATFORMS });
}

export async function tradePage(raw: Raw) {
  const r = await resolve(raw);
  const completedOnly = parseBool(raw, 'completedOnly') ?? false;
  const [trade, events] = await Promise.all([
    runCurrent<TradeRow>('trade', {
      select: `t.year AS year, t.month AS month, t.compliance_pct AS compliance, t.giveaways_stock_pct AS giveaways,
               t.printed_stock_pct AS printed, t.attendees_actual AS actual, t.attendees_expected AS expected`,
      where: [where.eq('t.year', r.year), where.between('t.month', r.fromMonth, r.toMonth)],
      orderBy: 't.month',
    }),
    runCurrent<EventRow>('events', {
      select: `t.name AS name, t.event_type AS type, t.brand_id AS brandId, b.name AS brand,
               DATE_FORMAT(t.planned_date, '%Y-%m-%d') AS planned, DATE_FORMAT(t.completion_date, '%Y-%m-%d') AS completion, t.status AS status`,
      joins: [BRAND_JOIN],
      where: [where.between('t.planned_date', monthStart(r.year, r.fromMonth), monthEnd(r.year, r.toMonth)), r.brandFilter ? where.in('t.brand_id', r.brandFilter) : null],
      orderBy: 't.planned_date, t.name',
    }),
  ]);
  const payload = buildTrade({ year: r.year, fromMonth: r.fromMonth, toMonth: r.toMonth, trade, events, today: businessToday(), completedOnly });
  return envelope('trade', { year: r.year, fromMonth: r.fromMonth, toMonth: r.toMonth, brands: r.selected, companies: r.selectedCompanies, completedOnly }, r, payload);
}

export { makeEnvelope };
