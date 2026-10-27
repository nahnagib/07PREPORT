'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import { Button, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import { CaseDetail } from '../../../../components/nps-followup/CaseDetail';
import { CaseCard, FollowupShell, StatusPill, TimeOpen } from '../../../../components/nps-followup/FollowupBits';
import { KaizenKpi } from '../../../../components/kaizen/KaizenBits';
import { useAuth } from '../../../../lib/AuthProvider';
import { ApiError } from '../../../../lib/api';
import {
  BAND_COLOR,
  BOARD_COLUMNS,
  EMPTY_FILTERS,
  NO_OWNER,
  STATUSES,
  STATUS_COLOR,
  STATUS_LABEL,
  apiQuery,
  byColumn,
  filtersFromSearch,
  filtersToSearch,
  followupApi,
  type FollowupBoard,
  type FollowupCase,
  type FollowupFilters,
  type FollowupOptions,
  type FollowupStatus,
  type Paged,
} from '../../../../lib/nps/followup';

/**
 * NPS Detractor Follow-up (Process department; docs/nps-followup.md). One case per detractor rating, created by the
 * nightly NPS refresh (process_nps, 02:00): a new detractor appears here the next morning.
 *
 * Board: a column per status, New -> Contacted -> In progress -> Solved -> Cancelled; Solved shows the last 30 days
 * only; Historical cases (rated before the cut-over) are in the List view only. List: every case, paged, newest first.
 * Filters: the global FilterBar (company, customer group, channel, branch, salesperson, customer -- the role's data
 * scope applies) + the follow-up's own (rating dates, status, reason, owner, search), kept in the URL so a chart on the
 * NPS page can link here pre-filtered. A card opens the case (?case=ID): the rating, the comment, the follow-up form
 * and its history.
 */
export default function NpsFollowupPage() {
  return (
    <PermissionGuard pageKey="nps_followup">
      <FollowupBody />
    </PermissionGuard>
  );
}

const LIST_PAGE = 100;

