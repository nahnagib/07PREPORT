'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { fetchMarcomPage, MarcomKpiError } from './api';
import { apiQuery, clearStored, EMPTY_FILTERS, MarcomFilters, readStored, restoreFilters, toSearchParams, writeStored } from './filters';
import { createLatestGate } from './requestGate';
import type { PageData, PageKey } from './types';

/**
 * Filter state <-> URL <-> sessionStorage. On mount the URL wins, else the session-stored filters
 * (so filters follow the user between the four pages), and the URL is rewritten so the view is
 * shareable. Changing a filter updates state, storage and URL in one step.
 */
export function useMarcomFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const searchStr = search?.toString() ?? '';

  const [filters, setFiltersState] = useState<MarcomFilters>(() => restoreFilters(searchStr, readStored()));

  const writeUrl = useCallback((f: MarcomFilters) => {
    const qs = toSearchParams(f).toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname]);

  // First render: make the (restored) view shareable. Later: follow browser back/forward.
  const first = useRef(true);
  useEffect(() => {
    const current = toSearchParams(filters).toString();
    if (first.current) {
      first.current = false;
      if (current !== searchStr) writeUrl(filters);
      return;
    }
    if (searchStr !== current) {
      const fromUrl = restoreFilters(searchStr, null);
      setFiltersState(fromUrl);
      writeStored(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchStr]);

  const setFilters = useCallback((next: MarcomFilters) => {
    setFiltersState(next);
    writeStored(next);
    writeUrl(next);
  }, [writeUrl]);

  const reset = useCallback(() => {
    setFiltersState({ ...EMPTY_FILTERS });
    clearStored();
    router.replace(pathname, { scroll: false });
  }, [router, pathname]);

  return { filters, setFilters, reset };
}

export interface MarcomDataState<T extends PageData> {
  data: T | null;
  error: MarcomKpiError | null;
  /** First load (nothing to show yet). */
  loading: boolean;
  /** A newer request is in flight while the previous data stays visible. */
  refreshing: boolean;
  retry: () => void;
}

const DEBOUNCE_MS = 250;

/**
 * Fetches one page's data. Filter changes are debounced; the previous data stays on screen with a
 * "refreshing" flag; only the newest request may publish (out-of-order responses are dropped) and
 * superseded requests are aborted.
 */
export function useMarcomData<T extends PageData>(page: PageKey, token: string | null, filters: MarcomFilters): MarcomDataState<T> {
  const query = useMemo(() => apiQuery(page, filters), [page, filters]);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<MarcomKpiError | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const gate = useRef(createLatestGate());
  const abort = useRef<AbortController | null>(null);
  const hasData = useRef(false);

  useEffect(() => {
    if (!token) return undefined;
    const delay = hasData.current ? DEBOUNCE_MS : 0;
    const timer = setTimeout(async () => {
      const ticket = gate.current.next();
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      setInFlight(true);
      setError(null);
      try {
        const result = await fetchMarcomPage<T>(page, query, token, ctl.signal);
        if (!gate.current.isLatest(ticket)) return; // a newer filter change already took over
        hasData.current = true;
        setData(result);
      } catch (err) {
        if (!gate.current.isLatest(ticket) || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof MarcomKpiError ? err : new MarcomKpiError(0, 'Something went wrong.'));
      } finally {
        if (gate.current.isLatest(ticket)) setInFlight(false);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [page, query, token, reloadKey]);

  useEffect(() => () => { gate.current.cancelAll(); abort.current?.abort(); }, []);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);
  return { data, error, loading: data === null && error === null, refreshing: inFlight && data !== null, retry };
}
