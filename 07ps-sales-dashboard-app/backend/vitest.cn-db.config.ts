import { defineConfig } from 'vitest/config';

/** The Critical Number split from sales_targets.xlsx against a real warehouse, read-only
 * (src/measures/__tests__/criticalNumberShare.db.test.ts). Needs DB_* in the environment, e.g. the local powerBI_Data. */
export default defineConfig({
  test: {
    include: ['src/measures/__tests__/criticalNumberShare.db.test.ts'],
    env: { CN_TEST_DB: '1' },
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
