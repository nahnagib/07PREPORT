import { Rat, R, sum } from './rat';
import { Kpi, makeKpi, classify, withMonthlyTrend } from './kpi';
import * as F from './formulas';
import { AppliedPeriod, BrandRef, Num, groupBy, monthRange, total } from './common';
import { PLATFORMS } from '../marcom/templateConfig';

/**
 * Social / web rows are per brand since template 2.0 (migration 0061). brandId null = a row uploaded before that
 * (needs review): it is never assigned to a brand, only counted under "All".
 */
export interface SocialRow {
  year: number; month: number; platform: string;
  brandId?: number | null; brand?: string | null; accountName?: string | null;
  followers: Num; impressions: Num; clicks: Num; paid: Num; organic: Num;
}
export interface WebRow { year: number; month: number; brandId?: number | null; brand?: string | null; bounce: Num; totalVisitors: Num; sessions: Num; minutes: Num }

export interface DigitalInput extends AppliedPeriod {
  /** Social rows of `year`, months 1..toMonth (platform/brand-filtered; months before fromMonth feed the follower snapshot only). */
  social: SocialRow[];
  /** Website rows of `year`, months fromMonth..toMonth (brand-filtered). */
  web: WebRow[];
  /** Selected platforms (all when no filter), in display order. */
  platforms: string[];
  /** Selected brands (all when no filter) -- one entry each in the brand comparison. */
  brands?: BrandRef[];
}

/** Label of the comparison entry holding pre-2.0 rows without a brand. */
export const NO_BRAND_LABEL = 'No brand (needs review)';

const hasBrand = (r: { brandId?: number | null }) => r.brandId !== null && r.brandId !== undefined;

/**
 * Pre-2.0 brand-less rows are dropped for any (year, month, platform) -- web: (year, month) -- that already has
 * branded rows, so a month re-entered per brand is never counted twice.
 */
export function dropSupersededLegacy<T extends { year: number; month: number; brandId?: number | null; platform?: string }>(rows: T[]): T[] {
  const cell = (r: T) => `${r.year}-${r.month}-${r.platform ?? ''}`;
  const branded = new Set(rows.filter(hasBrand).map(cell));
  return rows.filter((r) => hasBrand(r) || !branded.has(cell(r)));
}

/** Last two months (with data) of a monthly series -> exact values for the trend arrow. */
function lastTwo(series: { month: number; value: Rat | null }[]): { last: Rat | null; prev: Rat | null } {
  const have = series.filter((s) => s.value !== null);
  return { last: have.length ? have[have.length - 1].value : null, prev: have.length > 1 ? have[have.length - 2].value : null };
}

interface SAgg { impressions: Rat; clicks: Rat; paid: Rat; organic: Rat }
const sAgg = (rows: SocialRow[]): SAgg => ({
  impressions: total(rows, (r) => r.impressions), clicks: total(rows, (r) => r.clicks),
  paid: total(rows, (r) => r.paid), organic: total(rows, (r) => r.organic),
});

/**
 * Followers are a snapshot, NEVER summed across months: the latest month (<= toMonth) of each brand + platform +
 * account, then added across accounts/brands.
 */
function latestFollowers(rows: SocialRow[]): { value: Rat | null; asOf: { year: number; month: number } | null } {
  const latest = new Map<string, SocialRow>();
  for (const r of rows) {
    const k = `${r.brandId ?? 'none'}|${r.platform}|${(r.accountName ?? '').toLowerCase()}`;
    const prev = latest.get(k);
    if (!prev || r.month > prev.month) latest.set(k, r);
  }
  if (!latest.size) return { value: null, asOf: null };
  const picked = [...latest.values()];
  const newest = picked.reduce((a, b) => (b.month > a.month ? b : a));
  return { value: sum(picked.map((r) => R(r.followers))), asOf: { year: newest.year, month: newest.month } };
}

