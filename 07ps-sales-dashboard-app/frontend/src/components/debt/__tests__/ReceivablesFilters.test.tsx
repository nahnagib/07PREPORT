import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReceivablesCollectionsPage from '../../../app/(departments)/price/receivables-collections/page';
import { DEFAULT_DEBT_FILTERS } from '../../../lib/debt/view';
import type { DebtMeta, DebtReportScope } from '../../../lib/api';

const mocked = vi.hoisted(() => ({
  calls: [] as { endpoint: string; scope: DebtReportScope }[],
  result: null as DebtMeta | null,
  stale: false,
  prune: false,
  isAdmin: false,
}));
vi.mock('../../../lib/AuthProvider', () => ({ useAuth: () => ({ canView: () => true, isSalesperson: false, isAdmin: mocked.isAdmin }) }));
vi.mock('../../../lib/debt/useUrlCurrency', () => ({ useUrlCurrency: () => ({ currency: null, ready: true, setCurrency: () => {} }) }));
vi.mock('../../../components/AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../../../components/BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../../components/AuthGuard', () => ({ PermissionGuard: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../../components/FilterBar', () => ({ FilterBar: ({ extraFields, onReset }: { extraFields: React.ReactNode; onReset: () => void }) => <div>{extraFields}<button onClick={onReset}>Reset filters</button></div> }));
vi.mock('../../../components/debt/CreditPolicyChart', () => ({ CreditPolicyChart: () => null }));
vi.mock('../../../components/debt/DebtDrilldownModal', () => ({ DebtDrilldownModal: () => null }));
vi.mock('../../../components/debt/CollectionsTrend', () => ({ CollectionsDrilldownModal: () => null, CollectionsTrendPanel: () => null }));
vi.mock('@07ps/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@07ps/ui')>(),
  Button: () => null, ChartPanel: () => null, ComboChart: () => null, DataGrid: () => null, EmptyState: () => null,
  ErrorState: () => null, GroupedBarChart: () => null, KpiTile: () => null, LoadingSkeleton: () => null,
  Select: ({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string[]; onChange: (values: string[]) => void }) => (
    <label>{label}<select aria-label={label} multiple value={value} onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select></label>
  ),
}));
vi.mock('../../../lib/hooks', () => ({
  useDebtReport: (_token: unknown, _auth: unknown, _retry: unknown, endpoint: string, scope: DebtReportScope) => {
    mocked.calls.push({ endpoint, scope });
    if (endpoint !== 'meta') return { data: null, loading: true, error: null };
    const filters = Object.fromEntries(['companyKeys', 'segmentKeys', 'channelKeys', 'salesTeamKeys', 'salespersonKeys', 'customerKeys'].map((k) => [k, (scope[k as keyof DebtReportScope] as (string | number)[] ?? []).map(String)]));
    if (mocked.prune) Object.assign(filters, { salespersonKeys: [], salesTeamKeys: [], customerKeys: [] });
    return { data: { ...mocked.result, filters }, loading: false, scopeKey: mocked.stale ? 'old request' : JSON.stringify(scope) };
  },
}));

const option = (value: string, labelEn: string) => ({ value, labelEn, labelAr: null });
beforeEach(() => {
  mocked.calls = [];
  mocked.stale = false;
  mocked.prune = false;
  mocked.isAdmin = false;
  mocked.result = {
    snapshotDate: '2026-10-15', snapshots: [{ date: '2026-10-15', lineCount: 1 }],
    options: {
      companies: [option('1', 'Majaal'), option('3', 'Tika')], customerGroups: [option('1', 'B2B')],
      distributionChannels: [option('2', 'Wholesale')], salesTeams: [option('M-East', 'East')],
      salespersons: [option('10', 'Ali')], customers: [option('100', 'Customer A')],
      agingBuckets: [], deliveryStatuses: [], paymentTerms: [], sizeTiers: [], customerCategories: [], scopes: [], currencies: [],
    },
    creditPolicy: { zones: [] },
  } as unknown as DebtMeta;
});
afterEach(cleanup);

const latest = (endpoint: string) => mocked.calls.filter((c) => c.endpoint === endpoint).at(-1)!.scope;
const choose = (label: string, value: string) => fireEvent.change(screen.getByRole('listbox', { name: label }), { target: { value } });

