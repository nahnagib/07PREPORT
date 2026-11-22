import { defineConfig } from 'vitest/config';

/** Product Development Plan tracker against the local TEST stack (src/services/pdt/__tests__/trackerService.db.test.ts).
 * WRITES and cleans up. Needs PDT_TEST_DB=1 and DB_* pointing at 127.0.0.1:33309 (the test refuses any other port). */
export default defineConfig({
  test: {
    include: ['src/services/pdt/__tests__/trackerService.db.test.ts', 'src/services/pdt/__tests__/importService.db.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
