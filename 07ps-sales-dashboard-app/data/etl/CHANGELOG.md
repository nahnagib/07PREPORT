# Changelog

## 0.2.0 - 2026-06-06

- Marked the current functionally correct sales/CRM model as the stable baseline.
- Preserved legacy sales cleaning, mapping, customer, invoice, target, off-day, and workbook parity behavior.
- Added/retained CRM lead, opportunity, quotation/sales, delivery, lost-reason, active-flag, journey, and real-funnel logic.
- Optimized incremental SQL with in-place sale-report window refresh, removal of a discarded full staging merge, parsed reference caching, focused indexes, stage timing, and optional profiling.
- Added structural/referential validation, strict mode, schema/row/KPI baseline comparison, and final run summaries.
- Added complete README, business logic, technical, data dictionary, incremental mode, performance, and changelog documentation.
