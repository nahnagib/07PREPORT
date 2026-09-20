import { defineConfig } from 'vitest/config';

/** DB-backed MARCOM suites. Needs the throwaway MySQL: `python scripts/marcomTestDb.py up`. */
export default defineConfig({
  test: {
    include: ['src/marcom/**/*.test.ts', 'src/routes/**/*.test.ts'],
    env: { MARCOM_TEST_DB: '1', MARCOM_REQUIRE_TEST_DB: '1' },
    fileParallelism: false, // all files share one database
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
