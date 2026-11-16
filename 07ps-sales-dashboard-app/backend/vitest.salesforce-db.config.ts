import { defineConfig } from 'vitest/config';

/** Salesforce Performance Team pulse = Tachometer YTD Value against a real warehouse, read-only
 * (src/routes/__tests__/salesforceTachometer.db.test.ts). Needs DB_* in the environment, e.g. the local powerBI_Data. */
export default defineConfig({
  test: {
    include: ['src/routes/__tests__/salesforceTachometer.db.test.ts', 'src/routes/__tests__/debtTachometer.db.test.ts'],
    env: { SALESFORCE_TEST_DB: '1' },
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
