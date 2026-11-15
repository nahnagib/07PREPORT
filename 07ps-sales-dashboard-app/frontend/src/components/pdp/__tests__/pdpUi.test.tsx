import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../../lib/api';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/AuthProvider', () => ({
  useAuth: () => ({
    token: 'test', user: { role: { label: 'Admin' }, fullName: 'Admin' }, logout: vi.fn(), error: null, retryAuth: vi.fn(), isAdmin: true,
    canView: () => true, canEdit: () => true, canCreate: () => true, canDelete: () => true, canExport: () => true, can: () => true,
  }),
}));
vi.mock('../../../lib/pdp/api', async () => ({ ...(await vi.importActual('../../../lib/pdp/api')), pdp: request }));
// Page chrome is not under test here.
vi.mock('../../AppHeader', () => ({ AppHeader: () => <header>header</header> }));
vi.mock('../../BottomNavBar', () => ({ BottomNavBar: () => null }));
vi.mock('../../TopTabBar', () => ({ TopTabBar: ({ tabs }: { tabs: { label: string }[] }) => <nav>{tabs.map((x) => x.label).join('|')}</nav> }));
vi.mock('../../../lib/hooks', () => ({ useRefreshStatus: () => ({ data: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

import { Empty, Loaded, PdpForm, fields } from '../ui';
import { Scoring } from '../ProjectDetail';
import PdpPage from '../PdpPage';

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe('never a blank page', () => {
  it('Loaded shows the API error with Retry, then the content', () => {
    const retry = vi.fn();
    const { rerender } = render(<Loaded state={{ data: null, error: 'connect ECONNREFUSED', loading: false, retry }}>{() => <p>content</p>}</Loaded>);
    expect(screen.getByText(/ECONNREFUSED/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalled();
    rerender(<Loaded state={{ data: { x: 1 }, error: null, loading: false, retry }}>{() => <p>content</p>}</Loaded>);
    expect(screen.getByText('content')).toBeTruthy();
  });
  it('the whole module shows an ErrorState when /options fails (e.g. the database is down)', async () => {
    request.mockRejectedValue(new ApiError(503, 'The service is temporarily unavailable.'));
    render(<PdpPage section="tree" />);
    await waitFor(() => expect(screen.getByText('The service is temporarily unavailable.')).toBeTruthy());
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
  it('an empty list says why it is empty', () => {
    render(<Empty message="No products imported yet. An admin can run the import from Administration." />);
    expect(screen.getByText(/No products imported yet/)).toBeTruthy();
  });
});

describe('forms in the Kaizen style', () => {
  it('required fields are checked first; the API error lands under the field it names', async () => {
    const submit = vi.fn().mockRejectedValueOnce(new ApiError(400, 'Pick a product from the Product Tree.', { error: 'Pick a product from the Product Tree.', code: 'project.treeLink', field: 'productId' }));
    render(<PdpForm spec={fields('title! productId:select', { productId: { options: [{ value: 7, label: 'XtraCol One' }] } })} onSubmit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('Title is required.');
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New adhesive' } });
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Pick a product from the Product Tree.'));
    expect(submit).toHaveBeenCalledWith({ title: 'New adhesive', productId: 7 });
  });
});

describe('priority scoring panel', () => {
  const criteria = [20, 20, 20, 20, 10, 10].map((weight, i) => ({ criterion_id: i + 1, name: `C${i + 1}`, weight, meanings: ['m0', 'm1', 'm2', 'm3 meaning', 'm4', 'm5'] }));
  const d = { project: { code: 'RD-2026-001' }, criteria, scoreRounds: [], settings: { min_score: 60 } };
  it('all 3s = exactly 60 = PASS; evidence is required on every row before it is sent', async () => {
    request.mockResolvedValue({});
    const refresh = vi.fn();
    render(<Scoring d={d} editable refresh={refresh} />);
    screen.getAllByRole('radiogroup').forEach((g) => fireEvent.click(g.querySelectorAll('button')[3]));
    expect(screen.getByTestId('pdp-score-total').textContent).toBe('60');
    expect(screen.getByText('PASS')).toBeTruthy();
    expect(screen.getAllByText('m3 meaning')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Save scoring round' }));
    expect(screen.getAllByText('Evidence is required.')).toHaveLength(6);
    expect(request).not.toHaveBeenCalled();
    for (const c of criteria) fireEvent.change(screen.getByLabelText(`${c.name} evidence`), { target: { value: 'because' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save scoring round' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/projects/RD-2026-001/scores', 'test', 'POST', { scores: criteria.map((c) => ({ criterionId: c.criterion_id, score: 3, evidence: 'because' })) }));
    expect(refresh).toHaveBeenCalled();
  });
  it('a 58 shows BELOW 60', () => {
    render(<Scoring d={d} editable refresh={vi.fn()} />);
    [4, 3, 2, 5, 1, 0].forEach((n, i) => fireEvent.click(screen.getAllByRole('radiogroup')[i].querySelectorAll('button')[n]));
    expect(screen.getByTestId('pdp-score-total').textContent).toBe('58');
    expect(screen.getByText('BELOW 60')).toBeTruthy();
  });
});
