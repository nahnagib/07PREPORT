import { ValidationError } from '../../lib/errors';

/**
 * Product Development Plan validation error: a stable `code` (the frontend maps it to text, lib/pdp/text.ts), the
 * message, and the form field it belongs to -- the same `{ error, code, field }` shape as KaizenValidationError.
 * `status` defaults to 400; codes ending in `.notFound` are 404, permission-like refusals 403.
 */
export class PdpError extends ValidationError {
  code: string;
  field?: string;
  status: number;
  constructor(code: string, message: string, field?: string, status?: number) {
    super(message);
    this.code = code;
    this.field = field;
    this.status = status ?? (code.endsWith('.notFound') ? 404 : 400);
  }
}

export function notFound(what: string): PdpError {
  return new PdpError(`${what}.notFound`, `${what.charAt(0).toUpperCase()}${what.slice(1)} not found.`);
}
