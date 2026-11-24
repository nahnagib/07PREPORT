import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  lastSaleDate: '2026-11-01', productStatus: 'Active', bcgClass: 'Stars', bcgMovement: 'Improved', bcgExcludedCategory: false,
  negativeStockRows: 0,
  bcgVolume: 10 * id, bcgValue: 100, bcgProfit: 40, bcgGrossProfitPct: 40, bcgDataAsOf: '2026-11-0' + id, ...over,
});
/** What the API sends a user without profit access (backend withoutProfit). */
function withoutProfit(o: ProductDashboardOverview): ProductDashboardOverview {
  const products = o.products.map((r) => {
    const rest = { ...r };
    delete rest.grossProfitPct; delete rest.bcgProfit; delete rest.bcgGrossProfitPct; delete rest.missingCost;
    return rest;
  });
  const statusSummary = o.statusSummary && { ...o.statusSummary, bcg: { classes: o.statusSummary.bcg.classes.map(({ key, count, units, value }) => ({ key, count, units, value })) } };
  return { ...o, products, statusSummary, profitAccess: false };
}
const OVERVIEW: ProductDashboardOverview = {
  view: 'BMH', asOfDate: '2026-11-07', builtAtUtc: null, period: { from: '2025-11-07', to: '2026-11-07', days: 366, priorFrom: '2024-11-06', priorTo: '2025-11-06', isDefault: true, label: 'Last 12 Months' },
  lookbackDays: 90, thresholds: { bcg: { movement_stable_band_pct: 10 } },
  products: [row(1, {}), row(2, {}), { ...row(3, { company: 'Tika', productCompanyKey: 'Tika|3' }), odooUrl: url(3, 3) }],
  totals: { value: 300, lines: 3, volumeByUom: [] }, intercompanyValue: 0, profitAccess: true, statusSummaryError: null,
  statusSummary: {
    total: 12,
    active: { count: 4, units: 60, value: 300 },
    nonActive: { count: 5, withStock: 2, zeroStock: 3, stockUnits: 10, stockValue: 25 },
    dormant: { count: 2 },
    unclassified: { count: 1 },
    bcg: {
      classes: [
        { key: 'Stars', count: 3, units: 60, value: 300, profit: 120 },
        { key: 'Cash Cows', count: 0, units: 0, value: 0, profit: 0 },
        { key: 'Strategic', count: 1, units: 0, value: 0, profit: 0 },
        { key: 'Dogs', count: 0, units: 0, value: 0, profit: 0 },
      ],
      missingCost: 1,
    },
  },
};

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), useParams: () => ({ brand: 'stonewrap' }), useSearchParams: () => new URLSearchParams() }));
// profit access can be switched off per test (a user without View on profit_data, whose API response has no profit fields)
const access = vi.hoisted(() => ({ profit: true }));
const workbooks = vi.hoisted(() => [] as { fileName: string; sheets: { name: string; headers: string[]; rows: unknown[][] }[] }[]);
vi.mock('../../../../lib/AuthProvider', () => ({
  useAuth: () => ({ user: null, token: 't', error: null, retryAuth: () => {}, logout: () => {}, isSalesperson: false, canView: () => true,
    can: (page: string) => page !== 'profit_data' || access.profit }),
}));
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
  useProductDashboard: () => ({ data: access.profit ? OVERVIEW : withoutProfit(OVERVIEW), loading: false, error: null, retry: () => {} }),
  useRefreshStatus: () => ({ data: null, loading: false, error: null }),
  // SKU Trend section (2026-11-16): not under test here
  useSkuTrend: () => ({ data: null, loading: true, error: null, retry: () => {} }),
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
  useCanExport: () => true,
  exportSheetsAsXlsx: async (o: { fileName: string; sheets: { name: string; headers: string[]; rows: unknown[][] }[] }) => {
    workbooks.push(o);
  },
}));

afterEach(() => {
  cleanup();
  access.profit = true;
  workbooks.length = 0;
});

