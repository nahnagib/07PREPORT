import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
    expect(screen.getByTitle(/Responders ÷ Total Reach = 120 ÷ 900 = 13.33%/)).toBeTruthy();
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

const SUMMARY: NpsFollowupSummary = {
  dateFrom: '2026-01-01', dateTo: '2026-10-20', detractors: 43, charted: 14, cancelled: 1, historical: 28, noCase: 0,
  byStatus: [{ key: 'solved_48h', count: 1 }, { key: 'solved_5d', count: 0 }, { key: 'solved_late', count: 0 }, { key: 'pending', count: 13 }],
  byReason: [{ reasonId: null, label: 'Not yet classified', labelAr: null, count: 12 }, { reasonId: 1, label: 'Late delivery', labelAr: 'تأخر التوصيل', count: 2 }],
  now: '2026-10-20 12:00:00',
};
const fuState = (data: NpsFollowupSummary | null) => ({ data, loading: false, error: null, retry: () => undefined });

describe('follow-up charts (live)', () => {
  it('status: the four buckets in their colours, Cancelled / Historical counted under the chart', () => {
    render(<FollowupCharts state={fuState(SUMMARY)} part="status" />);
    expect(screen.getByTestId('fu-status-solved_48h').textContent).toContain('Solved < 48 h');
    expect(screen.getByTestId('fu-status-pending').textContent).toContain('13');
    expect(screen.getByTestId('fu-left-out').textContent).toBe('Cancelled: 1 · Historical: 28');
    expect(screen.queryByText(/Waiting for the follow-up data source|No follow-up data/)).toBeNull();
  });

  it('reason: "Not yet classified" for cases without a reason', () => {
    render(<FollowupCharts state={fuState(SUMMARY)} part="reason" />);
    expect(screen.getByTestId('fu-reason-none').textContent).toContain('Not yet classified');
    expect(screen.getByTestId('fu-reason-1').textContent).toContain('Late delivery');
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
