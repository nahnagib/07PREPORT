import type { Kpi, Status, Unit } from './types';
import { APP_TIMEZONE, DISPLAY_LOCALE, formatDate } from '../format';
import { t } from './text';

/**
 * Display formatting for the MARCOM pages (the API returns raw numbers only):
 *   LYD amounts "LYD 1,234", percentages with one decimal, ratios "1 : 5.6", minutes "3.5 min"
 *   (tooltip "3 min 30 s"), dates "28 Sep 2026" (the app-wide en-GB format, lib/format.ts). Null / non-finite input always renders "n/a" --
 *   never "NaN", "Infinity" or "undefined".
 */
let LOCALE: string = DISPLAY_LOCALE; // app-wide en-GB; tests may pin another locale
export function setFormatLocale(locale: string | undefined): void { LOCALE = locale ?? DISPLAY_LOCALE; }

const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const NA = () => t('generic.na');

function num(v: number, min: number, max: number): string {
  return v.toLocaleString(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max });
}

export function fmtInt(v: number | null | undefined): string {
  return ok(v) ? num(v, 0, 0) : NA();
}

export function fmtLyd(v: number | null | undefined, digits = 0): string {
  return ok(v) ? `${t('unit.lyd')} ${num(v, digits, digits)}` : NA();
}

/** Axis ticks: 1.2M / 340K / 950. */
export function fmtCompact(v: number | null | undefined): string {
  if (!ok(v)) return NA();
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${num(v / 1_000_000, 0, 1)}M`;
  if (a >= 1_000) return `${num(v / 1_000, 0, 1)}K`;
  return num(v, 0, 1);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  return ok(v) ? `${num(v, digits, digits)}%` : NA();
}

export function fmtSignedPct(v: number | null | undefined, digits = 1): string {
  if (!ok(v)) return NA();
  return `${v > 0 ? '+' : ''}${num(v, digits, digits)}%`;
}

/** "1 : 5.6" -- up to two decimals, trailing zeros trimmed. */
export function fmtRatio(v: number | null | undefined): string {
  return ok(v) ? `1 : ${num(v, 0, 2)}` : NA();
}

export function fmtMinutes(v: number | null | undefined): string {
  return ok(v) ? `${num(v, 0, 1)} ${t('unit.min')}` : NA();
}

/** Tooltip for minutes: 3.5 -> "3 min 30 s". */
export function minutesLong(v: number | null | undefined): string {
  if (!ok(v)) return NA();
  const total = Math.round(v * 60);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' (string surgery: no timezone shifts). */
export function fmtDate(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  // The calendar date as written (no timezone shift), in the app-wide "10 Aug 2026" format.
  return m ? formatDate(`${m[1]}-${m[2]}-${m[3]}`, undefined, NA()) : NA();
}

/** Any ISO timestamp -> "28 Sep 2026" in the business timezone (upload dates). */
export function fmtTimestampDate(iso: string | null | undefined): string {
  if (!iso) return NA();
  return formatDate(iso, APP_TIMEZONE, NA());
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthName(month: number, style: 'long' | 'short' = 'short'): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) return NA();
  // Short names are fixed three letters: en-GB Intl data can render September as "Sept".
  if (style === 'short') return SHORT_MONTHS[month - 1];
  return new Intl.DateTimeFormat(LOCALE, { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month - 1, 1)));
}

export const monthYear = (year: number, month: number) => `${monthName(month, 'long')} ${year}`;

/** Formats a KPI's value by its unit. `digits` overrides the default precision. */
export function fmtKpiValue(k: Kpi | null | undefined, digits?: number): string {
  if (!k || !ok(k.value)) return NA();
  switch (k.unit) {
    case 'ratio': return fmtRatio(k.value);
    case 'percent': return fmtPct(k.value, digits ?? 1);
    case 'lyd': return fmtLyd(k.value, digits ?? (Math.abs(k.value) < 1000 ? 2 : 0));
    case 'minutes': return fmtMinutes(k.value);
    case 'days': return `${num(k.value, 0, 0)} d`;
    default: return fmtInt(k.value);
  }
}

/** Below this (in the KPI's display unit) a change rounds to zero and reads as "unchanged", never as a red/green arrow. */
const FLAT_EPS: Record<Unit, number> = { percent: 0.05, ratio: 0.005, lyd: 0.005, minutes: 0.05, count: 0.5, days: 0.5 };

/** Signed change in the KPI's own unit ("+2.6", "-1.5 pp", "+0.5 min"). */
export function fmtDelta(k: Kpi | null | undefined): string | null {
  if (!k || !ok(k.delta)) return null;
  const a = Math.abs(k.delta);
  const sign = a < FLAT_EPS[k.unit] ? '' : k.delta > 0 ? '+' : '−';
  switch (k.unit) {
    case 'percent': return `${sign}${num(a, 1, 1)} pp`;
    case 'ratio': return `${sign}${num(a, 0, 2)}`;
    case 'lyd': return `${sign}${num(a, 0, a < 1000 ? 2 : 0)}`;
    case 'minutes': return `${sign}${num(a, 0, 1)} ${t('unit.min')}`;
    default: return `${sign}${num(a, 0, 0)}`;
  }
}

export type DeltaTone = 'good' | 'bad' | 'flat' | 'unknown';

/** Whether a change is good or bad, decided by the API's `direction` (never by the value's sign alone). */
export function deltaTone(k: Kpi | null | undefined): DeltaTone | null {
  if (!k || !ok(k.delta)) return null;
  if (Math.abs(k.delta) < FLAT_EPS[k.unit]) return 'flat';
  if (!k.direction) return 'unknown';
  const up = k.delta > 0;
  return (k.direction === 'higher_better') === up ? 'good' : 'bad';
}

export const isNa = (s: Status | undefined) => s === 'na';
