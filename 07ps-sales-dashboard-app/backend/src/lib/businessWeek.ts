/**
 * The business week: Saturday..Friday -- shared by NPS and Collections. A week is named by its Saturday. Pure ISO-date arithmetic at UTC noon, so the
 * server's time zone never shifts a date.
 */
const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);

export function addDaysIso(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Saturday of the week holding `iso` (yyyy-mm-dd). */
export function weekStartIso(iso: string): string {
  return addDaysIso(iso, -((toDate(iso).getUTCDay() + 1) % 7));
}

/** The same rule in MySQL, for a DATE expression: the Saturday of its week (DAYOFWEEK: 7 = Saturday). */
export const weekStartSql = (dateExpr: string): string => `DATE_SUB(${dateExpr}, INTERVAL MOD(DAYOFWEEK(${dateExpr}), 7) DAY)`;
