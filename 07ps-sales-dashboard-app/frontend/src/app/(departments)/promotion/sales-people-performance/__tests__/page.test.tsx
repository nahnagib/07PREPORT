import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Page from '../page';
import { fetchPeopleOverview, type ContributionAtom, type PeopleStatus } from '../../../../../lib/salesPeoplePerformance';

const state = vi.hoisted(() => ({
  anchorDate: '2026-02-15', effectiveFilters: { segmentKeys: [1, 2] }, isAtDefaults: true,
  resetFilters: vi.fn(), onAnchorDateChange: vi.fn(),
}));
const filterBar = vi.hoisted(() => ({
  props: {} as { onReset?: () => void; isPristine?: boolean; salespersons?: { salesperson_name: string }[] },
}));
const nav = vi.hoisted(() => ({ active: undefined as string | undefined }));
const charts = vi.hoisted(() => ({ bars: [] as Record<string, unknown>[], lines: [] as Record<string, unknown>[] }));
vi.mock('../../../../../lib/AuthProvider', () => ({ useAuth: () => ({ token: 'test', user: null, canView: () => true, retryAuth: vi.fn(), logout: vi.fn() }) }));
vi.mock('../../../../../components/FilterProvider', () => ({
  useFilterState: () => state,
  useScopedFilterOptions: () => ({ salespersons: { data: [
    { salesperson_key: 1, salesperson_name: 'Omar' },
    { salesperson_key: 81, salesperson_name: 'Sales Person 2' },
    { salesperson_key: 82, salesperson_name: 'Salers Person 3' },
  ] } }),
  useDataVersion: () => 0,
}));
vi.mock('../../../../../components/standardFilterBarProps', () => ({ standardFilterBarProps: () => ({}) }));
vi.mock('../../../../../lib/hooks', async () => ({
  ...await vi.importActual('../../../../../lib/hooks'),
  useRefreshStatus: () => ({ data: null }),
}));
vi.mock('../../../../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../../../../components/FilterBar', () => ({
  FilterBar: (props: { onReset?: () => void; isPristine?: boolean }) => {
    filterBar.props = props;
    return <button type="button" onClick={props.onReset}>Reset filters</button>;
  },
}));
vi.mock('../../../../../components/BottomNavBar', () => ({
  BottomNavBar: ({ active }: { active?: string }) => { nav.active = active; return null; },
}));
vi.mock('../../../../../components/ValidationStatusBar', () => ({ ValidationStatusBar: () => null }));
vi.mock('../../../../../components/RefreshFooter', () => ({ RefreshFooter: () => null }));
vi.mock('../../../../../components/AuthGuard', () => ({ PermissionGuard: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../../../lib/salesPeoplePerformance', async () => ({
  ...await vi.importActual('../../../../../lib/salesPeoplePerformance'),
  fetchPeopleOverview: vi.fn(),
}));
type GridColumn = { key: string; header: string; render?: (r: Record<string, unknown>) => React.ReactNode };
vi.mock('@07ps/ui', () => ({
  Card: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => <div {...rest}>{children}</div>,
  ChartPanel: ({ children, title, headerActions }: { children: React.ReactNode; title: string; headerActions?: React.ReactNode }) =>
    <section aria-label={title}>{headerActions}{children}</section>,
  DataGrid: ({ columns, rows, getRowId, onRowClick }: { columns: GridColumn[]; rows: Record<string, unknown>[];
    getRowId: (r: Record<string, unknown>) => string; onRowClick?: (r: Record<string, unknown>) => void }) =>
    <table><thead><tr>{columns.map((c) => <th key={c.key}>{c.header}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={getRowId(r)} onClick={() => onRowClick?.(r)}>
        {columns.map((c) => <td key={c.key}>{c.render ? c.render(r) : String(r[c.key])}</td>)}</tr>)}</tbody></table>,
  Select: ({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) =>
    <select aria-label={label} value={value[0]} onChange={(e) => onChange([e.target.value])}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>,
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...rest}>{children}</button>,
  TrendChart: () => <div>Monthly revenue chart</div>, LoadingSkeleton: () => <div>Loading</div>,
  EmptyState: ({ message }: { message: string }) => <p>{message}</p>,
  ErrorState: ({ message, onRetry }: { message: string; onRetry: () => void }) => <div role="alert">{message}<button onClick={onRetry}>Retry</button></div>,
  VisualInfoIcons: () => null, chartTooltipProps: {}, tooltipBoxStyle: {}, exportRowsAsPdf: vi.fn(), useCanExport: () => true,
  DISPLAY_LOCALE: 'en-GB',
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ data }: { data: Record<string, unknown>[] }) => { charts.bars = data; return <div>Status mix chart</div>; },
  LineChart: ({ data, children }: { data: Record<string, unknown>[]; children: React.ReactNode }) => {
    charts.lines = data;
    return <div data-testid="mom">{children}</div>;
  },
  Line: ({ dataKey, hide }: { dataKey: string; hide?: boolean }) => (hide ? null : <span data-testid={`line-${dataKey}`} />),
  PieChart: () => <div>Contribution pie</div>, Pie: () => null, Cell: () => null, Sector: () => null, LabelList: () => null,
  ReferenceLine: () => null,
  Bar: () => null, CartesianGrid: () => null, Legend: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));