function FollowupBody() {
  const { token, isSalesperson, canExport } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { effectiveFilters, onFiltersChange, anchorDate, onAnchorDateChange } = useFilterState();
  const filterOptions = useScopedFilterOptions();

  const [filters, setFiltersState] = useState<FollowupFilters | null>(null);
  const [openCase, setOpenCase] = useState<number | null>(null);
  const [options, setOptions] = useState<FollowupOptions | null>(null);
  const [board, setBoard] = useState<FollowupBoard | null>(null);
  const [list, setList] = useState<Paged<FollowupCase> | null>(null);
  const [listPages, setListPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [version, setVersion] = useState(0);

  // the follow-up filters and the open case live in the URL (bookmarkable; Back closes a case)
  useEffect(() => {
    const read = () => {
      const { caseId, ...f } = filtersFromSearch(window.location.search);
      setFiltersState(f);
      setOpenCase(caseId);
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  const writeUrl = useCallback((f: FollowupFilters, caseId: number | null, push: boolean) => {
    const q = filtersToSearch(f, caseId);
    const url = q ? `${pathname}?${q}` : pathname;
    if (push) router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  }, [pathname, router]);

  const setFilters = (next: FollowupFilters) => {
    setFiltersState(next);
    setListPages(1);
    writeUrl(next, null, false);
  };
  const open = (id: number | null) => {
    setOpenCase(id);
    if (filters) writeUrl(filters, id, id !== null);
  };

  useEffect(() => {
    if (!token) return;
    followupApi.options(token).then(setOptions).catch(() => setOptions(null));
  }, [token]);

  const query = useMemo(() => (filters ? apiQuery(effectiveFilters, filters) : null), [effectiveFilters, filters]);

  useEffect(() => {
    if (!token || !filters || query === null) return;
    let live = true;
    setError(null);
    const req = filters.view === 'board'
      ? followupApi.board(token, query).then((b) => live && (setBoard(b), setList(null)))
      : followupApi.cases(token, apiQuery(effectiveFilters, filters, { page: 1, pageSize: LIST_PAGE * listPages })).then((l) => live && (setList(l), setBoard(null)));
    req.catch((err) => live && setError(err instanceof ApiError ? err.message : 'Failed to load the cases.'));
    return () => {
      live = false;
    };
  }, [token, query, filters, effectiveFilters, listPages, version]);

  async function exportList() {
    if (!token || !filters) return;
    setExporting(true);
    try {
      await followupApi.exportCases(token, apiQuery(effectiveFilters, filters));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  const view = filters?.view ?? 'board';
  const columns = board ? byColumn(board.cases) : null;

  return (
    <FollowupShell
      title="Detractor Follow-up"
      view={view}
      onView={(v) => filters && setFilters({ ...filters, view: v, statuses: v === 'board' ? filters.statuses.filter((x) => x !== 'HISTORICAL') : filters.statuses })}
      actions={canExport('nps_followup') ? (
        <Button variant="secondary" onClick={exportList} disabled={exporting || !filters}>
          <Download size={15} style={{ marginInlineEnd: 6 }} />{exporting ? 'Exporting…' : 'Export'}
        </Button>
      ) : undefined}
      filters={
        <FilterBar
          filters={effectiveFilters}
          onChange={onFiltersChange}
          anchorDate={anchorDate}
          onAnchorDateChange={onAnchorDateChange}
          businessUnits={filterOptions.businessUnits.data ?? []}
          customerGroups={filterOptions.customerGroups.data ?? []}
          distributionChannels={filterOptions.distributionChannels.data ?? []}
          branches={filterOptions.branches.data ?? []}
          salespersons={filterOptions.salespersons.data ?? []}
          isSalesperson={isSalesperson}
          showDateRange={false}
          showLastOrderInfo={false}
          showCustomerFilter
        />
      }
    >
      {filters && <OwnFilters filters={filters} options={options} onChange={setFilters} />}

      {error ? (
        <ErrorState message={error} onRetry={() => setVersion((v) => v + 1)} />
      ) : view === 'board' ? (
        !board || !columns ? (
          <LoadingSkeleton variant="chart" />
        ) : (
          <>
            <section className="ps-fu-kpis" aria-label="Summary">
              <KaizenKpi label="Open" value={String(board.kpis.open)} sub="New, Contacted, In progress" accent="var(--ps-color-accent)" />
              <KaizenKpi label="Open over 5 days" value={String(board.kpis.openOver5Days)} sub="red on the board" accent={BAND_COLOR.red} />
              <KaizenKpi label="Solved, last 30 days" value={String(board.kpis.solved30Days)}
                sub={`${board.kpis.solvedWithin48h} within 48 h`} accent={BAND_COLOR.green} />
              <KaizenKpi label="Not classified" value={String(board.kpis.noReason)} sub="no reason chosen yet" accent="var(--ps-color-watch)" />
            </section>
            <p className="ps-fu-muted" style={{ margin: 0 }}>
              New detractors appear as cases after the nightly refresh at 02:00 (the next morning). Solved shows the last 30 days; Historical cases are in the List view.
              {board.truncated ? ' Only the first 2,000 cases are shown: narrow the filters.' : ''}
            </p>
            {board.cases.length === 0 && <EmptyState message="No cases for these filters." />}
            <section className="ps-fu-board" aria-label="Board" data-testid="fu-board">
              {BOARD_COLUMNS.map((s) => (
                <div key={s} className="ps-fu-col" data-testid={`fu-col-${s}`}>
                  <div className="ps-fu-col-head" style={{ borderTopColor: STATUS_COLOR[s] }}>
                    <span>{STATUS_LABEL[s]}{s === 'SOLVED' ? ' (30 days)' : ''}</span>
                    <span className="ps-fu-count">{columns[s].length}</span>
                  </div>
                  <div className="ps-fu-col-body">
                    {columns[s].length === 0 ? <div className="ps-fu-muted ps-fu-empty">—</div> : columns[s].map((c) => <CaseCard key={c.caseId} c={c} onOpen={open} />)}
                  </div>
                </div>
              ))}
            </section>
          </>
        )
      ) : !list ? (
        <LoadingSkeleton variant="table" />
      ) : (
        <CaseList list={list} onOpen={open} onMore={() => setListPages((p) => p + 1)} />
      )}

      {openCase !== null && (
        <CaseDetail caseId={openCase} options={options} onClose={() => open(null)} onSaved={() => setVersion((v) => v + 1)} />
      )}
    </FollowupShell>
  );
}

/** Rating dates, status, reason, owner, "source changed", search. */
function OwnFilters({ filters, options, onChange }: { filters: FollowupFilters; options: FollowupOptions | null; onChange: (f: FollowupFilters) => void }) {
  const [search, setSearch] = useState(filters.search ?? '');
  useEffect(() => setSearch(filters.search ?? ''), [filters.search]);
  const statuses = filters.view === 'board' ? BOARD_COLUMNS : STATUSES;
  const one = <T,>(v: string, parse: (s: string) => T): T[] => (v === '' ? [] : [parse(v)]);
  return (
    <section className="ps-fu-filters" aria-label="Follow-up filters">
      <label className="ps-kaizen-field">
        <span>Rated from</span>
        <input type="date" className="ps-kaizen-input" value={filters.dateFrom ?? ''} onChange={(e) => onChange({ ...filters, dateFrom: e.target.value || undefined })} />
      </label>
      <label className="ps-kaizen-field">
        <span>Rated to</span>
        <input type="date" className="ps-kaizen-input" value={filters.dateTo ?? ''} onChange={(e) => onChange({ ...filters, dateTo: e.target.value || undefined })} />
      </label>
      <label className="ps-kaizen-field">
        <span>Status</span>
        <select className="ps-kaizen-input" value={filters.statuses[0] ?? ''} onChange={(e) => onChange({ ...filters, statuses: one(e.target.value, (s) => s as FollowupStatus) })}>
          <option value="">All</option>
          {statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </label>
      <label className="ps-kaizen-field">
        <span>Reason</span>
        <select className="ps-kaizen-input" value={filters.reasonIds[0] ?? ''} onChange={(e) => onChange({ ...filters, reasonIds: one(e.target.value, Number) })}>
          <option value="">All</option>
          {(options?.reasons ?? []).map((r) => <option key={r.reasonId} value={r.reasonId}>{r.nameEn}</option>)}
        </select>
      </label>
      <label className="ps-kaizen-field">
        <span>Owner</span>
        <select className="ps-kaizen-input" value={filters.owners[0] ?? ''} onChange={(e) => onChange({ ...filters, owners: one(e.target.value, String) })}>
          <option value="">All</option>
          <option value={NO_OWNER}>No owner</option>
          {(options?.owners ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      <form className="ps-kaizen-field" onSubmit={(e) => { e.preventDefault(); onChange({ ...filters, search: search.trim() || undefined }); }}>
        <span>Search</span>
        <input type="search" className="ps-kaizen-input" placeholder="Customer, order, delivery, #case" value={search}
          onChange={(e) => setSearch(e.target.value)} onBlur={() => (search.trim() || undefined) !== filters.search && onChange({ ...filters, search: search.trim() || undefined })} />
      </form>
      <label className="ps-fu-check">
        <input type="checkbox" checked={filters.sourceChanged === true} onChange={(e) => onChange({ ...filters, sourceChanged: e.target.checked ? true : undefined })} />
        Source changed only
      </label>
      {(filters.dateFrom || filters.dateTo || filters.statuses.length || filters.reasonIds.length || filters.owners.length || filters.search || filters.sourceChanged !== undefined) ? (
        <Button variant="secondary" onClick={() => onChange({ ...EMPTY_FILTERS, view: filters.view })}>Clear</Button>
      ) : null}
    </section>
  );
}

function CaseList({ list, onOpen, onMore }: { list: Paged<FollowupCase>; onOpen: (id: number) => void; onMore: () => void }) {
  if (list.total === 0) return <EmptyState message="No cases for these filters." />;
  return (
    <section aria-label="Cases" className="ps-fu-list-wrap">
      <div className="ps-fu-muted" style={{ marginBottom: 8 }}>{list.total} case{list.total === 1 ? '' : 's'} · newest rating first</div>
      <div className="ps-fu-table-scroll">
        <table className="ps-fu-table" data-testid="fu-list">
          <thead>
            <tr>
              <th>Case</th><th>Rated at</th><th>Status</th><th>Customer</th><th>Order</th><th>Company · Branch</th><th>Reason</th><th>Owner</th><th>Time open</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((c) => (
              <tr key={c.caseId} onClick={() => onOpen(c.caseId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(c.caseId)}>
                <td>#{c.caseId}{c.sourceChanged ? ' ⚠' : ''}</td>
                <td>{c.ratedAt?.slice(0, 16) ?? '—'}</td>
                <td><StatusPill status={c.status} /></td>
                <td dir="auto">{c.customer ?? '—'}</td>
                <td>{c.orderRef ?? c.deliveryCode ?? '—'}</td>
                <td>{[c.company, c.teamBranch ?? c.salesTeam].filter(Boolean).join(' · ') || '—'}</td>
                <td>{c.reasonEn ?? '—'}</td>
                <td>{c.ownerName ?? '—'}</td>
                <td><TimeOpen c={c} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.rows.length < list.total && (
        <div style={{ marginTop: 10 }}><Button variant="secondary" onClick={onMore}>Show more ({list.total - list.rows.length} left)</Button></div>
      )}
    </section>
  );
}
