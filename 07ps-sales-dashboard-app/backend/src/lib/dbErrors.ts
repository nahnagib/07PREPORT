import type { Request, Response } from 'express';

/**
 * Network-level failures that mean "the data store can't be reached right now" -- as opposed to a
 * bad query or bad credentials. These are transient/infrastructure problems, so callers should
 * answer 503 (retry later), not 500 (a bug) and never 401 (the user did nothing wrong).
 */
const CONNECTION_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
]);

export function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, cause, errors } = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
  // Node wraps dual-stack (IPv4 + IPv6) connect failures in an AggregateError with no top-level code.
  if (Array.isArray(errors) && errors.length > 0 && errors.every(isConnectionError)) return true;
  return cause !== undefined && cause !== err && isConnectionError(cause);
}

export const SERVICE_UNAVAILABLE_MESSAGE = 'Service temporarily unavailable. Please try again shortly.';

/** Logs the real error with the request ID and replies 503 with that same ID. */
export function sendServiceUnavailable(req: Request, res: Response, err: unknown, context: string): void {
  const requestId = req.id;
  const e = err as { code?: string; syscall?: string; message?: string };
  // eslint-disable-next-line no-console
  console.error(`[${requestId}] ${context}: data store unreachable`, {
    code: e?.code,
    syscall: e?.syscall,
    message: e?.message,
  });
  res.status(503).json({ error: SERVICE_UNAVAILABLE_MESSAGE, requestId });
}
