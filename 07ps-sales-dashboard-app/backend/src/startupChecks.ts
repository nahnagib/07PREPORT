import { DependencyStatus, checkAuthStore, checkDatabase } from './db/pool';
import { isQueueReachable } from './etl/queue/queueHealth';

function log(name: string, target: string, result: DependencyStatus, critical: boolean): void {
  if (result.status === 'ok') {
    // eslint-disable-next-line no-console
    console.log(`[startup] OK    ${name} (${target}) ${result.latencyMs}ms`);
  } else {
    // eslint-disable-next-line no-console
    console.error(
      `[startup] FAIL  ${name} (${target}) ${result.error} after ${result.latencyMs}ms` +
        (critical ? ' -- API cannot serve logins or data until this is reachable' : ' -- ETL runs will not be processed'),
    );
  }
}

export interface StartupReport {
  database: boolean;
  authStore: boolean;
  etlQueue: boolean;
}

/**
 * Probes every dependency once, before the server starts listening, and logs one clear line each.
 * The caller decides whether to exit (production) or carry on degraded (local dev with tsx watch).
 */
export async function runStartupChecks(): Promise<StartupReport> {
  const dbTarget = process.env.DB_SOCKET
    ? `socket ${process.env.DB_SOCKET}`
    : `${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? 3306}/${process.env.DB_NAME ?? 'ps_warehouse'}`;
  const redisTarget = `${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT ?? 6379}`;

  const [database, authStore, queueUp] = await Promise.all([checkDatabase(), checkAuthStore(), isQueueReachable()]);
  log('MySQL database', dbTarget, database, true);
  log('Auth store (revoked_tokens)', dbTarget, authStore, true);
  log('ETL queue (Redis)', redisTarget, queueUp ? { status: 'ok', latencyMs: 0 } : { status: 'down', latencyMs: 0, error: 'unreachable' }, false);

  return { database: database.status === 'ok', authStore: authStore.status === 'ok', etlQueue: queueUp };
}
