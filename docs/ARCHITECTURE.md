# Architecture Overview

This is a repo-level summary. For the full, section-by-section rationale behind every technology
choice, see
[`07ps-sales-dashboard-app/docs/tech-stack-decision.md`](../07ps-sales-dashboard-app/docs/tech-stack-decision.md).

## Components

```
Next.js frontend  →  Express/Node API  →  MySQL 8 (warehouse)  ←  Python ETL (Odoo + Excel)
                          │                                            ▲
                          │                                            │ HTTP
                          └── Redis (BullMQ, ETL queue only) ── etl-worker ── ETL Flask API
```

| Layer | Technology | Location |
|---|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS | `07ps-sales-dashboard-app/frontend/` |
| Shared UI | `@07ps/ui` component library | `07ps-sales-dashboard-app/packages/ui/` |
| Backend/API | Node.js + Express, TypeScript | `07ps-sales-dashboard-app/backend/` |
| Auth | JWT, issued by the backend, role/company/salesperson-scoped | `backend/src/middleware/` |
| Warehouse | MySQL 8, star schema | `07ps-sales-dashboard-app/data/warehouse/` |
| ETL pipeline | Python (pandas, Odoo XML-RPC, openpyxl) | `07ps-sales-dashboard-app/data/etl/` |
| ETL Flask API | Flask/gunicorn, wraps the ETL pipeline as an HTTP service | `07ps-sales-dashboard-app/data/etl/api/` |
| Job queue | Redis + BullMQ (ETL only) | configured via `REDIS_HOST`/`REDIS_PORT` |

## Data Flow

1. **Odoo ERP** and manually-maintained **Excel reference files** (`Input/`) are the two source
   systems.
2. The Node backend's `etl-worker` process enqueues/consumes ETL jobs via BullMQ, but doesn't
   execute the pipeline itself — it calls the **ETL Flask API** (`data/etl/api/`) over HTTP, which
   is the only process that actually spawns the Python pipeline (`data/etl/`) and has its
   dependencies installed. This split exists because the API/worker containers otherwise wouldn't
   need Python at all; see `07ps-sales-dashboard-app/docs/etl-deployment.md`.
3. The pipeline extracts, transforms, and loads into the MySQL warehouse (or, in Excel-export
   mode, writes a workbook instead — never both destinations from Odoo directly to the web app).
4. The main Node backend (API process) reads exclusively from the warehouse — it never queries
   Odoo directly, and never calls the ETL Flask API itself (only `etl-worker` does).
5. The Next.js frontend calls the backend's REST API — a **separate origin/subdomain** in
   production (`NEXT_PUBLIC_API_BASE_URL`), not a path prefix on the same domain, since backend
   routes are mounted at root paths (`/health`, `/tachometer`, `/admin/etl-runs`, etc.) that can
   collide with frontend page routes of the same name.

## Why MySQL, not PostgreSQL

The platform was originally designed around PostgreSQL for its native Row-Level Security. Once it
was confirmed the production BI/Odoo environment already runs MySQL, the warehouse was switched to
target MySQL directly rather than introduce a second database engine. This is a real, documented
gap: MySQL has no RLS equivalent, and the row-level scoping mechanism for MySQL is deferred/ongoing
work. See §3 and §8 of
[`tech-stack-decision.md`](../07ps-sales-dashboard-app/docs/tech-stack-decision.md) for the full
history and what's still open.

## Further Reading

- [`07ps-sales-dashboard-app/docs/tech-stack-decision.md`](../07ps-sales-dashboard-app/docs/tech-stack-decision.md) — full rationale per layer
- [`07ps-sales-dashboard-app/docs/running-the-project.md`](../07ps-sales-dashboard-app/docs/running-the-project.md) — verified setup/run guide
- [`07ps-sales-dashboard-app/data/warehouse/README.md`](../07ps-sales-dashboard-app/data/warehouse/README.md) — schema details
