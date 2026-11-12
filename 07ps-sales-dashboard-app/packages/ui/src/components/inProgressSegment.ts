/**
 * The current period of a time trend is partial (the data refreshes every 30 minutes), so the trend charts mark it:
 * a lighter bar, a dashed last line segment, and "Period in progress" in the tooltip title.
 *
 * A line cannot change its dash part-way, so a marked line is drawn as two visible pieces -- `<key>__done` (every
 * point but the last, solid) and `<key>__ip` (the last two points, dashed) -- while the original `<key>` line stays
 * as an invisible line that carries the legend entry, the tooltip value and the hover dot.
 */
export const IN_PROGRESS_NOTE = 'Period in progress';

export const doneKey = (key: string) => `${key}__done`;
export const inProgressKey = (key: string) => `${key}__ip`;

/** The index of the in-progress point, or -1 (only the LAST point can be in progress). */
export function inProgressIndex(points: readonly { label: string }[], inProgressLabel: string | null | undefined): number {
  if (inProgressLabel == null || points.length === 0) return -1;
  return points[points.length - 1].label === inProgressLabel ? points.length - 1 : -1;
}

/** Points with the `__done` / `__ip` copies of every key in `keys` added (unchanged when nothing is in progress). */
export function withInProgressSegment<P extends { label: string }>(points: P[], keys: readonly string[], index: number): P[] {
  if (index < 0) return points;
  return points.map((p, i) => {
    const out: Record<string, unknown> = { ...p };
    for (const k of keys) {
      const v = (p as Record<string, unknown>)[k];
      out[doneKey(k)] = i < index ? v : null;
      out[inProgressKey(k)] = i >= index - 1 ? v : null;
    }
    return out as P;
  });
}

/** Tooltip title of a point: the caller's label, plus the note on the in-progress period. */
export function inProgressTitle(label: string, inProgressLabel: string | null | undefined, format?: (label: string) => string): string {
  const title = format ? format(label) : label;
  return inProgressLabel != null && label === inProgressLabel ? `${title} · ${IN_PROGRESS_NOTE}` : title;
}
