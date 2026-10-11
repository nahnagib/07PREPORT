import { ValidationError } from './errors';

/**
 * Shared by services/salespersonAdminService.ts (validating/persisting an admin-entered profile)
 * and measures/tachometer.ts (applying it to a target-override amount). See
 * data/warehouse/migrations/0024_salesperson_target_seasonality.sql for the storage shape and why
 * this only applies to salesperson_admin_profile.target_override_amount, not real Fact_Targets data.
 */

export const SEASONALITY_MONTH_COUNT = 12;

/**
 * Default monthly split for a target override with no seasonality profile recorded -- an even
 * 12-way split, byte-for-byte identical to this override's behavior before seasonality existed
 * (target_override_amount / 12 per month). Named and exported here, rather than an inline `/ 12`
 * buried inside a calculation, so "what happens when nothing is configured" is explicit and easy to
 * find. This is a READ-time fallback only, for overrides that existed before this feature shipped --
 * see tachometer.ts's fetchOverrideMonthlyAmounts. Saving or editing an override going forward
 * always requires an explicit, validated profile (see validateSeasonality below); it never falls
 * back to this default silently.
 */
export const EVEN_SPLIT_SEASONALITY_PCT: readonly number[] = Object.freeze(
  Array.from({ length: SEASONALITY_MONTH_COUNT }, () => 100 / SEASONALITY_MONTH_COUNT),
);

/** Admin-entered percentages are allowed this much drift off 100.00% before being rejected -- big
 * enough to absorb ordinary rounding (each month stored to 4 decimal places), too small to let a
 * genuinely wrong profile (off by a whole point or more) through. */
const SUM_TOLERANCE_PCT = 0.02;

/**
 * Throws ValidationError with a message naming the current running total if `pct` isn't exactly 12
 * non-negative numbers summing to ~100%. Called before every write of a seasonality profile
 * (salespersonAdminService.ts) -- never trust client-side sum validation alone.
 */
export function validateSeasonality(pct: unknown): asserts pct is number[] {
  if (!Array.isArray(pct) || pct.length !== SEASONALITY_MONTH_COUNT) {
    throw new ValidationError(`Seasonality must have exactly ${SEASONALITY_MONTH_COUNT} monthly percentages (Jan-Dec).`);
  }
  for (let i = 0; i < pct.length; i++) {
    const v = pct[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new ValidationError(`Seasonality percentage for month ${i + 1} must be a non-negative number.`);
    }
  }
  const sum = pct.reduce((a: number, b: number) => a + b, 0);
  if (Math.abs(sum - 100) > SUM_TOLERANCE_PCT) {
    throw new ValidationError(`Monthly seasonality percentages must sum to 100% -- current total is ${sum.toFixed(2)}%.`);
  }
}
