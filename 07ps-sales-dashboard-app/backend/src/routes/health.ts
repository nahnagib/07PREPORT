import { Router } from 'express';
import { checkAuthStore, checkDatabase } from '../db/pool';
import { isQueueReachable } from '../etl/queue/queueHealth';

export const healthRouter = Router();

/**
 * Reports real dependency status. 503 when the database or auth store is down (the API cannot
 * serve logins or data); the ETL queue (Redis) is reported but only marks the API "degraded", since
 * dashboards and login keep working without it. The Docker healthcheck keys off this status code.
 */
healthRouter.get('/health', async (req, res) => {
  const [database, authStore, queueUp] = await Promise.all([checkDatabase(), checkAuthStore(), isQueueReachable()]);
  const etlQueue = { status: queueUp ? 'ok' : 'down' } as const;

  const critical = database.status === 'ok' && authStore.status === 'ok';
  const status = !critical ? 'unavailable' : queueUp ? 'ok' : 'degraded';

  res.status(critical ? 200 : 503).json({
    status,
    requestId: req.id,
    dependencies: { database, authStore, etlQueue },
  });
});
