import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProductDashboardOverview, ProductDashboardRow, ProductStatusList, ProductStatusSkuRow } from '../../../../lib/api';
import { rowsForStatus, statusCounts, statusMatchesCards, statusTableHref, scopeFromParams } from '../../../../lib/product/statusTable';
import BcgMatrixPage from '../bcg-matrix/page';
import ProductStatusTablePage from '../bcg-matrix/products/page';

/** BCG Matrix → status table (2026-11-15): the cards and chips open the table with the page filters, the table's counts
 * equal the cards, and every product hover names the company. */

// jsdom has no ResizeObserver (the charts measure themselves)
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const nav = vi.hoisted(() => ({ pushed: [] as string[], replaced: [] as string[], params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (u: string) => nav.pushed.push(u), replace: (u: string) => nav.replaced.push(u) }),
  useSearchParams: () => nav.params,
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...rest}>{children}</a>,
}));
const auth = vi.hoisted(() => ({ user: null as null | { isAdmin: boolean } }));
vi.mock('../../../../lib/AuthProvider', () => ({
  useAuth: () => ({ user: auth.user, token: 't', error: null, retryAuth: () => {}, logout: () => {}, isSalesperson: false, canView: () => true, can: () => true }),
}));
vi.mock('../../../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../../../components/BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../../../components/ValidationStatusBar', () => ({ ValidationStatusBar: () => null }));
vi.mock('../../../../components/RefreshFooter', () => ({ RefreshFooter: () => null }));
vi.mock('../../../../components/AuthGuard', () => ({ PermissionGuard: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../../components/FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../../../../components/product/useProductFilters', () => ({
  useProductFilters: () => ({ anchorDate: '2026-11-15', onAnchorDateChange: () => {}, scope: { company: 'Tika', fromDate: '2026-01-01', toDate: '2026-06-30' },
    companyLabel: 'Tika', filterBarProps: {}, withLocalReset: () => ({}) }),
}));

const sku = (id: number, over: Partial<ProductStatusSkuRow>): ProductStatusSkuRow => ({
  odooProductId: String(id), productName: `P${id}`, sku: `REF${id}`, companies: ['Tika'], category: 'Tiles', brand: 'QUA', status: 'Active',
  bcgClass: 'Stars', units: id, unitsPrior: 1, value: 10 * id, profit: 4 * id, grossProfitPct: 40, onHandQty: 0, lastSaleDate: '2026-06-01',
  odooUrl: null, withStock: false, archived: false, archivedDate: null, exclusionRule: null, ...over,
});
const SKUS: ProductStatusSkuRow[] = [
  sku(1, {}), sku(2, {}),
  sku(3, { status: 'NonActive', bcgClass: null, onHandQty: 5, withStock: true }),
  sku(4, { status: 'NonActive', bcgClass: null }),
  sku(5, { status: 'NonActive', bcgClass: null }),
  sku(6, { status: 'Dormant', bcgClass: null, archived: true }),
  sku(7, { status: 'Unclassified', bcgClass: null, exclusionRule: 'ProductExclusions.xlsx · Categories sheet · All / Packaging' }),
];
const SUMMARY = {
  total: 7, active: { count: 2, units: 3, value: 30 }, nonActive: { count: 3, withStock: 1, zeroStock: 2, stockUnits: 5, stockValue: 1 },
  dormant: { count: 1 }, unclassified: { count: 1 },
  bcg: { classes: [{ key: 'Stars' as const, count: 2, units: 3, value: 30, profit: 12 }, { key: 'Cash Cows' as const, count: 0, units: 0, value: 0 },
    { key: 'Strategic' as const, count: 0, units: 0, value: 0 }, { key: 'Dogs' as const, count: 0, units: 0, value: 0 }], missingCost: 1 },
};
const PERIOD = { from: '2026-01-01', to: '2026-06-30', days: 181, priorFrom: '2025-07-04', priorTo: '2025-12-31', isDefault: false, label: 'Custom' };
const LIST: ProductStatusList = { view: 'Tika', period: PERIOD, asOfDate: null, profitAccess: true, statusSummary: SUMMARY, statusSummaryError: null, skus: SKUS };

const productRow = { productCompanyKey: 'Tika|1', productKey: '1', odooUrl: null, productTemplateId: 1, company: 'Tika', productName: 'Cem Air',
  odooProductName: 'Cem Air', category: 'Tiles', brand: 'QUA', subBrand: null, family: null, size: null, sku: null, isActive: 1, companies: ['Tika'],
  parts: [], value: 100, volume: 10, volumeByUom: [], uom: 'Unit', lines: 1, orderDays: 3, velocity: 1, valuePrior: 50, volumePrior: 5,
  avgUnitPrice: 10, grossProfitPct: 40, stockQty: 0, stockValue: 0, inTransitQty: 0, inTransitValue: 0, avgDailySales: 0, daysOfInventory: null,
  stockBand: 'Normal', stockAgeDays: null, stockAgeBucket: null, lifecycleSegment: 'Mature', firstSaleDate: '2025-01-01', lastSaleDate: '2026-06-01',
  productStatus: 'Active', bcgClass: 'Stars', bcgMovement: 'Improved', bcgExcludedCategory: false, negativeStockRows: 0, bcgVolume: 10, bcgValue: 100,
  bcgProfit: 40, bcgGrossProfitPct: 40, bcgDataAsOf: '2026-06-01', missingCost: true } as unknown as ProductDashboardRow;
