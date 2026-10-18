/**
 * NPS Score colour bands and targets -- the ONE place they are defined. The API applies them (measures/npsScore.ts) and
 * sends them to the page in /nps-score/meta, so the page never keeps its own copy.
 *
 *   NPS tachometer   red below 50 · yellow 50 to below 90 · green 90 and up · target 90 (gauge drawn 0..100)
 *   CSAT bar         red below 85 · yellow 85 to below 95 · green 95 and up · target 95
 *
 * Boundaries are inclusive at the LOWER end: exactly 50 / 85 is yellow, exactly 90 / 95 is green. NPS can be negative
 * (-100..+100): it is red, and the gauge pins the needle at 0 (the real number is printed below it).
 */
export type Band = 'red' | 'yellow' | 'green';

export interface BandScale {
  /** where yellow starts (inclusive) */
  yellowFrom: number;
  /** where green starts (inclusive) */
  greenFrom: number;
  target: number;
  /** the drawn scale of the visual */
  min: number;
  max: number;
}

export const NPS_SCALE: BandScale = { yellowFrom: 50, greenFrom: 90, target: 90, min: 0, max: 100 };
export const CSAT_SCALE: BandScale = { yellowFrom: 85, greenFrom: 95, target: 95, min: 0, max: 100 };

export function bandOf(value: number | null, scale: BandScale): Band | null {
  if (value === null || Number.isNaN(value)) return null;
  if (value >= scale.greenFrom) return 'green';
  return value >= scale.yellowFrom ? 'yellow' : 'red';
}

export const npsBand = (nps: number | null): Band | null => bandOf(nps, NPS_SCALE);
export const csatBand = (csat: number | null): Band | null => bandOf(csat, CSAT_SCALE);

/** Below this many responders a value is shown greyed with "n = x" (NPS_MIN_RESPONDERS, default 5). */
export function minResponders(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.NPS_MIN_RESPONDERS);
  return Number.isInteger(n) && n >= 1 ? n : 5;
}
