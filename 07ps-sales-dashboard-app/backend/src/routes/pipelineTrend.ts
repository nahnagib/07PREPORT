import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { parsePipelineAnchor } from '../measures/filters';
import {
  AGING_BUCKET_KEYS,
  AGING_CATEGORIES,
  computePipelineTrendOverview,
  fetchAgingDetails,
  type AgingBucketKey,
  type AgingCategory,
} from '../measures/pipelineTrend';

/**
 * Pipeline Trend page KPI endpoint. Same middleware chain and scoping discipline as every other
 * page. No page-filter/scope query params, just anchorDate + the standard 5 sidebar filters; the
 * one drill-down (aging bucket -> its open records) has its own endpoint below.
 */
export const pipelineTrendRouter = Router();

pipelineTrendRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('pipeline_trend', 'view'),
  attachUserContext,
  resolveScopedFilters,
);

pipelineTrendRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parsePipelineAnchor(req.query.anchorDate);
    const overview = await computePipelineTrendOverview(pool, anchor, filters);
    res.json({ anchorDate: anchor.toISOString().slice(0, 10), ...overview });
  } catch (err) {
    next(err);
  }
});

/** Aging drill-down: the open opportunities (?category=opportunities) or quotations
 * (?category=quotations) in one age bucket (?bucket=b0to30|b30to60|b60to90|b90plus), with their
 * customer and salesperson names. Same scoping/filters as /overview. */
pipelineTrendRouter.get('/aging-details', async (req, res, next) => {
  try {
    const category = String(req.query.category ?? '');
    const bucket = String(req.query.bucket ?? '');
    if (!(AGING_CATEGORIES as readonly string[]).includes(category) || !(AGING_BUCKET_KEYS as readonly string[]).includes(bucket)) {
      res.status(400).json({ error: `category must be one of ${AGING_CATEGORIES.join(', ')}; bucket must be one of ${AGING_BUCKET_KEYS.join(', ')}` });
      return;
    }
    const filters = req.scopedFilters!;
    const anchor = parsePipelineAnchor(req.query.anchorDate);
    const rows = await fetchAgingDetails(pool, anchor, filters, category as AgingCategory, bucket as AgingBucketKey);
    res.json({ anchorDate: anchor.toISOString().slice(0, 10), category, bucket, rows });
  } catch (err) {
    next(err);
  }
});
