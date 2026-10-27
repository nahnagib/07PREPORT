import { R, Rat, sum } from './rat';
import { makeKpi, classify } from './kpi';
import * as F from './formulas';
import { AppliedPeriod, Num, total } from './common';
import { RAG_RULES } from './thresholds';
import { MEDIA_TYPES } from '../marcom/templateConfig';
import { RoiRow, buildRoi } from './roi';

export interface CampaignRow {
  name: string; brandId: number; brand: string; status: string;
  start: string; end: string; durationDays: number; spend: Num; revenue: Num;
}
/** `city` is '' / null for rows uploaded before template 1.1 (no City column). */
export interface MediaRow { campaignName: string; mediaType: string; city?: string | null; units: Num; cost: Num }

/** Label for media rows without a city (uploaded before template 1.1). */
export const NO_CITY = 'No city';

/**
 * A campaign re-uploaded with city rows still has its old city-less rows (uploads are upserts by key), so once a
 * campaign has ANY city row, its city-less rows are dropped -- otherwise its cost would be counted twice.
 */
export function dropLegacyCityless(media: MediaRow[]): MediaRow[] {
  const withCity = new Set(media.filter((m) => (m.city ?? '') !== '').map((m) => m.campaignName.toLowerCase()));
  return media.filter((m) => (m.city ?? '') !== '' || !withCity.has(m.campaignName.toLowerCase()));
}

export interface CampaignsInput extends AppliedPeriod {
  /** Campaigns overlapping the period, already brand/status-filtered (current rows only). */
  campaigns: CampaignRow[];
  /** Media rows of exactly those campaigns. */
  media: MediaRow[];
  /** Today's date in the business timezone, 'YYYY-MM-DD'. */
  today: string;
  /**
   * Monthly spend rows for the "ROI trend -- YTD vs LYTD" card, which moved here from the
   * Spending page: `current` = year, months fromMonth..toMonth; `previous` = the same months of year - 1. Same
   * brand filter as the campaigns. Omitted = no spend data (ROI n/a, lastYearData missing).
   */
  roiRows?: { current: RoiRow[]; previous: RoiRow[] };
}

/** Page 2 -- Media Campaign Performance. */
export function buildCampaigns(input: CampaignsInput) {
  const { campaigns, today } = input;
  const media = dropLegacyCityless(input.media);
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

  // City map: cost (bubble size) and units per city, with the media-type breakdown for the tooltip. Sum first.
  const cityNames = [...new Set(mediaRows.map((m) => ((m.city ?? '') === '' ? NO_CITY : String(m.city))))];
  const totalCost = sum(mediaRows.map((m) => m.cost));
  const perCity = cityNames.map((city) => {
    const rows = mediaRows.filter((m) => ((m.city ?? '') === '' ? NO_CITY : String(m.city)) === city);
    const cost = sum(rows.map((m) => m.cost));
    return {
      city,
      cost: cost.toNumber(),
      units: sum(rows.map((m) => m.units)).toNumber(),
      share: makeKpi('percent', cost.div(totalCost)).value,
      campaigns: new Set(rows.map((m) => m.campaignName)).size,
      byType: MEDIA_TYPES.map((type) => {
        const t = rows.filter((m) => m.mediaType === type);
        return { mediaType: type, units: sum(t.map((m) => m.units)).toNumber(), cost: sum(t.map((m) => m.cost)).toNumber() };
      }).filter((t) => t.units > 0 || t.cost > 0),
    };
  }).sort((a, b) => b.cost - a.cost || a.city.localeCompare(b.city));
  const { roi, hasPrev } = buildRoi(input.roiRows?.current ?? [], input.roiRows?.previous ?? [], input.fromMonth, input.toMonth);
  const meta = { missing: [] as string[] };
  if (!hasPrev) meta.missing.push('lastYearData');
  const hasSpend = (input.roiRows?.current.length ?? 0) > 0;

  return {
    period: { year: input.year, fromMonth: input.fromMonth, toMonth: input.toMonth },
    // The ROI trend counts as data too: a period with spend rows but no campaigns still has something to show.
    hasData: campaigns.length > 0 || hasSpend,
    meta,
    today,
    /** ROI trend -- YTD vs LYTD (same shape as the Spending payload's `roi`). */
    roi,
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
    /** City map (template 1.1): one entry per city, largest cost first; `No city` = rows uploaded before the City column. */
    coverageByCity: {
      totalCost: totalCost.toNumber(),
      totalUnits: totalUnits.toNumber(),
      cities: perCity,
    },
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
