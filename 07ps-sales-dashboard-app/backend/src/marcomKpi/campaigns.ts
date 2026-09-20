import { R, Rat, sum } from './rat';
import { makeKpi, classify } from './kpi';
import * as F from './formulas';
import { AppliedPeriod, Num, total } from './common';
import { RAG_RULES } from './thresholds';
import { MEDIA_TYPES } from '../marcom/templateConfig';

export interface CampaignRow {
  name: string; brandId: number; brand: string; status: string;
  start: string; end: string; durationDays: number; spend: Num; revenue: Num;
}
export interface MediaRow { campaignName: string; mediaType: string; units: Num; cost: Num }

export interface CampaignsInput extends AppliedPeriod {
  /** Campaigns overlapping the period, already brand/status-filtered (current rows only). */
  campaigns: CampaignRow[];
  /** Media rows of exactly those campaigns. */
  media: MediaRow[];
  /** Today's date in the business timezone, 'YYYY-MM-DD'. */
  today: string;
}

/** Page 2 -- Media Campaign Performance. */
export function buildCampaigns(input: CampaignsInput) {
  const { campaigns, media, today } = input;
  const spend = total(campaigns, (c) => c.spend);
  const revenue = total(campaigns, (c) => c.revenue);
  const rateOf = (rev: Rat, sp: Rat) => F.campaignRate(rev, sp);

  const withRoi = campaigns.map((c) => {
    const roi = F.roiRatio(R(c.revenue), R(c.spend));
    return { c, roi, roiKpi: makeKpi('ratio', roi, { rule: 'roi', direction: 'higher_better' }) };
  });

  const byRevenueDesc = [...withRoi].sort((a, b) => R(b.c.revenue).cmp(R(a.c.revenue)) || a.c.name.localeCompare(b.c.name));

  const mediaRows = media.map((m) => ({ ...m, units: R(m.units), cost: R(m.cost) }));
  const perType = MEDIA_TYPES.map((type) => {
    const rows = mediaRows.filter((m) => m.mediaType === type);
    const units = sum(rows.map((m) => m.units));
    const cost = sum(rows.map((m) => m.cost));
    return { mediaType: type, units, cost, costPerUnit: cost.div(units) };
  });
  const totalUnits = sum(perType.map((t) => t.units));

  return {
    period: { year: input.year, fromMonth: input.fromMonth, toMonth: input.toMonth },
    hasData: campaigns.length > 0,
    meta: { missing: [] as string[] },
    today,
    totals: {
      spend: spend.toNumber(),
      revenue: revenue.toNumber(),
      /** Revenue ÷ Spend × 100 (see formulas.campaignRate). */
      rate: makeKpi('percent', rateOf(revenue, spend), { direction: 'higher_better' }),
    },
    spendVsRevenue: byRevenueDesc.map(({ c }) => ({
      name: c.name, brandId: c.brandId, brand: c.brand, status: c.status,
      spend: R(c.spend).toNumber(), revenue: R(c.revenue).toNumber(),
    })),
    roiByCampaign: {
      bands: { greenAbove: Number(RAG_RULES.roi.green.value), redBelow: Number(RAG_RULES.roi.red.value) },
      campaigns: byRevenueDesc.map(({ c, roiKpi }) => ({ name: c.name, brand: c.brand, roi: roiKpi })),
    },
    timeline: withRoi.map(({ c, roiKpi }) => ({
      name: c.name, brandId: c.brandId, brand: c.brand, status: c.status,
      start: c.start, end: c.end, durationDays: c.durationDays,
      spend: R(c.spend).toNumber(), revenue: R(c.revenue).toNumber(),
      roi: roiKpi.value, roiStatus: roiKpi.status,
      rate: makeKpi('percent', rateOf(R(c.revenue), R(c.spend))).value,
    })).sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name)),
    coverageByType: {
      totalUnits: totalUnits.toNumber(),
      types: perType.map((t) => ({
        mediaType: t.mediaType, units: t.units.toNumber(),
        share: makeKpi('percent', t.units.div(totalUnits)).value,
      })),
    },
    costByType: {
      totalCost: sum(perType.map((t) => t.cost)).toNumber(),
      types: perType.map((t) => ({
        mediaType: t.mediaType, cost: t.cost.toNumber(), units: t.units.toNumber(),
        costPerUnit: t.costPerUnit === null ? null : t.costPerUnit.toNumber(),
      })),
    },
  };
}