const statuses = [
  { key: 'critical', label: 'Critical', range: '≤50%', benchmark: 0.05, direction: 'max' },
  { key: 'need_attention', label: 'Need attention', range: '>50–90%', benchmark: 0.10, direction: 'max' },
  { key: 'behind_target', label: 'Behind target', range: '>90–<100%', benchmark: 0.15, direction: 'max' },
  { key: 'on_target', label: 'On target', range: '100–110%', benchmark: 0.50, direction: 'min' },
  { key: 'top_performer', label: 'Top performer', range: '>110%', benchmark: 0.20, direction: 'min' },
] as const;
function person(key: number, name: string, actual: number, status: PeopleStatus, target = 100) {
  const figures = { actual, target, achievement: actual / target, variance: actual - target, variancePct: (actual - target) / target, status };
  return { key, name, ...figures, lastYear: 30, fullYearTarget: target * 12, months: ['2026-01', '2026-02'].map((month) => ({
    ...figures, month, through: `${month}-15`, previousActual: 20, momVariancePct: actual / 20 - 1,
    achievementChange: 0.1, previousStatus: status,
  })) };
}
const team = [
  person(1, 'Amal', 40, 'critical'),
  person(2, 'Omar', 150, 'top_performer'),
  person(3, 'Basma', 20, 'critical'),
  person(4, 'Hadi', 45, 'critical'),
  person(5, 'Ziad', 10, 'critical'),
  person(6, 'Sara', 120, 'top_performer'),
  person(7, 'Wide', 390, 'critical', 1000),
];
const atom = (personKey: number, companyKey: number, companyName: string, segmentKey: number, segmentName: string,
  teamKey: string, revenue: number): ContributionAtom => ({ personKey, companyKey, companyName, segmentKey, segmentName,
  teamKey, teamName: `Team ${teamKey}`, revenue, target: 100 });
const contributions = [
  atom(1, 1, 'Majaal', 1, 'B2B', 'A', 40),
  atom(4, 1, 'Majaal', 1, 'B2B', 'A', 45),
  atom(2, 1, 'Majaal', 2, 'B2C', 'B', 150),
  atom(3, 3, 'Tika', 1, 'B2B', 'C', 20),
];
beforeEach(() => {
  vi.clearAllMocks();
  state.isAtDefaults = true;
  vi.mocked(fetchPeopleOverview).mockResolvedValue({ anchorDate: '2026-02-15', monthsElapsed: 1.5, statuses: [...statuses], people: team,
    contributions });
});
afterEach(cleanup);

const topCard = (name: string) => within(screen.getByRole('region', { name: 'Top people by category' })).getByRole('region', { name });
const shown = (name: string) => within(topCard(name)).queryAllByRole('button').map((b) => b.getAttribute('aria-label'));

