/**
 * Shared Green/Yellow/Red threshold logic.
 *
 * Manual definition (Tachometer page, "Color Zones" / ASP indicators):
 *   Green  - target achieved or exceeded
 *   Yellow - below target by up to 10%
 *   Red    - below target by more than 10%
 *
 * This one function backs both the Value/Volume tachometers and the ASP cards on this page, and
 * is written to be reusable by any future gauge-style KPI on other pages -- it takes only
 * actual/target, no knowledge of which metric or page it's being used for.
 *
 * Ported 1:1 from data/warehouse/measures/classify.py (the validated Python reference). No logic
 * changes -- same boundary semantics, same NO_TARGET edge cases.
 */

export enum TargetStatus {
  GREEN = 'green',
  YELLOW = 'yellow',
  RED = 'red',
  NO_TARGET = 'no_target',
}

/**
 * Classify `actual` against `target` per the manual's color-zone rule.
 *
 * - GREEN: actual >= target (target achieved or exceeded)
 * - YELLOW: actual is below target, but by 10% or less of target, i.e. actual >= target * 0.90
 * - RED: actual is below target by more than 10%, i.e. actual < target * 0.90
 *
 * The 10% boundary is inclusive on the yellow side: exactly 10% below target ("within 10% below"
 * per the manual's own Yellow wording, and "up to 10%" per the tachometer wording) is YELLOW, not
 * RED.
 *
 * Edge cases:
 * - target is null/undefined, 0, or negative: NO_TARGET (nothing meaningful to measure against).
 * - actual is null/undefined: NO_TARGET as well.
 */
export function classifyVsTarget(
  actual: number | null | undefined,
  target: number | null | undefined,
): TargetStatus {
  if (target === null || target === undefined || target <= 0) {
    return TargetStatus.NO_TARGET;
  }
  if (actual === null || actual === undefined) {
    return TargetStatus.NO_TARGET;
  }

  if (actual >= target) {
    return TargetStatus.GREEN;
  }

  const yellowFloor = target * 0.9;
  if (actual >= yellowFloor) {
    return TargetStatus.YELLOW;
  }

  return TargetStatus.RED;
}

/**
 * Signed percentage variance of actual vs. target: (actual - target) / target.
 *
 * Returns null if target is missing/non-positive or actual is missing, matching
 * classifyVsTarget's NO_TARGET cases. A return of -0.10 means "10% below target" exactly -- the
 * same figure classifyVsTarget's yellow/red boundary is drawn at.
 */
export function variancePct(
  actual: number | null | undefined,
  target: number | null | undefined,
): number | null {
  if (target === null || target === undefined || target <= 0) {
    return null;
  }
  if (actual === null || actual === undefined) {
    return null;
  }
  return (actual - target) / target;
}
