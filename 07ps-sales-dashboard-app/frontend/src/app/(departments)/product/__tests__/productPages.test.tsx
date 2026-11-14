import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_FILTERS } from '../../../../components/FilterProvider';
import type { ProductDashboardScope } from '../../../../lib/api';
import BcgMatrixPage from '../bcg-matrix/page';
import StockVelocityPage from '../stock-velocity/page';
import PimContributionPage from '../pim-contribution/page';
import BrandPage from '../pim-contribution/brand/[brand]/page';
import ProductLifecyclePage from '../product-lifecycle/page';
import RevenueTrendPage from '../../promotion/revenue-trend/page';

interface FilterBarSeen {
  businessUnits: { company_name: string }[];
  customerGroups: { segment_key: number; segment_name: string }[];
  showCompanyDimension?: boolean;
  showTransactionDimensions?: boolean;
  showDateRange?: boolean;
  dateFromDate?: string;
  dateToDate?: string;
}

const mocked = vi.hoisted(() => ({
  scopes: [] as { page: string; scope: ProductDashboardScope }[],
  filterBars: [] as FilterBarSeen[],
  resetFilters: vi.fn(),
  state: null as unknown,
  options: null as unknown,
  refresh: { lastUpdate: '2026-11-06T14:32:00Z', lastOrderCreated: '2026-11-05T16:15:00Z', lastRefreshTime: '2026-11-07T08:53:00Z', isStale: false, isInverted: false },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useParams: () => ({ brand: 'tau' }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../../lib/AuthProvider', () => ({
  useAuth: () => ({ user: null, token: 't', error: null, retryAuth: () => {}, logout: () => {}, isSalesperson: false, canView: () => true, can: () => true }),
}));
vi.mock('../../../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../../../components/BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../../../components/ValidationStatusBar', () => ({ ValidationStatusBar: () => null }));
vi.mock('../../../../components/RefreshFooter', () => ({ RefreshFooter: () => null }));
vi.mock('../../../../components/AuthGuard', () => ({ PermissionGuard: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../../components/FilterBar', () => ({
  FilterBar: (props: FilterBarSeen & { onReset?: () => void; extraFields?: React.ReactNode }) => {
    mocked.filterBars.push(props);
    // Same fallback as the real FilterBar: without an onReset prop the button resets the shared FilterProvider state.
    return <div>{props.extraFields}<button onClick={props.onReset ?? mocked.resetFilters}>Reset filters</button></div>;
  },
}));
vi.mock('../../../../components/FilterProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../components/FilterProvider')>();
  const options = (data: unknown[]) => ({ data, loading: false, error: null });
  return {
    ...actual,
    // The app-wide state on first load: DEFAULT_FILTERS (Customer Group = B2B + B2C), calendar YTD. One object, so the
    // pages' FilterBar props can be compared by identity with Promotion's.
    useFilterState: () =>
      (mocked.state ??= {
        effectiveFilters: actual.DEFAULT_FILTERS,
        anchorDate: '2026-11-07',
        dateFromDate: '2026-01-01',
        dateToDate: '2026-11-07',
        onFiltersChange: () => {},
        onAnchorDateChange: () => {},
        onDateRangeChange: () => {},
        resetFilters: mocked.resetFilters,
        isAtDefaults: true,
      }),
    useScopedFilterOptions: () =>
      (mocked.options ??= {
        businessUnits: options([{ company_key: 1, company_name: 'Majaal' }, { company_key: 3, company_name: 'Tika' }, { company_key: 9, company_name: 'Athena' }]),
        customerGroups: options([1, 2, 3, 4].map((k) => ({ segment_key: k, segment_name: ['B2B', 'B2C', 'Backoffice', 'Inter Company'][k - 1] }))),
        distributionChannels: options([{ channel_key: 2, channel_name: 'Projects' }]),
        branches: options([{ sales_team_key: 'MJ-01', sales_team_name: 'Main' }]),
        salespersons: options([{ salesperson_key: 7, salesperson_name: 'S' }]),
      }),
  };
});
vi.mock('../../../../lib/hooks', () => ({
  useProductDashboard: (_t: unknown, _e: unknown, _r: unknown, page: string, scope: ProductDashboardScope) => {
    mocked.scopes.push({ page, scope });
    return { data: null, loading: true, error: null, retry: () => {} };
  },
  useRefreshStatus: () => ({ data: mocked.refresh, loading: false, error: null }),
  useRevenueTrendOverview: () => ({ data: null, loading: true, error: null, retry: () => {} }),
  usePeriodTrend: () => ({ data: null, loading: true, error: null, retry: () => {} }),
}));

