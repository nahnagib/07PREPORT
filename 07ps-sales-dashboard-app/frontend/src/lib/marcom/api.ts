import { API_BASE } from '../api';
import type { PageData, PageKey } from './types';

export class MarcomKpiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'MarcomKpiError';
    this.status = status;
    this.code = code;
  }
}

/** One request per page load (and one per filter change): the whole page's data in a single call. */
export async function fetchMarcomPage<T extends PageData = PageData>(
  page: PageKey,
  query: string,
  token: string,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/marcom/kpi/${page}${query ? `?${query}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new MarcomKpiError(0, 'Could not reach the server. It may be offline or unreachable.', 'NETWORK');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body === 'object') {
        if (typeof body.error === 'string') message = body.error;
        if (typeof body.code === 'string') code = body.code;
      }
    } catch {
      // keep the generic message
    }
    throw new MarcomKpiError(res.status, message, code);
  }
  return (await res.json()) as T;
}