const costedRow = { ...productRow, productCompanyKey: 'Tika|2', productKey: '2', productName: 'Fully costed', missingCost: false } as ProductDashboardRow;
const OVERVIEW = { view: 'Tika', asOfDate: null, builtAtUtc: null, period: PERIOD, lookbackDays: 90, thresholds: {}, products: [productRow, costedRow],
  totals: { value: 100, lines: 1, volumeByUom: [] }, intercompanyValue: 0, profitAccess: true, statusSummary: SUMMARY, statusSummaryError: null } as unknown as ProductDashboardOverview;

const list = vi.hoisted(() => ({ data: null as ProductStatusList | null }));
vi.mock('../../../../lib/hooks', () => ({
  useRefreshStatus: () => ({ data: null }),
  useProductStatusList: () => ({ data: list.data, loading: false, error: null, retry: () => {} }),
  useProductDashboard: () => ({ data: OVERVIEW, loading: false, error: null, retry: () => {} }),
}));

afterEach(() => {
  cleanup();
  auth.user = null;
  nav.pushed.length = 0;
  nav.replaced.length = 0;
  nav.params = new URLSearchParams();
});

describe('status table helpers', () => {
  it('counts per status equal the cards (and the Non Active with-stock split)', () => {
    expect(statusCounts(SKUS)).toEqual({ Active: 2, NonActive: 3, Dormant: 1, Unclassified: 1 });
    expect(statusMatchesCards(SKUS, SUMMARY)).toBe(true);
    expect(statusMatchesCards(SKUS.slice(1), SUMMARY)).toBe(false);
    expect(statusMatchesCards(SKUS, { ...SUMMARY, nonActive: { ...SUMMARY.nonActive, withStock: 2 } })).toBe(false);
    expect(rowsForStatus(SKUS, 'NonActive', 'with').map((r) => r.odooProductId)).toEqual(['3']);
    expect(rowsForStatus(SKUS, 'NonActive', 'zero').map((r) => r.odooProductId)).toEqual(['4', '5']);
  });

  it('the link carries the status and the Company + Date filters, and reads them back', () => {
    const href = statusTableHref('non_active', { company: 'Tika', fromDate: '2026-01-01', toDate: '2026-06-30' }, 'with');
    expect(href).toBe('/product/bcg-matrix/products?status=non_active&company=Tika&fromDate=2026-01-01&toDate=2026-06-30&stock=with');
    expect(scopeFromParams(new URLSearchParams(href.split('?')[1]))).toEqual({ company: 'Tika', fromDate: '2026-01-01', toDate: '2026-06-30' });
    expect(statusTableHref('active', {})).toBe('/product/bcg-matrix/products?status=active');
  });
});

