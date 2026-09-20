import { Rat, R, ratio, sum } from './rat';
import { Kpi, Status, classify, makeKpi, withMonthlyTrend } from './kpi';
import * as F from './formulas';
import { AppliedPeriod, Num, groupBy, monthRange, total } from './common';
import { EVENT_TYPES } from '../marcom/templateConfig';

export interface TradeRow {
  year: number; month: number;
  /** Fractions (0.94 = 94%), as stored. */
  compliance: Num; giveaways: Num; printed: Num;
  actual: Num; expected: Num;
}
export interface EventRow {
  name: string; type: string; brandId: number; brand: string;
  planned: string; completion: string | null; status: string;
}

export interface TradeInput extends AppliedPeriod {
  /** Trade KPI rows of `year`, months fromMonth..toMonth. */
  trade: TradeRow[];
  /** Events whose Planned Date falls in year/fromMonth..toMonth (brand-filtered). */
  events: EventRow[];
  /** Business-timezone today, 'YYYY-MM-DD'. */
  today: string;
  /** false (default): every status except Cancelled. true: Completed only. */
  completedOnly: boolean;
}

type Pick = (r: TradeRow) => Num;

function stockBlock(rows: TradeRow[], pick: Pick) {
  const sorted = [...rows].sort((a, b) => a.month - b.month);
  const values = sorted.map((r) => ({ year: r.year, month: r.month, v: R(pick(r)) }));
  const latest = values.length ? values[values.length - 1] : null;
  const before = values.length > 1 ? values[values.length - 2] : null;
  const avg = values.length ? sum(values.map((x) => x.v)).div(Rat.of(BigInt(values.length))) : null;
  const rule = 'percentOfTarget' as const;
  return {
    /** Latest month in the range; `previous`/`delta` compare it with the month before it. */
    headline: {
      ...makeKpi('percent', latest?.v ?? null, { rule, direction: 'higher_better', previous: before?.v ?? null }),
      asOf: latest ? { year: latest.year, month: latest.month } : null,
    },
    /** Simple average of the monthly values in the range. */
    average: makeKpi('percent', avg, { rule, direction: 'higher_better' }),
    series: values.map((x) => ({ year: x.year, month: x.month, value: makeKpi('percent', x.v).value, status: classify(rule, x.v) as Status })),
  };
}

const ZERO_COUNTS = () => Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) as Record<string, number>;

/** Page 4 -- Trade Marketing & Retail. */
export function buildTrade(input: TradeInput) {
  const { year, fromMonth, toMonth, trade, events, today, completedOnly } = input;
  const months = monthRange(fromMonth, toMonth);

  // ---- attendance: ΣActual ÷ ΣExpected
  const actual = total(trade, (r) => r.actual);
  const expected = total(trade, (r) => r.expected);
  const sorted = [...trade].sort((a, b) => a.month - b.month);
  const att = sorted.map((r) => ({ r, v: F.attendanceRate(R(r.actual), R(r.expected)) }));
  const withVal = att.filter((x) => x.v !== null);
  const last = withVal.length ? withVal[withVal.length - 1].v : null;
  const prev = withVal.length > 1 ? withVal[withVal.length - 2].v : null;
  const attendanceKpi: Kpi = withMonthlyTrend(
    makeKpi('percent', F.attendanceRate(actual, expected), { rule: 'percentOfTarget', direction: 'higher_better' }),
    'percent', last, prev,
  );

  // ---- events
  const counted = events.filter((e) => (completedOnly ? e.status === 'Completed' : e.status !== 'Cancelled'));
  const byMonth = groupBy(counted, (e) => Number(e.planned.slice(5, 7)));
  const eventsByTypeMonthly = months.map((m) => {
    const byType = ZERO_COUNTS();
    for (const e of byMonth.get(m) ?? []) if (e.type in byType) byType[e.type] += 1;
    return { year, month: m, total: Object.values(byType).reduce((a, b) => a + b, 0), byType };
  });

  const eventsTimeline = [...events]
    .sort((a, b) => a.planned.localeCompare(b.planned) || a.name.localeCompare(b.name))
    .map((e) => ({
      name: e.name, type: e.type, brandId: e.brandId, brand: e.brand,
      planned: e.planned, completion: e.completion, status: e.status,
      overdue: e.status !== 'Completed' && e.status !== 'Cancelled' && e.planned < today,
    }));

  // Planned = every non-cancelled event planned in the month; Completed = status Completed.
  const eventsMonthlySummary = months.map((m) => {
    const inMonth = events.filter((e) => Number(e.planned.slice(5, 7)) === m);
    const planned = inMonth.filter((e) => e.status !== 'Cancelled').length;
    const completed = inMonth.filter((e) => e.status === 'Completed').length;
    return {
      year, month: m, planned, completed,
      completionPct: makeKpi('percent', ratio(Rat.of(BigInt(completed)), Rat.of(BigInt(planned)))).value,
    };
  });

  return {
    period: { year, fromMonth, toMonth },
    hasData: trade.length > 0 || events.length > 0,
    meta: { missing: [] as string[], deltaBasis: 'lastMonthVsPreviousMonth', eventsFilter: completedOnly ? 'completedOnly' : 'excludingCancelled' },
    today,
    compliance: stockBlock(trade, (r) => r.compliance),
    giveawaysStock: stockBlock(trade, (r) => r.giveaways),
    printedStock: stockBlock(trade, (r) => r.printed),
    attendance: {
      kpi: attendanceKpi,
      actual: actual.toNumber(),
      expected: expected.toNumber(),
      series: att.map(({ r, v }) => ({
        year: r.year, month: r.month, actual: R(r.actual).toNumber(), expected: R(r.expected).toNumber(),
        value: v === null ? null : makeKpi('percent', v).value, status: classify('percentOfTarget', v) as Status,
      })),
    },
    eventsByTypeMonthly,
    eventsTimeline,
    eventsMonthlySummary,
  };
}
