import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProductDashboardOverview, ProductDashboardRow } from '../../../../lib/api';
import StockVelocityPage from '../stock-velocity/page';

const THRESHOLDS = {
  days_of_inventory: { lookback_days: 90, overstock_days: { Majaal: 180, Tika: 60, Athena: 180 }, stockout_risk_days: { Majaal: 60, Tika: 30 } },
  stock: {
    isr_target_pct: 15, isr_red_pct: 25, fast_mover_vs_category_median_pct: 150, slow_mover_vs_category_median_pct: 50,
    aging_buckets: [{ label: '0–90 days', max_days: 90 }, { label: '91–180 days', max_days: 180 }, { label: '181–365 days', max_days: 365 }, { label: '1–2 years', max_days: 730 }, { label: '> 2 years', max_days: null }],
  },
  sales_frequency: { buckets: [{ key: 'Daily', max_gap_days: 2 }, { key: 'Weekly', max_gap_days: 7 }, { key: 'Monthly', max_gap_days: 30 }, { key: 'Quarterly', max_gap_days: 90 }, { key: 'Rarely', max_gap_days: null }] },
};

const row = (id: number, over: Partial<ProductDashboardRow>): ProductDashboardRow => ({
  productCompanyKey: `Majaal|${id}`, productKey: String(id), odooUrl: `https://odoo.example.com/web#id=${id}&model=product.product&view_type=form&cids=1`, productTemplateId: id, company: 'Majaal', productName: `P${id}`, odooProductName: `P${id}`,
  category: 'Tiles', brand: null, subBrand: null, family: null, size: null, sku: null, isActive: 1, companies: ['Majaal'], parts: [],
  value: 0, volume: 0, volumeByUom: [], uom: 'Unit', lines: 0, orderDays: 0, velocity: 0, valuePrior: 0, volumePrior: 0, avgUnitPrice: null,
  grossProfitPct: null, stockQty: 0, stockValue: 0, inTransitQty: 0, inTransitValue: 0, avgDailySales: 0, daysOfInventory: null,
  stockBand: 'Normal', stockAgeDays: null, stockAgeBucket: null, lifecycleSegment: 'Mature', firstSaleDate: null, lastSaleDate: null,
  bcgClassYTD: 'Dogs', bcgClassLYTD: null, bcgMovement: null, bcgExcludedCategory: false, valueYTD: 0, volumeYTD: 0, valueLYTD: 0,
  volumeLYTD: 0, grossProfitPctYTD: null, grossProfitPctLYTD: null, negativeStockRows: 0, ...over,
});

