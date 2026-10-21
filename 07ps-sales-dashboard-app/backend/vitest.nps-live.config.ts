import { defineConfig } from 'vitest/config';

/** The follow-up page drives the NPS page, on a real warehouse (src/routes/__tests__/npsLiveFollowup.db.test.ts). WRITES one
 * case edit and restores it. Needs DB_* in the environment (e.g. the local powerBI_Data), migrations 0046-0053 and a
 * process_nps run. Never point it at production. */
export default defineConfig({
  test: {
    include: ['src/routes/__tests__/npsLiveFollowup.db.test.ts'],
    env: { NPS_TEST_DB_WRITE: '1' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