describe('Product tables use the standard grid, volume first, and every product opens in Odoo', () => {
  it('BCG Matrix: Product Detail grid + class panels link each product to its own company in Odoo', () => {
    render(<BcgMatrixPage />);
    const grid = screen.getByTestId('data-grid');
    expect(grid.getAttribute('data-file')).toBe('bcg-matrix-product-detail');
    expect(grid.getAttribute('data-headers')!.split('|').slice(0, 4)).toEqual(['Product Name', 'Status', 'Volume', 'Volume prior period']);
    expect(grid.getAttribute('data-headers')).toMatch(/Vol Growth\|Quantity On Hand/); // Quantity On Hand right after the growth columns
    expect(grid.getAttribute('data-headers')).toMatch(/\|Vendor\|BCG Class\|/);
    expect(grid.getAttribute('data-headers')).toMatch(/\|Profit\|GP%\|Cost data$/); // profit access (this user)
    expect(within(grid).getByRole('link', { name: /P3/ }).getAttribute('href')).toBe(url(3, 3)); // Tika product -> Tika company
    // the Stars panel (a ranked visual, not a grid) links too
    const links = screen.getAllByRole('link', { name: /P1/ }).map((a) => a.getAttribute('href'));
    expect(links).toContain(url(1, 1));
  });

  it('BCG Matrix (round 2): 4 classes only, no thresholds anywhere, shared KPI cards, Product Detail full width under Product Movement', () => {
    const { container } = render(<BcgMatrixPage />);
    // one short line per class (2026-11-15: the advice moved to the manual)
    expect(screen.getByTestId('bcg-class-definition-Stars').textContent).toBe('High volume · high margin');
    expect(screen.getByTestId('bcg-class-definition-Dogs').textContent).toBe('Low volume · low margin');
    expect(container.textContent).not.toMatch(/3,500|25,000|35%|≥|Not classified|not classified/);
    // 2x2: STARS | CASH COWS / STRATEGIC | DOGS
    expect([...screen.getByTestId('bcg-class-grid').querySelectorAll('[data-testid^="bcg-class-card-"]')].map((e) => e.getAttribute('data-testid')))
      .toEqual(['bcg-class-card-Stars', 'bcg-class-card-Cash Cows', 'bcg-class-card-Strategic', 'bcg-class-card-Dogs']);
    // 3 rows: Total SKUs (full-width hero, 2026-11-15) · Product Status (4 clickable cards) · BCG Matrix of the Active products
    const kpis = screen.getByTestId('bcg-kpis');
    const row = (id: string) => [...kpis.querySelector(`section[aria-labelledby="${id}"] > div`)!.children];
    const labels = (id: string) => row(id).map((tile) => tile.getAttribute('aria-label'));
    expect([...kpis.querySelectorAll('h2')].map((h) => h.textContent?.trim())).toEqual(['Total SKUs', 'Product Status', 'BCG Summary']);
    expect(screen.getByTestId('total-skus-value').textContent).toBe('12');
    expect([...screen.getByTestId('total-skus-chips').querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['Active 4', 'Non Active 5', 'Dormant 2', 'Unclassified 1']);
    expect(screen.getByTestId('total-skus-hero').textContent).toMatch(/Active \+ archived, every category/);
    expect(labels('row-product-status')).toEqual(['Active 4: list the products', 'Non Active 5: list the products', 'Dormant 2: list the products', 'Unclassified 1: list the products']);
    expect(row('row-product-status').map((t) => t.getAttribute('role'))).toEqual(['link', 'link', 'link', 'link']);
    expect(row('row-product-status').map((t) => t.querySelector('[aria-label]')?.getAttribute('aria-label')))
      .toEqual(['Active · Units sold and in stock', 'Non Active · Units sold but not in stock, OR in stock but not sold',
        'Dormant · archived, or no stock and no sales', 'Unclassified · SKUs not for sale']);
    // every status card: quantity on hand · its value (2026-11-16); the old breakdown is the card's hover
    for (const tile of row('row-product-status')) expect(tile.textContent).toMatch(/[0-9.,]+[KM]? Unit · LYD [0-9.,]+[KM]?/);
    expect(row('row-product-status')[1].getAttribute('title')).toBe('Non Active: 2 in stock but not sold · 3 sold but not in stock');
    // the BCG cards carry their quadrant definition, the same words as the class panels (2026-11-15)
    expect(row('row-bcg').map((t) => t.querySelector('[data-testid="kpi-tile-footnote"]')?.textContent))
      .toEqual(['High volume · high margin', 'High volume · low margin', 'Low volume · high margin', 'Low volume · low margin']);
    expect(labels('row-bcg')).toEqual(['Stars', 'Cash Cows', 'Strategic', 'Dogs']);
    expect(row('row-bcg')[0].textContent).toMatch(/profit LYD/); // profit access (this user)
    expect(row('row-bcg')[0].textContent).toMatch(/ · ASP (LYD [0-9,]+\.[0-9]{2}|–)/); // class ASP = value ÷ units, 2 decimals (2026-11-16)
    // the missing-cost note is an admin-only data quality row (2026-11-15): not for this (non-admin) user
    expect(screen.queryByTestId('bcg-data-quality')).toBeNull();
    expect(container.textContent).not.toMatch(/missing cost|no cost in Odoo/);
    expect(screen.getByTestId('period-note').textContent).toMatch(/^Last 12 Months · 7 Nov 2025 – 7 Nov 2026/);
    expect(container.textContent).not.toMatch(/YTD|Year to Date/);
    expect(screen.queryByText(/axes|Export image/)).toBeNull();
    expect(screen.getByText('Export BCG')).toBeTruthy();
    expect(container.textContent).not.toMatch(/median|Cannot classify|Insufficient comparison|unstable/i);
    const text = container.textContent ?? '';
    expect(text.indexOf('Product Movement')).toBeLessThan(text.lastIndexOf('Product Detail')); // the card (the note also says "Product Detail")
    // neither card shares a row with the other (no two-column grid around them)
    const grid = screen.getByTestId('data-grid');
    const sharedRow = [...container.querySelectorAll<HTMLElement>('div')].find((d) => d.style.gridTemplateColumns && d.contains(grid));
    expect(sharedRow).toBeUndefined();
  });

  it('BCG Matrix without profit access: no profit, GP% or missing-cost anywhere, the class stays', () => {
    access.profit = false;
    const { container } = render(<BcgMatrixPage />);
    const headers = screen.getByTestId('data-grid').getAttribute('data-headers')!;
    expect(headers).not.toMatch(/Profit|GP%|Cost data/);
    expect(headers).toMatch(/BCG Class/);
    expect(container.textContent).not.toMatch(/\bprofit\b|GP%|missing cost/i); // ('profitability' in the class actions is advice, not data)
    expect(screen.getByTestId('bcg-kpis').textContent).toMatch(/Stars/);
  });

  it('Export BCG: one workbook, a Summary sheet + one sheet per class with every Active + Non Active product; profit columns only with access', async () => {
    const run = async () => {
      render(<BcgMatrixPage />);
      fireEvent.click(screen.getByText('Export BCG'));
      await vi.waitFor(() => expect(workbooks).toHaveLength(1));
      const wb = workbooks.pop()!;
      cleanup();
      return wb;
    };
    const full = await run();
    expect(full.fileName).toBe('bcg-matrix');
    expect(full.sheets.map((sh) => sh.name)).toEqual(['Summary', 'Stars', 'Cash Cows', 'Strategic', 'Dogs']);
    expect(full.sheets[0].headers).toEqual(['Class', 'Products', 'Volume (Unit)', 'Value (LYD)', 'Profit (LYD)']);
    expect(full.sheets[0].rows.map((r) => r[0])).toEqual(['Stars', 'Cash Cows', 'Strategic', 'Dogs', 'Total (Active + Non Active)', undefined, 'Period', 'Compared with', 'Company filter']);
    const meta = Object.fromEntries(full.sheets[0].rows.filter((r) => typeof r[0] === 'string' && r.length === 2).map((r) => [r[0], r[1]]));
    expect(meta).toEqual({ Period: 'Last 12 Months · 7 Nov 2025 – 7 Nov 2026', 'Compared with': '6 Nov 2024 – 6 Nov 2025', 'Company filter': 'Majaal + Tika' });
    expect(full.sheets[1].headers).toEqual(['Product', 'Vendor', 'Class', 'Value (LYD)', 'Volume (Unit)', 'Volume prior period (Unit)', 'Growth %', 'Qty on hand (Unit)', 'Profit (LYD)', 'GP%', 'Missing cost data']);
    expect(full.sheets[1].rows).toHaveLength(3); // every Stars product (the panel shows the top 10)
    access.profit = false;
    const plain = await run();
    expect(plain.sheets[0].headers).toEqual(['Class', 'Products', 'Volume (Unit)', 'Value (LYD)']);
    expect(plain.sheets[1].headers).toEqual(['Product', 'Vendor', 'Class', 'Value (LYD)', 'Volume (Unit)', 'Volume prior period (Unit)', 'Growth %', 'Qty on hand (Unit)']);
    expect(JSON.stringify(plain)).not.toMatch(/Profit|GP%|Missing cost|3,500|35%/);
  });

  it('Product Lifecycle: Product Detail is the standard grid, volume first', () => {
    render(<ProductLifecyclePage />);
    const grid = within(screen.getByTestId('lifecycle-product-grid')).getByTestId('data-grid');
    expect(grid.getAttribute('data-headers')!.split('|').slice(0, 3)).toEqual(['Product Name', 'Volume (Last 12 months)', 'Volume vs prior 12 months']);
    expect(within(grid).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([url(3, 3), url(2, 1), url(1, 1)]); // highest volume first
  });

  it('Product Lifecycle (2026-11-15): a "?" on every KPI card, Freshness over Active + Non Active, segment definitions', () => {
    render(<ProductLifecyclePage />);
    for (const label of ['Mature SKUs', 'Discontinued', 'Portfolio Freshness']) {
      const card = screen.getByLabelText(label, { selector: '[aria-label]:not(button)' });
      expect(within(card).getByTestId('visual-help'), label).toBeTruthy();
    }
    // Company = All: one line per company against its own target (2026-11-15), never one blended number; none New here
    const fresh = screen.getByTestId('freshness-by-company');
    expect(within(fresh).getAllByTestId(/^freshness-(Majaal|Tika)$/).map((e) => e.textContent?.split('%')[0])).toEqual(['Majaal0.0', 'Tika0.0']);
    const defs = screen.getByTestId('lifecycle-segment-definitions');
    expect([...defs.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['New', 'Growing', 'Mature', 'Declining', 'Discontinued', 'Never sold']);
    expect(defs.textContent).toMatch(/First sale ≤ 180 d/);
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

  it('PIM Contribution (2026-11-15): no Categories donut; the Category filter and the hierarchy donut stay', () => {
    const { container } = render(<PimContributionPage />);
    expect(screen.queryByTestId('pim-categories-donut')).toBeNull();
    expect(container.textContent).not.toMatch(/Top \d+ categories|Other \(\+\d+\)/);
    expect(screen.queryByText('Categories')).toBeNull();
    expect(screen.getByText('Product Hierarchy Contribution')).toBeTruthy();
    expect(screen.getByText('Average Selling Price (ASP)')).toBeTruthy();
    // one By Volume / By Value toggle left: the hierarchy's
    expect(screen.getAllByText('By Volume (Unit)')).toHaveLength(1);
  });

  it('Brand page lists every product with its own Brand column (a card can group several vendors)', () => {
    render(<BrandPage />);
    const grid = within(screen.getByTestId('brand-product-table')).getByTestId('data-grid');
    expect(grid.getAttribute('data-headers')!.split('|')).toContain('Brand');
  });
});
