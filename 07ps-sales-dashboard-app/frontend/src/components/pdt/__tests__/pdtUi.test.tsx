import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Product Development Plan dashboard (components/pdt): the KPI rows from the API (Total = In market + Active + Planned,
 * the status row, the "Health not set" note), every card / pipeline stage / family segment / year opening its details
 * table, the stage click filtering the page, the Brand filter in the shared filter bar, the 90-day roadmap, the two tabs
 * only, the gate screens Admin-only, the empty state. The charts are replaced by buttons that call the same callbacks
 * (Recharts draws nothing in jsdom).
 */

const { request, perms } = vi.hoisted(() => ({ request: vi.fn(), perms: { entry: true, admin: false } }));
vi.mock('../../../lib/AuthProvider', () => ({
  useAuth: () => ({
    token: 'test', user: { role: { label: 'Admin' }, fullName: 'Admin' }, logout: vi.fn(), error: null, retryAuth: vi.fn(), isAdmin: perms.admin,
    canView: (k: string) => k === 'product_development_plan' || (perms.entry && k === 'product_development_entry'),
    canEdit: (k: string) => perms.entry && k === 'product_development_entry',
    canCreate: (k: string) => perms.entry && k === 'product_development_entry',
    canDelete: () => false, canExport: () => true, can: () => true,
  }),
}));
vi.mock('../../../lib/pdp/api', async () => ({ ...(await vi.importActual('../../../lib/pdp/api')), pdp: request }));
vi.mock('../../AppHeader', () => ({ AppHeader: () => <header>header</header> }));
vi.mock('../../BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../TopTabBar', () => ({ TopTabBar: ({ tabs }: { tabs: { label: string }[] }) => <nav>{tabs.map((x) => x.label).join('|')}</nav> }));
vi.mock('../../../lib/hooks', () => ({ useRefreshStatus: () => ({ data: null }) }));
// The shared filter bar reads the app's FilterProvider; this page passes its own state (onReset / activeCount).
vi.mock('../../FilterProvider', () => ({
  useFilterState: () => ({ setOptionsDateMode: vi.fn(), setCustomerFilterEnabled: vi.fn(), resetFilters: vi.fn(), isAtDefaults: true }),
  useScopedFilterOptions: () => ({ businessUnits: { loading: false, data: [] }, customers: { data: [] } }),
}));
vi.mock('@07ps/ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@07ps/ui');
  type Point = { label: string; [k: string]: unknown };
  return {
    ...actual,
    GroupedBarChart: ({ points, bars, onCategoryClick, onBarClick, endLabel }: { points: Point[]; bars: { key: string }[]; onCategoryClick?: (l: string) => void; onBarClick?: (l: string, k: string) => void; endLabel?: (p: Point) => { text: string; badge?: string } }) => (
      <div>
        {points.map((p) => (
          <div key={p.label}>
            <button type="button" onClick={() => onCategoryClick?.(p.label)}>{`bar ${p.label}`}</button>
            {endLabel && <span>{`${endLabel(p).text}${endLabel(p).badge ? ` ${endLabel(p).badge}` : ''}`}</span>}
            {onBarClick && bars.filter((b) => Number(p[b.key]) > 0).map((b) => <button key={b.key} type="button" onClick={() => onBarClick(p.label, b.key)}>{`segment ${p.label} ${b.key}`}</button>)}
          </div>
        ))}
      </div>
    ),
  };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/product/product-development-plan' }));

import PdpPage from '../../pdp/PdpPage';

