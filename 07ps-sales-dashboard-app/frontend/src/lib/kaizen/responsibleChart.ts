import type { GroupedBarChartPoint } from '@07ps/ui';
import type { KaizenDashboard } from './api';

/** How many responsible parties get their own bar; the rest share one "Others" bar. */
export const RESPONSIBLE_TOP_N = 10;

export type ResponsiblePoint = GroupedBarChartPoint & {
  open: number;
  closed: number;
  kind: 'person' | 'others' | 'unassigned';
  /** The exact Responsible Party to filter by ('' for "(Not assigned)", unused for "Others"). */
  name: string;
  /** How many parties the "Others" bar combines. */
  parties?: number;
};

/**
 * Bars for "Cards by Responsible Party": the top N parties in the API's order (most -> fewest
 * cards), then one "Others" bar for everyone else, then "(Not assigned)" at the bottom whatever its
 * count. Each bar carries its Open/Closed split.
 */
export function responsiblePoints(
  rows: KaizenDashboard['byResponsible'],
  labels: { others: string; notAssigned: string },
  topN = RESPONSIBLE_TOP_N,
): ResponsiblePoint[] {
  const named = rows.filter((r) => r.name !== null);
  const points: ResponsiblePoint[] = named
    .slice(0, topN)
    .map((r) => ({ label: r.name as string, name: r.name as string, open: r.open, closed: r.closed, kind: 'person' }));
  const rest = named.slice(topN);
  if (rest.length > 0) {
    points.push({
      label: labels.others,
      name: '',
      open: rest.reduce((s, r) => s + r.open, 0),
      closed: rest.reduce((s, r) => s + r.closed, 0),
      kind: 'others',
      parties: rest.length,
    });
  }
  const unassigned = rows.find((r) => r.name === null);
  if (unassigned) {
    points.push({ label: labels.notAssigned, name: '', open: unassigned.open, closed: unassigned.closed, kind: 'unassigned' });
  }
  return points;
}
