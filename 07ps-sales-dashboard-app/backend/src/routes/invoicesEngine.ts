import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC } from '../measures/filters';
import { parseGranularity, PeriodQueryError } from '../lib/periods';
import {
  computeInvoicesEngineKpis,
  fetchInvoiceClassificationYtd,
  fetchInvoicesEngineTrend,
  type InvoicesEngineScope,
} from '../measures/invoicesEngine';

/**
 * Invoices Engine page KPI endpoint. Same middleware chain and scoping discipline as
 * routes/tachometer.ts, routes/criticalNumber.ts and routes/revenueTrend.ts -- every query goes
 * through resolveScopedFilters before any measures function runs.
 *
 * /overview: the Zone A/B KPI tiles and the Invoices Classification donut.
 * /trend?granularity=day|week|month|year (default week): the Sales Trend (by period and by period + class, so the
 * drill-down toggle needs no second request) and the Invoices Trend over that period window (lib/periods.ts), so the
 * period selector reloads only the two trend charts. The Year page-filter is a Sales Trend click on Yearly.
 *
 * Page-filter interactivity: `selectedYear`/`selectedInvoiceClass` are optional and come from a
 * Sales Trend bar click / Invoices Classification segment click respectively (see the frontend
 * page's drillMode/selectedYear/selectedInvoiceClass state). Each chart's own query deliberately
 * skips the scope field it produces -- Sales Trend never re-scopes itself by `selectedYear`, and
 * Invoices Classification never re-scopes itself by `selectedInvoiceClass` -- so the chart that's
 * driving a selection keeps showing its full series (highlighted/dimmed on the frontend) while
 * every other visual on the page narrows for real. See measures/invoicesEngine.ts's per-function
 * comments for the exact self-exclusion rule each one follows.
 */
export const invoicesEngineRouter = Router();

invoicesEngineRouter.use(
  requireAuth,
  requirePasswordChangeCleared,
  requirePermission('invoices_engine', 'view'),
  attachUserContext,
  resolveScopedFilters,
);

function parseAnchorDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const now = new Date();
    return dateOnlyUTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  }
  const [y, m, d] = raw.split('-').map(Number);
  return dateOnlyUTC(y, m, d);
}

function parseSelectedYear(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !/^\d{4}$/.test(raw)) return undefined;
  return Number(raw);
}

const VALID_INVOICE_CLASSES = new Set(['A', 'B', 'C', 'D', 'Unclassified']);

function parseSelectedInvoiceClass(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase() === 'unclassified' ? 'Unclassified' : trimmed.toUpperCase();
  return VALID_INVOICE_CLASSES.has(normalized) ? normalized : undefined;
}

invoicesEngineRouter.get('/overview', async (req, res, next) => {
  try {
    const filters = req.scopedFilters!;
    const anchor = parseAnchorDate(req.query.anchorDate);
    const selectedYear = parseSelectedYear(req.query.selectedYear);
    const selectedInvoiceClass = parseSelectedInvoiceClass(req.query.selectedInvoiceClass);

    // Self-exclusion per chart -- see this file's header comment.
    const yearOnlyScope: InvoicesEngineScope = { year: selectedYear };
    const fullScope: InvoicesEngineScope = { year: selectedYear, invoiceClass: selectedInvoiceClass };

    const [kpis, classification] = await Promise.all([
      computeInvoicesEngineKpis(pool, anchor, filters, fullScope),
      fetchInvoiceClassificationYtd(pool, anchor, filters, yearOnlyScope),
    ]);

    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      selectedYear: selectedYear ?? null,
      selectedInvoiceClass: selectedInvoiceClass ?? null,
      kpis,
      classification,
    });
  } catch (err) {
    next(err);
  }
});

/** The two trend charts. The Sales Trend ignores the year it produces (self-exclusion); the Invoices Trend takes both. */
invoicesEngineRouter.get('/trend', async (req, res, next) => {
  try {
    const selectedYear = parseSelectedYear(req.query.selectedYear);
    const selectedInvoiceClass = parseSelectedInvoiceClass(req.query.selectedInvoiceClass);
    const trend = await fetchInvoicesEngineTrend(pool, parseAnchorDate(req.query.anchorDate), parseGranularity(req.query.granularity), req.scopedFilters!, {
      year: selectedYear,
      invoiceClass: selectedInvoiceClass,
    });
    res.json(trend);
  } catch (err) {
    if (err instanceof PeriodQueryError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