const PAGES: [string, () => React.ReactElement][] = [
  ['bcg-matrix', () => <BcgMatrixPage />],
  ['stock-velocity', () => <StockVelocityPage />],
  ['pim-contribution', () => <PimContributionPage />],
  ['pim-contribution brand', () => <BrandPage />],
  ['product-lifecycle', () => <ProductLifecyclePage />],
];

beforeEach(() => {
  mocked.scopes.length = 0;
  mocked.filterBars.length = 0;
  mocked.resetFilters.mockClear();
});
afterEach(cleanup);

describe('Product pages: standard FilterBar with Company and Date only', () => {
  it('the shared default is Customer Group B2B + B2C', () => {
    expect(DEFAULT_FILTERS.segmentKeys).toEqual([1, 2]);
  });

  it.each(PAGES)('%s sends Company and Date only: no Customer Group / Channel / Branch / Salesperson, no dates by default (Last 12 Months)', (_name, page) => {
    render(page());
    const last = mocked.scopes[mocked.scopes.length - 1];
    for (const key of ['segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys', 'fromDate', 'toDate']) expect(last.scope).not.toHaveProperty(key);
  });

  it.each(PAGES)('%s shows only Company (no Athena) and the Date range, defaulting to the Last 12 Months', (_name, page) => {
    render(page());
    const bar = mocked.filterBars[mocked.filterBars.length - 1];
    expect([bar.showCompanyDimension, bar.showTransactionDimensions, bar.showDateRange]).toEqual([undefined, false, undefined]);
    expect(bar.businessUnits.map((u) => u.company_name)).toEqual(['Majaal', 'Tika']);
    const to = new Date();
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(bar.dateToDate).toBe(iso(to));
    expect(bar.dateFromDate?.slice(0, 4)).toBe(String(to.getFullYear() - 1));
  });

  it.each(PAGES)('%s: Reset brings the shared filters back to their defaults', (_name, page) => {
    render(page());
    fireEvent.click(screen.getAllByText('Reset filters')[0]);
    expect(mocked.resetFilters).toHaveBeenCalledTimes(1);
  });
});

describe('BCG Matrix', () => {
  it('names the movement visual "Product Movement" (never "Portfolio Movement")', () => {
    render(<BcgMatrixPage />);
    expect(screen.getByText(/^Product Movement/)).toBeTruthy();
    expect(screen.queryByText(/Portfolio Movement/)).toBeNull();
  });
});

describe('FilterBar parity with Promotion (Revenue Trend)', () => {
  /** The only differences a Product page may have: its two option lists are narrowed (no Athena; no Backoffice /
   * Inter Company) and it adds its own second row (+ a Reset that also clears that row). */
  const NARROWED = ['businessUnits', 'customerGroups'];
  // ... and has no date range (always the last 12 months, 2026-11-14)
  // ... and shows Company + its own Date range only (2026-11-14): no transaction filters, dates default to the Last 12 Months
  const PRODUCT_ONLY = ['secondRow', 'onReset', 'isPristine', 'showTransactionDimensions'];
  const OWN_DATES = ['dateFromDate', 'dateToDate', 'onDateRangeChange'];
  const promotionProps = () => {
    mocked.filterBars.length = 0;
    render(<RevenueTrendPage />);
    const props = { ...mocked.filterBars[mocked.filterBars.length - 1] } as Record<string, unknown>;
    cleanup();
    return props;
  };

  it.each(PAGES)('%s passes exactly the Promotion FilterBar props (fields, order, dates, Reset, refresh info)', (_name, page) => {
    const promo = promotionProps();
    mocked.filterBars.length = 0;
    render(page());
    const product = mocked.filterBars[mocked.filterBars.length - 1] as unknown as Record<string, unknown>;
    const productKeys = Object.keys(product).filter((k) => !PRODUCT_ONLY.includes(k));
    expect(productKeys).toEqual(Object.keys(promo)); // same props, same order
    for (const key of Object.keys(promo)) {
      if (NARROWED.includes(key) || OWN_DATES.includes(key)) continue;
      expect(product[key], key).toBe(promo[key]);
    }
    expect(product.showLastOrderInfo).toBeUndefined(); // the default (on), as on Promotion
    expect(product.lastUpdate).toBe('2026-11-06T14:32:00Z');
    expect(product.lastRefreshTime).toBe('2026-11-07T08:53:00Z');
    // the narrowed lists are subsets of Promotion's
    expect((product.businessUnits as unknown[]).every((u) => (promo.businessUnits as unknown[]).includes(u))).toBe(true);
    expect((product.customerGroups as unknown[]).every((g) => (promo.customerGroups as unknown[]).includes(g))).toBe(true);
  });
});