describe('Receivables filter controls', () => {
  it('renders the requested order, with the existing Include control after Customer Category', () => {
    render(<ReceivablesCollectionsPage />);
    expect(screen.getAllByRole('listbox').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Date', 'Company', 'Customer group', 'Distribution Channel', 'Branch', 'Salesperson', 'Customer', 'Overdue status',
      'Aging bucket', 'Delivery status', 'Payment term', 'Invoice size ⓘ', 'Customer Category ⓘ', 'Include',
    ]);
  });

  it('sends selections to finance options and to the reports, and resets the new dimensions', async () => {
    render(<ReceivablesCollectionsPage />);
    choose('Company', '1');
    choose('Customer group', '1');
    choose('Distribution Channel', '2');
    choose('Branch', 'M-East');
    choose('Salesperson', '10');
    choose('Customer', '100');
    for (const endpoint of ['meta', 'overview', 'trend', 'customers', 'aging', 'collections-trend']) {
      expect(latest(endpoint)).toMatchObject({ companyKeys: [1], segmentKeys: [1], channelKeys: [2], salesTeamKeys: ['M-East'], salespersonKeys: [10], customerKeys: [100] });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(latest('overview')).toMatchObject(DEFAULT_DEBT_FILTERS));
  });

  it('adopts current pruning results but never lets retained results clear a new selection', async () => {
    mocked.stale = true;
    mocked.prune = true;
    const view = render(<ReceivablesCollectionsPage />);
    choose('Salesperson', '10');
    expect(latest('overview').salespersonKeys).toEqual([10]);
    mocked.stale = false;
    view.rerender(<ReceivablesCollectionsPage />);
    await waitFor(() => expect(latest('overview').salespersonKeys).toEqual([]));
  });
});

describe('Receivables status strip', () => {
  const ADMIN_ITEMS = ['Receivables snapshot', 'Showing', 'Always excluded:', 'Amounts per currency; LYD equivalents', 'Last finance run failed'];
  const items = () => Array.from(screen.getByRole('status').children, (el) => el.textContent ?? '');
  const withContext = () => {
    mocked.result = {
      ...mocked.result!,
      options: { ...mocked.result!.options, scopes: [{ value: 'customer', labelEn: 'Customer debt', labelAr: null, isDefault: true, description: null }] },
      exclusions: { segments: ['Backoffice', 'Inter Company'], salesTeams: [], teams: [] },
      freshness: { department: 'finance', lastSuccessUtc: '2026-10-19T00:02:00.000Z', lastSuccessJob: 'x', lastFailureUtc: '2026-10-19T01:00:00.000Z', lastFailureJob: 'x', dataAsOf: '2026-10-19' },
    } as DebtMeta;
  };

  it('keeps freshness visible and moves admin scope details into hover help', () => {
    mocked.isAdmin = true;
    withContext();
    render(<ReceivablesCollectionsPage />);
    const shown = items();
    expect(shown).toHaveLength(4);
    expect(shown[0]).toMatch(/^Receivables snapshot /);
    expect(shown[1]).toMatch(/^Finance refresh /);
    expect(shown[2]).toMatch(/^Last finance run failed at /);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(screen.getAllByRole('button', { name: 'About this visual' })[0]);
    expect(screen.getByRole('tooltip').textContent).toContain('Showing Customer debt; inter-company excluded');
    expect(screen.getByRole('tooltip').textContent).toContain('Always excluded: segments Backoffice, Inter Company');
    expect(screen.getByRole('tooltip').textContent).toContain('Amounts per currency; LYD equivalents');
  });

  it('shows everyone else the finance refresh alone, with nothing else in the strip', () => {
    withContext(); // even if the fields reached the browser, they would not render
    render(<ReceivablesCollectionsPage />);
    const shown = items();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/^Finance refresh \S/);
    for (const text of ADMIN_ITEMS) expect(screen.getByRole('status').textContent).not.toContain(text);
  });

  it('handles a non-admin meta without the admin-only fields (as the API sends it)', () => {
    mocked.result = { ...mocked.result!, freshness: { department: 'finance', lastSuccessUtc: '2026-10-19T00:02:00.000Z', lastSuccessJob: 'x', dataAsOf: '2026-10-19' } } as DebtMeta;
    render(<ReceivablesCollectionsPage />);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatch(/^Finance refresh /);
  });
});
