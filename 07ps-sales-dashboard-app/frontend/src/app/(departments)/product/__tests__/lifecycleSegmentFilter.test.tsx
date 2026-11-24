import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProductDashboardOverview, ProductDashboardRow } from '../../../../lib/api';
import ProductLifecyclePage from '../product-lifecycle/page';

/**
 * Product Lifecycle: a click on a Pareto segment (bar / axis label, legend item, pill) filters every other visual -- KPI
 * cards, Product Detail grid and its export summary -- while the Pareto keeps all its bars and highlights the selection.
 * Ctrl / Cmd adds segments; the selection is a filter bar chip (badge + Reset) and the URL's ?segment=. Recharts draws
 * nothing in jsdom, so the shared ComboChart / FilterBar / DataGrid are replaced by recorders.
 */

const row = (id: number, lifecycleSegment: ProductDashboardRow['lifecycleSegment'], volume: number): ProductDashboardRow => ({
  productCompanyKey: `Majaal|${id}`, productKey: String(id), odooUrl: null, productTemplateId: id, company: 'Majaal', productName: `P${id}`,
  odooProductName: `P${id}`, category: 'Tiles', brand: null, subBrand: null, family: null, size: null, sku: null, isActive: 1,
  companies: ['Majaal'], parts: [], value: volume * 10, volume, volumeByUom: [], uom: 'Unit', lines: 1, orderDays: 3, velocity: 1, valuePrior: 50,
  volumePrior: 5, avgUnitPrice: 10, stockQty: 0, stockValue: 0, inTransitQty: 0, inTransitValue: 0, avgDailySales: 0, daysOfInventory: null,
  stockBand: 'Normal', stockAgeDays: null, stockAgeBucket: null, onHandQty: 0, onHandValue: 0, stockAgeOldestDays: null, stockAgeSource: null,
  agingBuckets: [], lifecycleSegment, firstSaleDate: '2024-01-01', lastSaleDate: lifecycleSegment === 'Discontinued' ? '2025-01-01' : '2026-11-01',
  productStatus: 'Active', bcgClass: 'Stars', bcgVolume: null, bcgValue: null, bcgDataAsOf: null, bcgMovement: null, bcgExcludedCategory: false,
  negativeStockRows: 0,
} as ProductDashboardRow);

const overview = (products: ProductDashboardRow[], label: string, priorLabel: string): ProductDashboardOverview => ({
  view: 'BMH', asOfDate: '2026-11-24', builtAtUtc: null,
  period: { from: '2025-11-24', to: '2026-11-24', days: 366, priorFrom: '2024-11-23', priorTo: '2025-11-23', isDefault: true, label: 'Last 12 Months' },
  lookbackDays: 90, thresholds: {}, products, totals: { value: 0, lines: 0, volumeByUom: [] }, intercompanyValue: 0, profitAccess: true,
  statusSummary: null, statusSummaryError: null,
  lifecycleBenchmark: { from: '', to: '', priorFrom: '', priorTo: '', days: 366, label, priorLabel, growthPct: 20, newDays: 180, noSalesDays: 365, asOf: '2026-11-24' },
} as unknown as ProductDashboardOverview);

// 12 months: 1, 2 Growing (100 + 50 units), 3 Mature, 4 Declining, 5 Discontinued
const TWELVE = overview([row(1, 'Growing', 100), row(2, 'Growing', 50), row(3, 'Mature', 30), row(4, 'Declining', 20), row(5, 'Discontinued', 0)], 'Last 12 months', 'Prior 12 months');
// the last 90 days re-classify: only 3 is Growing
const NINETY = overview([row(1, 'Mature', 25), row(2, 'Declining', 5), row(3, 'Growing', 12), row(4, 'Declining', 4), row(5, 'Discontinued', 0)], 'Last 90 days', 'Prior 90 days');

const h = vi.hoisted(() => ({ data: null as unknown, combo: [] as Record<string, any>[], bar: [] as Record<string, any>[], grid: [] as Record<string, any>[], reset: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('../../../../lib/AuthProvider', () => ({
  useAuth: () => ({ user: null, token: 't', error: null, retryAuth: () => {}, logout: () => {}, isSalesperson: false, canView: () => true, can: () => true }),
}));
vi.mock('../../../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../../../components/BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../../../components/ValidationStatusBar', () => ({ ValidationStatusBar: () => null }));
vi.mock('../../../../components/RefreshFooter', () => ({ RefreshFooter: () => null }));
vi.mock('../../../../components/AuthGuard', () => ({ PermissionGuard: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../../components/FilterBar', () => ({
  FilterBar: (p: Record<string, any>) => {
    h.bar.push(p);
    return (
      <div data-testid="bar">
        <span data-testid="badge">{p.extraActiveCount ?? 0}</span>
        {(p.chips ?? []).map((c: { key: string; label: string; onRemove: () => void }) => <button key={c.key} type="button" onClick={c.onRemove}>{`${c.label} ✕`}</button>)}
        <button type="button" onClick={p.onReset}>Reset filters</button>
      </div>
    );
  },
}));
vi.mock('../../../../components/product/useProductFilters', () => ({
  useProductFilters: () => ({
    anchorDate: '2026-11-24', onAnchorDateChange: () => {}, scope: {}, companyLabel: 'Majaal + Tika', filterBarProps: {},
    withLocalReset: (resetLocal: () => void, localPristine: boolean) => ({ onReset: () => { h.reset(); resetLocal(); }, isPristine: localPristine }),
  }),
}));
vi.mock('../../../../lib/hooks', () => ({
  useProductDashboard: () => ({ data: h.data, loading: false, error: null, retry: () => {} }),
  useRefreshStatus: () => ({ data: null, loading: false, error: null }),
}));
vi.mock('@07ps/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@07ps/ui')>()),
  ComboChart: (p: Record<string, any>) => { h.combo.push(p); return <div data-testid="combo" />; },
  DataGrid: (p: Record<string, any>) => { h.grid.push(p); return <div data-testid="grid">{p.rows.map((r: { id: string }) => r.id).join(',')}</div>; },
}));

