import cron from 'node-cron';
import { getEtlConfig, npsRefresh } from '../config/etlConfig';
import { EtlAlreadyRunningError, enqueuePipelineRun } from '../queue/etlQueue';
import { etlLogger } from '../services/etlLogger';
import { cronFiresInMinute } from './nextRunTime';

/**
 * Replaces the Windows Task Scheduler + scheduler.py combo: called once from server.ts at API
 * process startup. Each cron tick only enqueues a BullMQ job -- it never blocks the API process
 * and never runs the pipeline itself (that's the worker's job, see commands/worker.ts). Both
 * schedules are independently configurable/disable-able via .env (ETL_SCHEDULE_*), matching the
 * "every hour / every 30 minutes / every night" flexibility asked for.
 *
 * Nothing is registered unless ETL_SCHEDULER_ENABLED=true -- set ONLY in the production server's backend/.env, so a
 * laptop or a test copy of the app never starts an ETL run by itself (docs/etl-refresh-schedule.md).
 *
 * Schedules, all read in config.schedule.timezone (ETL_SCHEDULE_TIMEZONE, else APP_TIMEZONE):
 *   refresh      ETL job `refresh_30m`         shared lists -> receivables + collections -> NPS  every 30 min
 *                (ETL_REFRESH_MODULES in data/etl; each module isolated). Yields when the full or sales schedule
 *                fires in the same minute; skipped while any other run is queued or running; one BullMQ attempt.
 *   incremental  ETL job `main`               core dims -> sales incremental (no finance)    08:50 11:50 14:50 17:50 20:50
 *   full         ETL job `full_all`           core dims -> receivables -> sales full         02:00
 *   finance      ETL job `finance_receivables` core dims -> receivables + collections         15:00, OFF by default
 *                (the refresh covers it)
 *   nps          ETL job `process_nps`         core dims -> NPS Score                         02:00, full reload
 *                ONLY when the full schedule is off: full_all already ends with process_nps, so NPS runs exactly
 *                once a night (npsRefresh). Off unless ETL_SCHEDULE_PROCESS_NPS_ENABLED=true; the ETL's NPS_ENABLED
 *                must be true too. The 30-minute refresh also runs process_nps (ETL_REFRESH_MODULES).
 * The full and sales ticks queue behind a running refresh instead of being dropped (queueBehindRefresh).
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

  if (!config.schedulerEnabled) {
    etlLogger.info('ETL schedules not registered: ETL_SCHEDULER_ENABLED is not true on this machine (only the production server runs them)');
    return;
  }

  if (config.schedule.refreshEnabled) {
    if (!cron.validate(config.schedule.refreshCron)) {
      etlLogger.error('Invalid ETL_SCHEDULE_REFRESH_CRON -- 30-minute refresh not registered', { cron: config.schedule.refreshCron });
    } else {
      cron.schedule(config.schedule.refreshCron, () => {
        const now = new Date();
        const tz = config.schedule.timezone;
        const yieldsTo = config.schedule.fullEnabled && cronFiresInMinute(config.schedule.fullCron, now, tz) ? 'full refresh'
          : config.schedule.incrementalEnabled && cronFiresInMinute(config.schedule.incrementalCron, now, tz) ? 'sales refresh'
            : null;
        if (yieldsTo) {
          etlLogger.info(`Scheduled 30-minute refresh tick skipped -- the ${yieldsTo} runs this minute`);
          return;
        }
        etlLogger.info('Scheduled 30-minute refresh tick -- enqueueing job');
        enqueuePipelineRun({
          job: 'refresh_30m',
          mode: 'refresh',
          loadMode: 'incremental',
          outputMode: 'sql',
          label: 'scheduled-refresh',
          triggerSource: 'scheduled',
          attempts: 1,
        }).catch(onScheduledEnqueueError('30-minute refresh'));
      }, { timezone: config.schedule.timezone });
      etlLogger.info('Registered 30-minute refresh schedule', { cron: config.schedule.refreshCron, timezone: config.schedule.timezone });
    }
  } else {
    etlLogger.info('30-minute refresh schedule disabled (ETL_SCHEDULE_REFRESH_ENABLED=false)');
  }

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
          queueBehindRefresh: true,
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
          queueBehindRefresh: true,
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
          queueBehindRefresh: true,
        }).catch(onScheduledEnqueueError('nps'));
      }, { timezone: config.schedule.timezone });
      etlLogger.info('Registered NPS Score schedule', { cron: config.schedule.processNpsCron, timezone: config.schedule.timezone });
    }
  } else {
    etlLogger.info('NPS Score schedule disabled (ETL_SCHEDULE_PROCESS_NPS_ENABLED is not true)');
  }
}
