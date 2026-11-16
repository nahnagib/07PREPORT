import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DetractorsByBranch, branchItems } from '../DetractorsByBranch';

vi.mock('@07ps/ui', async () => ({
  ...await vi.importActual('@07ps/ui'),
  ChartPanel: ({ title, headerActions, children }: { title: string; headerActions?: React.ReactNode; children: React.ReactNode }) =>
    <section aria-label={title}><h3>{title}</h3>{headerActions}{children}</section>,
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...rest}>{children}</button>,
  EmptyState: ({ message }: { message: string }) => <p>{message}</p>,
  ErrorState: ({ message }: { message: string }) => <p>{message}</p>,
  LoadingSkeleton: () => <div>Loading</div>,
  exportRowsAsPdf: vi.fn(), exportShareBarAsImage: vi.fn(),
}));

const data = {
  total: 46,
  branches: [
    { key: '5', branch: 'Factory Outlet', count: 3, share: 3 / 46 },
    { key: null, branch: 'Unknown', count: 6, share: 6 / 46 },
    { key: '7', branch: 'مبيعات المنطقة الشرقية B2B', count: 9, share: 9 / 46 },
    { key: '8', branch: 'فريق المعرض الرئيسي', count: 7, share: 7 / 46 },
    ...Array.from({ length: 21 }, (_, i) => ({ key: String(100 + i), branch: `Branch ${i}`, count: 1, share: 1 / 46 })),
  ],
};

describe('NPS Detractors by Branch: one stacked bar (2026-11-15, round 4)', () => {
  it('biggest first; widths = shares; the segments add up to the Detractors card; Unknown grey; neighbours differ', () => {
    const items = branchItems(data);
    expect(items.slice(0, 4).map((i) => i.label)).toEqual(['مبيعات المنطقة الشرقية B2B', 'فريق المعرض الرئيسي', 'Unknown', 'Factory Outlet']);
    expect(items.reduce((t, i) => t + Math.round(i.share * 46), 0)).toBe(46);
    expect(items[0].detail).toBe('9 (19.6%)');
    expect(items[2].color).toBe('#8C8C8C');
    expect(items.filter((i) => i.label !== 'Unknown').every((i) => i.color !== '#8C8C8C')).toBe(true);
    items.slice(1).forEach((item, n) => expect(item.color).not.toBe(items[n].color));
  });

  it('renders the bar and a full legend (Arabic names isolated, never truncated); title keeps the total', () => {
    render(<DetractorsByBranch state={{ data, loading: false, error: null, retry: () => {} }} cardTotal={46} />);
    expect(screen.getByRole('heading').textContent).toBe('Detractors by Branch (46)');
    const segments = screen.getAllByTestId('share-bar-segment');
    expect(segments).toHaveLength(25);
    expect(Number(segments[0].getAttribute('data-share'))).toBeCloseTo(9 / 46);
    expect(segments[0].getAttribute('title')).toBe('مبيعات المنطقة الشرقية B2B: 9 detractors (19.6% of detractors)');
    const legend = screen.getAllByTestId('share-bar-legend');
    expect(legend[0].textContent).toBe('مبيعات المنطقة الشرقية B2B 9 (19.6%)');
    expect(legend[0].querySelector('bdi')?.textContent).toBe('مبيعات المنطقة الشرقية B2B');
    expect(screen.getByText('Export image')).toBeTruthy();
    expect(screen.getByText('Export as PDF')).toBeTruthy();
  });
});
