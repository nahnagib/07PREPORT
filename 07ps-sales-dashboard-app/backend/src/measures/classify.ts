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

/**
 * Classify a "lower is better" rate (e.g. a defect/dirty-record percentage) against two ascending
 * thresholds: GREEN below `yellowAt`, YELLOW below `redAt`, RED at or above `redAt`. Both bounds
 * are caller-supplied and deliberately not baked in here -- see each call site for its own
 * documented, tunable constants (e.g. dataQuality.ts's DATA_QUALITY_YELLOW_PCT/RED_PCT).
 */
export function classifyRate(value: number | null | undefined, yellowAt: number, redAt: number): TargetStatus {
  if (value === null || value === undefined) return TargetStatus.NO_TARGET;
  if (value < yellowAt) return TargetStatus.GREEN;
  if (value < redAt) return TargetStatus.YELLOW;
  return TargetStatus.RED;
}

/**
 * Deliberate default, not derived from the data -- tune once the business agrees on its actual
 * tolerance for a year-over-year decline. Used by classifyVsPriorPeriod below.
 */
export const YOY_YELLOW_THRESHOLD = -0.1;

/**
 * Classify `actual` against the same metric's own prior-period value, for pages/metrics with no
 * absolute target in their data model (e.g. Customer Growth, Invoices Engine, BCG Matrix -- none
 * of them have a Fact_Targets-style benchmark). Mirrors classifyVsTarget's green/yellow/red
 * banding, but the benchmark is last period's actual instead of a fixed target.
 *
 * - GREEN: actual >= prior (at or above last period)
 * - YELLOW: below prior, but variance is still >= YOY_YELLOW_THRESHOLD
 * - RED: variance below YOY_YELLOW_THRESHOLD
 * - NO_TARGET: prior or actual missing/non-positive, matching classifyVsTarget's edge cases
 */
export function classifyVsPriorPeriod(
  actual: number | null | undefined,
  prior: number | null | undefined,
): TargetStatus {
  if (prior === null || prior === undefined || prior <= 0) return TargetStatus.NO_TARGET;
  if (actual === null || actual === undefined) return TargetStatus.NO_TARGET;
  if (actual >= prior) return TargetStatus.GREEN;
  const variance = (actual - prior) / prior;
  if (variance >= YOY_YELLOW_THRESHOLD) return TargetStatus.YELLOW;
  return TargetStatus.RED;
}
