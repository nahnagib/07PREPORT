import cron from 'node-cron';
import { getEtlConfig } from '../config/etlConfig';
import { EtlAlreadyRunningError, enqueuePipelineRun } from '../queue/etlQueue';
import { etlLogger } from '../services/etlLogger';

/**
 * Replaces the Windows Task Scheduler + scheduler.py combo: called once from server.ts at API
 * process startup. Each cron tick only enqueues a BullMQ job -- it never blocks the API process
 * and never runs the pipeline itself (that's the worker's job, see commands/worker.ts). Both
 * schedules are independently configurable/disable-able via .env (ETL_SCHEDULE_*), matching the
 * "every hour / every 30 minutes / every night" flexibility asked for.
 */
/** A tick that lands while a run is still active is skipped, not queued behind it (that would build
 * a backlog after any long run) -- the next tick simply tries again. */
function onScheduledEnqueueError(kind: string) {
  return (err: unknown) => {
    if (err instanceof EtlAlreadyRunningError) {
      etlLogger.info(`Scheduled ${kind} ETL tick skipped -- a run is already queued or running`);
      return;
    }
    etlLogger.error(`Failed to enqueue scheduled ${kind} run`, { error: err instanceof Error ? err.message : String(err) });
  };
}

export function registerEtlSchedules(): void {
  const config = getEtlConfig();

  if (config.schedule.incrementalEnabled) {
    if (!cron.validate(config.schedule.incrementalCron)) {
      etlLogger.error('Invalid ETL_SCHEDULE_INCREMENTAL_CRON -- incremental schedule not registered', {
        cron: config.schedule.incrementalCron,
      });
    } else {
      cron.schedule(config.schedule.incrementalCron, () => {
        etlLogger.info('Scheduled incremental ETL tick -- enqueueing job');
        enqueuePipelineRun({
          mode: 'incremental',
          loadMode: 'incremental',
          outputMode: 'sql',
          fast: true,
          label: 'scheduled-incremental',
          triggerSource: 'scheduled',
        }).catch(onScheduledEnqueueError('incremental'));
      }, { timezone: config.schedule.timezone });
      etlLogger.info('Registered incremental ETL schedule', { cron: config.schedule.incrementalCron });
    }
  } else {
    etlLogger.info('Incremental ETL schedule disabled (ETL_SCHEDULE_INCREMENTAL_ENABLED=false)');
  }

  if (config.schedule.fullEnabled) {
    if (!cron.validate(config.schedule.fullCron)) {
      etlLogger.error('Invalid ETL_SCHEDULE_FULL_CRON -- full-refresh schedule not registered', {
        cron: config.schedule.fullCron,
      });
    } else {
      cron.schedule(config.schedule.fullCron, () => {
        etlLogger.info('Scheduled full-refresh ETL tick -- enqueueing job');
        enqueuePipelineRun({
          mode: 'full',
          loadMode: 'full',
          outputMode: 'sql',
          label: 'scheduled-full',
          triggerSource: 'scheduled',
        }).catch(onScheduledEnqueueError('full'));
      }, { timezone: config.schedule.timezone });
      etlLogger.info('Registered full-refresh ETL schedule', { cron: config.schedule.fullCron });
    }
  } else {
    etlLogger.info('Full-refresh ETL schedule disabled (ETL_SCHEDULE_FULL_ENABLED=false)');
  }
}