describe('BCG Matrix page: clickable status cards and chips; company in the hover', () => {
  it('a chip and a card (click, Enter, Space) open the table with the page filters', () => {
    render(<BcgMatrixPage />);
    fireEvent.click(screen.getByTestId('total-skus-chip-dormant'));
    const card = screen.getByRole('link', { name: 'Non Active 3: list the products' });
    fireEvent.click(card);
    fireEvent.keyDown(screen.getByRole('link', { name: 'Unclassified 1: list the products' }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('link', { name: 'Active 2: list the products' }), { key: ' ' });
    expect(nav.pushed).toEqual([
      '/product/bcg-matrix/products?status=dormant&company=Tika&fromDate=2026-01-01&toDate=2026-06-30',
      '/product/bcg-matrix/products?status=non_active&company=Tika&fromDate=2026-01-01&toDate=2026-06-30',
      '/product/bcg-matrix/products?status=unclassified&company=Tika&fromDate=2026-01-01&toDate=2026-06-30',
      '/product/bcg-matrix/products?status=active&company=Tika&fromDate=2026-01-01&toDate=2026-06-30',
    ]);
    expect(card.className).toMatch(/ps-card-clickable/);
    expect(card.getAttribute('tabindex')).toBe('0');
  });

  it('the product hover shows the company first, under the name', () => {
    render(<BcgMatrixPage />);
    const name = screen.getAllByTestId('product-name').find((n) => n.textContent?.includes('Cem Air') && n.closest('table'))!;
    fireEvent.mouseEnter(name.closest('div[dir="ltr"]')!);
    const badges = screen.getByTestId('product-tooltip-badges');
    expect(badges.firstElementChild?.textContent).toBe('Tika');
    expect(badges.textContent).toMatch(/^Tika.*QUA.*Stars/);
  });
});

describe('status table page', () => {
  it('tabs show the card counts; the rows of the chosen status; back link; Unclassified shows the rule', () => {
    list.data = LIST;
    nav.params = new URLSearchParams('status=unclassified&company=Tika&fromDate=2026-01-01&toDate=2026-06-30');
    render(<ProductStatusTablePage />);
    expect(['active', 'non_active', 'dormant', 'unclassified'].map((k) => screen.getByTestId(`status-tab-${k}`).textContent))
      .toEqual(['Active 2', 'Non Active 3', 'Dormant 1', 'Unclassified 1']);
    expect(screen.getByTestId('status-table-count').textContent).toMatch(/^1 SKUs/);
    expect(screen.getByText(/Categories sheet · All \/ Packaging/)).toBeTruthy();
    expect(screen.queryByTestId('status-table-mismatch')).toBeNull();
    expect(screen.getByTestId('status-table-back').getAttribute('href')).toBe('/product/bcg-matrix');
    fireEvent.click(screen.getByTestId('status-tab-dormant'));
    expect(nav.replaced).toEqual(['/product/bcg-matrix/products?status=dormant&company=Tika&fromDate=2026-01-01&toDate=2026-06-30']);
  });

  it('Non Active: With stock / Zero stock match the card; Dormant: archived in Odoo, date not loaded', () => {
    list.data = LIST;
    nav.params = new URLSearchParams('status=non_active&stock=with');
    render(<ProductStatusTablePage />);
    expect(['all', 'with', 'zero'].map((k) => screen.getByTestId(`stock-filter-${k}`).textContent)).toEqual(['All 3', 'With stock 1', 'Zero stock 2']);
    expect(screen.getByTestId('status-table-count').textContent).toMatch(/^1 SKUs/);
    cleanup();
    nav.params = new URLSearchParams('status=dormant');
    render(<ProductStatusTablePage />);
    expect(screen.getByText('Archived in Odoo')).toBeTruthy();
    expect(screen.getByText('not loaded')).toBeTruthy();
  });

  it('rows that do not add up to the cards are flagged, never hidden', () => {
    list.data = { ...LIST, skus: SKUS.slice(1) };
    nav.params = new URLSearchParams('status=active');
    render(<ProductStatusTablePage />);
    expect(screen.getByTestId('status-table-mismatch')).toBeTruthy();
  });
});

describe('BCG class colours (2026-11-15): one map everywhere', () => {
  it('the summary cards use the matrix colours (BCG_COLOR)', async () => {
    const { BCG_COLOR } = await import('../../../../lib/materialsAnalogy/shared');
    render(<BcgMatrixPage />);
    const row = document.querySelector('section[aria-labelledby="row-bcg"] > div')!;
    const values = [...row.children].map((tile) => (tile.querySelector('div[style*="font-size: 32px"]') as HTMLElement).style.color);
    expect(values).toEqual(['Stars', 'Cash Cows', 'Strategic', 'Dogs'].map((k) => BCG_COLOR[k]));
    expect(BCG_COLOR).toMatchObject({ Stars: 'var(--ps-color-gold)', 'Cash Cows': 'var(--ps-color-success)', Strategic: 'var(--ps-color-accent)', Dogs: 'var(--ps-color-alert)' });
  });
});

describe('missing cost: an admin-only data quality row (2026-11-15)', () => {
  it('non-admins see no row and no sentence', () => {
    const { container } = render(<BcgMatrixPage />);
    expect(screen.queryByTestId('bcg-data-quality')).toBeNull();
    expect(container.textContent).not.toMatch(/no cost in Odoo|missing cost data/);
  });

  it('admins see one short line; it opens Product Detail with Cost data = Missing applied', () => {
    auth.user = { isAdmin: true, role: { label: 'Admin' }, fullName: 'Admin' } as unknown as { isAdmin: boolean };
    Element.prototype.scrollIntoView = vi.fn();
    render(<BcgMatrixPage />);
    const row = screen.getByTestId('bcg-data-quality');
    expect(row.textContent).toMatch(/^Data Quality1 Active products have no cost in Odoo \(counted as low margin\)/);
    const grid = document.getElementById('product-detail')!;
    expect(grid.textContent).toContain('Fully costed');
    fireEvent.click(screen.getByTestId('bcg-data-quality-open'));
    expect(grid.textContent).not.toContain('Fully costed');   // only the missing-cost product is left
    expect(grid.textContent).toContain('Cem Air');
    expect(window.location.search).toBe('?costData=missing');
  });
});
