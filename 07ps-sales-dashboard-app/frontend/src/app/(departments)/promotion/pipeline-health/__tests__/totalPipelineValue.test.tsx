import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { formatCompactCurrency, formatCurrency } from '../../../../../lib/format';
import PipelineHealthPage from '../page';

/** Total Pipeline Value (2026-11-09): the page's first row, full width, in the Daily Critical Number's hero style. */

const mocked = vi.hoisted(() => ({
  overview: { data: null as unknown, loading: false, error: null as string | null, retry: () => {} },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../../../lib/AuthProvider', () => ({
  useAuth: () => ({ user: null, token: 't', error: null, retryAuth: () => {}, logout: () => {}, isSalesperson: false, canView: () => true }),
}));
vi.mock('../../../../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../../../../components/BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../../../../components/ValidationStatusBar', () => ({ ValidationStatusBar: () => null }));
vi.mock('../../../../../components/RefreshFooter', () => ({ RefreshFooter: () => null }));
vi.mock('../../../../../components/FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../../../../../components/AuthGuard', () => ({ PermissionGuard: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../../../components/FilterProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../components/FilterProvider')>();
  const options = { data: [], loading: false, error: null };
  return {
    ...actual,
    useFilterState: () => ({
      effectiveFilters: actual.DEFAULT_FILTERS, anchorDate: '2026-11-09', dateFromDate: '2026-01-01', dateToDate: '2026-11-09',
      onFiltersChange: () => {}, onAnchorDateChange: () => {}, onDateRangeChange: () => {}, resetFilters: () => {}, isAtDefaults: true,
    }),
    useScopedFilterOptions: () => ({ businessUnits: options, customerGroups: options, distributionChannels: options, branches: options, salespersons: options }),
  };
});
vi.mock('../../../../../lib/hooks', () => ({
  usePipelineHealthOverview: () => mocked.overview,
  useRefreshStatus: () => ({ data: null, loading: false, error: null, retry: () => {} }),
}));

const zero = { opportunities: 0, quotations: 0, salesOrders: 0, deliveries: 0 };
function overview(openPipeline: { count: number; value: number }) {
  return {
    funnel: { leads: 0, ...zero }, funnelValues: { leads: 0, ...zero }, funnelOpportunityIds: {}, funnelStageRecords: {}, opportunityChains: {},
    stageBenchmark: [], benchmarkCohort: { ...zero, values: zero }, openPipeline, expectedClosureByMonth: [], opportunityByStage: [], stages: [],
    opportunitiesByStatus: { Won: { count: 0, value: 0 }, Lost: { count: 0, value: 0 }, Pending: { count: 0, value: 0 } },
    probabilityDistribution: [], opportunities: [],
  };
}

// jsdom has no ResizeObserver (the charts measure themselves)
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(cleanup);

describe('Total Pipeline Value hero row', () => {
  it('shows the compact value with the exact one in its tooltip and below it, with the open opportunity count', () => {
    mocked.overview = { data: overview({ count: 89, value: 50_512_345.5 }), loading: false, error: null, retry: () => {} };
    render(<PipelineHealthPage />);
    const value = screen.getByTestId('total-pipeline-value');
    expect(value.textContent).toBe(formatCompactCurrency(50_512_345.5));
    expect(value.getAttribute('title')).toBe(formatCurrency(50_512_345.5));
    const desc = value.nextElementSibling as HTMLElement;
    expect(desc.className).toBe('ps-cn-hero-desc');
    expect(desc.textContent).toBe(`${formatCurrency(50_512_345.5)} · 89 open opportunities`);
  });

  it('one open opportunity: singular', () => {
    mocked.overview = { data: overview({ count: 1, value: 1000 }), loading: false, error: null, retry: () => {} };
    render(<PipelineHealthPage />);
    expect(screen.getByTestId('total-pipeline-value').nextElementSibling?.textContent).toMatch(/· 1 open opportunity$/);
  });

  it('renders before the funnel / benchmark grid, not inside it', () => {
    mocked.overview = { data: overview({ count: 2, value: 10 }), loading: false, error: null, retry: () => {} };
    render(<PipelineHealthPage />);
    const value = screen.getByTestId('total-pipeline-value');
    const grid = screen.getByTestId('pipeline-top-grid');
    expect(grid.contains(value)).toBe(false);
    expect(value.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(grid.textContent).toContain('Stage Benchmark');
  });

  it('error: the card keeps its label and a retry, full width above the grid', () => {
    mocked.overview = { data: null, loading: false, error: 'boom', retry: () => {} };
    render(<PipelineHealthPage />);
    const label = screen.getAllByText('Total Pipeline Value')[0];
    const grid = screen.getByTestId('pipeline-top-grid');
    expect(grid.contains(label)).toBe(false);
    expect(label.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
