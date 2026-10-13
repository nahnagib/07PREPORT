import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every table the backend reads or writes is lowercase (dim_company, fact_sales, v_sales_lines, ...).
 *
 * Why: live MySQL runs on Linux with lower_case_table_names=0, where `Dim_Company` and `dim_company` are two
 * DIFFERENT tables -- the legacy pipeline's stale Dim_Company (1 Majaal, 2 Tika) and the core ETL's dim_company
 * (Odoo ids: 1 Majaal, 3 Tika, 9 Athena, ...). Local Windows MySQL (lower_case_table_names=1) folds them into one,
 * so a capitalised name works locally and silently reads the wrong table on live (2026-10-13: Athena missing from the
 * Company "ETL Relation" dropdown on live only).
 */
const SRC = path.resolve(__dirname, '..', '..');
const SQL_TABLE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+`?([A-Za-z_][A-Za-z0-9_]*)/g;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') && full !== __filename ? [full] : [];
  });
}

describe('table names in backend SQL', () => {
  it('are all lowercase (case-sensitive MySQL on live)', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\*|\/\/)/.test(line)) return; // comments may name legacy tables
          for (const m of line.matchAll(SQL_TABLE)) {
            if (/[A-Z]/.test(m[1])) offenders.push(`${path.relative(SRC, file)}:${i + 1} ${m[1]}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('the check itself catches a capitalised table', () => {
    expect(
      [...'SELECT 1 FROM Dim_Company c JOIN dim_date d'.matchAll(SQL_TABLE)].map((m) => m[1]),
    ).toEqual(['Dim_Company', 'dim_date']);
  });
});
