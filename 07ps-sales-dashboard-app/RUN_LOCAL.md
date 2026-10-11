# Run the app locally (Docker Desktop, Windows)

Local testing only. The stack uses the MySQL on this PC (`host.docker.internal:3306`, database
`powerBI_Data`) and reads Odoo **read-only** (writes are blocked in code). Nothing here touches the
production server.

Run every command from this folder (`07ps-sales-dashboard-app`), in PowerShell or Git Bash.

## URLs

| What | URL |
| --- | --- |
| App (frontend) | http://localhost:13000/Dashboard |
| Receivables & aging | http://localhost:13000/Dashboard/price/receivables-collections |
| Backend API | http://localhost:14000 |
| ETL API | http://localhost:15001 |

## 1. Start

1. Open Docker Desktop and wait until it says "running".
2. Start (or rebuild after a code change):

   ```
   docker compose -p 07ps-local -f docker-compose.yml -f docker-compose.local.yml up -d --build
   ```

3. Check every container says `healthy`:

   ```
   docker compose -p 07ps-local ps
   ```

## 2. Stop

```
docker compose -p 07ps-local -f docker-compose.yml -f docker-compose.local.yml down
```

`down` keeps the data (MySQL is outside Docker; the ETL volumes stay). Do not add `-v` unless you
want to delete the ETL output/log volumes.

## 3. Run the ETL

Full run (core dimensions, then receivables/aging, then sales full; about 30-45 min):

```
docker compose -p 07ps-local exec etl-api python -m etl_platform.run full_all --full --trigger-source development
```

Other jobs (same command, other job name):

| Job | What it does |
| --- | --- |
| `main` | core dimensions + sales, no finance (fast daily run) |
| `finance_receivables` | receivables / aging snapshot of today only |
| `full_all` | everything (above) |

Exit codes: `0` success, `1` failed, `3` partial (e.g. finance failed, sales kept), `4` skipped
(another run holds the lock).

Logs while it runs:

```
docker compose -p 07ps-local logs -f etl-api
```

## 4. Database migrations

There is no migration ledger. Apply only new files, by name, to the local database:

```
python data/warehouse/apply_migrations.py 0041_example.sql
```

(uses `DB_*` from your shell environment; take values from `backend/.env`, `DB_HOST=127.0.0.1`.)
Never run it without file names on an existing database.

## 5. Automated tests

```
cd backend;  npm test
cd frontend; npm test
cd data/etl; .venv\Scripts\python -m pytest -q
```

## Settings

- `data/etl/.env`: Odoo + ETL settings. `ODOO_COMPANY_NAMES=Athena` adds Athena. Finance uses
  `ODOO_DEBT_LOGIN` / `ODOO_DEBT_API_KEY` (currently the same account as `ODOO_USER`).
- `backend/.env`: backend settings.
- The old `07ps-aging` stack (ports 3000/4000/5001/6379) is separate; stop it from
  `..\..\07PREPORT-aging\07ps-sales-dashboard-app` with `docker compose -p 07ps-aging down` if not needed.
