import cron from 'node-cron';
import { getEtlConfig, npsRefresh } from '../config/etlConfig';
import { EtlAlreadyRunningError, enqueuePipelineRun } from '../queue/etlQueue';
import { etlLogger } from '../services/etlLogger';

/**
 * Replaces the Windows Task Scheduler + scheduler.py combo: called once from server.ts at API
 * process startup. Each cron tick only enqueues a BullMQ job -- it never blocks the API process
 * and never runs the pipeline itself (that's the worker's job, see commands/worker.ts). Both
 * schedules are independently configurable/disable-able via .env (ETL_SCHEDULE_*), matching the
 * "every hour / every 30 minutes / every night" flexibility asked for.
 *
 * Three schedules, all read in config.schedule.timezone (ETL_SCHEDULE_TIMEZONE, else APP_TIMEZONE):
 *   incremental  ETL job `main`               core dims -> sales incremental (no finance)    every 3 h
 *   full         ETL job `full_all`           core dims -> receivables -> sales full         02:00
 *   finance      ETL job `finance_receivables` core dims (reused when fresh) -> receivables   15:00
 *   nps          ETL job `process_nps`         core dims (reused when fresh) -> NPS Score     02:00, full reload
 *                ONLY when the full schedule is off: full_all already ends with process_nps, so NPS runs exactly
 *                once a night (npsRefresh). Off unless ETL_SCHEDULE_PROCESS_NPS_ENABLED=true; the ETL's NPS_ENABLED
 *                must be true too.
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
          job: 'main',
          mode: 'incremental',
          loadMode: 'incremental',
          outputMode: 'sql',
          fast: true,
          label: 'scheduled-incremental',
          triggerSource: 'scheduled',
        }).catch(onScheduledEnqueueError('incremental'));
      }, { timezone: config.schedule.timezone });
      etlLogger.info('Registered incremental ETL schedule', { cron: config.schedule.incrementalCron, timezone: config.schedule.timezone });
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
          job: 'full_all',
          mode: 'full',
          loadMode: 'full',
          outputMode: 'sql',
          label: 'scheduled-full',
          triggerSource: 'scheduled',
        }).catch(onScheduledEnqueueError('full'));
      }, { timezone: config.schedule.timezone });
      etlLogger.info('Registered full-refresh ETL schedule', { cron: config.schedule.fullCron, timezone: config.schedule.timezone });
    }
  } else {
    etlLogger.info('Full-refresh ETL schedule disabled (ETL_SCHEDULE_FULL_ENABLED=false)');
  }

  if (config.schedule.financeEnabled) {
    if (!cron.validate(config.schedule.financeCron)) {
      etlLogger.error('Invalid ETL_SCHEDULE_FINANCE_CRON -- receivables snapshot schedule not registered', {
        cron: config.schedule.financeCron,
      });
    } else {
      cron.schedule(config.schedule.financeCron, () => {
        etlLogger.info('Scheduled receivables snapshot tick -- enqueueing job');
        enqueuePipelineRun({
          job: 'finance_receivables',
          mode: 'finance',
          loadMode: 'full',
          outputMode: 'sql',
          label: 'scheduled-finance',
          triggerSource: 'scheduled',
        }).catch(onScheduledEnqueueError('finance'));
      }, { timezone: config.schedule.timezone });
      etlLogger.info('Registered receivables snapshot schedule', { cron: config.schedule.financeCron, timezone: config.schedule.timezone });
    }
  } else {
    etlLogger.info('Receivables snapshot schedule disabled (ETL_SCHEDULE_FINANCE_ENABLED=false)');
  }

  const nps = npsRefresh(config.schedule);
  if (nps.via === 'full_all') {
    etlLogger.info('NPS Score refreshes inside the nightly full_all (its last step); no separate NPS schedule', {
      cron: config.schedule.fullCron, timezone: config.schedule.timezone,
    });
  } else if (nps.via === 'own') {
    if (!cron.validate(config.schedule.processNpsCron)) {
      etlLogger.error('Invalid ETL_SCHEDULE_PROCESS_NPS_CRON -- NPS Score schedule not registered', {
        cron: config.schedule.processNpsCron,
      });
    } else {
      cron.schedule(config.schedule.processNpsCron, () => {
        etlLogger.info('Scheduled NPS Score tick -- enqueueing job');
        enqueuePipelineRun({
          job: 'process_nps',
          mode: 'nps',
          loadMode: 'full',
          outputMode: 'sql',
          label: 'scheduled-nps',
          triggerSource: 'scheduled',
        }).catch(onScheduledEnqueueError('nps'));
      }, { timezone: config.schedule.timezone });
      etlLogger.info('Registered NPS Score schedule', { cron: config.schedule.processNpsCron, timezone: config.schedule.timezone });
    }
  } else {
    etlLogger.info('NPS Score schedule disabled (ETL_SCHEDULE_PROCESS_NPS_ENABLED is not true)');
  }
}
