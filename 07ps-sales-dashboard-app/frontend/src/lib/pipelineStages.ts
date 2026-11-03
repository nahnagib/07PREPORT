/**
 * Stage order and colours on the page side (2026-11-03). The order itself is defined once, in backend
 * config/pipelineStages.ts (by Odoo stage id); the API sends each stage's `position` and `colorKey`, and this file only
 * turns them into a theme colour, a sort value and a filter list.
 */

/** The stage's theme colour (tokens.css --ps-stage-*), the same on every chart. */
export function stageColor(colorKey: string): string {
  return `var(--ps-stage-${colorKey})`;
}

/** DataGrid dropdown filter for a Stage column: the stages present in `rows`, in pipeline order. */
export function stageFilterOptions(rows: { stage: string; stagePosition: number | null }[]): { value: string; label: string }[] {
  const position = new Map<string, number>();
  for (const r of rows) if (!position.has(r.stage)) position.set(r.stage, r.stagePosition ?? Number.MAX_SAFE_INTEGER);
  return [...position.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([name]) => ({ value: name, label: name }));
}

/** Rows sorted by pipeline order (stable within a stage). */
export function sortByStagePosition<T>(rows: T[], position: (row: T) => number | null | undefined): T[] {
  return rows
    .map((row, i) => ({ row, i, p: position(row) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.row);
}