describe('Sales People Performance: top people by category', () => {
  it('shows only the #1 person: best for good statuses, worst variance for the others', async () => {
    render(<Page />);
    await screen.findByRole('region', { name: 'Top people by category' });
    expect(shown('Top performer')).toEqual(['Omar']);
    // Worst by variance % to YTD target: Ziad −90% (Wide is −61%).
    expect(shown('Critical')).toEqual(['Ziad']);
    expect(topCard('Critical').textContent).toContain('-90.00%');
    expect(topCard('Critical').textContent).toContain('−LYD 90 vs target');
    expect(topCard('Critical').textContent).toContain('LYD 10 of LYD 100');
    expect(topCard('Top performer').textContent).toContain('+LYD 50 vs target');
    expect(within(topCard('On target')).getByText('No one in this status')).toBeTruthy();
    expect(screen.queryByText(/Show all/)).toBeNull();
  });
  it('always ranks by variance % to YTD target, with no measure toggle', async () => {
    vi.mocked(fetchPeopleOverview).mockResolvedValue({ anchorDate: '2026-02-15', monthsElapsed: 1.5, statuses: [...statuses], contributions,
      people: [...team, person(8, 'Big gap', 4000, 'critical', 10000)] });
    render(<Page />);
    await screen.findByRole('region', { name: 'Top people by category' });
    expect(screen.queryByRole('group', { name: 'Rank by' })).toBeNull();
    // Ziad −90% is the worst by %, although Big gap is LYD −6,000.
    expect(shown('Critical')).toEqual(['Ziad']);
  });
  it('fills the first slot with Team pulse, or the selected person\'s pulse', async () => {
    render(<Page />);
    const pulse = await screen.findByRole('region', { name: 'Team pulse' });
    // 775 of 1,600 YTD; full year 19,200; (19,200 − 775) ÷ 10.5 months left; 775 ÷ 1.5 months.
    expect(pulse.textContent).toContain('48.44%');
    expect(pulse.textContent).toContain('−LYD 825 behind YTD target');
    expect(pulse.textContent).toContain('Need LYD 1.8K/month');
    expect(pulse.textContent).toContain('running LYD 517/month');
    fireEvent.click(screen.getByRole('button', { name: 'Omar' }));
    expect(pulse.textContent).toContain('Pulse · Omar');
    expect(pulse.textContent).toContain('150.00%');
    expect(pulse.textContent).toContain('+LYD 50 ahead of YTD target');
  });
  it('name search picks the #1 among matching people', async () => {
    render(<Page />);
    await screen.findByRole('region', { name: 'Top people by category' });
    fireEvent.change(screen.getByLabelText('Search sales people'), { target: { value: 'ma' } });
    expect(shown('Critical')).toEqual(['Basma']);
    expect(shown('Top performer')).toEqual(['Omar']);
    fireEvent.change(screen.getByLabelText('Search sales people'), { target: { value: 'zi' } });
    expect(within(topCard('Top performer')).getByText('No one matches this search')).toBeTruthy();
  });
});

