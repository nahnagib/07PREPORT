# 07PREPORT — Sales/Promotion Dashboard & ETL Platform

Sales and promotion reporting platform for Ben Moussa Holding Group (BMH), covering the **07 Ps**
web dashboard and the Python ETL pipeline that feeds it from Odoo and reference Excel workbooks.

Phase 1 (the Tachometer dashboard + warehouse + ETL foundation) is functionally complete. This
repository is the single source of truth for everything needed to run the system: web app, ETL,
reference data templates, and deployment configuration.

## Repository Layout

```
07PREPORT/
├── 07ps-sales-dashboard-app/   # The application itself (frontend, backend, ETL, warehouse)
│   ├── frontend/               # Next.js + TypeScript + Tailwind dashboard
│   ├── backend/                # Node.js/Express API, JWT auth, ETL orchestration
│   ├── packages/ui/            # @07ps/ui — shared component library
│   ├── data/etl/               # Python ETL pipeline (Odoo + Excel → MySQL / Excel export)
│   ├── data/ingestion/         # Earlier/CI-linted ingestion service (mocked-Odoo tests)
│   ├── data/warehouse/         # MySQL 8 star-schema migrations + KPI measures layer
│   ├── docs/                   # Detailed, verified technical docs (architecture, ETL, ops)
│   └── docker-compose.yml      # Production stack: redis, backend, frontend, etl-worker, ingestion
├── Input/                      # Reference Excel templates the ETL depends on (see below)
├── docs/                       # Repo-wide docs (this overview level) + docs/archive/
├── assets/brand/               # Raw brand/logo source files (BMH, Majaal, Tika)
├── .env.example                # Environment variable reference (see the real .env.example files
│                                #   inside 07ps-sales-dashboard-app/backend and data/ingestion)
└── .gitignore
```

## Architecture

```
Next.js frontend  →  Express/Node API  →  MySQL 8 (warehouse)  ←  Python ETL (Odoo + Excel)
                          │                                            │
                          └── Redis (BullMQ job queue, ETL only) ──────┘
```

- **Frontend**: Next.js 14 (App Router), TypeScript, Tailwind CSS, `@07ps/ui` shared components.
- **Backend**: Node.js/Express (TypeScript), JWT-based auth, role-scoped API middleware.
- **Database**: MySQL 8 (the platform originally targeted PostgreSQL; see
  [`docs/tech-stack-decision.md`](07ps-sales-dashboard-app/docs/tech-stack-decision.md) for the
  documented correction and why).
- **ETL**: Python (`pandas`, Odoo XML-RPC, `openpyxl`), run on-demand or on a schedule, writing to
  MySQL and/or an Excel export.
- **Queue**: Redis + BullMQ — only required for background/scheduled ETL execution; not required
  to run the web app or to run the ETL manually with `--sync`.
- **Hosting target**: a Libyan Spider VPS running the stack under Docker Compose.

Full rationale for every choice above is in
[`07ps-sales-dashboard-app/docs/tech-stack-decision.md`](07ps-sales-dashboard-app/docs/tech-stack-decision.md).

## Requirements

| Software | Version | Needed for |
|---|---|---|
| Node.js | ≥ 20 | frontend, backend |
| npm | bundled with Node | npm workspaces (frontend/backend/packages/ui share one `node_modules`) |
| Python | ≥ 3.10 | the vendored ETL pipeline in `data/etl/` |
| MySQL | 8.x | the app connects to an existing instance; not containerized |
| Redis | any recent version | only for the ETL queue/worker/scheduler execution path |
| Docker | optional | production deployment via `docker-compose.yml`, or running Redis locally |

## Installation & Running Locally

The full, verified step-by-step guide (with expected output for every command) lives in
**[`07ps-sales-dashboard-app/docs/running-the-project.md`](07ps-sales-dashboard-app/docs/running-the-project.md)**.
Short version:

