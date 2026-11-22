import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Product Development Plan dashboard (components/pdt): the sections from the API (6 KPI cards with the gap lines, pipeline
 * with Launched collapsed, family x stage matrix, tracker with Family / Flag), clicks that filter the page, the two tabs
 * only, the gate screens Admin-only, the empty state.
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
  users: [], owners: ['Omar Ali'], subfamilies: [{ familyId: 21, subfamily: 'Tile Adhesive' }], today: '2026-11-18',
};
const product = (code: string, name: string, family: [number, string], stage: string, health: string | null, readiness: number | null, target: string | null, actual: string | null = null, flag: string | null = null) => ({
  productId: Number(code.slice(3)), code, name, familyId: family[0], family: family[1], subfamily: 'Sub', ownerUserId: null, ownerName: null, priority: null, stage, health,
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
  today: '2026-11-18', settings: OPTIONS.settings, totalProducts: 3,
  kpis: { total: 3, inMarket: 1, active: 2, onTrack: 0, needAttention: 0, upcomingLaunches: 1, targetPassed: 1, healthNotSet: 2 },
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
  roadmap: { months: [{ month: '2026-11', products: [] }, { month: '2026-12', products: [] }, { month: '2027-01', products: [{ code: 'XT-011', name: 'MonoSeal', family: 'Waterproofing', targetLaunch: '2027-01-10', health: null }] }, { month: '2027-02', products: [] }], outsideWindow: 1 },
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
  it('shows the six KPI cards with the gap lines, the matrix and the tracker', async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    const kpis = await screen.findByTestId('pdt-kpis');
    for (const label of ['Total products', 'In market', 'Active in pipeline', 'On track', 'Need attention', 'Launches in next 90 days']) expect(within(kpis).getByText(label)).toBeTruthy();
    expect(within(kpis).getByRole('button', { name: /Target date passed\s*1/ })).toBeTruthy();
    expect(within(kpis).getByRole('button', { name: /Health not set\s*2/ })).toBeTruthy();
    const matrix = screen.getByTestId('pdt-matrix');
    expect(within(matrix).getByText('3 products')).toBeTruthy();
    expect(within(matrix).getByRole('button', { name: 'Waterproofing, Development: 1' })).toBeTruthy();
    // The full tracker sits behind "Show all products" so the landing page starts compact.
    expect(screen.queryByTestId('pdt-tracker')).toBeNull();
    fireEvent.click(screen.getByTestId('pdt-show-tracker'));
    const tracker = screen.getByTestId('pdt-tracker');
    expect(within(tracker).getByText('3 products')).toBeTruthy();
    expect(within(tracker).getByText('Target date passed')).toBeTruthy();
    expect(within(tracker).getAllByText('Health not set').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('pdt-years')).getByText('2023')).toBeTruthy();
  });

  it('shows six stage tiles with the backend counts, health split and warnings; no product cards', async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    await screen.findByTestId('pdt-tile-IDEA');
    expect(screen.getByTestId('pdt-stage-totals').textContent).toBe('3 products · 2 in pipeline · 1 in market');
    const tile = (st: string) => screen.getByTestId(`pdt-tile-${st}`).textContent;
    expect(tile('DEVELOPMENT')).toMatch(/Development\s*1/);
    expect(tile('DEVELOPMENT')).toContain('2 on track · 1 at risk · 1 blocked · 1 not set');
    expect(tile('DEVELOPMENT')).toContain('Avg readiness 48%');
    expect(tile('DEVELOPMENT')).toContain('Next target 10 Jan 2027');
    expect(tile('DEVELOPMENT')).toContain('1 blocked');
    expect(tile('IDEA')).toContain('1 not set');
    expect(tile('IDEA')).toContain('Avg readiness —');
    expect(tile('IDEA')).toContain('1 overdue');
    // An empty stage is muted with "No products"; Launched shows the count and "in market" only.
    expect(tile('RESEARCH')).toBe('Research0No products');
    expect(tile('LAUNCHED')).toBe('Launched1in market');
    expect(screen.queryByTestId('pdt-card-XT-011')).toBeNull();
    expect(screen.queryByTestId('pdt-stage-detail')).toBeNull();
  });

  it('opens one stage below the tiles, sets the Stage filter and ?stage=, and closes with the tile, ✕ or Esc', async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    fireEvent.click(await screen.findByTestId('pdt-tile-DEVELOPMENT'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/tracker/dashboard?stages=DEVELOPMENT', 'test'));
    const panel = await screen.findByTestId('pdt-stage-detail');
    expect(within(panel).getByTestId('pdt-detail-row-XT-011')).toBeTruthy();
    expect(within(panel).queryByTestId('pdt-detail-row-XT-001')).toBeNull();
    expect(window.location.search).toBe('?stage=development');
    expect(screen.getByTestId('pdt-tile-DEVELOPMENT').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('pdt-tile-DEVELOPMENT'));
    await waitFor(() => expect(screen.queryByTestId('pdt-stage-detail')).toBeNull());
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByTestId('pdt-tile-IDEA'));
    fireEvent.click(await screen.findByRole('button', { name: 'Close Idea' }));
    await waitFor(() => expect(screen.queryByTestId('pdt-stage-detail')).toBeNull());
    fireEvent.click(screen.getByTestId('pdt-tile-IDEA'));
    await screen.findByTestId('pdt-stage-detail');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('pdt-stage-detail')).toBeNull());
  });

  it('opens the stage from a ?stage= deep link', async () => {
    window.history.replaceState(null, '', '/?stage=development');
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    expect(await screen.findByTestId('pdt-stage-detail')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/tracker/dashboard?stages=DEVELOPMENT', 'test');
  });

  it('groups the open stage by family', async () => {
    window.history.replaceState(null, '', '/?stage=development');
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    const panel = await screen.findByTestId('pdt-stage-detail');
    fireEvent.click(within(panel).getByLabelText('Group by family'));
    const head = within(panel).getByRole('button', { name: /Waterproofing \(1\)/ });
    expect(within(panel).queryByTestId('pdt-detail-row-XT-011')).toBeNull();
    fireEvent.click(head);
    expect(within(panel).getByTestId('pdt-detail-row-XT-011')).toBeTruthy();
  });

  it('a row opens the product drawer: editable with entry rights, read-only without', async () => {
    window.history.replaceState(null, '', '/?stage=development');
    respond(DASH);
    const { unmount } = render(<PdpPage section="dashboard" />);
    fireEvent.click(await screen.findByTestId('pdt-detail-row-XT-011'));
    const drawer = await screen.findByTestId('pdt-drawer');
    await waitFor(() => expect(within(drawer).getByRole('button', { name: 'Change stage' })).toBeTruthy());
    unmount();
    perms.entry = false;
    window.history.replaceState(null, '', '/?stage=development');
    render(<PdpPage section="dashboard" />);
    fireEvent.click(await screen.findByTestId('pdt-detail-row-XT-011'));
    const ro = await screen.findByTestId('pdt-drawer');
    await waitFor(() => expect(within(ro).getByText('MonoSeal')).toBeTruthy());
    expect(within(ro).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(ro).queryByRole('button', { name: 'Change stage' })).toBeNull();
  });

  it('a matrix cell and a gap line filter the whole page', async () => {
    respond(DASH);
    render(<PdpPage section="dashboard" />);
    await screen.findByTestId('pdt-matrix');
    fireEvent.click(screen.getByRole('button', { name: 'Waterproofing, Development: 1' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/tracker/dashboard?familyIds=22&stages=DEVELOPMENT', 'test'));
    fireEvent.click(screen.getByRole('button', { name: /Health not set\s*2/ }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/tracker/dashboard?stages=IDEA%2CRESEARCH%2CDEVELOPMENT%2CTESTING%2CLAUNCH_READY&health=NONE', 'test'));
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
