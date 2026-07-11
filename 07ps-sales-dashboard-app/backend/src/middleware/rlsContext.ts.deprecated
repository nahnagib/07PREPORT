// DEPRECATED 2026-07-05 (Tachometer backend port session): superseded by scopeContext.ts.
//
// This file implemented Standards Section 5.2's data-layer scope enforcement via Postgres-native
// Row-Level Security (SET LOCAL app.role/app.company_scope/app.salesperson_id, read by RLS
// policies via current_setting()). The warehouse decision moved to MySQL 8
// (docs/tech-stack-decision.md) before this backend package was updated to match, and MySQL has
// no equivalent native RLS mechanism -- this file could never actually have worked against the
// real warehouse.
//
// Replacement: scopeContext.ts enforces the same Section 5.2 requirement in application code
// instead -- every measures route resolves and locks its Filters object via
// resolveScopedFilters() (which calls the validated, tested applySalespersonLock from
// ../measures/filters.ts) before any query runs, and there is no code path that builds a measures
// query from unvalidated request input directly. The original Postgres RLS policy migration file
// is likewise deprecated -- see data/warehouse/migrations/0007_rls_policies.sql's header.
//
// Kept in git history rather than deleted, per "replace, don't silently disappear."
