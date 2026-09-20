import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Structural guard: every read of versioned MARCOM data must go through db.ts's runCurrent (which
 * adds `is_current = 1`). So no other file in marcomKpi/ may contain SQL or a marcom_* table name.
 */
describe('marcomKpi has exactly one SQL entry point', () => {
  const dir = path.join(__dirname, '..');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('finds the module files', () => expect(files).toEqual(expect.arrayContaining(['db.ts', 'pages.ts', 'spending.ts'])));

  it.each(files.filter((f) => f !== 'db.ts'))('%s contains no raw SQL keywords or marcom_* table names', (f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    expect(src).not.toMatch(/\b(SELECT|FROM|JOIN|INSERT|UPDATE|DELETE|WHERE|GROUP BY)\b/);
    expect(src).not.toMatch(/\bmarcom_[a-z_]+/);
    expect(src).not.toMatch(/pool\.query|db\/pool/);
  });

  it('db.ts only names versioned tables inside the TABLES map (plus the brand master)', () => {
    const src = fs.readFileSync(path.join(dir, 'db.ts'), 'utf8');
    const names = [...src.matchAll(/\bmarcom_[a-z_]+/g)].map((m) => m[0]);
    const allowed = new Set(['marcom_spend_monthly', 'marcom_campaign', 'marcom_campaign_media', 'marcom_social_monthly', 'marcom_web_monthly', 'marcom_trade_monthly', 'marcom_event', 'marcom_brand']);
    for (const n of names) expect(allowed.has(n), n).toBe(true);
    // The raw pool is used in exactly two places: the brand master and runCurrent.
    expect((src.match(/pool\.query/g) ?? []).length).toBe(2);
  });
});
