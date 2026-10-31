import type { Rat } from './rat';
import { makeKpi, classify, Status } from './kpi';
import * as F from './formulas';
import { Num, groupBy, monthRange, total } from './common';
import { RAG_RULES } from './thresholds';

/** The two columns ROI needs from a spend row. */
export interface RoiRow { month: number; spend: Num | Rat; revenue: Num }

/**
 * "ROI trend -- YTD vs LYTD". Pure and shared: the Spending payload keeps it (API compatibility)
 * and the Media Campaign Performance page renders it. Cumulative ROI over fromMonth..toMonth
 * (= YTD when fromMonth is 1) and monthly points for Y and Y-1; sums first, then divides.
 * `previous` is the per-year spend rows of Y-1 for the same months (empty = not uploaded).
 */
export function buildRoi(current: RoiRow[], previous: RoiRow[], fromMonth: number, toMonth: number) {
  const months = monthRange(fromMonth, toMonth);
  const sums = (rows: RoiRow[]) => ({ revenue: total(rows, (r) => r.revenue), spend: total(rows, (r) => r.spend) });
  const cur = sums(current);
  const prev = sums(previous);
  const byMonthCur = groupBy(current, (r) => r.month);
  const byMonthPrev = groupBy(previous, (r) => r.month);

  const roiYtd = F.roiRatio(cur.revenue, cur.spend);
  const hasPrev = previous.length > 0;
  const roiLytd = hasPrev ? F.roiRatio(prev.revenue, prev.spend) : null;
  const monthly = months.map((m) => {
    const c = byMonthCur.get(m);
    const p = byMonthPrev.get(m);
    const cs = c ? sums(c) : null;
    const ps = p ? sums(p) : null;
    const cv = cs ? F.roiRatio(cs.revenue, cs.spend) : null;
    const pv = ps ? F.roiRatio(ps.revenue, ps.spend) : null;
    return {
      month: m,
      current: cv === null ? null : cv.toNumber(),
      currentStatus: (c ? classify('roi', cv) : 'na') as Status,
      lastYear: pv === null ? null : pv.toNumber(),
      lastYearStatus: (p ? classify('roi', pv) : 'na') as Status,
    };
  });

  return {
    hasPrev,
    roi: {
      /** Cumulative over fromMonth..toMonth (= YTD when fromMonth is 1). `previous` is the LYTD ROI when uploaded. */
      ytd: makeKpi('ratio', roiYtd, { rule: 'roi', direction: 'higher_better', previous: hasPrev ? roiLytd : null }),
      lytd: hasPrev ? makeKpi('ratio', roiLytd, { rule: 'roi', direction: 'higher_better' }) : null,
      monthly,
      /** Reference lines for the chart, read from the threshold config (green above `greenAbove`, red below `redBelow`). */
      bands: { greenAbove: Number(RAG_RULES.roi.green.value), redBelow: Number(RAG_RULES.roi.red.value) },
    },
  };
}
