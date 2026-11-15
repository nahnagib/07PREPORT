import { DateTime } from 'luxon';
import { getAppTimezone } from '../../lib/timezone';
import { PdpError } from './errors';

/** Input helpers: every PDP form goes through these, so the rules (and the error codes) are the same everywhere. */

export function text(v: unknown, field: string, opts: { max: number; required?: boolean; label?: string }): string | null {
  const s = typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim();
  const label = opts.label ?? field;
  if (!s) {
    if (opts.required) throw new PdpError('field.required', `${label} is required.`, field);
    return null;
  }
  if (s.length > opts.max) throw new PdpError('field.tooLong', `${label} is limited to ${opts.max} characters.`, field);
  return s;
}

export function reqText(v: unknown, field: string, max: number, label?: string): string {
  return text(v, field, { max, required: true, label }) as string;
}

export function int(v: unknown, field: string, opts: { min?: number; max?: number; required?: boolean; label?: string } = {}): number | null {
  const label = opts.label ?? field;
  if (v === null || v === undefined || v === '') {
    if (opts.required) throw new PdpError('field.required', `${label} is required.`, field);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new PdpError('field.integer', `${label} must be a whole number.`, field);
  if (opts.min !== undefined && n < opts.min) throw new PdpError('field.range', `${label} must be at least ${opts.min}.`, field);
  if (opts.max !== undefined && n > opts.max) throw new PdpError('field.range', `${label} must be at most ${opts.max}.`, field);
  return n;
}

export function num(v: unknown, field: string, opts: { min?: number; max?: number; required?: boolean; label?: string } = {}): number | null {
  const label = opts.label ?? field;
  if (v === null || v === undefined || v === '') {
    if (opts.required) throw new PdpError('field.required', `${label} is required.`, field);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new PdpError('field.number', `${label} must be a number.`, field);
  if (opts.min !== undefined && n < opts.min) throw new PdpError('field.range', `${label} must be at least ${opts.min}.`, field);
  if (opts.max !== undefined && n > opts.max) throw new PdpError('field.range', `${label} must be at most ${opts.max}.`, field);
  return n;
}

export function date(v: unknown, field: string, opts: { required?: boolean; label?: string } = {}): string | null {
  const label = opts.label ?? field;
  if (v === null || v === undefined || v === '') {
    if (opts.required) throw new PdpError('field.required', `${label} is required.`, field);
    return null;
  }
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !DateTime.fromISO(s).isValid) throw new PdpError('field.date', `${label} must be a date (YYYY-MM-DD).`, field);
  return s;
}

export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string, label?: string): T {
  const s = String(v ?? '');
  if (!allowed.includes(s as T)) throw new PdpError('field.invalid', `${label ?? field} is not a valid choice.`, field);
  return s as T;
}

export function id(v: unknown, field: string, label?: string): number {
  return int(v, field, { min: 1, required: true, label }) as number;
}

export function optId(v: unknown, field: string): number | null {
  return int(v, field, { min: 1 });
}

/** A link stored next to a checklist item: http(s) only. */
export function url(v: unknown, field: string): string | null {
  const s = text(v, field, { max: 500 });
  if (s === null) return null;
  if (!/^https?:\/\//i.test(s)) throw new PdpError('field.url', 'Links must start with http:// or https://.', field);
  return s;
}

/** Today in the business timezone (YYYY-MM-DD). */
export function today(): string {
  return DateTime.now().setZone(getAppTimezone()).toISODate() as string;
}

/** An ISO instant as a business date. */
export function businessDate(instant: string | Date): string {
  const dt = instant instanceof Date ? DateTime.fromJSDate(instant) : DateTime.fromISO(instant, { zone: 'utc' });
  return dt.setZone(getAppTimezone()).toISODate() as string;
}
