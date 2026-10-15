'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminApi, ApiError, type DataScopeValue } from './api';
import { useAuth } from './AuthProvider';
import { normalizeDimensionValues } from './dataScope';

/** Loaded lists per dimension, shared by every rule row (one request per dimension per page visit). */
const cache = new Map<string, DataScopeValue[]>();
const inFlight = new Map<string, Promise<DataScopeValue[]>>();

function load(token: string, dimension: string): Promise<DataScopeValue[]> {
  const cached = cache.get(dimension);
  if (cached) return Promise.resolve(cached);
  let p = inFlight.get(dimension);
  if (!p) {
    p = adminApi
      .getDimensionValues(token, dimension)
      .then((r) => {
        const values = normalizeDimensionValues(r?.values ?? r);
        cache.set(dimension, values);
        return values;
      })
      .finally(() => inFlight.delete(dimension));
    inFlight.set(dimension, p);
  }
  return p;
}

/**
 * Every value of one data-scope dimension for the Roles page's value picker (GET /admin/roles/dimension-values/:d --
 * all data, never the admin's own scope), normalised to [{ value, label }]. Loads when the row mounts and again
 * whenever `dimension` changes; `loading` while fetching, `error` (shown, never swallowed) when the request fails,
 * `retry` to try again. An empty `dimension` returns no options and no request.
 */
export function useDimensionValues(dimension: string): {
  options: DataScopeValue[];
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const { token } = useAuth();
  const [state, setState] = useState<{ dimension: string; options: DataScopeValue[]; loading: boolean; error: string | null }>({
    dimension,
    options: cache.get(dimension) ?? [],
    loading: !!dimension && !cache.has(dimension),
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!dimension) {
      setState({ dimension, options: [], loading: false, error: null });
      return;
    }
    if (!token) return;
    let current = true;
    const cached = cache.get(dimension);
    setState({ dimension, options: cached ?? [], loading: !cached, error: null });
    if (cached) return;
    load(token, dimension)
      .then((options) => current && setState({ dimension, options, loading: false, error: null }))
      .catch((err) =>
        current &&
        setState({ dimension, options: [], loading: false, error: err instanceof ApiError ? err.message : 'Could not load the values for this dimension.' }),
      );
    return () => {
      current = false;
    };
  }, [dimension, token, attempt]);

  const retry = useCallback(() => {
    cache.delete(dimension);
    setAttempt((a) => a + 1);
  }, [dimension]);

  // never hand a row the previous dimension's list while the new one loads
  const fresh = state.dimension === dimension;
  return {
    options: fresh ? state.options : [],
    loading: fresh ? state.loading : !!dimension,
    error: fresh ? state.error : null,
    retry,
  };
}

/** For tests: forget every loaded list. */
export function clearDimensionValuesCache(): void {
  cache.clear();
  inFlight.clear();
}