// 6 sellers (velocities 1..6 -> Slow 1,2 · Normal 3,4 · Fast 5,6), stock on hand of 30 + 30 + 40 LYD at cost, sales 1,000 LYD
const PRODUCTS: ProductDashboardRow[] = [1, 2, 3, 4, 5, 6].map((v) =>
  row(v, { value: [100, 100, 100, 200, 200, 300][v - 1], volume: v * 10, velocity: v, orderDays: [10, 10, 2, 1, 1, 10][v - 1], lines: 1 }),
);
PRODUCTS[0] = { ...PRODUCTS[0], stockQty: 50, stockValue: 30, daysOfInventory: 300, stockBand: 'Overstock', stockAgeDays: 40, stockAgeBucket: '0–90 days' };
PRODUCTS[1] = { ...PRODUCTS[1], stockQty: 20, stockValue: 30, daysOfInventory: 20, stockBand: 'StockOutRisk', stockAgeDays: 800, stockAgeBucket: '> 2 years' };
PRODUCTS[2] = { ...PRODUCTS[2], stockQty: 10, stockValue: 40, daysOfInventory: 100, stockAgeDays: 200, stockAgeBucket: '181–365 days' };
const OVERVIEW: ProductDashboardOverview = {
  view: 'BMH', asOfDate: '2026-11-07', builtAtUtc: null, period: { from: '2026-10-08', to: '2026-11-07', days: 31, priorFrom: '', priorTo: '' },
  lookbackDays: 90, thresholds: THRESHOLDS, products: PRODUCTS, totals: { value: 1000, lines: 6, volumeByUom: [] }, intercompanyValue: 0,
};

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), useParams: () => ({}), useSearchParams: () => new URLSearchParams() }));
vi.mock('../../../../lib/AuthProvider', () => ({ useAuth: () => ({ user: null, token: 't', error: null, retryAuth: () => {}, logout: () => {}, isSalesperson: false, canView: () => true }) }));
vi.mock('../../../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../../../components/BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../../../components/ValidationStatusBar', () => ({ ValidationStatusBar: () => null }));
vi.mock('../../../../components/RefreshFooter', () => ({ RefreshFooter: () => null }));
vi.mock('../../../../components/AuthGuard', () => ({ PermissionGuard: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../../components/FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../../../../components/product/ProductBarChart', () => ({
  ProductBarChart: ({ rows }: { rows: { id: string; name: string; href?: string | null }[] }) => (
    <ul data-testid="product-bars">{rows.map((r) => <li key={r.id}>{r.href ? <a href={r.href}>{r.name}</a> : r.name}</li>)}</ul>
  ),
}));
vi.mock('../../../../components/product/useProductFilters', () => ({
  useProductFilters: () => ({ anchorDate: '2026-11-07', onAnchorDateChange: () => {}, scope: {}, companyLabel: 'Majaal + Tika', filterBarProps: {}, withLocalReset: () => ({}) }),
}));
vi.mock('../../../../lib/hooks', () => ({
  useProductDashboard: () => ({ data: OVERVIEW, loading: false, error: null, retry: () => {} }),
  useRefreshStatus: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('@07ps/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@07ps/ui')>()),
  GroupedBarChart: ({ points, onCategoryClick }: { points: { label: string; skus: number }[]; onCategoryClick?: (l: string) => void }) => (
    <ul>{points.map((p) => <li key={p.label} data-testid="bar" onClick={() => onCategoryClick?.(p.label)}>{`${p.label}: ${p.skus}`}</li>)}</ul>
  ),
  DataGrid: ({ columns, rows }: { columns: { header: string; render?: (r: unknown) => React.ReactNode }[]; rows: unknown[] }) => (
    <div data-testid="data-grid" data-headers={columns.map((c) => c.header).join('|')}>{rows[0] ? columns[0].render?.(rows[0]) : null}</div>
  ),
  Gauge: ({ valueLabel, status }: { valueLabel: string; status: string }) => <div data-testid="gauge">{`${valueLabel} ${status}`}</div>,
}));

afterEach(cleanup);

