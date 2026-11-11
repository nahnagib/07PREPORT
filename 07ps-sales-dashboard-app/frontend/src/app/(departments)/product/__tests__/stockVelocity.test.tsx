import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProductDashboardOverview, ProductDashboardRow } from '../../../../lib/api';
import StockVelocityPage from '../stock-velocity/page';

const THRESHOLDS = {
  days_of_inventory: { lookback_days: 90, overstock_days: { Majaal: 180, Tika: 60, Athena: 180 }, stockout_risk_days: { Majaal: 60, Tika: 30 } },
  stock: {
    isr_target_pct: 15, isr_red_pct: 25, fast_mover_vs_category_median_pct: 150, slow_mover_vs_category_median_pct: 50,
    aging_buckets: [{ key: '0_90', label: '0–90 days', max_days: 90 }, { key: '91_180', label: '91–180 days', max_days: 180 }, { key: '181_365', label: '181–365 days', max_days: 365 }, { key: '1_2y', label: '1–2 years', max_days: 730 }, { key: '2y_plus', label: '> 2 years', max_days: null }],
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
PRODUCTS[0] = { ...PRODUCTS[0], stockQty: 50, stockValue: 30, onHandQty: 50, onHandValue: 30,
  agingBuckets: [{ key: '0_90', label: '0–90 days', qty: 40, value: 24 }, { key: '91_180', label: '91–180 days', qty: 10, value: 6 }], daysOfInventory: 300, stockBand: 'Overstock', stockAgeDays: 40, stockAgeBucket: '0–90 days' };
PRODUCTS[1] = { ...PRODUCTS[1], stockQty: 20, stockValue: 30, onHandQty: 20, onHandValue: 30, daysOfInventory: 20, stockBand: 'StockOutRisk', stockAgeDays: 800, stockAgeBucket: '> 2 years' };
PRODUCTS[2] = { ...PRODUCTS[2], stockQty: 10, stockValue: 40, onHandQty: 10, onHandValue: 40, daysOfInventory: 100, stockAgeDays: 200, stockAgeBucket: '181–365 days' };
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
  ProductBarChart: ({ rows, tooltip }: { rows: { id: string; name: string; href?: string | null }[]; tooltip?: (r: unknown) => React.ReactNode }) => (
    <>
      <ul data-testid="product-bars">{rows.map((r) => <li key={r.id}>{r.href ? <a href={r.href}>{r.name}</a> : r.name}</li>)}</ul>
      {tooltip && rows[0] ? <div data-testid="bar-tooltip">{tooltip(rows[0])}</div> : null}
    </>
  ),
}));
const csvCalls = vi.hoisted(() => [] as { fileName: string; headers: string[]; rows: unknown[]; values: unknown[][] }[]);
vi.mock('../../../../components/product/ProductUi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../components/product/ProductUi')>();
  return {
    ...actual,
    exportProductCsv: async (fileName: string, columns: { header: string; value: (r: unknown) => unknown }[], rows: unknown[]) => {
      csvCalls.push({ fileName, headers: columns.map((c) => c.header), rows, values: rows.map((r) => columns.map((c) => c.value(r))) });
    },
  };
});
// the four inventory exports (InventoryVisual): file name, columns, rows, summary section
const invCsv = vi.hoisted(() => [] as { fileName: string; headers: string[]; rows: unknown[]; values: unknown[][]; summary?: { title: string; headers: string[]; rows: unknown[][] } }[]);
vi.mock('../../../../components/product/InventoryVisual', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../components/product/InventoryVisual')>();
  return {
    ...actual,
    exportInventoryCsv: async (fileName: string, columns: { header: string; value: (r: unknown) => unknown }[], rows: unknown[], summary?: { title: string; headers: string[]; rows: unknown[][] }) => {
      invCsv.push({ fileName, headers: columns.map((c) => c.header), rows, values: rows.map((r) => columns.map((c) => c.value(r))), summary });
    },
    exportInventoryPdf: async () => {},
  };
});
vi.mock('../../../../components/product/useProductFilters', () => ({
  useProductFilters: () => ({ anchorDate: '2026-11-07', onAnchorDateChange: () => {}, scope: {}, companyLabel: 'Majaal', filterBarProps: {}, withLocalReset: () => ({}) }),
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
  it('6 KPI cards in order (no ISR card), plain sub-lines; Total Value in LYD at cost', () => {
    render(<StockVelocityPage />);
    const kpis = screen.getByTestId('stock-velocity-kpis');
    const labels = [...kpis.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).filter((l) => !String(l).startsWith('About'));
    expect(labels).toEqual(['DOH – Avg Days of Inventory', 'Overstocked SKUs', 'Stock-Out Risk SKUs', 'Fast Movers', 'SKUs in Stock', 'Total Value']);
    expect(within(kpis).queryByText(/ISR/)).toBeNull();
    expect(within(kpis).getByText('Based on the last 90 days of sales')).toBeTruthy();
    expect(within(kpis).getByText('In finished-goods locations')).toBeTruthy();
    expect(within(kpis).getByText('Out of 6 SKUs sold in the period')).toBeTruthy();
    expect(within(kpis).getByText('LYD 100')).toBeTruthy(); // 30 + 30 + 40 LYD at cost
    expect(within(kpis).getByText('80 Units finished goods · 0 Units in transit')).toBeTruthy();
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
    expect(screen.getByText("6 SKUs sold in the period, by Sales Velocity against their category's median")).toBeTruthy();
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
    expect(grid.getAttribute('data-headers')!.split('|').slice(0, 2)).toEqual(['Product', 'Quantity Sold']);
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

  // ---- one design for the four inventory visuals (2026-11-11) ----
  const STANDARD_HOVER = ['Quantity On Hand', 'Total Value', 'Days on Hand (DOH)', 'Stock Age (days)', 'Sales Velocity', 'Quantity Sold', 'Sales Value'];
  const STANDARD_COLUMNS = ['Product ID', 'Product name', 'Company', 'BCG Class', 'Quantity On Hand (Units)', 'Total Value (LYD)', 'DOH (days)',
    'Stock Age (days)', 'Sales Velocity (Unit/day)', 'Quantity Sold (Units)', 'Sales Value (LYD)'];
  const hoverLabels = () => {
    const tip = screen.getByTestId('bar-tooltip');
    return [...within(tip).getByTestId('inventory-hover').querySelectorAll('div > span:first-child')].map((e) => e.textContent);
  };
  const openHover: Record<string, () => void> = {
    movers: () => fireEvent.click(within(screen.getByTestId('movers-share-bar')).getByLabelText('Slow movers: 1 SKUs (16.7%)')),
    aging: () => fireEvent.click(within(screen.getByTestId('aging-share-bar')).getByLabelText('0–90 days: 1 SKUs (33.3%)')),
    overstock: () => fireEvent.click(screen.getAllByTestId('bar').find((b) => b.textContent === 'Dogs: 1')!),
    // the Stock-Out bar list is rendered after the Overstock one
    stockOut: () => fireEvent.click(screen.getAllByTestId('bar').filter((b) => b.textContent === 'Dogs: 1').at(-1)!),
  };

  it('the four inventory hovers show the same fields, in the same order, with the same labels; Movers shows Quantity On Hand', () => {
    const extras: Record<string, string[]> = {
      movers: ['Mover Group', 'Category Median Velocity'],
      aging: ['Aging Bucket'],
      overstock: ['Excess quantity / value'],
      stockOut: ['Risk level / days until stock-out'],
    };
    // P5 (50 units sold, above the median) runs out: 5 finished-goods units, DOH 10 -> a Stock-Out Risk product
    const saved = PRODUCTS[4];
    for (const [visual, extra] of Object.entries(extras)) {
      if (visual === 'stockOut') {
        PRODUCTS[4] = { ...saved, stockQty: 5, stockValue: 5, onHandQty: 5, onHandValue: 5, daysOfInventory: 10, stockBand: 'StockOutRisk', stockAgeDays: 3, stockAgeBucket: '0–90 days' };
      }
      try {
        render(<StockVelocityPage />);
        openHover[visual]();
        expect(hoverLabels(), visual).toEqual([...STANDARD_HOVER, ...extra]);
        const badges = within(screen.getByTestId('bar-tooltip')).getByTestId('product-tooltip-badges').textContent;
        expect(badges, visual).toBe('MajaalDogs');
        if (visual === 'stockOut') expect(screen.getByTestId('bar-tooltip').textContent).toContain('High · 10 days');
      } finally {
        PRODUCTS[4] = saved;
        cleanup();
      }
    }
    // Movers: Quantity On Hand of P1 (50 Units), its category median velocity (3.5 Unit/day)
    render(<StockVelocityPage />);
    openHover.movers();
    const text = screen.getByTestId('bar-tooltip').textContent ?? '';
    expect(text).toContain('Quantity On Hand50 Units');
    expect(text).toContain('Category Median Velocity3.50 Unit/day');
    expect(text).toContain('Mover GroupSlow');
  });

  it('a product with no sale and no stock shows "–" with the same reasons on every field', async () => {
    const { inventoryFields, bcgClassName } = await vi.importActual<typeof import('../../../../components/product/InventoryVisual')>('../../../../components/product/InventoryVisual');
    const fact = { onHandQty: 0, onHandValue: 0, stockQty: 0, daysOfInventory: null, stockAgeDays: null, velocity: 0, volume: 0, value: 0 } as never;
    expect(inventoryFields(fact).map((f) => f.value)).toEqual(['0 Units', 'LYD 0', '– No stock', '– No stock', '– No sales in period', '– No sales in period', '– No sales in period']);
    expect(bcgClassName(null)).toBe('Not classified (no sales in period)');
    // the BCG Matrix's own class names everywhere (threshold class of the ETL)
    expect(['Stars', 'Cash Cows', 'Strategic', 'Dogs', 'Unclassified (no cost)'].map(bcgClassName)).toEqual(['Stars', 'Cash Cows', 'Strategic', 'Dogs', 'Not classified (no profit data)']);
  });

  it('Export movers data: every SKU of the visual, the standard columns, the mover columns and the group summary', async () => {
    invCsv.length = 0;
    render(<StockVelocityPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Export all movers data as CSV' }));
    await vi.waitFor(() => expect(invCsv).toHaveLength(1));
    const [csv] = invCsv;
    expect(csv.fileName).toBe('fast_slow_movers_majaal_2026-10-08_2026-11-07');
    expect(csv.headers).toEqual([...STANDARD_COLUMNS, 'Category Median Velocity (Unit/day)', 'Mover Group']);
    expect(csv.rows).toHaveLength(6);                                   // every SKU sold in the period, not a drilled group
    const p1 = csv.values.find((v) => v[0] === '1')!;
    expect(p1.slice(4, 11)).toEqual([50, 30, 300, 40, 1, 10, 100]);
    expect(p1.slice(11)).toEqual([3.5, 'Slow']);
    expect(csv.summary!.headers).toEqual(['Mover Group', 'SKUs', '% of SKUs', 'Quantity On Hand (Units)', 'Total Value (LYD)', 'Quantity Sold (Units)']);
    expect(csv.summary!.rows).toEqual([['Fast', 1, 16.7, 0, 0, 60], ['Normal', 4, 66.7, 30, 70, 140], ['Slow', 1, 16.7, 50, 30, 10], ['Total', 6, 100, 80, 100, 210]]);
  });

  it('the four exports share the 11 standard columns in the same order, then their own columns; each card has its button', async () => {
    invCsv.length = 0;
    render(<StockVelocityPage />);
    for (const name of ['movers', 'aging', 'overstock', 'stock-out']) {
      fireEvent.click(screen.getByRole('button', { name: `Export all ${name} data as CSV` }));
      expect(screen.getByRole('button', { name: `Export all ${name} data as CSV` }).textContent).toBe(`Export ${name} data`);
      expect(screen.getByRole('button', { name: `Export all ${name} data as PDF` })).toBeTruthy();
    }
    await vi.waitFor(() => expect(invCsv).toHaveLength(4));
    const byName = Object.fromEntries(invCsv.map((c) => [c.fileName.split('_majaal_')[0], c]));
    expect(Object.keys(byName).sort()).toEqual(['fast_slow_movers', 'overstock', 'stock_aging', 'stock_out_risk']);
    for (const c of invCsv) expect(c.headers.slice(0, 11), c.fileName).toEqual(STANDARD_COLUMNS);
    expect(byName.stock_aging.headers[11]).toBe('Aging Bucket');
    expect(byName.overstock.headers.slice(11)).toEqual(['Excess Quantity (Units)', 'Excess Value (LYD)']);
    expect(byName.stock_out_risk.headers.slice(11)).toEqual(['Risk Level', 'Days Until Stock-Out']);
  });

  it('Export aging data: every product on hand, the bucket split by receipt layer, then the bucket totals in one file', async () => {
    invCsv.length = 0;
    render(<StockVelocityPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Export all aging data as CSV' }));
    await vi.waitFor(() => expect(invCsv).toHaveLength(1));
    const [data] = invCsv;
    expect(data.fileName).toBe('stock_aging_majaal_2026-10-08_2026-11-07');
    expect(data.headers).toContain('Quantity On Hand 0–90 days (Units)');
    expect(data.headers).toContain('Total Value > 2 years (LYD)');
    expect(data.rows).toHaveLength(3); // every product on hand, not only a drilled bucket
    const p1 = data.values.find((v) => v[0] === '1')!;
    expect(p1[data.headers.indexOf('Quantity On Hand 0–90 days (Units)')]).toBe(40);
    expect(p1[data.headers.indexOf('Quantity On Hand 91–180 days (Units)')]).toBe(10);
    expect(data.summary!.rows.at(-1)).toEqual(['Total', 3, 80, 100]);
    expect(data.summary!.rows[0]).toEqual(['0–90 days', 1, 40, 24]);
  });

  it('no old inventory wording is left on the page', () => {
    const { container } = render(<StockVelocityPage />);
    expect(screen.getAllByTestId('share-legend').length).toBe(4); // Movers, Aging, Overstock, Stock-Out: one legend format
    openHover.aging();
    const text = container.textContent ?? '';
    for (const old of ['Stock value', 'Units on hand', 'Volume (period)', 'Value (period)', 'Stock aging', 'Units sold', 'Revenue (period)']) {
      expect(text, old).not.toContain(old);
    }
    expect(text).not.toMatch(/(^|[^s] )Velocity/); // only "Sales Velocity" / "Category Median Velocity"
  });
});
