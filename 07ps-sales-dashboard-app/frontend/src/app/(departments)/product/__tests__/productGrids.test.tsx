import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ProductDashboardOverview, ProductDashboardRow } from '../../../../lib/api';
import BcgMatrixPage from '../bcg-matrix/page';
import ProductLifecyclePage from '../product-lifecycle/page';
import BrandPage from '../pim-contribution/brand/[brand]/page';
import PimContributionPage from '../pim-contribution/page';

const url = (id: number, cid: number) => `https://odoo.example.com/web#id=${id}&model=product.product&view_type=form&cids=${cid}`;
const row = (id: number, over: Partial<ProductDashboardRow>): ProductDashboardRow => ({
  productCompanyKey: `Majaal|${id}`, productKey: String(id), odooUrl: url(id, 1), productTemplateId: id, company: 'Majaal', productName: `P${id}`,
  odooProductName: `P${id}`, category: 'Tiles', brand: 'Stonewrap', subBrand: null, family: null, size: null, sku: null, isActive: 1,
  companies: ['Majaal'], parts: [], value: 100, volume: 10 * id, volumeByUom: [], uom: 'Unit', lines: 1, orderDays: 3, velocity: id, valuePrior: 50,
  volumePrior: 5, avgUnitPrice: 10, grossProfitPct: 40, stockQty: 0, stockValue: 0, inTransitQty: 0, inTransitValue: 0, avgDailySales: 0,
  daysOfInventory: null, stockBand: 'Normal', stockAgeDays: null, stockAgeBucket: null, lifecycleSegment: 'Mature', firstSaleDate: '2025-01-01',
  lastSaleDate: '2026-11-01', productStatus: 'Active', bcgClass: 'Stars', bcgClassPrior12M: 'Stars', bcgMovement: 'Improved', bcgExcludedCategory: false,
  grossProfitPctL12M: 40, grossProfitPctPrior12M: 40, negativeStockRows: 0,
  bcgVolume: 10 * id, bcgValue: 100, bcgProfit: 40, bcgGrossProfitPct: 40, bcgDataPeriod: 'Last 12 Months', bcgDataAsOf: '2026-11-0' + id, ...over,
});
const OVERVIEW: ProductDashboardOverview = {
  view: 'BMH', asOfDate: '2026-11-07', builtAtUtc: null, period: { from: '2025-11-07', to: '2026-11-07', days: 366, priorFrom: '2024-11-07', priorTo: '2025-11-06', label: 'Last 12 Months' },
  lookbackDays: 90, thresholds: { bcg: { volume_threshold: { Majaal: 3500, Tika: 25000 }, profit_threshold_pct: 35 } },
  products: [row(1, {}), row(2, {}), { ...row(3, { company: 'Tika', productCompanyKey: 'Tika|3' }), odooUrl: url(3, 3) }],
  totals: { value: 300, lines: 3, volumeByUom: [] }, intercompanyValue: 0, statusSummaryError: null,
  statusSummary: {
    total: 12,
    active: { count: 4, units: 60, value: 300 },
    nonActive: { count: 5, withStock: 2, zeroStock: 3, stockUnits: 10, stockValue: 25 },
    dormant: { count: 2 },
    unclassified: { count: 1 },
    bcg: {
      classes: [
        { key: 'Stars', count: 3, units: 60, profit: 120 },
        { key: 'Cash Cows', count: 0, units: 0, profit: 0 },
        { key: 'Strategic', count: 0, units: 0, profit: 0 },
        { key: 'Dogs', count: 0, units: 0, profit: 0 },
      ],
      notClassified: 1,
    },
  },
};

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), useParams: () => ({ brand: 'stonewrap' }), useSearchParams: () => new URLSearchParams() }));
vi.mock('../../../../lib/AuthProvider', () => ({ useAuth: () => ({ user: null, token: 't', error: null, retryAuth: () => {}, logout: () => {}, isSalesperson: false, canView: () => true }) }));
vi.mock('../../../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../../../components/BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../../../components/ValidationStatusBar', () => ({ ValidationStatusBar: () => null }));
vi.mock('../../../../components/RefreshFooter', () => ({ RefreshFooter: () => null }));
vi.mock('../../../../components/AuthGuard', () => ({ PermissionGuard: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../../components/FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../../../../components/product/useProductFilters', () => ({
  useProductFilters: () => ({ anchorDate: '2026-11-07', onAnchorDateChange: () => {}, dateFromDate: '2026-01-01', dateToDate: '2026-11-07', scope: {}, companyLabel: 'Majaal + Tika', filterBarProps: {}, withLocalReset: () => ({}) }),
}));
vi.mock('../../../../lib/hooks', () => ({
  useProductDashboard: () => ({ data: OVERVIEW, loading: false, error: null, retry: () => {} }),
  useRefreshStatus: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('@07ps/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@07ps/ui')>()),
  // the app's standard grid: record which table uses it, its columns, and render the first column of every row
  DataGrid: ({ columns, rows, fileName }: { columns: { header: string; render?: (r: unknown) => React.ReactNode }[]; rows: unknown[]; fileName?: string }) => (
    <div data-testid="data-grid" data-file={fileName} data-headers={columns.map((c) => c.header).join('|')}>
      {rows.map((r, i) => <div key={i}>{columns[0].render?.(r)}</div>)}
    </div>
  ),
  DonutChart: () => null,
  ComboChart: () => null,
  GroupedBarChart: () => null,
}));

