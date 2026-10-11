import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DebtAgingMap, placePopup, type DebtAgingMapProps } from '../DebtAgingMap';
import type { DebtAging, DebtAgingCustomer } from '../../../lib/api';

afterEach(cleanup);

const ZONES = [
  { key: 'green', label: 'Green', owner: 'Sales rep', lowerMultiplier: 0, upperMultiplier: 1 },
  { key: 'yellow', label: 'Yellow', owner: 'Sales director', lowerMultiplier: 1, upperMultiplier: 2 },
  { key: 'red', label: 'Red', owner: 'Management', lowerMultiplier: 2, upperMultiplier: 3 },
  { key: 'black', label: 'Black', owner: 'Legal', lowerMultiplier: 3, upperMultiplier: null },
];

/** A customer as the API sends it (the server computed every field; the test only picks a position). */
function customer(i: number, position: number, outstanding: number): DebtAgingCustomer {
  const zoneIndex = position <= 1 ? 0 : position <= 2 ? 1 : position <= 3 ? 2 : 3;
  const age = Math.round(position * 30);
  return {
    customerKey: i, customer: `Customer ${i}`, companyKey: 1, company: 'Majaal', termKey: '4', termLabel: '30 Days', termDays: 30,
    termSource: 'payment_term', oldestOpenMoveId: 1000 + i, oldestOpenDocument: `INV/${i}`, odooUrl: `https://odoo.test/web#id=${1000 + i}`,
    invoiceDate: '2026-06-01', dueDate: '2026-07-01', invoiceAge: age, daysPastDue: Math.max(0, age - 30), termWidth: 30, position,
    zone: ZONES[zoneIndex].key, zoneIndex, owner: ZONES[zoneIndex].owner, nextZone: ZONES[zoneIndex + 1]?.key ?? null,
    daysToNextZone: zoneIndex === 3 ? null : (zoneIndex + 1) * 30 + 1 - age, escalatingSoon: zoneIndex < 3 && (zoneIndex + 1) * 30 + 1 - age <= 7,
    outstanding, outstandingCompany: outstanding * 9.8, openInvoices: 2,
  };
}

function aging(customers: DebtAgingCustomer[], currency = 'LYD'): DebtAging {
  return {
    snapshotDate: '2026-10-04', currency, currencies: customers.length ? [currency] : [],
    settings: { minStep: 7, escalationWindowDays: 7, axisCap: 4.5 },
    zones: ZONES,
    terms: customers.length ? [{ key: '4', label: '30 Days', termDays: 30, customers: customers.length, ranges: null }] : [],
    customers: [...customers].sort((a, b) => b.position - a.position),
  };
}

function show(data: DebtAging, extra: Partial<DebtAgingMapProps> = {}) {
  return render(<DebtAgingMap data={data} loading={false} error={null} onRetry={() => {}} term={null} onTermChange={() => {}} {...extra} />);
}

const dots = (c: HTMLElement) => [...c.querySelectorAll('svg[role="img"] g[role="button"]')];
/** The filled circle of each dot (the dashed ring, when present, comes first and has no fill). */
const discs = (c: HTMLElement) =>
  dots(c).map((g) => {
    const circle = [...g.querySelectorAll('circle')].find((x) => x.getAttribute('fill') !== 'none')!;
    return { x: Number(circle.getAttribute('cx')), y: Number(circle.getAttribute('cy')), r: Number(circle.getAttribute('r')) };
  });

