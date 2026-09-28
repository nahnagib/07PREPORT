'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { filtersFromQuery, filtersToQuery, type KaizenFilters } from '../../lib/kaizen/api';

/**
 * Card-list filters kept in the URL query, so a dashboard drill-down (…/manage?departmentIds=3)
 * opens pre-filtered and the result can be bookmarked or shared. Also carries `no` (the card open
 * in the detail view). Reads window.location rather than useSearchParams to avoid a Suspense
 * boundary on these client pages.
 */
export function useUrlFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFiltersState] = useState<KaizenFilters | null>(null);
  const [openNo, setOpenNoState] = useState<number | null>(null);
  /** True while the open card is a history entry this page pushed (so Back can pop it). */
  const pushedRef = useRef(false);

  const readUrl = useCallback(() => {
    pushedRef.current = false;
    setFiltersState(filtersFromQuery(window.location.search));
    const no = Number(new URLSearchParams(window.location.search).get('no'));
    setOpenNoState(Number.isInteger(no) && no > 0 ? no : null);
  }, []);

  useEffect(() => {
    readUrl();
    window.addEventListener('popstate', readUrl);
    return () => window.removeEventListener('popstate', readUrl);
  }, [readUrl]);

  const write = useCallback(
    (next: KaizenFilters, no: number | null, push: boolean) => {
      const q = filtersToQuery(next, no ? { no: String(no) } : {});
      const url = q ? `${pathname}?${q}` : pathname;
      if (push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [pathname, router],
  );

  const setFilters = useCallback(
    (next: KaizenFilters) => {
      setFiltersState(next);
      write(next, null, false);
    },
    [write],
  );

  /** Opening a card is a history entry, so the phone's back button returns to the list. */
  const setOpenNo = useCallback(
    (no: number | null) => {
      if (no === null && openNo !== null && pushedRef.current) {
        pushedRef.current = false;
        router.back();
        return;
      }
      pushedRef.current = no !== null;
      setOpenNoState(no);
      write(filters ?? {}, no, no !== null);
    },
    [filters, openNo, router, write],
  );

  return { filters, setFilters, openNo, setOpenNo };
}
