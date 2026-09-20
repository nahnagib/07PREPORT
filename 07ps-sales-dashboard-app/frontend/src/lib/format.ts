import type { TargetStatus } from './api';
import type { SemanticStatus } from '@07ps/ui';

/** Maps the backend's TargetStatus (from classifyVsTarget) to packages/ui's SemanticStatus.
 * This is a label mapping only -- the classification decision itself always comes from the
 * backend; nothing here re-implements or second-guesses the green/yellow/red threshold. */
export function toSemanticStatus(status: TargetStatus): SemanticStatus {
  switch (status) {
    case 'green':
      return 'success';
    case 'yellow':
      return 'watch';
    case 'red':
      return 'alert';
    default:
      return 'neutral';
  }
}

/** Guards against non-finite input (null/undefined/NaN) rather than assuming the caller's own
 * null-check already ran -- every existing caller does check first, but a value that's `undefined`
 * (an API field omitted from the JSON payload) rather than an explicit `null` slips past a
 * `=== null` guard and previously reached `.toLocaleString()` unguarded, producing "Cannot read
 * properties of undefined (reading 'toLocaleString')" instead of a clean fallback. */
export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `LYD ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function formatVolume(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function formatAsp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `LYD ${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function formatVariance(pct: number | null | undefined): string | undefined {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return undefined;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${(pct * 100).toFixed(2)}%`;
}

/** Every timestamp in this app describes a Libya business event (an Odoo order, an ETL run) --
 * it must always read as Libya time, regardless of which timezone the viewer's own browser/OS
 * happens to be set to. `timeZone: APP_TIMEZONE` (NEXT_PUBLIC_APP_TIMEZONE, default Africa/Tripoli) is an IANA identifier, so this stays correct
 * even if Libya's offset rules ever change; it's resolved by the runtime's own tz database, not
 * hardcoded here. */
export const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE || 'Africa/Tripoli';

export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Compact K/M number formatting (Tachometer modernization pass) - "this will be our main page to
 * the whole company", per the user's own framing. Full-precision values are never thrown away:
 * every place a compact string renders also carries the exact formatCurrency/formatVolume string
 * as a `title` attribute (native browser tooltip), so hovering always reveals the real number.
 *
 * Thresholds: >= 1,000,000 -> "X.XM", >= 1,000 -> "X.XK", below that -> plain integer. One decimal
 * place, consistent with how LYD amounts are normally spoken about internally (e.g. "40.4M").
 */
function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function formatCompactCurrency(value: number): string {
  return `LYD ${compactNumber(value)}`;
}

export function formatCompactVolume(value: number): string {
  return compactNumber(value);
}
