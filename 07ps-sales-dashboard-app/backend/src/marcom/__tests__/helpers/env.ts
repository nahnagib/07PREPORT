/**
 * MUST be the first import of any DB-backed MARCOM test: pool.ts reads DB_* at import time.
 * Points everything at the throwaway docker MySQL (see backend/scripts/marcomTestDb.py) and refuses
 * to run against anything but a database literally named `marcom_test` on localhost, because the
 * tests TRUNCATE the MARCOM tables.
 */
import os from 'node:os';
import path from 'node:path';

process.env.DB_HOST = process.env.MARCOM_TEST_DB_HOST ?? '127.0.0.1';
process.env.DB_PORT = process.env.MARCOM_TEST_DB_PORT ?? '33307';
process.env.DB_USER = process.env.MARCOM_TEST_DB_USER ?? 'root';
process.env.DB_PASSWORD = process.env.MARCOM_TEST_DB_PASSWORD ?? 'testroot';
process.env.DB_NAME = 'marcom_test';
process.env.DB_SOCKET = '';
process.env.JWT_SECRET = 'marcom-test-secret';
process.env.MARCOM_STAGING_DIR = path.join(os.tmpdir(), `marcom-test-staging-${process.pid}`);

if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST) || process.env.DB_NAME !== 'marcom_test') {
  throw new Error('Refusing to run MARCOM DB tests against a non-test database.');
}
