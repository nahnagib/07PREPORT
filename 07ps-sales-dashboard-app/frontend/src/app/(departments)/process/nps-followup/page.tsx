'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import { Button, EmptyState, ErrorState, LoadingSkeleton } from '@07ps/ui';
import { FilterBar } from '../../../../components/FilterBar';
import { PermissionGuard } from '../../../../components/AuthGuard';
import { useFilterState, useScopedFilterOptions } from '../../../../components/FilterProvider';
import { CaseDetail } from '../../../../components/nps-followup/CaseDetail';
import { FollowupHelp } from '../../../../components/nps-followup/FollowupHelp';
import { CaseCard, FollowupShell, SlaKpis, StagePill, StatusBadge, TimeOpen } from '../../../../components/nps-followup/FollowupBits';
import { KaizenKpi } from '../../../../components/kaizen/KaizenBits';
import { useAuth } from '../../../../lib/AuthProvider';
import { ApiError } from '../../../../lib/api';
import {
  BOARD_COLUMNS,
  EMPTY_FILTERS,
  NO_OWNER,
  STAGES,
  STAGE_COLOR,
  STAGE_LABEL,
  STATUSES,
  STATUS_COLOR,
  STATUS_LABEL,
  apiQuery,
  byColumn,
  filtersFromSearch,
  filtersToSearch,
  followupApi,
  groupReasons,
  type FollowupBoard,
  type FollowupCase,
  type FollowupFilters,
  type FollowupOptions,
  type FollowupStage,
  type FollowupStatus,
  type Paged,
} from '../../../../lib/nps/followup';

