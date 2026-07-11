import { parseExpression } from 'cron-parser';

/** node-cron (used to actually register the schedules, see registerSchedules.ts) has no API to
 * ask "when does this fire next" -- cron-parser is the complementary library for that, used only
 * for display (Next Scheduled Run / Scheduler Settings), never for scheduling itself. */
export function computeNextRunTime(cronExpression: string): Date | null {
  try {
    const interval = parseExpression(cronExpression);
    return interval.next().toDate();
  } catch {
    return null;
  }
}
