'use client';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../AuthProvider';
import { pdp, type Row } from './api';

/** The message to show for a failed call: the API's own `error` text, or a plain "could not reach" line. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}

/** `{ error, code, field }` from a PDP validation error (backend services/pdp/errors.ts). */
export function apiFieldError(err: unknown): { code?: string; field?: string; message: string } {
  const body = err instanceof ApiError && err.body && typeof err.body === 'object' ? (err.body as { code?: string; field?: string }) : {};
  return { code: body.code, field: body.field, message: errorText(err) };
}

export interface PdpState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/**
 * GET one Product Development Plan endpoint. Never leaves the caller guessing: `loading` until the first answer,
 * then either `data` or `error` (the API's message) -- screens render LoadingSkeleton / ErrorState / content from it.
 * `revision` re-fetches after a save; `path = null` skips the call.
 */
export function usePdp<T = Row>(path: string | null, revision = 0): PdpState<T> {
  const { token } = useAuth();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<Omit<PdpState<T>, 'retry'>>({ data: null, error: null, loading: path !== null });
  useEffect(() => {
    if (!path || !token) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    setState((s) => ({ data: s.data, error: null, loading: true }));
    pdp(path, token)
      .then((d) => live && setState({ data: d as T, error: null, loading: false }))
      .catch((e) => live && setState({ data: null, error: errorText(e), loading: false }));
    return () => {
      live = false;
    };
  }, [path, token, revision, nonce]);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, retry };
}
