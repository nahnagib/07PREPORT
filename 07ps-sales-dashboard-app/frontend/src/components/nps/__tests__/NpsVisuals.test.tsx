import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Gauge, RadialGauge } from '@07ps/ui';
import type { NpsCounts, NpsFollowupSummary, NpsResponseRate } from '../../../lib/api';
import { FollowupCharts } from '../FollowupCharts';
import { NpsTopRow, ResponseRateCard } from '../NpsTopRow';
import { OdooLink } from '../../OdooLink';
import { Waiting } from '../Waiting';

afterEach(cleanup);

const NPS = { yellowFrom: 50, greenFrom: 90, target: 90, min: 0, max: 100 };
const CSAT = { yellowFrom: 85, greenFrom: 95, target: 95, min: 0, max: 100 };

describe('the tachometer Gauge with fixed bands (NPS)', () => {
  it('draws red / yellow / green zones from the bands and the scale ends 0 and 100', () => {
    const { container } = render(<Gauge actual={64.97} targetToDate={90} status="watch" bands={NPS} label="NPS" />);
    const strokes = [...container.querySelectorAll('path')].map((p) => p.getAttribute('stroke'));
    expect(strokes).toEqual(['var(--ps-color-alert)', 'var(--ps-color-watch)', 'var(--ps-color-success)']);
    expect(container.textContent).toContain('0');
    expect(container.textContent).toContain('100');
  });

  it('without bands it keeps the Target x0.5..x1.5 scale (the Promotion pages are unchanged)', () => {
    const { container } = render(<Gauge actual={100} targetToDate={200} status="alert" label="YTD" />);
    expect(container.textContent).toContain('100'); // left end = 200 x 0.5
    expect(container.textContent).toContain('300'); // right end = 200 x 1.5
  });
});

/** The needle's angle in degrees (0 = right, 180 = left) from the drawn line. */
function needleAngle(container: HTMLElement): number {
  const line = [...container.querySelectorAll('line')].find((l) => l.getAttribute('stroke-width') === '5') as SVGLineElement;
  const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((a) => Number(line.getAttribute(a)));
  return (Math.atan2(y1 - y2, x2 - x1) * 180) / Math.PI;
}

describe('RadialGauge (the KpiCard gauge) with fixed bands', () => {
  it('zones red < 50 <= yellow < 90 <= green on 0..100, min / max labels 0 and 100, target tick at 90', () => {
    const { container } = render(<RadialGauge actual={64.97} targetToDate={90} status="watch" bands={NPS} targetLabel="Target 90" showValueLabel={false} />);
    const strokes = [...container.querySelectorAll('path')].map((p) => p.getAttribute('stroke'));
    expect(strokes).toEqual(['var(--ps-color-alert)', 'var(--ps-color-watch)', 'var(--ps-color-success)']);
    const texts = [...container.querySelectorAll('text')].map((t) => t.childNodes[0]?.textContent);
    expect(texts).toContain('0');
    expect(texts).toContain('100');
    expect(needleAngle(container)).toBeCloseTo(180 - 0.6497 * 180, 0);
  });

  it('the target label sits INSIDE the arc (never over the green zone or out of the card)', () => {
    const { container } = render(<RadialGauge actual={64.97} targetToDate={90} status="watch" bands={NPS} targetLabel="Target 90" showValueLabel={false} />);
    const label = screen.getByTestId('radial-gauge-target-label');
    expect(label.textContent).toBe('Target 90');
    expect(label.getAttribute('text-anchor')).toBe('end'); // grows towards the centre, away from the track
    const [cx, cy] = [130, 128];
    const dist = Math.hypot(Number(label.getAttribute('x')) - cx, Number(label.getAttribute('y')) - cy);
    expect(dist).toBeLessThan(100 - 22); // inside the track's inner edge (r - trackWidth)
    expect(Number(label.getAttribute('x'))).toBeLessThan(260);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).not.toContain('50% to 150%');
  });

  it('a negative NPS pins the needle at 0 (left), in red', () => {
    const { container } = render(<RadialGauge actual={-35} targetToDate={90} status="alert" bands={NPS} showValueLabel={false} />);
    expect(needleAngle(container)).toBeCloseTo(180, 5);
    const needle = [...container.querySelectorAll('line')].find((l) => l.getAttribute('stroke-width') === '5');
    expect(needle?.getAttribute('stroke')).toBe('var(--ps-color-alert)');
  });

  it('without bands: the Target x0.5..x1.5 scale and the label outside the arc, as on the Promotion page', () => {
    const { container } = render(<RadialGauge actual={100} targetToDate={200} status="alert" showValueLabel={false} />);
    const texts = [...container.querySelectorAll('text')].map((t) => t.childNodes[0]?.textContent);
    expect(texts).toEqual(expect.arrayContaining(['100', '300']));
    expect(screen.getByTestId('radial-gauge-target-label').getAttribute('text-anchor')).toBe('middle');
  });
});

