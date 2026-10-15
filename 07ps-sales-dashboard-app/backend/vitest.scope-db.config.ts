import { defineConfig } from 'vitest/config';

/** Role data scope (migration 0044) against a real database, read-only (src/routes/__tests__/dataScope.db.test.ts). Needs
 * DB_* in the environment, e.g. the local powerBI_Data. */
export default defineConfig({
  test: {
    include: ['src/routes/__tests__/dataScope.db.test.ts'],
    env: { SCOPE_TEST_DB: '1' },
    testTimeout: 60_000,
  },
});
