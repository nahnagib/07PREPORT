# Architecture Overview

This is a repo-level summary. For the full, section-by-section rationale behind every technology
choice, see
[`07ps-sales-dashboard-app/docs/tech-stack-decision.md`](../07ps-sales-dashboard-app/docs/tech-stack-decision.md).

## Components

```
Next.js frontend  →  Express/Node API  →  MySQL 8 (warehouse)  ←  Python ETL (Odoo + Excel)
                          │                                            │
                          └── Redis (BullMQ job queue, ETL only) ──────┘
```

| Layer | Technology | Location |
|---|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS | `07ps-sales-dashboard-app/frontend/` |
| Shared UI | `@07ps/ui` component library | `07ps-sales-dashboard-app/packages/ui/` |
| Backend/API | Node.js + Express, TypeScript | `07ps-sales-dashboard-app/backend/` |
| Auth | JWT, issued by the backend, role/company/salesperson-scoped | `backend/src/middleware/` |
| Warehouse | MySQL 8, star schema | `07ps-sales-dashboard-app/data/warehouse/` |
| ETL | Python (pandas, Odoo XML-RPC, openpyxl) | `07ps-sales-dashboard-app/data/etl/` |
| Job queue | Redis + BullMQ (ETL only) | configured via `REDIS_HOST`/`REDIS_PORT` |

## Data Flow

1. **Odoo ERP** and manually-maintained **Excel reference files** (`Input/`) are the two source
   systems.
2. The Python ETL pipeline (`data/etl/`) extracts, transforms, and loads into the MySQL warehouse
   (or, in Excel-export mode, writes a workbook instead — never both destinations from Odoo
   directly to the web app).
3. The Node backend reads exclusively from the warehouse — it never queries Odoo directly.
4. The Next.js frontend calls the backend's REST API for dashboard data, filter value-lists, and
   ETL run status.

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
