import { defineConfig } from 'vitest/config';

/** The period trends (lib/periods.ts) against a real warehouse, read-only (src/routes/__tests__/periodTrends.db.test.ts).
 * Needs DB_* in the environment, e.g. the local powerBI_Data. */
export default defineConfig({
  test: {
    include: ['src/routes/__tests__/periodTrends.db.test.ts'],
    env: { TREND_TEST_DB: '1' },
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
