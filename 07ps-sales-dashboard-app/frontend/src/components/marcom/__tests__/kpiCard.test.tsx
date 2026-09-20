import React from 'react';
import { describe, expect, it } from 'vitest';
import { MarcomKpiCard } from '../MarcomKpiCard';
import { RagBadge } from '../RagBadge';
import type { Kpi, Status } from '../../../lib/marcom/types';
import { flat, render } from './helpers';

const k = (over: Partial<Kpi> = {}): Kpi => ({ value: 5.28, status: 'green', unit: 'percent', ...over });

describe('RagBadge: icon + word + colour, never colour alone', () => {
  it.each([
    ['green', 'On target'], ['yellow', 'Watch'], ['red', 'Off target'], ['neutral', 'No target'], ['na', 'n/a'],
  ] as [Status, string][])('%s -> "%s"', (status, word) => {
    const html = render(<RagBadge status={status} />);
    expect(flat(html)).toBe(word);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain('<svg'); // an icon accompanies the colour
    expect(html).toContain('aria-hidden="true"'); // decorative: the word carries the meaning
  });
  it('the n/a badge explains itself in a tooltip', () => {
    expect(render(<RagBadge status="na" />)).toContain('title="Not available');
  });
});

describe('MarcomKpiCard', () => {
  it.each([
    ['green', 'On target'], ['yellow', 'Watch'], ['red', 'Off target'], ['neutral', 'No target'],
  ] as [Status, string][])('renders %s with value, label, status chip and a status-coloured edge', (status, word) => {
    const html = render(<MarcomKpiCard label="CTR" kpi={k({ status })} />);
    expect(flat(html)).toContain('CTR');
    expect(flat(html)).toContain('5.3%');
    expect(flat(html)).toContain(word);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(`aria-label="CTR: 5.3%, ${word}"`);
    expect(html).toContain(`var(--ps-color-${status === 'green' ? 'success' : status === 'yellow' ? 'watch' : status === 'red' ? 'alert' : 'neutral-text'})`);
  });

  it('na shows "n/a" (not NaN / 0) with an explanatory tooltip', () => {
    const html = render(<MarcomKpiCard label="CPC" kpi={{ value: null, status: 'na', unit: 'lyd' }} />);
    expect(flat(html)).toContain('n/a');
    expect(html).toContain('Not available: there is no data, or a zero denominator');
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('missing kpi renders as n/a too', () => {
    expect(flat(render(<MarcomKpiCard label="X" kpi={null} />))).toContain('n/a');
  });

  describe('delta arrow respects the API direction', () => {
    const delta = (d: number, direction: 'higher_better' | 'lower_better') => render(<MarcomKpiCard label="M" kpi={k({ delta: d, direction, status: 'neutral' })} />);

    it('higher_better: up is good', () => {
      const h = delta(2.5, 'higher_better');
      expect(h).toContain('data-tone="good"');
      expect(flat(h)).toContain('+2.5 pp');
      expect(flat(h)).toContain('improving');
    });
    it('higher_better: down is bad', () => {
      const h = delta(-2.5, 'higher_better');
      expect(h).toContain('data-tone="bad"');
      expect(flat(h)).toContain('−2.5 pp');
      expect(flat(h)).toContain('worsening');
    });
    it('lower_better (bounce rate): up is BAD', () => {
      const h = delta(1.2, 'lower_better');
      expect(h).toContain('data-tone="bad"');
      expect(flat(h)).toContain('worsening');
    });
    it('lower_better: down is good', () => {
      expect(delta(-1.2, 'lower_better')).toContain('data-tone="good"');
    });
    it('no delta -> no arrow', () => {
      expect(render(<MarcomKpiCard label="M" kpi={k()} />)).not.toContain('kpi-delta');
    });
    it('zero change is flat', () => {
      expect(delta(0, 'higher_better')).toContain('data-tone="flat"');
    });
  });

  it('draws a sparkline only with two or more finite points', () => {
    const many = render(<MarcomKpiCard label="M" kpi={k()} sparkline={[1, 2, 3, null, 4]} />);
    const one = render(<MarcomKpiCard label="M" kpi={k()} sparkline={[1, null]} />);
    expect(many).toContain('<svg');
    expect(many.match(/<svg/g)!.length).toBeGreaterThan(one.match(/<svg/g)?.length ?? 0);
  });

  it('valueText and valueTitle override the formatted value and tooltip', () => {
    const html = render(<MarcomKpiCard label="Session" kpi={{ value: 3.5, status: 'green', unit: 'minutes' }} valueTitle="3 min 30 s" />);
    expect(flat(html)).toContain('3.5 min');
    expect(html).toContain('title="3 min 30 s"');
  });

  it('hideStatus drops the chip (plain totals) but keeps the value', () => {
    const html = render(<MarcomKpiCard label="Spend" kpi={{ value: 1000, status: 'neutral', unit: 'lyd' }} valueText="LYD 1,000" hideStatus />);
    expect(html).not.toContain('data-testid="rag-badge"');
    expect(flat(html)).toContain('LYD 1,000');
  });

  it('the small variant still labels itself for screen readers', () => {
    expect(render(<MarcomKpiCard label="TikTok" kpi={k()} size="sm" />)).toContain('aria-label="TikTok: 5.3%, On target"');
  });
});
