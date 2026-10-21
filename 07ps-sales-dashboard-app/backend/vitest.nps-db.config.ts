import { defineConfig } from 'vitest/config';

/** NPS Score against a real warehouse, read-only (src/routes/__tests__/npsScore.db.test.ts). Needs DB_* in the environment,
 * e.g. the local powerBI_Data, migration 0046 and one process_nps run. */
export default defineConfig({
  test: {
    include: ['src/routes/__tests__/npsScore.db.test.ts'],
    env: { NPS_TEST_DB: '1' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
