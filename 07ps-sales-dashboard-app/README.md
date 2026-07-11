# 07 Ps Sales Dashboard — Web App

Power BI → web application migration for Ben Moussa Holding Group's Sales/Promotion dashboard
(Tachometer, Critical Number, Revenue Trend, Invoices Engine, Customer Growth), governed by
[`docs/07Ps_Phase1_Architecture_Standards.md`](docs/07Ps_Phase1_Architecture_Standards.md) and
[`docs/Sales_Promotion_Dashboard_Migration_Plan.docx`](docs/Sales_Promotion_Dashboard_Migration_Plan.md).

See [`docs/status-report.md`](docs/status-report.md) for exactly what's been delivered and which
standards section each piece satisfies, and [`docs/tech-stack-decision.md`](docs/tech-stack-decision.md)
for why each technology was chosen (including the Postgres → **MySQL 8** correction).

**Tachometer is the first live Sales page** (see `frontend/src/app/page.tsx`), wired to a real
TypeScript backend (`backend/src/measures/`) and gated to run only against throwaway/validation
data -- never live Odoo or production. Critical Number, Revenue Trend, Invoices Engine, and
Customer Growth are not built yet; their nav tabs are visible but disabled.

## Layout

```
frontend/         Next.js + TypeScript + Tailwind - header, sidebar filters, nav, and the
                   Tachometer page. @07ps/ui is the only component library every page uses.
backend/           Node.js/Express API (mysql2) - Tachometer measures endpoints, filter
                   value-lists, refresh-status, and application-level Salesperson RBAC scope
                   enforcement (backend/src/middleware/scopeContext.ts).
packages/ui/       @07ps/ui - the shared, versioned component library every dashboard must use
                   (Standards Section 3.20/5.8).
data/warehouse/    MySQL 8 star-schema migrations + the Python Tachometer KPI measures layer
                   (data/warehouse/measures/) that backend/src/measures/ is a 1:1 TypeScript port of.
data/ingestion/    Python: mocked-Odoo connector + real Excel Input-file ingestion (orchestrator.py),
                   plus load_real_export.py - loads a real SalesModel_OneOutput.xlsx export
                   directly for KPI validation/local dev (see below).
docs/              Standards + migration plan (converted to Markdown, version-controlled here),
                   tech stack decision doc, and the delivery status report.
```

## Getting started (local dev)

Prerequisites: Node.js 20+, Python 3.10+, and a MySQL 8 server reachable from your machine
(MySQL Community Server, XAMPP/WAMP, or `docker run -p 3306:3306 -e MYSQL_ROOT_PASSWORD=devpass
-e MYSQL_DATABASE=ps_warehouse mysql:8` if you have Docker Desktop). You do **not** need the
`mysql` command-line client -- every step below uses Python (`pymysql`) instead, since PowerShell
doesn't support the `mysql ... < file.sql` redirection syntax and the CLI often isn't installed/on
`PATH` on Windows.

```powershell
npm install                                   # installs frontend, backend, and packages/ui
pip install pymysql --break-system-packages   # or just: pip install -r data\ingestion\requirements.txt

# 1. Point everything at your MySQL instance
copy backend\.env.example backend\.env          # fill in DB_HOST/DB_USER/DB_PASSWORD/JWT_SECRET
copy data\ingestion\.env.example data\ingestion\.env
# apply_migrations.py and load_real_export.py both read DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/
# DB_NAME/DB_SOCKET from the environment -- either set them in your shell before each command
# below, or (simplest) load backend\.env's values into your PowerShell session first:
Get-Content backend\.env | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { Set-Item "Env:$($matches[1])" $matches[2] }
}

# 2. Create the schema - applies every file in data/warehouse/migrations/ in order
python data\warehouse\apply_migrations.py
# (creates the DB_NAME database if it doesn't exist yet; deprecated Postgres-era stub files in
# that folder are pure comments and are harmless to include)

# 3. Load data - pick ONE:
#    (a) Real historical data (recommended - what the Tachometer KPIs were validated against):
python data\ingestion\load_real_export.py "C:\path\to\SalesModel_OneOutput.xlsx"
#        Reads a ~65MB, 28-sheet workbook via openpyxl - the large fact sheets genuinely take a
#        few minutes to parse. Let it run; see data/ingestion/tachometer_kpi_validation.md for the
#        expected reconciled figures.
#
#    (b) Small, obviously-fake mocked data (fast, but only useful for a UI smoke test):
python data\ingestion\orchestrator.py --run-once

# 4. Start the app (two separate terminal windows)
npm run dev:backend     # http://localhost:4000
npm run dev:frontend    # http://localhost:3000
```

Open **http://localhost:3000** - it lands on the Tachometer page. A dev-only "Sign-in" role
switcher in the page content area (see `backend/src/routes/devAuth.ts`) lets you exercise the
Salesperson RBAC lock end-to-end; it is not a real login system and refuses to run if
`NODE_ENV=production`.

## Deployment target

Libyan Spider VPS (root access) via `docker compose up -d --build` — see
`docs/tech-stack-decision.md` Section 5 for why, and `docker-compose.yml` for the service layout.
Note: `docker-compose.yml`'s `postgres` service is stale (pre-dates the MySQL correction) and
should be swapped for a `mysql:8` service before this is used to actually deploy.

## What's NOT in this repo yet (by design)

Critical Number, Revenue Trend, Invoices Engine, and Customer Growth pages (Phase P3, not started).
A real login/identity system (the Tachometer page's role switcher is a dev-only stand-in). A live
Odoo connection (the ingestion pipeline defaults to a mocked Odoo client; set `ALLOW_LIVE_ODOO=1`
only once real credentials and network access are actually available).