const dd = (list: string, code: string | null, label: string, color: string, sort: number, id: number) => ({ value_id: id, list_key: list, code, label, description: null, color, sort_order: sort, is_active: 1 });
const STAGE_ROWS = [
  dd('stage', 'IDEA', 'Idea', '#a3abb9', 1, 1), dd('stage', 'RESEARCH', 'Research', '#a99be0', 2, 2), dd('stage', 'DEVELOPMENT', 'Development', '#8a6fdf', 3, 3),
  dd('stage', 'TESTING', 'Testing', '#6a9fd8', 4, 4), dd('stage', 'LAUNCH_READY', 'Launch ready', '#5bb79a', 5, 5), dd('stage', 'LAUNCHED', 'Launched', '#2e9a73', 6, 6),
];
const OPTIONS = {
  dropdowns: [
    ...STAGE_ROWS,
    dd('health', 'ON_TRACK', 'On track', '#2e9a73', 1, 7), dd('health', 'AT_RISK', 'At risk', '#c4892f', 2, 8), dd('health', 'BLOCKED', 'Blocked', '#d0504a', 3, 9),
    dd('priority', 'HIGH', 'High', '#c4892f', 1, 10), dd('priority', 'MEDIUM', 'Medium', '#8a94a6', 2, 11), dd('priority', 'LOW', 'Low', '#8a94a6', 3, 12),
    dd('family', null, 'Tile Fixing', '#5b7fd6', 1, 21), dd('family', null, 'Waterproofing', '#3fa3c4', 2, 22),
    dd('project_type', 'PLANNED', 'Planned', '#8a94a6', 1, 31),
  ],
  settings: { staleDays: 14, roadmapMonths: 4, upcomingWindowDays: 90, followupDueSoonDays: 7, launchSoonDays: 30, launchSoonMinReadiness: 80 },
  users: [], owners: ['Omar Ali'], subfamilies: [{ familyId: 21, subfamily: 'Tile Adhesive' }], brands: ['Xtreme', 'Unassigned'], today: '2026-11-18',
};
const product = (code: string, name: string, family: [number, string], stage: string, health: string | null, readiness: number | null, target: string | null, actual: string | null = null, flag: string | null = null) => ({
  productId: Number(code.slice(3)), code, name, familyId: family[0], family: family[1], subfamily: 'Sub', brand: code === 'XT-011' ? 'Xtreme' : 'Unassigned', ownerUserId: null, ownerName: null, priority: null, stage, health,
  readinessPct: readiness, targetLaunch: target, actualLaunch: actual, projectType: 'PLANNED', nextStep: null, nextStepDue: null, healthReviewRequired: false,
  stageSince: '2026-11-18', lastUpdateAt: null, stale: false, openBlockers: 0, flag, flagLabel: flag === 'TARGET_PASSED' ? 'Target date passed' : flag === 'HEALTH_NOT_SET' ? 'Health not set' : null,
});
const TF: [number, string] = [21, 'Tile Fixing'];
const WP: [number, string] = [22, 'Waterproofing'];
const L1 = product('XT-001', 'XtraCol One', TF, 'LAUNCHED', 'ON_TRACK', 100, null, '2023-05-01');
const I1 = product('XT-009', 'Wide-Joint Grout', TF, 'IDEA', null, null, '2026-04-01', null, 'TARGET_PASSED');
const D1 = product('XT-011', 'MonoSeal', WP, 'DEVELOPMENT', null, null, '2027-01-10', null, 'HEALTH_NOT_SET');
const ALL = [L1, I1, D1];
const zero = { IDEA: 0, RESEARCH: 0, DEVELOPMENT: 0, TESTING: 0, LAUNCH_READY: 0, LAUNCHED: 0 };
const DASH = {
  today: '2026-11-18', settings: OPTIONS.settings, totalProducts: 3, lastImport: '2026-11-18T10:05:00Z',
  // XT-011 (Jan 2027) is Active and launches within 90 days; XT-009 (Apr 2026) is Planned, date passed.
  kpis: { total: 3, inMarket: 1, active: 1, planned: 1, plannedNoDate: 0, plannedBeyond: 0, plannedPassed: 1, onTrack: 0, needAttention: 0, upcomingLaunches: 1, healthNotSet: 2, targetPassed: 1 },
  kpiCodes: { total: ['XT-001', 'XT-009', 'XT-011'], inMarket: ['XT-001'], active: ['XT-011'], planned: ['XT-009'], onTrack: [], needAttention: [], upcomingLaunches: ['XT-011'], healthNotSet: ['XT-009', 'XT-011'] },
  stageSummary: {
    stages: STAGE_ROWS.map((d) => ({
      stage: d.code, label: d.label, color: d.color, count: ALL.filter((p) => p.stage === d.code).length,
      health: d.code === 'IDEA' ? { onTrack: 0, atRisk: 0, blocked: 0, notSet: 1 } : d.code === 'DEVELOPMENT' ? { onTrack: 2, atRisk: 1, blocked: 1, notSet: 1 } : { onTrack: d.code === 'LAUNCHED' ? 1 : 0, atRisk: 0, blocked: 0, notSet: 0 },
      avgReadiness: d.code === 'DEVELOPMENT' ? 48 : d.code === 'LAUNCHED' ? 100 : null,
      nextTarget: d.code === 'IDEA' ? '2026-04-01' : d.code === 'DEVELOPMENT' ? '2027-01-10' : null,
      nextTargetPassed: d.code === 'IDEA', overdue: d.code === 'IDEA' ? 1 : 0, blocked: d.code === 'DEVELOPMENT' ? 1 : 0,
    })),
    totals: { total: 3, inPipeline: 2, inMarket: 1 },
  },
  pipeline: STAGE_ROWS.map((d) => ({ stage: d.code, label: d.label, color: d.color, products: ALL.filter((p) => p.stage === d.code) })),
  matrix: {
    rows: [{ familyId: 21, family: 'Tile Fixing', counts: { ...zero, IDEA: 1, LAUNCHED: 1 }, total: 2 }, { familyId: 22, family: 'Waterproofing', counts: { ...zero, DEVELOPMENT: 1 }, total: 1 }],
    totals: { ...zero, IDEA: 1, DEVELOPMENT: 1, LAUNCHED: 1 }, total: 3,
  },
  tracker: ALL,
  roadmap: { months: [{ month: '2026-11', products: [] }, { month: '2026-12', products: [] }, { month: '2027-01', products: [{ code: 'XT-011', name: 'MonoSeal', family: 'Waterproofing', targetLaunch: '2027-01-10', health: null }] }, { month: '2027-02', products: [] }], outsideWindow: 1, windowEnd: '2027-02-16' },
  byYear: [2023, 2024, 2025, 2026, 2027, 2028].map((year) => ({ year, launched: year === 2023 ? 1 : 0, planned: year === 2026 ? 1 : year === 2027 ? 1 : 0 })),
  blockers: [],
};