function counts(p: Partial<NpsCounts>): NpsCounts {
  return { responders: 0, promoters: 0, passives: 0, detractors: 0, promotersPct: null, passivesPct: null, detractorsPct: null,
    nps: null, csat: null, npsBand: null, csatBand: null, belowMinimum: false, ...p };
}
const TOTALS = counts({ responders: 177, promoters: 124, passives: 44, detractors: 9, promotersPct: 70.0564971, passivesPct: 24.858757,
  detractorsPct: 5.0847457, nps: 64.97175141, csat: 94.915254, npsBand: 'yellow', csatBand: 'yellow' });

const RATE: NpsResponseRate = {
  status: 'ready', dateFrom: '2026-10-03', dateTo: '2026-10-20', reachStart: '2026-10-03', companyAndDateOnly: true,
  responders: 120, delivered: 300, read: 350, reached: 650, totalReach: 900, rate: (120 / 650) * 100, rateOfReach: (120 / 900) * 100,
  band: 'red', target: 30, variancePts: (120 / 650) * 100 - 30,
  weekly: [{ weekStart: '2026-09-27', responders: 10, reached: 80, rate: 12.5 }, { weekStart: '2026-10-04', responders: 110, reached: 570, rate: 19.3 }],
  isEstimated: false, estimateStatus: 'not_needed', measured: { from: '2026-10-03', responders: 120, reached: 650, rate: (120 / 650) * 100 }, estimate: null,
};
// YTD on the local data: 801 responders / (1,222 measured + 2,841 estimated)
const RATE_EST: NpsResponseRate = {
  ...RATE, dateFrom: '2026-07-12', dateTo: '2026-11-09', responders: 801, delivered: 900, read: 322, reached: 4063, totalReach: 1500,
  rate: (801 / 4063) * 100, rateOfReach: (269 / 1500) * 100, band: 'red', variancePts: (801 / 4063) * 100 - 30,
  isEstimated: true, estimateStatus: 'applied', measured: { from: '2026-10-03', responders: 269, reached: 1222, rate: (269 / 1222) * 100 },
  estimate: { from: '2026-07-12', to: '2026-10-02', weeks: 83 / 7, perWeek: 239.6, reached: 2841, basis: 'auto', basisWeeks: 5, basisFrom: '2026-10-03', basisTo: '2026-11-06' },
};
const rateState = (data: NpsResponseRate | null, extra: Partial<{ loading: boolean; error: string | null }> = {}) =>
  ({ data, loading: false, error: null, retry: () => undefined, ...extra });

