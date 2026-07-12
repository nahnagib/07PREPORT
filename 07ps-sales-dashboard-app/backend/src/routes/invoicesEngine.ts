import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { requirePasswordChangeCleared, requirePermission } from '../middleware/permission';
import { attachUserContext, resolveScopedFilters } from '../middleware/scopeContext';
import { dateOnlyUTC } from '../measures/filters';
import {
  computeInvoicesEngineKpis,
  fetchInvoiceClassificationYtd,
  fetchInvoicesTrendByYear,
  fetchSalesTrendByYear,
  fetchSalesTrendByYearClass,
  type InvoicesEngineScope,
} from '../measures/invoicesEngine';

/**
 * Invoices Engine page KPI endpoint. Same middleware chain and scoping discipline as
 * routes/tachometer.ts, routes/criticalNumber.ts and routes/revenueTrend.ts -- every query goes
 * through resolveScopedFilters before any measures function runs.
 *
 * One /overview endpoint: the page needs the Zone A/B KPI tiles, the Sales Trend series (by year
 * and by year+class, so the drill-down toggle needs no second request), the Invoices Trend series,
 * and the Invoices Classification donut on a single load.
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
    const classOnlyScope: InvoicesEngineScope = { invoiceClass: selectedInvoiceClass };
    const yearOnlyScope: InvoicesEngineScope = { year: selectedYear };
    const fullScope: InvoicesEngineScope = { year: selectedYear, invoiceClass: selectedInvoiceClass };

    const [kpis, byYear, byYearClass, invoicesTrend, classification] = await Promise.all([
      computeInvoicesEngineKpis(pool, anchor, filters, fullScope),
      fetchSalesTrendByYear(pool, anchor, filters, classOnlyScope),
      fetchSalesTrendByYearClass(pool, anchor, filters, classOnlyScope),
      fetchInvoicesTrendByYear(pool, anchor, filters, fullScope),
      fetchInvoiceClassificationYtd(pool, anchor, filters, yearOnlyScope),
    ]);

    res.json({
      anchorDate: anchor.toISOString().slice(0, 10),
      selectedYear: selectedYear ?? null,
      selectedInvoiceClass: selectedInvoiceClass ?? null,
      kpis,
      salesTrend: { byYear, byYearClass },
      invoicesTrend,
      classification,
    });
  } catch (err) {
    next(err);
  }
});