/** Page 3 -- Digital Performance. */
export function buildDigital(input: DigitalInput) {
  const { year, fromMonth, toMonth, platforms } = input;
  const months = monthRange(fromMonth, toMonth);
  const social = dropSupersededLegacy(input.social);
  const web = dropSupersededLegacy(input.web);
  const inRange = social.filter((r) => r.month >= fromMonth && r.month <= toMonth);
  const overall = sAgg(inRange);
  const socialByMonth = groupBy(inRange, (r) => r.month);
  const socialByPlatform = groupBy(inRange, (r) => r.platform);

  // ---- followers: latest snapshot per brand + platform + account (<= toMonth), summed per platform.
  const followerRows = platforms.map((p) => ({ platform: p, ...latestFollowers(social.filter((r) => r.platform === p)) }));
  const knownF = followerRows.filter((f) => f.value !== null);
  const followerTotal = knownF.length ? sum(knownF.map((f) => f.value!)) : null;
  const fb = followerRows.find((f) => f.platform === 'Facebook')?.value ?? null;
  const ig = followerRows.find((f) => f.platform === 'Instagram')?.value ?? null;
  const metaTotal = fb === null && ig === null ? null : (fb ?? Rat.ZERO).add(ig ?? Rat.ZERO);

  // ---- CTR / engagement rate: overall + per platform, with month-over-month trend on the overall card.
  const monthlyCtr = months.map((m) => ({ month: m, value: socialByMonth.has(m) ? F.ctr(sAgg(socialByMonth.get(m)!).clicks, sAgg(socialByMonth.get(m)!).impressions) : null }));
  const monthlyEr = months.map((m) => {
    const a = socialByMonth.has(m) ? sAgg(socialByMonth.get(m)!) : null;
    return { month: m, value: a ? F.engagementRate(a.paid, a.organic, a.impressions) : null };
  });
  const ctrKpi = (a: SAgg) => makeKpi('percent', F.ctr(a.clicks, a.impressions), { rule: 'ctr', direction: 'higher_better' });
  const erKpi = (a: SAgg) => makeKpi('percent', F.engagementRate(a.paid, a.organic, a.impressions), { rule: 'engagementRate', direction: 'higher_better' });
  const t1 = lastTwo(monthlyCtr);
  const t2 = lastTwo(monthlyEr);

  // ---- organic vs paid per month
  const engagementMonthly = months.map((m) => {
    const rows = socialByMonth.get(m);
    const a = rows ? sAgg(rows) : null;
    return {
      year, month: m,
      paid: a ? a.paid.toNumber() : null,
      organic: a ? a.organic.toNumber() : null,
      organicShare: a ? makeKpi('percent', F.organicShare(a.paid, a.organic)).value : null,
    };
  });

  // ---- website
  type WAgg = { bounce: Rat; visitors: Rat; sessions: Rat; minutes: Rat };
  const wAgg = (rows: WebRow[]): WAgg => ({ bounce: total(rows, (r) => r.bounce), visitors: total(rows, (r) => r.totalVisitors), sessions: total(rows, (r) => r.sessions), minutes: total(rows, (r) => r.minutes) });
  const webByMonth = groupBy(web, (r) => r.month);
  const wTotals = wAgg(web);
  const monthlyBounce = months.map((m) => {
    const rows = webByMonth.get(m);
    return { month: m, value: rows ? F.bounceRate(total(rows, (r) => r.bounce), total(rows, (r) => r.totalVisitors)) : null };
  });
  const monthlySession = months.map((m) => {
    const rows = webByMonth.get(m);
    return { month: m, value: rows ? F.avgSessionMinutes(total(rows, (r) => r.minutes), total(rows, (r) => r.sessions)) : null };
  });
  const b = lastTwo(monthlyBounce);
  const s = lastTwo(monthlySession);
  const bounceKpi = (a: WAgg) => makeKpi('percent', F.bounceRate(a.bounce, a.visitors), { direction: 'lower_better' });
  const sessionKpi = (a: WAgg) => makeKpi('minutes', F.avgSessionMinutes(a.minutes, a.sessions), { rule: 'avgSessionMinutes', direction: 'higher_better' });

  // ---- side-by-side comparison by brand (every KPI of the page, per brand)
  const legacySocial = inRange.filter((r) => !hasBrand(r));
  const legacyWeb = web.filter((r) => !hasBrand(r));
  const entries: { brandId: number | null; brand: string; social: SocialRow[]; followerRows: SocialRow[]; web: WebRow[] }[] = (input.brands ?? []).map((br) => ({
    brandId: br.id, brand: br.name,
    social: inRange.filter((r) => r.brandId === br.id),
    followerRows: social.filter((r) => r.brandId === br.id),
    web: web.filter((r) => r.brandId === br.id),
  }));
  if (legacySocial.length || legacyWeb.length) {
    entries.push({ brandId: null, brand: NO_BRAND_LABEL, social: legacySocial, followerRows: social.filter((r) => !hasBrand(r)), web: legacyWeb });
  }
  const byBrand = entries
    .filter((e) => e.social.length || e.web.length || e.followerRows.length)
    .map((e) => {
      const a = sAgg(e.social);
      const w = wAgg(e.web);
      return {
        brandId: e.brandId, brand: e.brand, needsReview: e.brandId === null,
        followers: latestFollowers(e.followerRows).value?.toNumber() ?? null,
        impressions: a.impressions.toNumber(), clicks: a.clicks.toNumber(), engagement: a.paid.add(a.organic).toNumber(),
        ctr: ctrKpi(a), engagementRate: erKpi(a),
        visitors: e.web.length ? w.visitors.toNumber() : null,
        bounceRate: bounceKpi(w), avgSession: sessionKpi(w),
      };
    });

  const hasData = social.some((r) => r.month >= fromMonth) || web.length > 0;
  const meta: { missing: string[]; deltaBasis: string; brandNeedsReview?: number } = { missing: [], deltaBasis: 'lastMonthVsPreviousMonth' };
  if (legacySocial.length || legacyWeb.length) {
    meta.missing.push('brandNeedsReview');
    meta.brandNeedsReview = legacySocial.length + legacyWeb.length;
  }

  return {
    period: { year, fromMonth, toMonth },
    hasData,
    meta,
    followers: {
      platforms: followerRows.map((f) => ({ platform: f.platform, value: f.value === null ? null : f.value.toNumber(), asOf: f.asOf })),
      total: followerTotal === null ? null : followerTotal.toNumber(),
      /** Facebook + Instagram (the template has no separate "Meta" entry). */
      metaTotal: metaTotal === null ? null : metaTotal.toNumber(),
    },
    ctr: {
      overall: withMonthlyTrend(ctrKpi(overall), 'percent', t1.last, t1.prev),
      byPlatform: platforms.map((p) => ({ platform: p, kpi: ctrKpi(sAgg(socialByPlatform.get(p) ?? [])) })),
    },
    engagementRate: {
      overall: withMonthlyTrend(erKpi(overall), 'percent', t2.last, t2.prev),
      byPlatform: platforms.map((p) => ({ platform: p, kpi: erKpi(sAgg(socialByPlatform.get(p) ?? [])) })),
    },
    engagementMonthly,
    bounceRate: {
      kpi: withMonthlyTrend(bounceKpi(wTotals), 'percent', b.last, b.prev),
      series: monthlyBounce.map((x) => ({ year, month: x.month, value: x.value === null ? null : makeKpi('percent', x.value).value })),
    },
    avgSession: {
      kpi: withMonthlyTrend(sessionKpi(wTotals), 'minutes', s.last, s.prev),
      series: monthlySession.map((x) => ({
        year, month: x.month,
        value: x.value === null ? null : x.value.toNumber(),
        status: classify('avgSessionMinutes', x.value),
      })),
    },
    byBrand,
  };
}

export type { Kpi };
export const ALL_PLATFORMS: readonly string[] = PLATFORMS;