describe('DebtAgingMap', () => {
  it('keeps only the chart and its legend: no zone cards, escalate list, table, look-ahead or sales rep filter', () => {
    const { container } = show(aging([customer(1, 1.9, 15600), customer(2, 0.4, 100)]));
    expect(container.querySelector('svg[role="img"]')).not.toBeNull();
    expect(screen.getByText('Where every customer stands · LYD')).toBeTruthy();
    expect(screen.getByLabelText('Legend').textContent).toContain('Dot size = amount outstanding');
    expect(screen.queryByRole('group', { name: 'Aging zones and owners' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'About to escalate' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('input[type="range"]')).toBeNull();
    expect(container.textContent).not.toContain('Look ahead');
    expect(container.textContent).not.toContain('All reps');
    expect(container.textContent).not.toContain('Select a dot');
    expect(container.textContent).toContain('Payment term');
  });

  it('0 customers: an empty state instead of the track', () => {
    const { container } = show(aging([]));
    expect(screen.getByText('No customer owes LYD with these filters.')).toBeTruthy();
    expect(container.querySelector('svg[role="img"]')).toBeNull();
  });

  it('a dot click opens the popup next to it; Esc closes it', () => {
    const { container } = show(aging([customer(1, 1.9, 15600)]));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(dots(container)[0]);
    const popup = screen.getByRole('dialog', { name: 'Customer 1' });
    expect(popup.textContent).toContain('Majaal');
    expect(popup.textContent).toContain('Yellow · Sales director');
    expect(popup.textContent).toContain('30 Days');
    expect(popup.textContent).toContain('INV/1');
    expect(popup.textContent).toContain('Red (Management) in 4 days');
    expect(popup.textContent).toContain('LYD 15,600.000');
    expect(popup.textContent).not.toContain('≈'); // no LYD line for an LYD customer
    expect(dots(container)[0].getAttribute('aria-expanded')).toBe('true');
    // escalating soon: the dashed ring stays
    expect(dots(container)[0].querySelectorAll('circle')).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(dots(container)[0]); // focus goes back to the dot
  });

  it('Enter on a dot opens it; the close button and a click outside close it; one popup at a time', () => {
    const { container } = show(aging([customer(1, 0.5, 100), customer(2, 3.5, 200)]));
    const [a, b] = dots(container);
    fireEvent.keyDown(a, { key: 'Enter' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(b);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(a);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Black says "With legal"; a USD customer also shows the LYD amount', () => {
    const black = { ...customer(3, 3.5, 1000), oldestOpenDocument: 'INV/USD/3' };
    const { container } = show(aging([black], 'USD'));
    fireEvent.click(dots(container)[0]);
    const popup = screen.getByRole('dialog');
    expect(popup.textContent).toContain('Black · Legal');
    expect(popup.textContent).toContain('With legal');
    expect(popup.textContent).toContain('USD 1,000.00');
    expect(popup.textContent).toContain('≈ LYD 9,800.000');
  });

  it('500 customers: 500 dots and no two overlap', () => {
    const many = Array.from({ length: 500 }, (_, i) => customer(i + 1, (i * 37) % 100 < 30 ? 4.6 + (i % 50) : ((i * 53) % 450) / 100, 100 + ((i * 7919) % 100000)));
    const { container } = show(aging(many));
    const d = discs(container);
    expect(d).toHaveLength(500);
    for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) {
      expect(Math.hypot(d[i].x - d[j].x, d[i].y - d[j].y), `dots ${i} and ${j}`).toBeGreaterThanOrEqual(d[i].r + d[j].r - 1e-6);
    }
  });
});

describe('placePopup: stays on screen', () => {
  const size = { width: 320, height: 300 };
  const desktop = { width: 1280, height: 800 };
  const dot = (x: number, y: number) => ({ left: x - 5, right: x + 5, top: y - 5, bottom: y + 5 });
  const inside = (p: { left: number; top: number }, v: { width: number; height: number }) =>
    p.left >= 8 && p.top >= 8 && p.left + size.width <= v.width - 8 && p.top + size.height <= v.height - 8;

  it('to the right of the dot when there is room, else to the left', () => {
    expect(placePopup(dot(200, 400), size, desktop)).toEqual({ left: 215, top: 250 });
    expect(placePopup(dot(1200, 400), size, desktop).left).toBe(1200 - 5 - 10 - 320);
  });
  it('near the corners: clamped inside the viewport', () => {
    for (const [x, y] of [[2, 2], [1278, 2], [2, 798], [1278, 798], [640, 2], [640, 798]]) expect(inside(placePopup(dot(x, y), size, desktop), desktop)).toBe(true);
  });
  it('on a phone: under (or above) the dot, never off screen', () => {
    const phone = { width: 375, height: 667 };
    const p = placePopup(dot(180, 100), size, phone);
    expect(p.top).toBe(115);
    expect(inside(p, phone)).toBe(true);
    expect(placePopup(dot(180, 600), size, phone).top).toBe(600 - 5 - 10 - 300);
    for (const [x, y] of [[2, 2], [373, 665], [187, 333]]) expect(inside(placePopup(dot(x, y), size, phone), phone)).toBe(true);
  });
});
