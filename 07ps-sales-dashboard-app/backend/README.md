# Backend API (Phase P1/P2 foundation)

Node.js/Express/TypeScript API layer. Scope in this phase: auth, RLS session-scoping, dimension
filter-value-list endpoints (Section 4.16), and refresh-metadata endpoints (Section 3.23/5.11).
No Sales KPI/measure endpoints yet - those arrive in Phase P3 once the warehouse (../data/warehouse)
is reconciled against Power BI per the Migration Plan's P1 exit criterion.

## Row-Level Security model (Section 5.2)

RLS is enforced in Postgres itself, not in application code:

1. `requireAuth` verifies the JWT and attaches `{ role, companyScope, salespersonId }` to the request.
2. `withRlsContext` opens a transaction-scoped Postgres client and `SET LOCAL`s those claims as
   session variables (`app.role`, `app.company_scope`, `app.salesperson_id`).
3. Every table's RLS policy (`data/warehouse/migrations/0005_rls_policies.sql`) reads those
   variables via `current_setting()` and filters rows structurally - there is no query path,
   in this API or any future consumer of the same warehouse, that can select rows outside scope.

## Local dev

```
cp .env.example .env   # fill in DATABASE_URL / JWT_SECRET
npm install
npm run dev
```
