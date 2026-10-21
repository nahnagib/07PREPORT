/**
 * The business week: Sunday..Saturday -- the week the app already uses for Collections (measures/debtCollections.ts
 * periodStart, the ar_weekly mart). A week is named by its Sunday. Pure ISO-date arithmetic at UTC noon, so the
 * server's time zone never shifts a date.
 */
const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);

export function addDaysIso(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Sunday of the week holding `iso` (yyyy-mm-dd). */
export function weekStartIso(iso: string): string {
  return addDaysIso(iso, -toDate(iso).getUTCDay());
}

/** The same rule in MySQL, for a DATE expression: the Sunday of its week (DAYOFWEEK: 1 = Sunday). */
export const weekStartSql = (dateExpr: string): string => `DATE_SUB(${dateExpr}, INTERVAL DAYOFWEEK(${dateExpr}) - 1 DAY)`;