```bash
cd 07ps-sales-dashboard-app
npm install                                    # installs frontend, backend, packages/ui

# Configure environment (never commit the resulting .env files)
cp backend/.env.example backend/.env
cp data/ingestion/.env.example data/ingestion/.env
# edit backend/.env: DB_*, JWT_SECRET, ODOO_*, SMTP_*, REDIS_* — see comments in the file

# Run the web app (two terminals)
cd backend && npm run dev      # http://localhost:4000
cd frontend && npm run dev     # http://localhost:3000
```

See [Environment Files](07ps-sales-dashboard-app/docs/running-the-project.md#environment-files)
for exactly which variables are needed and why only `backend/.env` matters for the web app.

## Reference Input Files

The ETL depends on a small set of manually-maintained Excel workbooks, committed at
[`Input/`](Input/):

| File | Purpose |
|---|---|
| `SalesTeam.xlsx` | Sales team / salesperson reference dimension |
| `sales_targets.xlsx` | Target/plan figures reconciled against the warehouse's Target/Plan fact |
| `PRODUCTS.xlsx` | Product reference dimension |
| `OffDays.xlsx` | Business calendar exceptions |
| `BlockedCustomers.xlsx` | Customer exclusion list |

These are **required templates** — keep them under version control and update them in place when
the business data changes. **Do not commit** anything under `data/etl/Exports/` or
`data/etl/Input/` inside the app folder — those are the ETL's local runtime working copies
(already git-ignored by `data/etl/.gitignore`) and are regenerated/repopulated per environment.

## ETL Workflow

The ETL is a Python pipeline (`data/etl/`) invoked through the Node backend
(`backend/src/etl/`), in four modes — full refresh, incremental refresh, SQL-only, and Excel
export — each runnable manually (`--sync`) or via the Redis-backed queue/worker. Full details,
every command, and expected run times are documented in
[`docs/ETL_WORKFLOW.md`](docs/ETL_WORKFLOW.md) (this repo) and
[`07ps-sales-dashboard-app/docs/running-the-project.md`](07ps-sales-dashboard-app/docs/running-the-project.md).

## Scheduler

The backend registers two cron schedules on startup (`registerEtlSchedules()` in
`backend/src/server.ts`): an incremental refresh several times a day and a full refresh nightly.
The scheduler only *enqueues* jobs — a running `npm run etl:worker` process and a reachable Redis
instance are required for anything to actually execute. See
[`07ps-sales-dashboard-app/docs/running-the-project.md`](07ps-sales-dashboard-app/docs/running-the-project.md#5-scheduler)
for configuration and verification steps.

## Deployment

Production target is a Libyan Spider VPS running the whole stack via
`07ps-sales-dashboard-app/docker-compose.yml` (Redis, backend, frontend, ETL worker, ingestion —
behind Nginx/TLS). See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the repo-level overview and
[`07ps-sales-dashboard-app/docs/etl-deployment.md`](07ps-sales-dashboard-app/docs/etl-deployment.md)
for ETL-specific deployment notes.

## Documentation Index

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — repo-level architecture summary
- [`docs/ETL_WORKFLOW.md`](docs/ETL_WORKFLOW.md) — ETL modes, scheduling, monitoring
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — deployment overview
- [`docs/archive/`](docs/archive/) — historical development notes/status reports from building
  Phase 1 (kept for reference, not maintained going forward)
- [`07ps-sales-dashboard-app/docs/`](07ps-sales-dashboard-app/docs/) — detailed, code-verified
  technical docs: tech stack decisions, running the project, ETL deployment, standards, migration
  plan

## Security

- All credentials live in `.env` files (`backend/.env`, `data/ingestion/.env`), never committed —
  see the root [`.gitignore`](.gitignore).
- Copy `*.env.example` → `.env` and fill in real values per environment.
- If you are cloning this repository from an earlier, informal working copy: **rotate every
  credential that ever appeared in a chat, ticket, or the archived docs under `docs/archive/`**
  before treating this as production-secure. See the pre-release audit notes for specifics.

## Status

**Phase 1**: web app foundation (Tachometer dashboard, warehouse, JWT auth, ETL pipeline,
scheduler) — functionally complete. Later phases (Critical Number, Revenue Trend, Invoices Engine,
Customer Growth) are not yet built.