function respond(dash: unknown) {
  request.mockImplementation(async (path: string) => {
    if (path.startsWith('/tracker/options')) return OPTIONS;
    if (path.startsWith('/tracker/dashboard')) return dash;
    if (path.startsWith('/tracker/products/')) {
      const p = ALL.find((x) => path.endsWith(x.code))!;
      return { product: { ...p, description: null, notes: null, comment: null }, history: [], updates: [], blockers: [], audit: { updatedAt: null, updatedBy: null, createdAt: null, createdBy: null, excelUpdatedOn: null, excelUpdatedBy: null } };
    }
    // The gate module's own data: only its request is checked here, so it stays pending (its screens are not rendered).
    if (path === '/options') return new Promise(() => undefined);
    throw new Error(`unexpected ${path}`);
  });
}

afterEach(() => {
  cleanup();
  request.mockReset();
  perms.entry = true;
  perms.admin = false;
  window.history.replaceState(null, '', '/');
});

describe('Product Development Plan dashboard', () => {
  it('shows the portfolio row that adds up, the status row, the health note and the 90-day roadmap', async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    const portfolio = await screen.findByTestId('pdt-kpi-portfolio');
    for (const label of ['Total products', 'In market', 'Active', 'Planned']) expect(within(portfolio).getByText(label)).toBeTruthy();
    const n = (key: string) => Number(screen.getByTestId(`pdt-kpi-${key}`).querySelector('[aria-label] > div')!.textContent);
    expect(n('total')).toBe(3);
    expect(n('inMarket') + n('active') + n('planned')).toBe(n('total'));
    expect(within(portfolio).getByText('No date 0 · >12 months 0 · Date passed 1')).toBeTruthy();
    const status = screen.getByTestId('pdt-kpi-status');
    for (const label of ['On track', 'Need attention', 'Launches in next 90 days']) expect(within(status).getByText(label)).toBeTruthy();
    expect(screen.getByTestId('pdt-health-not-set').textContent).toBe('Health not set: 2');
    expect(within(screen.getByTestId('pdt-roadmap')).getByText('MonoSeal')).toBeTruthy();
    expect(screen.getByTestId('pdt-roadmap-all').textContent).toBe('NEXT 90 DAYS · 1');
    expect([...screen.getByTestId('pdt-roadmap').querySelectorAll('[class*="monthName"]')].map((m) => m.textContent)).toEqual(['NOV 2026', 'DEC 2026', 'JAN 2027', 'FEB 2027']);
    // the shared filter bar starts collapsed, like on the other pages; the info line is on the right of its panel
    expect(screen.queryByTestId('filter-bar-info')).toBeNull();
    fireEvent.click(within(screen.getByTestId('pdt-filters')).getByRole('button', { name: /Filters/ }));
    expect(screen.getByTestId('filter-bar-info').textContent).toMatch(/^Last Excel import: 18 Nov 2026/);
    // the stage pipeline: one line of totals, then a chevron per stage with count, share, overdue, readiness, next target
    expect(screen.getByTestId('pdt-stage-totals').textContent).toBe('3 products · 2 in pipeline · 1 in market');
    const idea = screen.getByTestId('pdt-stage-IDEA');
    expect(idea.getAttribute('aria-label')).toBe('Idea: 1 products (33%)');
    expect(within(idea).getByText('1 overdue')).toBeTruthy();
    expect(within(idea).getByText('Next 01 Apr 2026')).toBeTruthy();
    expect(within(screen.getByTestId('pdt-stage-DEVELOPMENT')).getByText('Avg 48%')).toBeTruthy();
    // an empty stage still shows 0, without share or details
    expect(screen.getByTestId('pdt-stage-RESEARCH').textContent).toBe('Research0');
    expect(screen.queryByText('Product stage pipeline')).toBeNull();
    expect(screen.getByText('Development stage pipeline')).toBeTruthy();
  });

  it('every KPI card opens its details table with the products behind it, and shows as active', { timeout: 15_000 }, async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    const card = await screen.findByTestId('pdt-kpi-planned');
    fireEvent.click(card);
    const drill = await screen.findByTestId('pdt-drill');
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(within(drill).getByTestId('pdt-drill-count').textContent).toBe('1 product');
    expect(within(drill).getByText('Wide-Joint Grout')).toBeTruthy();
    expect(within(drill).queryByText('MonoSeal')).toBeNull();
    for (const h of ['Code', 'Product name', 'Brand', 'Family', 'Subfamily', 'Stage', 'Health', 'Priority', 'Owner', 'Readiness %', 'Target launch', 'Days to launch', 'Flag', 'Next step']) {
      expect(within(drill).getAllByText(h).length).toBeGreaterThan(0);
    }
    fireEvent.click(within(drill).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('pdt-drill')).toBeNull());
    fireEvent.click(screen.getByTestId('pdt-kpi-upcomingLaunches'));
    expect(within(await screen.findByTestId('pdt-drill')).getByTestId('pdt-drill-count').textContent).toBe('1 product');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('pdt-drill')).toBeNull());
    fireEvent.click(screen.getByTestId('pdt-health-not-set'));
    expect(within(await screen.findByTestId('pdt-drill')).getByTestId('pdt-drill-count').textContent).toBe('2 products');
  });

  it('a stage click filters the page on it (and ?stage=) and opens its products; clicking it again clears both', async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    fireEvent.click(await screen.findByTestId('pdt-stage-DEVELOPMENT'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/tracker/dashboard?stages=DEVELOPMENT', 'test'));
    expect(screen.getByTestId('pdt-stage-DEVELOPMENT').getAttribute('aria-pressed')).toBe('true');
    expect(window.location.search).toBe('?stage=development');
    const drill = await screen.findByTestId('pdt-drill');
    expect(within(drill).getByText('MonoSeal')).toBeTruthy();
    expect(within(drill).queryByText('XtraCol One')).toBeNull();
    fireEvent.click(within(drill).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByTestId('pdt-stage-DEVELOPMENT'));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.queryByTestId('pdt-drill')).toBeNull();
  });

  it('opens the stage from a ?stage= deep link', async () => {
    window.history.replaceState(null, '', '/?stage=development');
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    expect(within(await screen.findByTestId('pdt-drill')).getByText('MonoSeal')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/tracker/dashboard?stages=DEVELOPMENT', 'test');
  });

  it('where we stand: a count cell opens that family + stage, a family name filters the page', { timeout: 15_000 }, async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    const matrix = await screen.findByTestId('pdt-matrix');
    expect(within(matrix).queryByTestId('pdt-matrix-toggle')).toBeNull();
    fireEvent.click(within(matrix).getByRole('button', { name: 'Tile Fixing, Launched: 1' }));
    const drill = await screen.findByTestId('pdt-drill');
    expect(within(drill).getByText('Tile Fixing · Launched')).toBeTruthy();
    expect(within(drill).getByText('XtraCol One')).toBeTruthy();
    expect(within(drill).queryByText('Wide-Joint Grout')).toBeNull();
    fireEvent.click(within(drill).getByRole('button', { name: 'Close' }));
    fireEvent.click(within(matrix).getByRole('button', { name: 'Waterproofing, Development: 1' }));
    expect(within(await screen.findByTestId('pdt-drill')).getByText('MonoSeal')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('pdt-drill')).getByRole('button', { name: 'Close' }));
    fireEvent.click(within(matrix).getByRole('button', { name: /Waterproofing$/ }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/tracker/dashboard?familyIds=22', 'test'));
  });

  it('a year opens its launched and planned products', async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    fireEvent.click(await screen.findByRole('button', { name: 'bar 2023' }));
    const drill = await screen.findByTestId('pdt-drill');
    expect(within(drill).getByText('Launches in 2023')).toBeTruthy();
    expect(within(drill).getByText('XtraCol One')).toBeTruthy();
  });

  it('a row of the details table opens the product drawer: editable with entry rights, read-only without', { timeout: 15_000 }, async () => {
    respond(DASH);
    const { unmount } = render(<PdpPage section="dashboard" />);
    fireEvent.click(await screen.findByTestId('pdt-kpi-active'));
    fireEvent.click(within(await screen.findByTestId('pdt-drill')).getByText('MonoSeal').closest('tr')!);
    const drawer = await screen.findByTestId('pdt-drawer');
    await waitFor(() => expect(within(drawer).getByRole('button', { name: 'Change stage' })).toBeTruthy());
    unmount();
    perms.entry = false;
    render(<PdpPage section="dashboard" />);
    fireEvent.click(await screen.findByTestId('pdt-kpi-active'));
    fireEvent.click(within(await screen.findByTestId('pdt-drill')).getByText('MonoSeal').closest('tr')!);
    const ro = await screen.findByTestId('pdt-drawer');
    await waitFor(() => expect(within(ro).getAllByText('MonoSeal').length).toBeGreaterThan(0));
    expect(within(ro).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(ro).queryByRole('button', { name: 'Change stage' })).toBeNull();
  });

  it('the Brand filter sits next to Family in the shared filter bar and filters the page', async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    await screen.findByTestId('pdt-kpis');
    const bar = screen.getByTestId('pdt-filters');
    fireEvent.click(within(bar).getByRole('button', { name: /Filters/ }));
    const labels = [...bar.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels.indexOf('Brand')).toBe(labels.indexOf('Family') + 1);
    expect(within(bar).getByRole('button', { name: 'Reset filters' })).toHaveProperty('disabled', true);
    fireEvent.click(within(bar).getAllByRole('button', { name: /All/ })[1]);
    fireEvent.click(await within(bar).findByText('Xtreme'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/tracker/dashboard?brands=Xtreme', 'test'));
    expect(within(bar).getByRole('button', { name: 'Reset filters' })).toHaveProperty('disabled', false);
  });

  it('shows only Dashboard and Data entry tabs; no gate tabs', async () => {
    respond(DASH);
    const { unmount } = render(<PdpPage section="dashboard" />);
    await screen.findByTestId('pdt-kpis');
    expect(screen.getByRole('navigation').textContent).toBe('Dashboard|Data entry & follow-up');
    unmount();
    perms.entry = false;
    render(<PdpPage section="dashboard" />);
    await screen.findByTestId('pdt-kpis');
    expect(screen.getByRole('navigation').textContent).toBe('Dashboard');
  });

  it('keeps the gate screens for the Admin role only', async () => {
    respond(DASH);
    const { unmount } = render(<PdpPage section="tree" />);
    expect(await screen.findByText(/reserved for the Admin role/)).toBeTruthy();
    unmount();
    perms.admin = true;
    render(<PdpPage section="tree" />);
    await waitFor(() => expect(request).toHaveBeenCalledWith('/options', 'test'));
  });

  it('says what to do when there are no products yet', async () => {
    respond({ ...DASH, totalProducts: 0, tracker: [], blockers: [], pipeline: [] });
    render(<PdpPage section="dashboard" />);
    expect(await screen.findByText(/No products yet/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Excel import/ })).toBeTruthy();
  });
});
