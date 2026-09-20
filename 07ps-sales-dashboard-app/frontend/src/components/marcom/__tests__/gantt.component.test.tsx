import React from 'react';
import { describe, expect, it } from 'vitest';
import { GanttChart, GanttRow } from '../GanttChart';
import { flat, render } from './helpers';

const row = (o: Partial<GanttRow> & { id: string }): GanttRow => ({
  label: o.id, start: '2026-02-01', end: '2026-03-15', status: 'Completed', color: '#7A5195', details: [{ label: 'Brand', value: 'Brand A' }], ...o,
});
const RANGE = { start: '2026-01-01', end: '2026-12-31' };
const LEGEND = [{ label: 'Completed', color: '#7A5195' }, { label: 'Ongoing', color: '#0072B2' }];
const gantt = (rows: GanttRow[], extra: Partial<React.ComponentProps<typeof GanttChart>> = {}) =>
  render(<GanttChart rows={rows} range={RANGE} today="2026-09-20" legend={LEGEND} ariaLabel="Campaign timeline" {...extra} />);

describe('GanttChart', () => {
  it('renders one row per item with a sticky label column, a month axis, a legend and a today marker', () => {
    const html = gantt([row({ id: 'Alpha', sublabel: 'Brand A' }), row({ id: 'Beta' })]);
    expect(html.match(/data-testid="gantt-row"/g)).toHaveLength(2);
    expect(html).toContain('position:sticky');
    expect(flat(html)).toContain('Alpha');
    expect(flat(html)).toContain('Brand A');
    for (const m of ['Jan', 'Feb', 'Mar', 'Dec']) expect(flat(html)).toContain(m);
    expect(html).toContain('data-testid="gantt-today"');
    expect(flat(html)).toContain('Today');
    expect(flat(html)).toContain('Completed');
    expect(flat(html)).toContain('Ongoing'); // legend
  });

  it('bars carry their status colour and are keyboard-focusable with a full accessible description', () => {
    const html = gantt([row({ id: 'Alpha', details: [{ label: 'Spend', value: 'LYD 120,000' }] })]);
    expect(html).toContain('data-testid="gantt-bar"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('background:#7A5195');
    expect(html).toMatch(/aria-label="Alpha\. Completed\. 01\/02\/2026 – 15\/03\/2026\. Spend LYD 120,000"/);
  });

  it('a bar that starts before the period shows a start arrow', () => {
    const html = gantt([row({ id: 'Old', start: '2025-11-20', end: '2026-02-15' })]);
    expect(html).toContain('data-clipped-start="true"');
    expect(html).toContain('data-testid="gantt-clip-start"');
    expect(html).not.toContain('data-testid="gantt-clip-end"');
  });

  it('a bar that ends after the period shows an end arrow (crossing the year boundary)', () => {
    const html = gantt([row({ id: 'Long', start: '2026-11-15', end: '2027-02-10' })]);
    expect(html).toContain('data-clipped-end="true"');
    expect(html).toContain('data-testid="gantt-clip-end"');
    expect(html).not.toContain('data-testid="gantt-clip-start"');
  });

  it('a bar spanning both sides has both arrows', () => {
    const html = gantt([row({ id: 'Both', start: '2025-06-01', end: '2027-06-01' })]);
    expect(html).toContain('data-testid="gantt-clip-start"');
    expect(html).toContain('data-testid="gantt-clip-end"');
  });

  it('an item with no end date is a milestone marker, not a bar', () => {
    const html = gantt([row({ id: 'Planned event', start: '2026-07-16', end: null, status: 'Planned' })]);
    expect(html).toContain('data-testid="gantt-milestone"');
    expect(html).not.toContain('data-testid="gantt-bar"');
    expect(html).toMatch(/aria-label="Planned event\. Planned\. Planned 16\/07\/2026, not completed/);
  });

  it('overdue items get a text flag (not colour only) and an outline', () => {
    const html = gantt([row({ id: 'Late', end: null, overdue: true }), row({ id: 'Bar', overdue: true })]);
    expect(html.match(/data-testid="gantt-overdue"/g)).toHaveLength(2);
    expect(flat(html)).toContain('Overdue');
    expect(html).toContain('outline:2px dashed var(--ps-color-alert)');
  });

  it('an item entirely outside the period gets no bar, just its dates', () => {
    const html = gantt([row({ id: 'Next year', start: '2027-03-01', end: '2027-04-01' })]);
    expect(html).not.toContain('data-testid="gantt-bar"');
    expect(flat(html)).toContain('01/03/2027 – 01/04/2027');
  });

  it('long labels are truncated with the full text available on hover', () => {
    const long = 'An Extraordinarily Long Campaign Name That Would Never Fit In The Label Column Of Any Chart';
    const html = gantt([row({ id: 'x', label: long, sublabel: 'Brand A' })]);
    expect(html).toContain(`title="${long} — Brand A"`);
    expect(html).toContain('text-overflow:ellipsis');
  });

  it('handles 30 rows and paginates beyond the page size', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ id: `Row ${i}` }));
    expect(gantt(rows).match(/data-testid="gantt-row"/g)).toHaveLength(30);
    const many = Array.from({ length: 130 }, (_, i) => row({ id: `Row ${i}` }));
    const html = gantt(many);
    expect(html.match(/data-testid="gantt-row"/g)).toHaveLength(60);
    expect(flat(html)).toContain('Show all 130');
  });

  it('adapts the ticks to a one-month range (day ticks) and keeps a scrollable axis', () => {
    const html = gantt([row({ id: 'A', start: '2026-08-05', end: '2026-08-20' })], { range: { start: '2026-08-01', end: '2026-08-31' } });
    expect(flat(html)).toContain('Aug');
    expect(html.match(/data-testid="gantt-axis"/g)).toHaveLength(1);
    expect(flat(html)).toMatch(/\b15\b/); // a day tick
    expect(html).toContain('overflow:auto');
  });

  it('no rows -> a message, not an empty frame', () => {
    expect(flat(gantt([]))).toContain('Nothing to show on the timeline');
  });

  it('no today marker when today is outside the period', () => {
    expect(gantt([row({ id: 'A' })], { today: '2027-05-01' })).not.toContain('data-testid="gantt-today"');
  });
});