/**
 * NPS Detractor Follow-up (Process department; docs/nps-followup.md). One case per detractor rating, created by the
 * NPS refresh (process_nps, in the 30-minute refresh and the 02:00 full run): a new detractor appears here within 30 minutes.
 *
 * Stage and status are separate (lib/nps/followup.ts): the board's columns are STAGES, New -> Contacted -> In progress
 * -> Resolved -> Unresolved (Resolved shows the last 30 days only, Unresolved has no window; Historical cases, rated before
 * the cut-over, are in the List view only); the badge on each card is its STATUS (Open / Close / Disputed, from the
 * stage), so every card of a column has the same badge. The Open / Close / Disputed KPIs come from the status, the
 * time KPIs from the stage and its times. List: every case, paged, newest first.
 * Filters: the global FilterBar (company, customer group, channel, branch, salesperson, customer -- the role's data
 * scope applies) + the follow-up's own (rating dates, stage, status, reason category and sub-reason, owner, search),
 * kept in the URL so a chart on the NPS page can link here pre-filtered. A card opens the case (?case=ID): the rating,
 * the comment, the follow-up form and its history.
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
      view={view}
      onView={(v) => filters && setFilters({ ...filters, view: v, stages: v === 'board' ? filters.stages.filter((x) => x !== 'HISTORICAL') : filters.stages })}
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
            <section className="ps-fu-kpis" aria-label="Status" data-testid="fu-kpis-status">
              {/* by STATUS: every case of the filters (Historical has no status) */}
              {STATUSES.map((s) => (
                <KaizenKpi key={s} label={<span className="ps-fu-help-label"><span>{STATUS_LABEL[s]}</span><FollowupHelp kind="status" value={s} /></span>} value={String(board.kpis[STATUS_KPI[s]])}
                  sub={`${sharePct(board.kpis[STATUS_SHARE[s]])} of ${board.kpis.total} · ${STATUS_HINT[s]}`} accent={STATUS_COLOR[s]} />
              ))}
            </section>
            <SlaKpis kpis={board.kpis} />
            <p className="ps-fu-muted" style={{ margin: 0 }}>
              New detractors appear as cases within 30 minutes (the refresh runs every 30 min). The columns are stages; the badge is the status. Resolved shows the last 30 days; Historical cases are in the List view.
              {board.truncated ? ' Only the first 2,000 cases are shown: narrow the filters.' : ''}
            </p>
            {board.cases.length === 0 && <EmptyState message="No cases for these filters." />}
            <section className="ps-fu-board" aria-label="Board" data-testid="fu-board">
              {BOARD_COLUMNS.map((s) => (
                <div key={s} className="ps-fu-col" data-testid={`fu-col-${s}`}>
                  <div className="ps-fu-col-head" style={{ borderTopColor: STAGE_COLOR[s] }}>
                    <span className="ps-fu-help-label"><span>{STAGE_LABEL[s]}{s === 'RESOLVED' ? ' (30 days)' : ''}</span><FollowupHelp kind="stage" value={s} /></span>
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

const STATUS_KPI = { OPEN: 'open', CLOSED: 'close', DISPUTED: 'disputed' } as const;
const STATUS_SHARE = { OPEN: 'openShare', CLOSED: 'closeShare', DISPUTED: 'disputedShare' } as const;
const STATUS_HINT: Record<FollowupStatus, string> = { OPEN: 'New, Contacted, In progress', CLOSED: 'Resolved', DISPUTED: 'Unresolved' };
const sharePct = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);

/** Rating dates, stage, status, reason category and sub-reason, owner and search. */
function OwnFilters({ filters, options, onChange }: { filters: FollowupFilters; options: FollowupOptions | null; onChange: (f: FollowupFilters) => void }) {
  const [search, setSearch] = useState(filters.search ?? '');
  useEffect(() => setSearch(filters.search ?? ''), [filters.search]);
  const stages = filters.view === 'board' ? BOARD_COLUMNS : STAGES;
  const categories = useMemo(() => groupReasons(options?.reasons ?? []), [options]);
  const category = categories.find((c) => c.categoryKey === filters.categories[0]);
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
      <div className="ps-kaizen-field">
        <span className="ps-fu-help-label"><label htmlFor="fu-filter-stage">Stage</label><FollowupHelp kind="stage" /></span>
        <select id="fu-filter-stage" className="ps-kaizen-input" data-testid="fu-filter-stage" value={filters.stages[0] ?? ''}
          onChange={(e) => onChange({ ...filters, stages: one(e.target.value, (s) => s as FollowupStage) })}>
          <option value="">All</option>
          {stages.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
      </div>
      <div className="ps-kaizen-field">
        <span className="ps-fu-help-label"><label htmlFor="fu-filter-status">Status</label><FollowupHelp kind="status" /></span>
        <select id="fu-filter-status" className="ps-kaizen-input" data-testid="fu-filter-status" value={filters.statuses[0] ?? ''}
          onChange={(e) => onChange({ ...filters, statuses: one(e.target.value, (s) => s as FollowupStatus) })}>
          <option value="">All</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      <label className="ps-kaizen-field">
        <span>Reason category</span>
        <select className="ps-kaizen-input" value={filters.categories[0] ?? ''}
          onChange={(e) => onChange({ ...filters, categories: one(e.target.value, String), reasonIds: [] })}>
          <option value="">All</option>
          {categories.map((c) => <option key={c.categoryKey} value={c.categoryKey}>{c.categoryEn}</option>)}
        </select>
      </label>
      {category && category.subReasons.length > 0 && (
        <label className="ps-kaizen-field">
          <span>Sub-reason</span>
          <select className="ps-kaizen-input" value={filters.reasonIds[0] ?? ''} onChange={(e) => onChange({ ...filters, reasonIds: one(e.target.value, Number) })}>
            <option value="">All</option>
            <option value={category.row.reasonId}>Not specified</option>
            {category.subReasons.map((r) => <option key={r.reasonId} value={r.reasonId}>{r.subReasonEn}</option>)}
          </select>
        </label>
      )}
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
      {(filters.dateFrom || filters.dateTo || filters.stages.length || filters.statuses.length || filters.categories.length || filters.reasonIds.length
        || filters.owners.length || filters.search || filters.sourceChanged !== undefined) ? (
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
              <th>Case</th><th>Rated at</th><th><span className="ps-fu-help-label">Stage<FollowupHelp kind="stage" /></span></th><th><span className="ps-fu-help-label">Status<FollowupHelp kind="status" /></span></th><th>Customer</th><th>Order</th><th>Company · Branch</th><th>Reason</th><th>Owner</th><th>Time open / Resolved in</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((c) => (
              <tr key={c.caseId} onClick={() => onOpen(c.caseId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(c.caseId)}>
                <td>#{c.caseId}{c.sourceChanged ? ' ⚠' : ''}</td>
                <td>{c.ratedAt?.slice(0, 16) ?? '—'}</td>
                <td><StagePill stage={c.stage} /></td>
                <td>{c.status ? <StatusBadge status={c.status} /> : '—'}</td>
                <td dir="auto">{c.customer ?? '—'}</td>
                <td>{c.orderRef ?? c.deliveryCode ?? '—'}</td>
                <td>{[c.company, c.teamBranch ?? c.salesTeam].filter(Boolean).join(' · ') || '—'}</td>
                <td title={c.reasonNote ?? undefined}>{c.reasonLabelEn ?? '—'}</td>
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
