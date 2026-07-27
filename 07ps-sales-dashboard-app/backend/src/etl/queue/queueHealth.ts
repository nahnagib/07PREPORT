import Redis from 'ioredis';
import { getEtlConfig } from '../config/etlConfig';

const PROBE_TIMEOUT_MS = 2000;

/**
 * A fast, isolated yes/no reachability check -- deliberately NOT reusing the shared
 * `getEtlQueue()` connection (see etlQueue.ts). That connection is designed to retry forever in
 * the background so it self-heals once Redis comes back (see enqueuePipelineRun's comment on
 * why), which is exactly wrong for a health probe: a caller asking "is the queue up right now"
 * needs a bounded answer, not something that might hang for the same reason `.add()` used to.
 * `retryStrategy: () => null` stops this one-off connection from retrying at all, so an
 * unreachable Redis fails in milliseconds instead of hanging.
 *
 * Used by /admin/etl/status to distinguish "the queue is genuinely unreachable" from "a job is
 * genuinely running" -- those used to be indistinguishable (see hasActiveEtlRun in
 * etlRunTracker.ts), which is what produced the false "already running" lock.
 */
export function isQueueReachable(): Promise<boolean> {
  const config = getEtlConfig();
  return new Promise((resolve) => {
    const client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
      connectTimeout: PROBE_TIMEOUT_MS,
    });
    client.on('error', () => {
      // Swallowed deliberately -- the connect()/ping() promise chain below is what reports the
      // outcome; without this listener the unhandled 'error' event would crash the process (same
      // rationale as etlQueue.ts's own listener).
    });

    const timer = setTimeout(() => {
      client.disconnect();
      resolve(false);
    }, PROBE_TIMEOUT_MS);

    client
      .connect()
      .then(() => client.ping())
      .then(() => {
        clearTimeout(timer);
        client.disconnect();
        resolve(true);
      })
      .catch(() => {
        clearTimeout(timer);
        client.disconnect();
        resolve(false);
      });
  });
}
