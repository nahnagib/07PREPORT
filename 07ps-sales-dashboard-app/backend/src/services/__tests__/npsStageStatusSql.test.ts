import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stage and status are two separate things (migration 0066, docs/nps-followup.md "Stage, status and reasons"). Since
 * 0072 the column `status` holds OPEN / CLOSED / DISPUTED, so old code such as `WHERE status = 'SOLVED'` or
 * `c.status IN ('NEW', ...)` would not fail: it would quietly match nothing. This test fails when any SQL (or TS / Python
 * code) in the repo still compares `status` with a STAGE value. Only migration 0052 (which created the old column) and
 * the down/ files (which go back to it) may.
 */
const APP_ROOT = path.resolve(__dirname, '../../../..');
const STAGE_VALUES = ['NEW', 'CONTACTED', 'IN_PROGRESS', 'SOLVED', 'RESOLVED', 'UNRESOLVED', 'CANCELLED', 'REJECTED', 'HISTORICAL'];
const EXTENSIONS = new Set(['.sql', '.ts', '.tsx', '.js', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '__pycache__', '.venv', 'venv', '.pytest_cache', 'db_backups']);
/** Database dumps and generated files are not code; a multi-GB dump would also overflow a string. */
const MAX_BYTES = 5 * 1024 * 1024;
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

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * The repo's code files: tracked + untracked-not-ignored (`git ls-files`), so ignored dumps (db_backups/) and build
 * output never count; a plain walk with SKIP_DIRS where git is not available (e.g. a container without .git).
 */
function* files(root: string): Generator<string> {
  let list: string[];
  try {
    list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter(Boolean).map((f) => path.join(root, f));
  } catch {
    list = [...walk(root)];
  }
  for (const full of list) {
    if (!EXTENSIONS.has(path.extname(full)) || full.split(/[\\/]/).some((part) => SKIP_DIRS.has(part))) continue;
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      continue; // listed by git but deleted in the working tree
    }
    if (size <= MAX_BYTES) yield full;
  }
}

describe('stage and status are never mixed', () => {
  it('the check itself catches the old patterns and lets the new ones through', () => {
    expect(offendingLines("WHERE c.status = 'SOLVED'")).toHaveLength(1);
    expect(offendingLines("WHERE c.status = 'UNRESOLVED'")).toHaveLength(1);
    expect(offendingLines("WHERE c.status = 'REJECTED'")).toHaveLength(1);
    expect(offendingLines("WHERE status <> 'HISTORICAL' AND x")).toHaveLength(1);
    expect(offendingLines("c.status IN ('NEW', 'CONTACTED')")).toHaveLength(1);
    expect(offendingLines("WHERE fc.`status` NOT IN ('OPEN', 'CANCELLED')")).toHaveLength(1);
    expect(offendingLines("if (c.status === 'RESOLVED')")).toHaveLength(1);
    expect(offendingLines("SET status = 'CONTACTED'")).toHaveLength(1);
    // the new names
    expect(offendingLines("WHERE c.stage = 'RESOLVED' AND c.status IN ('OPEN', 'DISPUTED')")).toHaveLength(0);
    expect(offendingLines("c.stage = 'UNRESOLVED' AND c.status = 'DISPUTED'")).toHaveLength(0);
    expect(offendingLines("c.status = 'CLOSED'")).toHaveLength(0);
    // other tables' statuses are not stage values
    expect(offendingLines("app_user WHERE status <> 'INACTIVE'")).toHaveLength(0);
    expect(offendingLines('job.status = "cancelled"')).toHaveLength(0);
    expect(offendingLines("OpportunityStatus = 'New'")).toHaveLength(0);
  });

  it('no file outside migration 0052 and the down/ files compares status with a stage value', () => {
    const hits: string[] = [];
    const seen: string[] = [];
    for (const file of files(APP_ROOT)) {
      if (ALLOWED.some((re) => re.test(file))) continue;
      seen.push(path.relative(APP_ROOT, file).split(path.sep).join('/'));
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const hit of offendingLines(line)) hits.push(`${path.relative(APP_ROOT, file)}:${i + 1}  ${hit}`);
      });
    }
    expect(seen.length, 'the scan reached the repo').toBeGreaterThan(100);
    // the NPS code itself is in the scan (not skipped as too big, ignored or outside the list)
    for (const f of ['backend/src/services/npsFollowupService.ts', 'backend/src/measures/npsScore.ts', 'backend/src/config/npsSla.ts',
      'data/etl/src/departments/process/followup.py', 'frontend/src/lib/nps/followup.ts']) expect(seen, f).toContain(f);
    expect(seen.some((f) => f.startsWith('db_backups/')), 'database dumps are skipped').toBe(false);
    expect(hits, 'rename to `stage`, or compare the status with OPEN / CLOSED / DISPUTED').toEqual([]);
  });
});