describe('Stock Velocity page', () => {
  it('6 KPI cards in order (no ISR card), plain sub-lines; Inventory Value in LYD at cost', () => {
    render(<StockVelocityPage />);
    const kpis = screen.getByTestId('stock-velocity-kpis');
    const labels = [...kpis.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).filter((l) => !String(l).startsWith('About'));
    expect(labels).toEqual(['DOH – Avg Days of Inventory', 'Overstocked SKUs', 'Stock-Out Risk SKUs', 'Fast Movers', 'SKUs in Stock', 'Inventory Value']);
    expect(within(kpis).queryByText(/ISR/)).toBeNull();
    expect(within(kpis).getByText('Based on the last 90 days of sales')).toBeTruthy();
    expect(within(kpis).getByText('In finished-goods locations')).toBeTruthy();
    expect(within(kpis).getByText('Out of 6 SKUs sold in the period')).toBeTruthy();
    expect(within(kpis).getByText('LYD 100')).toBeTruthy(); // 30 + 30 + 40 LYD at cost
    expect(within(kpis).getByText('80 units on hand · 0 units in transit')).toBeTruthy();
    // ISR = 100 LYD stock at cost / 1,000 LYD sales = 10% -> green, on the gauge only
    expect(screen.getByTestId('gauge').textContent).toBe('10.0% success');
  });

  it('Fast / Normal / Slow against the category median (Fast >= 150%, Slow <= 50%), one stacked bar', () => {
    render(<StockVelocityPage />);
    // one category, velocities 1..6 -> median 3.5: 1 = 29% Slow, 2..5 = 57-143% Normal, 6 = 171% Fast
    const bar = screen.getByTestId('movers-share-bar');
    expect(within(bar).getByLabelText('Fast movers: 1 SKUs (16.7%)')).toBeTruthy();
    expect(within(bar).getByLabelText('Normal movers: 4 SKUs (66.7%)')).toBeTruthy();
    expect(within(bar).getByLabelText('Slow movers: 1 SKUs (16.7%)')).toBeTruthy();
    expect(screen.getByText("6 SKUs sold in the period, compared with their category's median sales speed")).toBeTruthy();
    const fastCard = within(screen.getByTestId('stock-velocity-kpis')).getByLabelText('Fast Movers');
    expect(within(fastCard).getByText('1')).toBeTruthy(); // the Fast Movers card uses the same rule
  });

  it('layout: gauge, then movers, then aging, each its own full-width row', () => {
    render(<StockVelocityPage />);
    const order = ['isr-gauge', 'movers-share-bar', 'aging-share-bar'].map((id) => screen.getByTestId(id));
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('isr-gauge').parentElement!.tagName).toBe('MAIN'); // not in a 2-column grid any more
  });

  it('drill lists open each product in Odoo; the Sales Frequency list is the standard grid (volume first)', () => {
    render(<StockVelocityPage />);
    fireEvent.click(within(screen.getByTestId('movers-share-bar')).getByLabelText('Fast movers: 1 SKUs (16.7%)'));
    const link = within(screen.getByTestId('product-bars')).getByRole('link', { name: 'P6' });
    expect(link.getAttribute('href')).toBe('https://odoo.example.com/web#id=6&model=product.product&view_type=form&cids=1');
    cleanup();
    render(<StockVelocityPage />);
    fireEvent.click(within(screen.getByTestId('sales-frequency-chart')).getByText('Weekly (3–7 days): 3'));
    const grid = within(screen.getByTestId('sales-frequency-table')).getByTestId('data-grid');
    expect(grid.getAttribute('data-headers')!.split('|').slice(0, 2)).toEqual(['Product', 'Units sold (period)']);
    expect(within(grid).getByRole('link').getAttribute('href')).toMatch(/model=product\.product/);
  });

  it('Stock Aging: SKUs on hand per config bucket', () => {
    render(<StockVelocityPage />);
    const bar = screen.getByTestId('aging-share-bar');
    expect(within(bar).getByLabelText('0–90 days: 1 SKUs (33.3%)')).toBeTruthy();
    expect(within(bar).getByLabelText('181–365 days: 1 SKUs (33.3%)')).toBeTruthy();
    expect(within(bar).getByLabelText('> 2 years: 1 SKUs (33.3%)')).toBeTruthy();
  });

  it('Sales Frequency: config buckets incl. Quarterly and Rarely, SKU counts, no cards under the chart', () => {
    render(<StockVelocityPage />);
    const chart = screen.getByTestId('sales-frequency-chart');
    // 31 days ÷ selling days: 10 -> 3.1 (Weekly) x3, 2 -> 15.5 (Monthly), 1 -> 31 (Quarterly) x2
    expect(within(chart).getAllByTestId('bar').map((b) => b.textContent)).toEqual([
      'Daily (≤ 2 days): 0', 'Weekly (3–7 days): 3', 'Monthly (8–30 days): 1', 'Quarterly (31–90 days): 2', 'Rarely (> 90 days): 0']);
    expect(screen.queryByTestId('sales-frequency-buckets')).toBeNull();
  });

  it('the long footnote is gone (its content is in the "?")', () => {
    const { container } = render(<StockVelocityPage />);
    expect(container.textContent).not.toMatch(/Days of inventory = finished-goods stock/);
    expect(container.textContent).not.toMatch(/Every product is one Odoo product in one company/);
  });
});
