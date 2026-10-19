import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Gauge } from '@07ps/ui';
import { CsatCard, axisLabels } from '../CsatCard';
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

describe('CsatCard', () => {
  const props = { scale: CSAT, satisfied: 168, responders: 177, belowMinimum: false };

  it('value in its band colour, status against the target, satisfied line, bullet bar with zones and target', () => {
    render(<CsatCard {...props} value={94.915} band="yellow" />);
    expect(screen.getByTestId('csat-value').textContent).toBe('94.92%');
    expect(screen.getByTestId('csat-value').style.color).toBe('var(--ps-color-watch)');
    expect(screen.getByTestId('csat-status').textContent).toBe('Yellow · 0.08 pts below target 95');
    expect(screen.getByTestId('csat-satisfied').textContent).toBe('Satisfied 168 of 177 responders (Passives + Promoters)');
    expect(screen.getByTestId('csat-zone-red').style.background).toBe('var(--ps-color-alert)');
    expect(screen.getByTestId('csat-zone-yellow').style.left).toBe('85%');
    expect(screen.getByTestId('csat-zone-green').style.left).toBe('95%');
    expect(screen.getByTestId('csat-fill').style.width).toBe('94.915%');
    expect(screen.getByTestId('csat-target').style.left).toBe('95%');
    expect(screen.getByTestId('csat-target-label').textContent).toBe('Target 95');
    // near the right end the label is anchored on its right edge so it never runs out of the card
    expect(screen.getByTestId('csat-target-label').style.textAlign).toBe('right');
    for (const t of [0, 85, 95, 100]) expect(screen.getByTestId(`csat-axis-${t}`).textContent).toBe(String(t));
  });

  it('95 next to 100 drops to a second axis line; 0, 85 and 100 stay on the first', () => {
    expect(axisLabels(CSAT).map((l) => [l.value, l.row])).toEqual([[0, 1], [85, 1], [95, 2], [100, 1]]);
  });

  it('on target: green; a long value fits', () => {
    render(<CsatCard {...props} value={100} band="green" satisfied={177} />);
    expect(screen.getByTestId('csat-value').textContent).toBe('100.00%');
    expect(screen.getByTestId('csat-status').textContent).toBe('Green · on target');
    expect(screen.getByTestId('csat-fill').style.width).toBe('100%');
  });

  it('below the minimum number of responders: grey with n = x', () => {
    render(<CsatCard {...props} value={75} band="red" satisfied={3} responders={4} belowMinimum />);
    expect(screen.getByTestId('csat-card').dataset.band).toBe('grey');
    expect(screen.getByTestId('csat-value').style.color).toBe('var(--ps-color-muted-text)');
    expect(screen.getByTestId('csat-status').textContent).toBe('n = 4');
    expect(screen.getByTestId('csat-zone-green').style.background).toBe('var(--ps-color-muted-text)');
  });

  it('no responders: a dash, no status and no value bar', () => {
    render(<CsatCard {...props} value={null} band={null} satisfied={0} responders={0} />);
    expect(screen.getByTestId('csat-value').textContent).toBe('—');
    expect(screen.queryByTestId('csat-status')).toBeNull();
    expect(screen.queryByTestId('csat-fill')).toBeNull();
    expect(screen.getByTestId('csat-satisfied').textContent).toBe('No responders for these filters');
  });
});

it('a waiting visual shows its message and no numbers', () => {
  render(<Waiting message="Waiting for the WhatsApp message data" />);
  expect(screen.getByTestId('nps-waiting').textContent).toBe('Waiting for the WhatsApp message data');
});
