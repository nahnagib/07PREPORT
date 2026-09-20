import { Rat, R, sum } from './rat';
import { Kpi, makeKpi, classify, withMonthlyTrend } from './kpi';
import * as F from './formulas';
import { AppliedPeriod, Num, groupBy, monthRange, total } from './common';
import { PLATFORMS } from '../marcom/templateConfig';

export interface SocialRow {
  year: number; month: number; platform: string;
  followers: Num; impressions: Num; clicks: Num; paid: Num; organic: Num;
}
export interface WebRow { year: number; month: number; bounce: Num; totalVisitors: Num; sessions: Num; minutes: Num }

export interface DigitalInput extends AppliedPeriod {
  /** Social rows of `year`, months 1..toMonth (platform-filtered; months before fromMonth feed the follower snapshot only). */
  social: SocialRow[];
  /** Website rows of `year`, months fromMonth..toMonth. */
  web: WebRow[];
  /** Selected platforms (all when no filter), in display order. */
  platforms: string[];
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

/** Page 3 -- Digital Performance. */
export function buildDigital(input: DigitalInput) {
  const { year, fromMonth, toMonth, platforms } = input;
  const months = monthRange(fromMonth, toMonth);
  const inRange = input.social.filter((r) => r.month >= fromMonth && r.month <= toMonth);
  const overall = sAgg(inRange);
  const socialByMonth = groupBy(inRange, (r) => r.month);
  const socialByPlatform = groupBy(inRange, (r) => r.platform);

  // ---- followers: latest snapshot per platform (<= toMonth), NEVER summed across months.
  const followerRows = platforms.map((p) => {
    const rows = input.social.filter((r) => r.platform === p).sort((a, b) => b.month - a.month);
    const latest = rows[0];
    return { platform: p, value: latest ? R(latest.followers) : null, asOf: latest ? { year: latest.year, month: latest.month } : null };
  });
  const known = followerRows.filter((f) => f.value !== null);
  const followerTotal = known.length ? sum(known.map((f) => f.value!)) : null;
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
  const webByMonth = groupBy(input.web, (r) => r.month);
  const wTotals = { bounce: total(input.web, (r) => r.bounce), visitors: total(input.web, (r) => r.totalVisitors), sessions: total(input.web, (r) => r.sessions), minutes: total(input.web, (r) => r.minutes) };
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

  const hasData = input.social.some((r) => r.month >= fromMonth) || input.web.length > 0;

  return {
    period: { year, fromMonth, toMonth },
    hasData,
    meta: { missing: [] as string[], deltaBasis: 'lastMonthVsPreviousMonth' },
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
      kpi: withMonthlyTrend(makeKpi('percent', F.bounceRate(wTotals.bounce, wTotals.visitors), { direction: 'lower_better' }), 'percent', b.last, b.prev),
      series: monthlyBounce.map((x) => ({ year, month: x.month, value: x.value === null ? null : makeKpi('percent', x.value).value })),
    },
    avgSession: {
      kpi: withMonthlyTrend(makeKpi('minutes', F.avgSessionMinutes(wTotals.minutes, wTotals.sessions), { rule: 'avgSessionMinutes', direction: 'higher_better' }), 'minutes', s.last, s.prev),
      series: monthlySession.map((x) => ({
        year, month: x.month,
        value: x.value === null ? null : x.value.toNumber(),
        status: classify('avgSessionMinutes', x.value),
      })),
    },
  };
}

export type { Kpi };
export const ALL_PLATFORMS: readonly string[] = PLATFORMS;
