import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRoleDataScope, groupScopeRows, type DataScopeRule } from '../../measures/filters';

/**
 * Migration 0044 (role_data_scope.operator) on a real database, READ-ONLY -- e.g. the local powerBI_Data after
 *   python data/warehouse/apply_migrations.py 0044_role_data_scope_operator.sql
 * Run: SCOPE_TEST_DB=1 DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=powerBI_Data npx vitest run -c vitest.scope-db.config.ts
 */
const RUN = process.env.SCOPE_TEST_DB === '1';

describe.skipIf(!RUN)('migration 0044 on the real database (read-only)', () => {
  let pool: typeof import('../../db/pool').pool;
  type Row = { role_id: number; dimension: string; operator: string; value: string } & Record<string, unknown>;
  const qa = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await pool.query(sql, params))[0] as Row[];

  beforeAll(async () => {
    ({ pool } = await import('../../db/pool'));
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('adds operator ENUM(in, not_in) NOT NULL DEFAULT in', async () => {
    const [c] = (await qa(
      "SELECT COLUMN_TYPE AS t, COLUMN_DEFAULT AS d, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'role_data_scope' AND COLUMN_NAME = 'operator'",
    )) as unknown as Record<string, unknown>[];
    expect(c).toEqual({ t: "enum('in','not_in')", d: 'in', n: 'NO' });
  });

  it('every role + dimension has ONE operator, so every stored rule is one rule', async () => {
    expect(await qa('SELECT role_id, dimension FROM role_data_scope GROUP BY role_id, dimension HAVING COUNT(DISTINCT operator) > 1')).toEqual([]);
  });

  it('every pre-existing "is any of" role enforces exactly what the old single-value rows enforced', async () => {
    const rows = await qa('SELECT role_id, dimension, operator, value FROM role_data_scope ORDER BY scope_id');
    const roles = [...new Set(rows.map((r) => Number(r.role_id)))];
    for (const roleId of roles) {
      const mine = rows.filter((r) => Number(r.role_id) === roleId);
      if (mine.some((r) => r.operator === 'not_in')) continue; // saved after the migration, nothing to compare with
      const old: DataScopeRule[] = mine.map((r) => ({ dimension: r.dimension as DataScopeRule['dimension'], value: String(r.value) }));
      const migrated = groupScopeRows(mine).flatMap((rule) => rule.values.map((value) => ({ dimension: rule.dimension, value })));
      expect(applyRoleDataScope({}, migrated), `role ${roleId}`).toEqual(applyRoleDataScope({}, old));
    }
  });
});