const lastCombo = () => h.combo[h.combo.length - 1];
const lastGrid = () => h.grid[h.grid.length - 1];
const gridIds = () => screen.getByTestId('grid').textContent;
const click = (label: string, additive = false) => act(() => lastCombo().onCategoryClick(label, { additive }));

afterEach(() => {
  cleanup();
  h.combo.length = 0; h.bar.length = 0; h.grid.length = 0; h.reset.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('Product Lifecycle: Pareto click filters the page', () => {
  it('one segment: the grid, cards and summary show only it; the Pareto keeps every bar and highlights it', () => {
    h.data = TWELVE;
    render(<ProductLifecyclePage />);
    expect(lastCombo().points.map((p: { label: string }) => p.label)).toEqual(['Growing', 'Mature', 'Declining', 'Discontinued']);
    expect(lastCombo().clickableAxisLabels).toBe(true);
    click('Growing');
    expect(gridIds()).toBe('Majaal|1,Majaal|2');
    // the totals = the Growing bar: 2 SKUs, 150 units
    const growingBar = lastCombo().points.find((p: { label: string }) => p.label === 'Growing');
    expect(growingBar.units).toBe(150);
    expect(screen.getByTestId('lifecycle-detail-summary').textContent).toContain('2 SKUs · 150 units · Segment: Growing');
    expect(lastCombo().points).toHaveLength(4); // the Pareto never filters itself
    expect(lastCombo().highlightedCategories).toEqual(['Growing']);
    expect(screen.getByLabelText('Mature SKUs', { selector: '[aria-label]:not(button)' }).textContent).toMatch(/^0/);
    expect(screen.getByLabelText('Discontinued', { selector: '[aria-label]:not(button)' }).textContent).toMatch(/^0/);
    expect(lastGrid().filtersSummary).toContain('Segment: Growing');
    expect(window.location.search).toBe('?segment=growing');
    expect(screen.getByTestId('badge').textContent).toBe('1');
    expect(screen.getByRole('button', { name: 'Segment: Growing ✕' })).toBeTruthy();
  });

  it('Ctrl / Cmd + click adds and removes; a plain click on the only selection clears it', () => {
    h.data = TWELVE;
    render(<ProductLifecyclePage />);
    click('Growing');
    click('Declining', true);
    expect(gridIds()).toBe('Majaal|1,Majaal|2,Majaal|4');
    expect(window.location.search).toBe('?segment=growing,declining');
    expect(screen.getByRole('button', { name: 'Segment: Growing, Declining ✕' })).toBeTruthy();
    click('Growing', true);
    expect(gridIds()).toBe('Majaal|4');
    click('Declining');
    expect(gridIds()).toBe('Majaal|1,Majaal|2,Majaal|3,Majaal|4,Majaal|5');
    expect(window.location.search).toBe('');
    expect(lastCombo().highlightedCategories).toEqual([]);
  });

  it('the legend item and the chip select / clear too; Reset filters clears the selection', () => {
    h.data = TWELVE;
    render(<ProductLifecyclePage />);
    fireEvent.click(screen.getByTestId('lifecycle-legend-Mature'));
    expect(gridIds()).toBe('Majaal|3');
    fireEvent.click(screen.getByTestId('lifecycle-legend-Discontinued'), { ctrlKey: true });
    expect(gridIds()).toBe('Majaal|3,Majaal|5');
    fireEvent.click(screen.getByRole('button', { name: 'Segment: Mature, Discontinued ✕' }));
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByTestId('lifecycle-legend-Growing'));
    fireEvent.click(within(screen.getByTestId('bar')).getByRole('button', { name: 'Reset filters' }));
    expect(h.reset).toHaveBeenCalled();
    expect(gridIds()).toBe('Majaal|1,Majaal|2,Majaal|3,Majaal|4,Majaal|5');
    expect(screen.getByTestId('badge').textContent).toBe('0');
  });

  it('reads the selection from the URL and keeps it when the date range changes (rows re-classified by the API)', () => {
    window.history.replaceState(null, '', '/?segment=growing');
    h.data = TWELVE;
    const { rerender } = render(<ProductLifecyclePage />);
    expect(gridIds()).toBe('Majaal|1,Majaal|2');
    h.data = NINETY; // the Date filter moved to the last 90 days: the API answers with the new segments
    rerender(<ProductLifecyclePage />);
    expect(gridIds()).toBe('Majaal|3');
    expect(window.location.search).toBe('?segment=growing');
    expect(screen.getByTestId('lifecycle-detail-summary').textContent).toContain('1 SKUs · 12 units');
    expect(lastCombo().bars[0].name).toBe('Units sold (Last 90 days)');
  });
});
