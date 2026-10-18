import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Gauge } from '@07ps/ui';
import { CsatBar } from '../CsatBar';
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

describe('CsatBar', () => {
  it('fills to the value in its band colour, with the target marker at 95', () => {
    render(<CsatBar value={94.915} band="yellow" scale={CSAT} />);
    expect(screen.getByRole('img', { name: 'CSAT 94.92%, target 95%' })).toBeTruthy();
    expect(screen.getByTestId('csat-fill').getAttribute('fill')).toBe('var(--ps-color-watch)');
    expect(screen.getByTestId('csat-target')).toBeTruthy();
  });

  it('no value: an empty track and a dash', () => {
    render(<CsatBar value={null} band={null} scale={CSAT} />);
    expect(screen.queryByTestId('csat-fill')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });
});

it('a waiting visual shows its message and no numbers', () => {
  render(<Waiting message="Waiting for the WhatsApp message data" />);
  expect(screen.getByTestId('nps-waiting').textContent).toBe('Waiting for the WhatsApp message data');
});
