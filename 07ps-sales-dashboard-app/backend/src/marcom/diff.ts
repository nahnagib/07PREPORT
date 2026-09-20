import type { ParsedRow } from './parser';
import { Adapter, keyOf, normalize } from './tables';

export interface FieldChange { field: string; old: string | null; new: string | null }

export interface RowUpdate {
  row: ParsedRow;
  existingId: number;
  changes: FieldChange[];
}

export interface TableDiff {
  inserts: ParsedRow[];
  updates: RowUpdate[];
  unchanged: ParsedRow[];
  /** Rows carrying a blocking error -- never written, reported separately. */
  invalid: ParsedRow[];
}

/** A live DB row read back with the parser's field names, plus its surrogate id as `__id`. */
export type CurrentRow = Record<string, unknown> & { __id: number };

/**
 * Pure classification of one parsed table against the current (is_current = 1) DB rows,
 * matched on natural key. Rows absent from the file are simply not looked at (merge, not replace).
 * `invalidRowNumbers` are rows that already have a blocking error (from the parser).
 */
export function diffTable(
  adapter: Adapter,
  rows: ParsedRow[],
  current: CurrentRow[],
  invalidRowNumbers: Set<number> = new Set(),
): TableDiff {
  const byKey = new Map<string, CurrentRow>();
  for (const c of current) byKey.set(keyOf(adapter, c), c);

  const out: TableDiff = { inserts: [], updates: [], unchanged: [], invalid: [] };
  for (const row of rows) {
    if (invalidRowNumbers.has(row.rowNumber)) { out.invalid.push(row); continue; }
    const existing = byKey.get(keyOf(adapter, row.data));
    if (!existing) { out.inserts.push(row); continue; }
    const changes: FieldChange[] = [];
    for (const fd of adapter.fields) {
      const a = normalize(fd.type, existing[fd.field]);
      const b = normalize(fd.type, row.data[fd.field]);
      if (a !== b) changes.push({ field: fd.field, old: a, new: b });
    }
    if (changes.length) out.updates.push({ row, existingId: existing.__id, changes });
    else out.unchanged.push(row);
  }
  return out;
}

/** Row number out of an A1 reference like "D7" (null for table-level issues). */
export function rowOfCell(cell: string): number | null {
  const m = /(\d+)$/.exec(cell);
  return m ? Number(m[1]) : null;
}
