import { defineConfig } from 'vitest/config';

/** Debt Report against a real warehouse, read-only (src/routes/__tests__/debtReport.db.test.ts, debtAging.db.test.ts). Needs DB_* in the
 * environment, e.g. the local powerBI_Data. */
export default defineConfig({
  test: {
    include: ['src/routes/__tests__/debtReport.db.test.ts', 'src/routes/__tests__/debtAging.db.test.ts', 'src/routes/__tests__/debtCollections.db.test.ts'],
    env: { DEBT_TEST_DB: '1' },
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
