import { parseExpression } from 'cron-parser';

/** node-cron (used to actually register the schedules, see registerSchedules.ts) has no API to
 * ask "when does this fire next" -- cron-parser is the complementary library for that, used only
 * for display (Next Scheduled Run / Scheduler Settings), never for scheduling itself. */
export function computeNextRunTime(cronExpression: string, timezone?: string): Date | null {
  try {
    const interval = parseExpression(cronExpression, timezone ? { tz: timezone } : undefined);
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/** True when `cronExpression` fires in the minute that contains `at` (read in `timezone`): lets the 30-minute refresh
 * tick see that the full refresh or the sales schedule fires at the same minute, and yield to it. */
export function cronFiresInMinute(cronExpression: string, at: Date, timezone?: string): boolean {
  const minuteStart = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  try {
    const interval = parseExpression(cronExpression, {
      currentDate: new Date(minuteStart.getTime() - 1),
      ...(timezone ? { tz: timezone } : {}),
    });
    return interval.next().toDate().getTime() === minuteStart.getTime();
  } catch {
    return false;
  }
}
