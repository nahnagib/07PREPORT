'use client';
import { useCallback, useEffect, useState } from 'react';
import { currencyFromSearch, searchWithCurrency } from './view';

/**
 * The Receivables and Collections page's currency filter, kept in the URL (?currency=USD) so the view can be shared and
 * survives a refresh; null = "All currencies (≈ LYD)". Reads window.location rather than useSearchParams to avoid a
 * Suspense boundary (as components/kaizen/useUrlFilters.ts does) and writes with history.replaceState, which Next.js
 * (>= 14.1) keeps in sync with its router without a navigation -- router.replace would reset the tab title AppHeader
 * set. `ready` turns true once the URL has been read, so the page does not load the all-currencies data first and
 * then the picked currency's.
 */
export function useUrlCurrency(): { currency: string | null; setCurrency: (c: string | null) => void; ready: boolean } {
  const [currency, setState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const read = () => setState(currencyFromSearch(window.location.search));
    read();
    setReady(true);
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  const setCurrency = useCallback((c: string | null) => {
    setState(c);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${searchWithCurrency(search, c)}${hash}`);
  }, []);

  return { currency, setCurrency, ready };
}
