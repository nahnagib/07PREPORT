/**
 * Thrown for expected, user-facing validation/business-rule failures (bad input, duplicate
 * email, unknown role, wrong current password, etc.) -- routes catch this specifically and
 * return its .message as a clean 400. Anything that is NOT this type falls through to the
 * generic 500 handler in server.ts, which never exposes the raw error (Section 5.9). Using a
 * single plain `Error` for both expected and unexpected failures would risk leaking internal
 * error text (DB errors, etc.) to the client through a route that assumes "any Error = safe to
 * show the user".
 */
export class ValidationError extends Error {}