describe('Sales People Performance: status cards, charts and table', () => {
  it('cards show headcount and YTD variance in LYD and percent', async () => {
    render(<Page />);
    const summary = await screen.findByRole('region', { name: 'YTD status summary' });
    const total = within(summary).getByRole('button', { name: /Total sales people/ });
    expect(total.textContent).toContain('7');
    // (775 − 1600) ÷ 1600
    expect(total.textContent).toContain('−LYD 825 · -51.56%');
    expect(total.textContent).toContain('vs YTD target');
    const critical = within(summary).getByRole('button', { name: /^Critical/ });
    // (505 − 1400) ÷ 1400
    expect(critical.textContent).toContain('−LYD 895 · -63.93%');
    expect(summary.textContent).not.toMatch(/Achievement|Benchmark/);
    expect(document.body.textContent).not.toContain('No target');
    expect(nav.active).toBe('Sales People Performance');
    expect(filterBar.props.salespersons?.map((option) => option.salesperson_name)).toEqual(['Omar']);
  });
  it('a status card filters the table; Total shows everyone again', async () => {
    render(<Page />);
    const summary = await screen.findByRole('region', { name: 'YTD status summary' });
    const criticalCard = within(summary).getByRole('button', { name: /^Critical/ });
    expect(criticalCard.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(criticalCard, { key: 'Enter' });
    expect(criticalCard.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('region', { name: 'Performance details · 5' })).toBeTruthy();
    expect(screen.getByRole('table').textContent).not.toContain('Omar');
    fireEvent.click(within(summary).getByRole('button', { name: /Total sales people/ }));
    expect(screen.getByRole('region', { name: 'Performance details · 7' })).toBeTruthy();
  });
  it('status mix compares team headcount shares against minimums and caps, starting at YTD', async () => {
    const largerTeam = [...team, ...Array.from({ length: 24 }, (_, i) => person(i + 8, `Person ${i + 8}`, 20, 'critical'))];
    vi.mocked(fetchPeopleOverview).mockResolvedValue({
      anchorDate: '2026-02-15', monthsElapsed: 1.5, statuses: [...statuses], contributions, people: largerTeam,
    });
    render(<Page />);
    await screen.findByRole('region', { name: 'Status mix' });
    const month = screen.getByLabelText('Month') as HTMLSelectElement;
    expect(month.value).toBe('ytd');
    expect([...month.options].map((o) => o.value)).toEqual(['2026-02', '2026-01', 'ytd']);
    expect(charts.bars.map((r) => r.status)).toEqual(['top_performer', 'on_target', 'behind_target', 'need_attention', 'critical']);
    expect(charts.bars.reduce((sum, row) => sum + Number(row.share), 0)).toBeCloseTo(1);
    expect(charts.bars[0]).toMatchObject({
      count: 2, share: 2 / 31, peopleLabel: '2 · 6.5%', benchmarkLabel: '≥20%', gap: '13.5 pp short', met: false,
    });
    expect(charts.bars[2]).toMatchObject({ count: 0, benchmarkLabel: '≤15%', gap: '15.0 pp below cap', met: true });
    expect(charts.bars[4]).toMatchObject({ count: 29, benchmarkLabel: '≤5%', gap: '88.5 pp over cap', met: false });
    fireEvent.change(month, { target: { value: '2026-02' } });
    expect(month.value).toBe('2026-02');
    expect(charts.bars[0]).toMatchObject({ count: 2, share: 2 / 31 });
  });
  it('status mix with a person selected shows only their row and a note', async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar' }));
    expect(charts.bars.map((r) => r.status)).toEqual(['top_performer']);
    expect(charts.bars[0]).toMatchObject({ count: 2, share: 2 / 7 });
    expect(screen.getByRole('note').textContent).toBe('Omar was top performer YTD');
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-02' } });
    expect(screen.getByRole('note').textContent).toBe('Omar was top performer in Feb 2026');
    expect(screen.getByRole('region', { name: 'Status mix' }).textContent).toContain('monthly status');
  });
  it('MoM performance: achievement per status per month; the legend toggles a line', async () => {
    render(<Page />);
    await screen.findByTestId('mom');
    expect(charts.lines).toHaveLength(2);
    expect(charts.lines[0]).toMatchObject({ top_performer: 270 / 200, on_target: null });
    const toggle = within(screen.getByRole('group', { name: 'Show statuses' })).getByRole('button', { name: 'Critical' });
    expect(screen.getByTestId('line-critical')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('line-critical')).toBeNull();
  });
  it('person contribution drills company > segment > team > person and back', async () => {
    render(<Page />);
    const pie = await screen.findByRole('region', { name: 'Person contribution' });
    const slices = () => within(pie).getAllByRole('listitem').map((li) => li.textContent);
    expect(slices()).toEqual(['Majaal92.16%', 'Tika7.84%']);
    fireEvent.click(within(pie).getByRole('button', { name: /^Majaal/ }));
    expect(slices()).toEqual(['B2C63.83%', 'B2B36.17%']);
    fireEvent.click(within(pie).getByRole('button', { name: /^B2B/ }));
    expect(slices()).toEqual(['Team A100.00%']);
    fireEvent.click(within(pie).getByRole('button', { name: /^Team A/ }));
    expect(slices()).toEqual(['Hadi52.94%', 'Amal47.06%']);
    expect((within(pie).getByRole('button', { name: /^Hadi/ }) as HTMLButtonElement).disabled).toBe(true);
    const crumbs = within(pie).getByRole('navigation', { name: 'Contribution level' });
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Majaal', 'B2B', 'Team A']);
    fireEvent.click(within(crumbs).getByRole('button', { name: 'Majaal' }));
    expect(slices()).toEqual(['B2C63.83%', 'B2B36.17%']);
    fireEvent.click(within(crumbs).getByRole('button', { name: 'All' }));
    expect(slices()).toEqual(['Majaal92.16%', 'Tika7.84%']);
  });
  it('selecting a person opens their team, highlights them and shows their share at every level', async () => {
    render(<Page />);
    fireEvent.click(within(await screen.findByRole('table')).getByText('Amal'));
    const pie = screen.getByRole('region', { name: 'Person contribution' });
    const crumbs = within(pie).getByRole('navigation', { name: 'Contribution level' });
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Majaal', 'B2B', 'Team A']);
    expect(within(pie).getByRole('button', { name: /^Amal/ }).getAttribute('data-highlighted')).toBe('true');
    expect(within(pie).getByRole('button', { name: /^Hadi/ }).getAttribute('data-dimmed')).toBe('true');
    // 40 of Team A 85, of B2B 85, of Majaal 235, of everyone 255.
    expect(within(pie).getByLabelText('Amal share of YTD actual').textContent)
      .toBe('Share of Team: 47.06% · Segment: 47.06% · Company: 17.02% · Group: 15.69% · Total: 15.69%');
    fireEvent.click(within(crumbs).getByRole('button', { name: 'All' }));
    expect(within(pie).getByRole('button', { name: /^Majaal/ }).getAttribute('data-highlighted')).toBe('true');
    expect(within(pie).getByRole('button', { name: /^Tika/ }).getAttribute('data-dimmed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show everyone' }));
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual(['All']);
    expect(within(pie).queryByLabelText('Amal share of YTD actual')).toBeNull();
  });
  it('the page order ends with the details table', async () => {
    render(<Page />);
    await screen.findByRole('region', { name: 'Top people by category' });
    const order = [...document.querySelectorAll('main section[aria-label]')].map((s) => s.getAttribute('aria-label'));
    expect(order).toEqual(['YTD status summary', 'Top people by category', 'Status mix', 'MoM performance by status',
      'Person contribution', 'Actual vs target by month', 'Performance details · 7']);
  });
  it('a top person or a table row selects that person; Show everyone clears it', async () => {
    render(<Page />);
    const omar = await screen.findByRole('button', { name: 'Omar' });
    fireEvent.click(omar);
    expect(omar.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Selected: Omar')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Performance details · 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show everyone' }));
    fireEvent.click(within(screen.getByRole('table')).getByText('Amal'));
    expect(screen.getByText('Selected: Amal')).toBeTruthy();
  });
  it('the FilterBar Reset also clears the page status, search and person', async () => {
    render(<Page />);
    const summary = await screen.findByRole('region', { name: 'YTD status summary' });
    fireEvent.click(within(summary).getByRole('button', { name: /^Critical/ }));
    expect(filterBar.props.isPristine).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(state.resetFilters).toHaveBeenCalled();
    expect(within(summary).getByRole('button', { name: /Total sales people/ }).getAttribute('aria-pressed')).toBe('true');
  });
  it('handles a failed request with a working retry', async () => {
    vi.mocked(fetchPeopleOverview).mockRejectedValueOnce(new Error('Unavailable'));
    render(<Page />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('region', { name: 'YTD status summary' });
  });
});
