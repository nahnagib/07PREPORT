# Revenue Trend & Invoices Engine Enhancements — 2026-09

## Summary
Adds detailed performance-analysis tables to Revenue Trend and enhances the Invoices Engine page with clearer invoice-classification labeling and a more informative donut chart.

## Revenue Trend page

### New: Performance Summary tables
Three sortable, exportable tables added below the existing trend charts (`DataGrid` from `@07ps/ui`):

1. **Value Performance Summary** — Month, Actual Value, Target Value, Variance (LYD), Variance %, Status, Trend
2. **Volume Performance Summary** — same shape, in units
3. **ASP Performance Summary** — same shape, Average Selling Price

Each table:
- Is built from the same month-by-month series (`RevenueTrendMonthPoint[]`) the charts above it already render, so a row can never disagree with its chart.
- Status is `Ahead` / `On Track` / `Behind`, using the same actual-vs-target boundary the rest of the app already draws its Green/Yellow/Red zones at (`classifyVsTarget`).
- Shows a month-over-month trend arrow, plus a Monthly Average / YTD Total footer strip.
- Is sortable, searchable, and exportable as PDF or CSV (DataGrid's built-in toolbar).

## Invoices Engine page

### 1. Classification tier relabeling
`A/B/C/D` → `High Value` / `Upper-Mid Value` / `Medium Value` / `Low Value`, applied everywhere the classification appears (donut, legend, detail table, tooltips). The underlying $ thresholds are **unchanged** (`>50K` / `25K–50K` / `5K–25K` / `<5K`) — this is a display-only rename, so every tier still contains exactly the same invoices it did before.

`Unclassified` is documented, not "fixed": it's lines whose parent order was never actually invoiced (a quotation, or a cancelled/pending order), not a data-quality bug. Forcing a `NOT NULL` constraint or reclassifying those rows would misrepresent them, so instead the page now explains this directly in a "Classification Tiers" help block.

### 2. Donut chart enhancements
- Percentage labels rendered directly on each ring segment (`DonutChart`'s new opt-in `showPercentLabels`).
- Tooltip now also shows invoice count per segment.
- Legend rows show label, value, percentage, and count.

### 3. New detail tables
Three `DataGrid` tables added below their corresponding chart:

- **Sales Performance by Year** (below Sales Trend) — Year, Invoice Sales Value, # of Invoices, Avg Value/Invoice, Variance vs. Prior Year, Trend.
- **Invoices Trend Detail** (below Invoices Trend) — Year, # of Invoices, Avg Sales/Invoice, Avg Lines/Invoice, Trend.
- **Invoices Classification Detail** (below the donut) — Classification, Count, % of Total, Total Value, Avg Value/Invoice, Trend, Status.

## Technical changes

**Frontend**
- `frontend/src/app/(departments)/promotion/revenue-trend/page.tsx` — three Performance Summary `DataGrid` panels.
- `frontend/src/app/(departments)/promotion/invoices-engine/page.tsx` — relabeled classification, donut percentage labels, Classification Tiers help block, three detail tables.
- `frontend/src/lib/api.ts` — `InvoiceClassificationSlice`/`InvoiceYearEfficiencyPoint` now also carry `invoiceCount`.

**Shared UI (`packages/ui`)**
- `DonutChart.tsx` — new `showPercentLabels` prop, optional per-segment `count`, richer tooltip.
- `DataGrid.tsx` — new "Export CSV" toolbar button (alongside the existing PDF export).

**Backend**
- `backend/src/measures/invoicesEngine.ts` — classification query now also returns `COUNT(DISTINCT InvoiceKey)` per class; `fetchInvoicesTrendByYear` now returns `invoiceCount`.

## Verification
- `tsc --noEmit` passes in `packages/ui`, `backend`, and `frontend`.
- `next build` completes cleanly for both changed pages.
- Backend test suite: 95/95 passing, no new failures.
- No database schema changes, no new dependencies, no breaking API changes.

## Deliberately out of scope
- Table 4 ("Classification KPI Boxes Detail") — marked optional in the original spec; not built. Can be added on request.
- No ETL/database changes for the `Unclassified` bucket or the value-tier $ thresholds — both were explicit decisions made with the project owner before implementation (see commit history).
