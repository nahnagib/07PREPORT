import { ValidationError } from '../lib/errors';
import { CAMPAIGN_STATUSES, PLATFORMS, YEAR_MAX, YEAR_MIN } from '../marcom/templateConfig';

export class KpiParamError extends ValidationError {}

type Raw = Record<string, unknown>;

/** Accepts `k=1&k=2`, `k[]=1&k[]=2` (qs flattens the brackets) and `k=1,2`. */
function listOf(raw: Raw, key: string): string[] | undefined {
  const v = raw[key] ?? raw[`${key}[]`];
  if (v === undefined || v === '') return undefined;
  const items = (Array.isArray(v) ? v : [v]).flatMap((x) => {
    if (typeof x !== 'string') throw new KpiParamError(`${key} must be a list of plain values.`);
    return x.split(',');
  });
  return items.map((s) => s.trim()).filter((s) => s !== '');
}

function intIn(raw: Raw, key: string, min: number, max: number): number | undefined {
  const v = raw[key];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !/^-?\d+$/.test(v.trim())) throw new KpiParamError(`${key} must be a whole number.`);
  const n = Number(v);
  if (n < min || n > max) throw new KpiParamError(`${key} must be between ${min} and ${max}.`);
  return n;
}

export interface CommonRaw { year?: number; fromMonth?: number; toMonth?: number }

/** Syntactic validation only (ranges/types); defaults and existence checks come later. */
export function parseCommonRaw(raw: Raw): CommonRaw {
  const out: CommonRaw = {
    year: intIn(raw, 'year', YEAR_MIN, YEAR_MAX),
    fromMonth: intIn(raw, 'fromMonth', 1, 12),
    toMonth: intIn(raw, 'toMonth', 1, 12),
  };
  if (out.fromMonth !== undefined && out.toMonth !== undefined && out.fromMonth > out.toMonth) {
    throw new KpiParamError('fromMonth must not be after toMonth.');
  }
  return out;
}

/** Fills year / fromMonth / toMonth from the latest uploaded period. */
export function applyDefaults(c: CommonRaw, latest: { year: number; month: number } | null, fallbackYear: number) {
  const year = c.year ?? latest?.year ?? fallbackYear;
  const fromMonth = c.fromMonth ?? 1;
  const toMonth = c.toMonth ?? Math.max(fromMonth, latest ? latest.month : 12);
  return { year, fromMonth, toMonth };
}

export function parseBrandIds(raw: Raw, known: { id: number; name: string }[]): number[] | undefined {
  const items = listOf(raw, 'brandIds');
  if (!items) return undefined;
  const ids = items.map((s) => {
    if (!/^\d+$/.test(s)) throw new KpiParamError(`brandIds must be whole numbers (got "${s.slice(0, 20)}").`);
    return Number(s);
  });
  const missing = ids.filter((id) => !known.some((b) => b.id === id));
  if (missing.length) throw new KpiParamError(`Unknown brand id(s): ${[...new Set(missing)].join(', ')}.`);
  return [...new Set(ids)];
}

function enumList<T extends string>(raw: Raw, key: string, allowed: readonly T[]): T[] | undefined {
  const items = listOf(raw, key);
  if (!items) return undefined;
  const bad = items.filter((s) => !allowed.includes(s as T));
  if (bad.length) throw new KpiParamError(`Unknown ${key}: ${bad.map((b) => `"${b.slice(0, 30)}"`).join(', ')}. Allowed: ${allowed.join(', ')}.`);
  return [...new Set(items as T[])];
}

export const parsePlatforms = (raw: Raw) => enumList(raw, 'platforms', PLATFORMS);
export const parseStatuses = (raw: Raw) => enumList(raw, 'status', CAMPAIGN_STATUSES);

export function parseBool(raw: Raw, key: string): boolean | undefined {
  const v = raw[key];
  if (v === undefined || v === '') return undefined;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new KpiParamError(`${key} must be true or false.`);
}
