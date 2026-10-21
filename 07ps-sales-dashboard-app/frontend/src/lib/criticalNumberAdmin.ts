/**
 * Pure helpers of Admin > Critical Number (2026-10-21). The backend (services/criticalNumberAdminService.ts) validates
 * every change again; these only give the admin the answer before the request.
 */

/** A change of more than this share of the current value asks for confirmation (the server requires it too). */
export const LARGE_CHANGE_RATIO = 0.5;

export type ParsedValue = { ok: true; value: number } | { ok: false; error: string };

/** The LYD amount typed by the admin: a full number ("560000", "560,000", "560000.50"); > 0, at most 2 decimals. */
export function parseCriticalNumberInput(raw: string): ParsedValue {
  const text = raw.replace(/[,\s]/g, '');
  if (text === '') return { ok: false, error: 'Enter the value in LYD.' };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, error: 'Enter a plain number, e.g. 560000.' };
  if (/\.\d{3,}$/.test(text)) return { ok: false, error: 'At most 2 decimals.' };
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'The value must be greater than 0.' };
  return { ok: true, value };
}

/** Signed change against the current value (0.1 = +10%); null without a current value. */
export function changeRatio(value: number, current: number | null | undefined): number | null {
  if (current === null || current === undefined || current <= 0) return null;
  return (value - current) / current;
}

/** True when the change needs the admin's explicit confirmation (more than +/-50%). */
export function isLargeChange(value: number, current: number | null | undefined): boolean {
  const r = changeRatio(value, current);
  return r !== null && Math.abs(r) > LARGE_CHANGE_RATIO;
}