describe('top row: NPS tachometer · Response Rate · CSAT tachometer (the Promotion components)', () => {
  it('NPS and CSAT cards: big value, status pill, Target label, the new footers', () => {
    render(<NpsTopRow totals={TOTALS} thresholds={{ nps: NPS, csat: CSAT }} rate={rateState(RATE)} />);
    const nps = screen.getByTestId('nps-card');
    expect(nps.textContent).toContain('64.97');
    expect(nps.textContent).toContain('Behind Target');
    expect(nps.textContent).toContain('Target 90');
    for (const t of ['Promoters', '70.06%', 'Passives', '24.86%', 'Detractors', '5.08%', 'Responders', '177']) expect(nps.textContent).toContain(t);
    expect(nps.textContent).not.toMatch(/LYTD|LFY/);
    expect(nps.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('72'); // 64.97 / 90
    const csat = screen.getByTestId('csat-card');
    expect(csat.textContent).toContain('94.92%');
    for (const t of ['Satisfied', '168', 'Target', '95', 'Variance', '−0.08 pts']) expect(csat.textContent).toContain(t);
    expect(csat.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100'); // 94.92 / 95 -> 99.9 % rounds to 100
  });

  it('a red NPS reads Critical; green reads On Track', () => {
    const { unmount } = render(<NpsTopRow totals={{ ...TOTALS, nps: 27.1, npsBand: 'red' }} thresholds={{ nps: NPS, csat: CSAT }} rate={rateState(RATE)} />);
    expect(screen.getByTestId('nps-card').textContent).toContain('Critical');
    unmount();
    render(<NpsTopRow totals={{ ...TOTALS, nps: 91, npsBand: 'green' }} thresholds={{ nps: NPS, csat: CSAT }} rate={rateState(RATE)} />);
    expect(screen.getByTestId('nps-card').textContent).toContain('On Track');
  });

  it('response rate: value, pill, Target 30%, variance, since the reach start, the filter note and the tooltip', () => {
    render(<ResponseRateCard state={rateState(RATE)} />);
    const card = screen.getByTestId('rate-card');
    expect(card.textContent).toContain('18.46%');
    expect(card.textContent).toContain('Critical');
    expect(card.textContent).toContain('30%');
    expect(card.textContent).toContain('−11.54 pts');
    expect(screen.getByTestId('rate-since').textContent).toBe('since 03 Oct 2026');
    expect(screen.getByTestId('rate-company-only').textContent).toBe('Company and date filters only');
    expect(screen.getAllByTitle(/Responders ÷ Total Reach = 120 ÷ 900 = 13.33%/).length).toBeGreaterThan(0);
    // the numerator under the rate; no estimate badge after the reach start
    expect(screen.getByTestId('rate-fraction').textContent).toBe('120 responders ÷ 650 reached');
    expect(screen.queryByTestId('rate-estimate-badge')).toBeNull();
    expect(screen.queryByTestId('rate-measured')).toBeNull();
  });

  it('response rate with the estimate: the badge with the gap, the measured-only line, the formula tooltip; sparkline unchanged', () => {
    render(<ResponseRateCard state={rateState(RATE_EST)} />);
    const card = screen.getByTestId('rate-card');
    expect(card.textContent).toContain('19.71%');
    expect(screen.getByTestId('rate-fraction').textContent).toBe('801 responders ÷ 4,063 reached');
    expect(screen.getByTestId('rate-estimate-badge').textContent).toBe('incl. estimate · 12 Jul – 02 Oct');
    expect(screen.getByTestId('rate-measured').textContent).toBe('Measured since 03 Oct: 22.01%');
    expect(screen.queryByTestId('rate-since')).toBeNull();
    const tip = screen.getByTestId('rate-fraction').parentElement!.getAttribute('title')!;
    expect(tip).toContain('801 ÷ (1,222 + 2,841) = 19.71%');
    expect(tip).toContain('239.6 per week');
    expect(tip).toContain('did not keep successful messages before 03 Oct');
  });

  it('response rate without a complete measured week: no estimate and says so', () => {
    render(<ResponseRateCard state={rateState({ ...RATE, estimateStatus: 'no_basis' })} />);
    expect(screen.getByTestId('rate-no-basis').textContent).toBe('Not estimated before 03 Oct 2026: no complete measured week yet');
    expect(screen.queryByTestId('rate-estimate-badge')).toBeNull();
  });

  it('response rate without the filter note when only company / date filters are set; restricted and waiting say why', () => {
    const { unmount } = render(<ResponseRateCard state={rateState({ ...RATE, companyAndDateOnly: false })} />);
    expect(screen.queryByTestId('rate-company-only')).toBeNull();
    unmount();
    const r2 = render(<ResponseRateCard state={rateState({ ...RATE, status: 'restricted', rate: null })} />);
    expect(screen.getByTestId('rate-card').textContent).toContain('Unavailable for your assigned data scope.');
    r2.unmount();
    render(<ResponseRateCard state={rateState({ ...RATE, status: 'waiting', rate: null })} />);
    expect(screen.getByTestId('rate-card').textContent).toContain('Waiting for the WhatsApp message data.');
  });
});

// the local data: 15 cases with a status (Open 13 = New 11 + In progress 2, Close 1, Disputed 1), 28 Historical
const SUMMARY: NpsFollowupSummary = {
  dateFrom: '2026-01-01', dateTo: '2026-10-20', detractors: 43, charted: 15, rejected: 1, historical: 28, noCase: 0,
  // Resolved Ageing: 1 resolved in a day; 13 open (5 under a day, 2 at 1-2 d, 4 at 5-10 d, 2 over 30 d); Rejected out
  ageing: {
    buckets: [
      { key: 'd1', label: '≤ 1 d', withinSla: true, resolved: 1, open: 5 }, { key: 'd2', label: '1–2 d', withinSla: true, resolved: 0, open: 2 },
      { key: 'd5', label: '2–5 d', withinSla: true, resolved: 0, open: 0 }, { key: 'd10', label: '5–10 d', withinSla: false, resolved: 0, open: 4 },
      { key: 'd30', label: '10–30 d', withinSla: false, resolved: 0, open: 0 }, { key: 'dmax', label: '> 30 d', withinSla: false, resolved: 0, open: 2 },
    ],
    closedInSla: { count: 1, of: 1 },
    contactedInSla: { count: 0, of: 8 },
  },
  byStatus: [
    { key: 'OPEN', count: 13, stages: [{ stage: 'NEW', count: 11 }, { stage: 'CONTACTED', count: 0 }, { stage: 'IN_PROGRESS', count: 2 }] },
    { key: 'CLOSE', count: 1, stages: [{ stage: 'RESOLVED', count: 1 }] },
    { key: 'DISPUTED', count: 1, stages: [{ stage: 'REJECTED', count: 1 }] },
  ],
  byReason: [{ categoryKey: null, label: 'Not yet classified', labelAr: null, count: 12, subReasons: [] },
    { categoryKey: 'delivery', label: 'Delivery & Logistics', labelAr: 'التوصيل والخدمات اللوجستية', count: 3,
      subReasons: [{ reasonId: 15, label: 'Late deliveries', labelAr: 'تأخر التوصيل', count: 2 }, { reasonId: 5, label: 'Not specified', labelAr: 'غير محدد', count: 1 }] }],
  now: '2026-10-20 12:00:00',
};
const fuState = (data: NpsFollowupSummary | null) => ({ data, loading: false, error: null, retry: () => undefined });

describe('follow-up charts (live)', () => {
  it('Resolved Ageing: six stacked bars, the Close SLA line after 2–5 d, the SLA line under it, Rejected / Historical in the note', () => {
    render(<FollowupCharts state={fuState(SUMMARY)} part="resolved" />);
    expect(screen.getByText('Resolved Ageing')).toBeTruthy();
    expect(screen.queryByText('Resolved by time')).toBeNull();
    const bars = ['d1', 'd2', 'd5', 'd10', 'd30', 'dmax'].map((k) => screen.getByTestId(`fu-ageing-${k}`));
    // [resolved, still open, the total over the bar, the axis label]
    expect(bars.map((b) => [b.getAttribute('data-resolved'), b.getAttribute('data-open'), ...[...b.querySelectorAll('text')].map((t) => t.textContent)])).toEqual([
      ['1', '5', '6', '≤ 1 d'], ['0', '2', '2', '1–2 d'], ['0', '0', '2–5 d'], ['0', '4', '4', '5–10 d'], ['0', '0', '10–30 d'], ['0', '2', '2', '> 30 d']]);
    expect(bars.map((b) => b.getAttribute('data-within-sla'))).toEqual(['true', 'true', 'true', 'false', 'false', 'false']);
    expect(bars[0].querySelectorAll('rect')).toHaveLength(2); // resolved + still open, stacked
    expect(bars[0].querySelector('title')?.textContent).toBe('≤ 1 d (within SLA): 1 resolved, 5 still open');
    expect(bars[3].querySelector('title')?.textContent).toBe('5–10 d (SLA breached): 0 resolved, 4 still open');
    // the line sits on the boundary between the 3rd and 4th bucket
    const line = screen.getByTestId('fu-ageing-sla-line');
    expect(line.textContent).toContain('Close SLA 5 d');
    expect(Number(line.querySelector('line')?.getAttribute('x1'))).toBeCloseTo(34 + ((640 - 34 - 12) / 6) * 3);
    expect(screen.getByTestId('fu-ageing-sla').textContent).toBe('Closed within SLA: 1 of 1 (100 %) · Contacted within 24 h: 0 of 8 (0 %)');
    expect(bars[0].querySelector('[data-series="resolved"]')?.getAttribute('fill')).toBe('var(--ps-sla-green)');
    expect(bars[3].querySelector('[data-series="open"]')?.getAttribute('style')).toContain('var(--ps-sla-red)');
    expect(bars[0].querySelector('[data-series="open"]')?.getAttribute('fill')).toMatch(/^url\(#ageing-open-/);
    const patterns = screen.getByTestId('fu-ageing').querySelectorAll('pattern');
    expect([...patterns].map((p) => p.querySelector('rect:last-child')?.getAttribute('fill'))).toEqual(['var(--ps-sla-green)', 'var(--ps-sla-red)']);
    expect(within(screen.getByTestId('fu-ageing')).queryByRole('button')).toBeNull(); // no click-to-filter: the detractor list has no chart filter
    expect(screen.queryByTestId('fu-by-status')).toBeNull();
    expect(screen.getByTestId('fu-left-out').textContent).toBe('Rejected: 1 · Historical: 28');
    expect(screen.queryByText(/Waiting for the follow-up data source|No follow-up data/)).toBeNull();
  });

  it('keeps the SLA shares and exclusion note visible when all cases are Rejected or Historical', () => {
    render(<FollowupCharts state={fuState({ ...SUMMARY, charted: 1, rejected: 1,
      ageing: { buckets: SUMMARY.ageing.buckets.map((b) => ({ ...b, resolved: 0, open: 0 })),
        closedInSla: { count: 0, of: 0 }, contactedInSla: { count: 0, of: 0 } } })} part="resolved" />);
    expect(screen.getByTestId('fu-ageing-sla').textContent).toContain('Closed within SLA: — (none due yet)');
    expect(screen.getByTestId('fu-left-out').textContent).toBe('Rejected: 1 · Historical: 28');
  });

  it('status: Open / Close / Disputed; a click drills into the stages (0 kept as 0) and "← All statuses" goes back', () => {
    render(<FollowupCharts state={fuState(SUMMARY)} part="status" />);
    expect(screen.getByText('Detractors by status')).toBeTruthy();
    expect(screen.getByTestId('fu-status-OPEN').textContent).toContain('Open');
    expect(screen.getByTestId('fu-status-OPEN').textContent).toContain('13');
    expect(screen.getByTestId('fu-status-DISPUTED').textContent).toContain('Disputed');
    expect(screen.getByTestId('fu-left-out').textContent).toBe('Historical: 28');
    fireEvent.click(screen.getByTestId('fu-status-OPEN').querySelector('button') as HTMLButtonElement);
    expect(screen.getByText('Detractors by status — Open')).toBeTruthy();
    expect(screen.getByTestId('fu-status-stage-NEW').textContent).toContain('11');
    expect(screen.getByTestId('fu-status-stage-CONTACTED').textContent).toContain('0');
    expect(screen.getByTestId('fu-status-stage-IN_PROGRESS').textContent).toContain('In Progress');
    fireEvent.click(screen.getByTestId('fu-status-back'));
    expect(screen.getByText('Detractors by status')).toBeTruthy();
    expect(screen.queryByTestId('fu-status-stage-NEW')).toBeNull();
  });

  it('the same filters give the same total in the centre of both follow-up donuts', () => {
    const centre = (part: 'reason' | 'status') => {
      const { container, unmount } = render(<FollowupCharts state={fuState(SUMMARY)} part={part} />);
      const n = container.querySelector('.ps-nps-donut-center strong')?.textContent;
      unmount();
      return n;
    };
    expect([centre('reason'), centre('status')]).toEqual(['15', '15']);
  });

  it('reason: by category, "Not yet classified" for cases without a reason', () => {
    render(<FollowupCharts state={fuState(SUMMARY)} part="reason" />);
    expect(screen.getByTestId('fu-reason-none').textContent).toContain('Not yet classified');
    expect(screen.getByTestId('fu-reason-delivery').textContent).toContain('Delivery & Logistics');
  });

  it('reason: a category drills into its sub-reasons, and "← All reasons" goes back', () => {
    render(<FollowupCharts state={fuState(SUMMARY)} part="reason" />);
    // "Not yet classified" has no sub-reasons: not a drill target
    expect(screen.getByTestId('fu-reason-none').querySelector('[data-selectable]')).toBeNull();
    fireEvent.click(screen.getByTestId('fu-reason-delivery').querySelector('button') as HTMLButtonElement);
    expect(screen.getByText('Detractors by reason — Delivery & Logistics')).toBeTruthy();
    expect(screen.getByTestId('fu-subreason-15').textContent).toContain('Late deliveries');
    expect(screen.getByTestId('fu-subreason-5').textContent).toContain('Not specified');
    fireEvent.click(screen.getByTestId('fu-reason-back'));
    expect(screen.getByText('Detractors by reason')).toBeTruthy();
    expect(screen.queryByTestId('fu-subreason-15')).toBeNull();
  });
});

describe('Odoo links', () => {
  it('a code with a URL opens Odoo in a new tab; without one it is plain text', () => {
    const { unmount } = render(<OdooLink href="https://erp.example.com/web#id=7001&model=stock.picking&view_type=form&cids=3">TIKA/OUT/1</OdooLink>);
    const a = screen.getByRole('link', { name: 'TIKA/OUT/1' });
    expect(a.getAttribute('href')).toBe('https://erp.example.com/web#id=7001&model=stock.picking&view_type=form&cids=3');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    unmount();
    render(<OdooLink href={null}>WH/OUT/2</OdooLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('WH/OUT/2')).toBeTruthy();
  });
});

it('a waiting visual shows its message and no numbers', () => {
  render(<Waiting message="Waiting for the WhatsApp message data" />);
  expect(screen.getByTestId('nps-waiting').textContent).toBe('Waiting for the WhatsApp message data');
});
