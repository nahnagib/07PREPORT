import Redis from 'ioredis';
import { getEtlConfig } from '../config/etlConfig';
import { etlLogger } from '../services/etlLogger';

/**
 * Cross-process "Cancel" signaling. The API process (handling the admin's click) and the worker
 * process (holding the actual running subprocess) are separate OS processes, so cancellation
 * can't be a plain in-memory call -- it goes over a small Redis pub/sub channel instead.
 *
 * A dedicated connection is required: an ioredis connection that's subscribed to a channel can no
 * longer issue normal commands (BullMQ's own connection is busy with blocking queue commands), so
 * this is intentionally separate from etlQueue.ts's connection.
 */
const CANCEL_CHANNEL = 'etl:cancel';

interface CancelMessage {
  jobId: string;
}

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    const config = getEtlConfig();
    publisher = new Redis({ host: config.redis.host, port: config.redis.port, lazyConnect: false });
    publisher.on('error', (err) => etlLogger.error('ETL cancel-channel publisher error', { error: err.message }));
  }
  return publisher;
}

/** Called by the API process (POST /admin/etl/cancel) -- fire-and-forget, the worker reports the
 * actual status change once it processes the abort. */
export async function publishCancelRequest(jobId: string): Promise<void> {
  const message: CancelMessage = { jobId };
  await getPublisher().publish(CANCEL_CHANNEL, JSON.stringify(message));
  etlLogger.info('Published ETL cancel request', { jobId });
}

/** Called once by the worker process at startup. Maintains the map of in-flight jobs so a cancel
 * message can be matched to the right AbortController -- see jobs/runPipelineJob.ts. */
/** `onCancel`'s `jobId` parameter name is a type-signature-only binding, same pre-existing ESLint
 * gap as middleware/auth.ts's `declare global` block (this repo's base no-unused-vars rule
 * doesn't fully understand TypeScript-only positions -- not something introduced here). */
export function subscribeToCancelRequests(onCancel: (jobId: string) => void): void {
  const config = getEtlConfig();
  const subscriber = new Redis({ host: config.redis.host, port: config.redis.port });
  subscriber.on('error', (err) => etlLogger.error('ETL cancel-channel subscriber error', { error: err.message }));
  subscriber.subscribe(CANCEL_CHANNEL, (err) => {
    if (err) {
      etlLogger.error('Failed to subscribe to ETL cancel channel', { error: err.message });
      return;
    }
    etlLogger.info('Worker subscribed to ETL cancel channel');
  });
  subscriber.on('message', (channel, raw) => {
    if (channel !== CANCEL_CHANNEL) return;
    try {
      const { jobId } = JSON.parse(raw) as CancelMessage;
      onCancel(jobId);
    } catch (err) {
      etlLogger.error('Malformed ETL cancel message', { raw, error: (err as Error).message });
    }
  });
}
