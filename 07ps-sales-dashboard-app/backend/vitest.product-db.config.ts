import { defineConfig } from 'vitest/config';

/** Product pages against a real warehouse, read-only (src/routes/__tests__/productDashboard.db.test.ts): the filter matrix
 * for every Product page. Needs DB_* in the environment, e.g. the local powerBI_Data. */
export default defineConfig({
  test: {
    include: ['src/routes/__tests__/productDashboard.db.test.ts'],
    env: { PRODUCT_TEST_DB: '1' },
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
