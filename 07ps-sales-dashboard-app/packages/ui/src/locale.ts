/**
 * The one display locale for the whole app: British English. Numbers read 1,234.5 and dates
 * 28 Sep 2026, whatever language the viewer's browser or phone is set to (formatting with no
 * locale would follow the device, so an Arabic phone would show Arabic-Indic digits).
 *
 * Lives in @07ps/ui because the shared charts/tables/exports need it and this package can't import
 * from the app; the app gets the same exports through frontend/src/lib/format.ts.
 */
export const DISPLAY_LOCALE = 'en-GB';

/** Number with thousands separators; `options` as for Intl.NumberFormat. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(DISPLAY_LOCALE, options);
}

// Fixed three-letter months: some Intl data renders September as "Sept" in en-GB.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(value: Date | string | number): Date | null {
  // A bare YYYY-MM-DD is a calendar date, not a UTC instant: read it as that local day.
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Calendar fields of `d` in `timeZone` (the viewer's own zone when omitted). */
function parts(d: Date, timeZone?: string) {
  const p = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? '';
  return { day: get('day'), month: MONTHS[Number(get('month')) - 1], year: get('year'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** "28 Sep 2026". Accepts a Date, an ISO timestamp, or a YYYY-MM-DD calendar date. */
export function formatDate(value: Date | string | number | null | undefined, timeZone?: string, fallback = '—'): string {
  const d = value === null || value === undefined || value === '' ? null : toDate(value);
  if (!d) return fallback;
  const x = parts(d, timeZone);
  return `${x.day} ${x.month} ${x.year}`;
}

/** "28 Sep 2026, 14:05" (24-hour); `withSeconds` adds ":07". */
export function formatDateTime(
  value: Date | string | number | null | undefined,
  timeZone?: string,
  { withSeconds = false, fallback = '—' }: { withSeconds?: boolean; fallback?: string } = {},
): string {
  const d = value === null || value === undefined || value === '' ? null : toDate(value);
  if (!d) return fallback;
  const x = parts(d, timeZone);
  return `${x.day} ${x.month} ${x.year}, ${x.hour}:${x.minute}${withSeconds ? `:${x.second}` : ''}`;
}

/** "14:05:07" (24-hour). */
export function formatTime(value: Date | string | number, timeZone?: string): string {
  const d = toDate(value);
  if (!d) return '—';
  const x = parts(d, timeZone);
  return `${x.hour}:${x.minute}:${x.second}`;
}
