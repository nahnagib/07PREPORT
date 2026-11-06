import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stage and status are two separate things (migration 0066, docs/nps-followup.md "Stage, status and reasons"). Since
 * 0066 the column `status` holds OPEN / CLOSE / DISPUTED, so old code such as `WHERE status = 'SOLVED'` or
 * `c.status IN ('NEW', ...)` would not fail: it would quietly match nothing. This test fails when any SQL (or TS / Python
 * code) in the repo still compares `status` with a STAGE value. Only migration 0052 (which created the old column) and
 * the down/ files (which go back to it) may.
 */
const APP_ROOT = path.resolve(__dirname, '../../../..');
const STAGE_VALUES = ['NEW', 'CONTACTED', 'IN_PROGRESS', 'SOLVED', 'RESOLVED', 'CANCELLED', 'REJECTED', 'HISTORICAL'];
const EXTENSIONS = new Set(['.sql', '.ts', '.tsx', '.js', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '__pycache__', '.venv', 'venv', '.pytest_cache']);
const ALLOWED = [/data[\\/]warehouse[\\/]migrations[\\/]0052_[^\\/]*\.sql$/, /data[\\/]warehouse[\\/]down[\\/]/, /npsStageStatusSql\.test\.ts$/];

// `status` (any alias, any case, optionally back-quoted) compared with a quoted stage value, directly or inside IN (...)
const VALUE = `(?:${STAGE_VALUES.join('|')})`;
const OP = String.raw`(?:={1,3}|<>|!==?|\bNOT\s+IN\b|\bIN\b)`;
const STATUS_WITH_STAGE = new RegExp(
  String.raw`\bstatus\b\`?\s*${OP}\s*\(?\s*(?:['"][A-Za-z_]*['"]\s*,\s*)*['"]${VALUE}['"]`,
  'gi',
);
const matchesStageValue = (hit: string) => new RegExp(`['"]${VALUE}['"]`).test(hit); // values themselves are upper case

function offendingLines(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(STATUS_WITH_STAGE)) if (matchesStageValue(m[0])) out.push(m[0]);
  return out;
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* files(full);
    else if (EXTENSIONS.has(path.extname(name))) yield full;
  }
}

describe('stage and status are never mixed', () => {
  it('the check itself catches the old patterns and lets the new ones through', () => {
    expect(offendingLines("WHERE c.status = 'SOLVED'")).toHaveLength(1);
    expect(offendingLines("WHERE status <> 'HISTORICAL' AND x")).toHaveLength(1);
    expect(offendingLines("c.status IN ('NEW', 'CONTACTED')")).toHaveLength(1);
    expect(offendingLines("WHERE fc.`status` NOT IN ('OPEN', 'CANCELLED')")).toHaveLength(1);
    expect(offendingLines("if (c.status === 'RESOLVED')")).toHaveLength(1);
    expect(offendingLines("SET status = 'CONTACTED'")).toHaveLength(1);
    // the new names
    expect(offendingLines("WHERE c.stage = 'RESOLVED' AND c.status IN ('OPEN', 'DISPUTED')")).toHaveLength(0);
    expect(offendingLines("c.status = 'CLOSE'")).toHaveLength(0);
    // other tables' statuses are not stage values
    expect(offendingLines("app_user WHERE status <> 'INACTIVE'")).toHaveLength(0);
    expect(offendingLines('job.status = "cancelled"')).toHaveLength(0);
    expect(offendingLines("OpportunityStatus = 'New'")).toHaveLength(0);
  });

  it('no file outside migration 0052 and the down/ files compares status with a stage value', () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const file of files(APP_ROOT)) {
      if (ALLOWED.some((re) => re.test(file))) continue;
      scanned += 1;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const hit of offendingLines(line)) hits.push(`${path.relative(APP_ROOT, file)}:${i + 1}  ${hit}`);
      });
    }
    expect(scanned, 'the scan reached the repo').toBeGreaterThan(100);
    expect(hits, 'rename to `stage`, or compare the status with OPEN / CLOSE / DISPUTED').toEqual([]);
  });
});