afterEach(cleanup);

describe('Product tables use the standard grid, volume first, and every product opens in Odoo', () => {
  it('BCG Matrix: Product Detail grid + class panels link each product to its own company in Odoo', () => {
    render(<BcgMatrixPage />);
    const grid = screen.getByTestId('data-grid');
    expect(grid.getAttribute('data-file')).toBe('bcg-matrix-product-detail');
    expect(grid.getAttribute('data-headers')!.split('|').slice(0, 4)).toEqual(['Product Name', 'Status', 'Volume Last 12 Months', 'Volume Prior 12 Months']);
    expect(grid.getAttribute('data-headers')).toMatch(/Vol Growth\|Quantity On Hand/); // Quantity On Hand right after the growth columns
    expect(grid.getAttribute('data-headers')).toMatch(/Volume Last 12 Months\|Volume Prior 12 Months\|Vol Growth/);
    expect(within(grid).getByRole('link', { name: /P3/ }).getAttribute('href')).toBe(url(3, 3)); // Tika product -> Tika company
    // the Stars panel (a ranked visual, not a grid) links too
    const links = screen.getAllByRole('link', { name: /P1/ }).map((a) => a.getAttribute('href'));
    expect(links).toContain(url(1, 1));
  });

  it('BCG Matrix (threshold version restored 2026-11-11): class rules from the config thresholds, no median, Product Detail full width under Product Movement', () => {
    const { container } = render(<BcgMatrixPage />);
    expect(screen.getByTestId('bcg-class-definition-Stars').textContent).toBe('Volume ≥ Majaal 3,500 / Tika 25,000 units, GP% ≥ 35%');
    expect(screen.getByTestId('bcg-class-definition-Dogs').textContent).toBe('Volume < Majaal 3,500 / Tika 25,000 units, GP% < 35%');
    // 2x2: STARS | CASH COWS / STRATEGIC | DOGS; KPI tiles in the same order, then Not classified
    expect([...screen.getByTestId('bcg-class-grid').querySelectorAll('[data-testid^="bcg-class-card-"]')].map((e) => e.getAttribute('data-testid')))
      .toEqual(['bcg-class-card-Stars', 'bcg-class-card-Cash Cows', 'bcg-class-card-Strategic', 'bcg-class-card-Dogs']);
    // 3 rows (2026-11-14): Total SKUs (1 card) · Product Status (4) · BCG Matrix of the Active products (5)
    const kpis = screen.getByTestId('bcg-kpis');
    const row = (id: string) => [...kpis.querySelector(`section[aria-labelledby="${id}"] > div`)!.children];
    const badges = (id: string) => row(id).map((tile) => tile.querySelector('span:last-child')?.textContent);
    expect([...kpis.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Total SKUs', 'Product Status', 'BCG Matrix (Active products · Last 12 Months)']);
    expect(badges('row-total-skus')).toEqual(['Total SKUs']);
    expect(row('row-total-skus')[0].textContent).toMatch(/12.*Active 4 · Non Active 5 · Dormant 2 · Unclassified 1/);
    expect(badges('row-product-status')).toEqual(['Active', 'Non Active', 'Dormant', 'Unclassified']);
    expect(row('row-product-status')[1].textContent).toMatch(/2 with stock · 3 zero stock/);
    expect(badges('row-bcg')).toEqual(['Stars', 'Cash Cows', 'Strategic', 'Dogs', 'Not classified']);
    expect(screen.getByTestId('last-12-months-note').textContent).toMatch(/^Last 12 Months · 7 Nov 2025 – 7 Nov 2026/);
    expect(container.textContent).not.toMatch(/YTD|Year to Date/);
    expect(screen.queryByText(/axes|Export image/)).toBeNull();
    expect(screen.getByTestId('bcg-profit-data').textContent).toMatch(/^Active products · profit data of the last 12 months, as of 2026-/);
    expect(screen.getByTestId('bcg-class-action-Dogs').textContent).toMatch(/not an automatic discontinue/);
    expect(container.textContent).not.toMatch(/median|Cannot classify|Insufficient comparison|unstable/i);
    const text = container.textContent ?? '';
    expect(text.indexOf('Product Movement')).toBeLessThan(text.lastIndexOf('Product Detail')); // the card (the subtitle also says "see Product Detail")
    // neither card shares a row with the other (no two-column grid around them)
    const grid = screen.getByTestId('data-grid');
    const sharedRow = [...container.querySelectorAll<HTMLElement>('div')].find((d) => d.style.gridTemplateColumns && d.contains(grid));
    expect(sharedRow).toBeUndefined();
  });

  it('Product Lifecycle: Product Detail is the standard grid, volume first', () => {
    render(<ProductLifecyclePage />);
    const grid = within(screen.getByTestId('lifecycle-product-grid')).getByTestId('data-grid');
    expect(grid.getAttribute('data-headers')!.split('|').slice(0, 3)).toEqual(['Product Name', 'Volume (Last 12 Months)', 'Volume vs prior 12 months']);
    expect(within(grid).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([url(3, 3), url(2, 1), url(1, 1)]); // highest volume first
  });

  it('Brand page (Stonewrap): the products are the standard grid, volume first, each linked to Odoo', () => {
    render(<BrandPage />);
    const grid = within(screen.getByTestId('brand-product-table')).getByTestId('data-grid');
    expect(grid.getAttribute('data-headers')!.split('|').slice(0, 2)).toEqual(['Product', 'Volume (Unit)']);
    expect(within(grid).getAllByRole('link')).toHaveLength(3);
  });

  it('PIM Contribution: 10 brand cards in the fixed 5-column grid, volume order, one-line titles with the full name on hover', () => {
    render(<PimContributionPage />);
    const grid = screen.getByTestId('brand-grid');
    expect(grid.className).toBe('ps-brand-grid');
    const titles = within(grid).getAllByTestId('brand-card-title');
    expect(titles).toHaveLength(10);
    expect(titles[0].textContent).toBe('Stonewrap'); // the only brand with sales here: first by volume
    expect(titles.map((t) => t.textContent)).toEqual(expect.arrayContaining(['Saquer Gulf & Lotus Tile', 'Al-Saraya Al-Hamra']));
    for (const t of titles) {
      expect(t.getAttribute('title')).toBe(t.textContent);
      expect([t.style.whiteSpace, t.style.textOverflow, t.style.overflow]).toEqual(['nowrap', 'ellipsis', 'hidden']);
    }
  });

  it('Brand page lists every product with its own Brand column (a card can group several vendors)', () => {
    render(<BrandPage />);
    const grid = within(screen.getByTestId('brand-product-table')).getByTestId('data-grid');
    expect(grid.getAttribute('data-headers')!.split('|')).toContain('Brand');
  });
});
