# Deployment Overview

This is a repo-level summary. The authoritative, detailed deployment/operations docs are
[`07ps-sales-dashboard-app/docs/etl-deployment.md`](../07ps-sales-dashboard-app/docs/etl-deployment.md)
(ETL integration) and
[`07ps-sales-dashboard-app/docs/vps-deployment.md`](../07ps-sales-dashboard-app/docs/vps-deployment.md)
(full VPS walkthrough: DNS, Docker, Nginx, TLS).

## Target Environment

- **Host**: Libyan Spider VPS (root access).
- **Orchestration**: Docker Compose (`07ps-sales-dashboard-app/docker-compose.yml`) — `frontend`,
  `backend` (API + ETL scheduler), `redis`, `etl-api` (Flask service wrapping the Python pipeline),
  `etl-worker` (BullMQ worker, calls `etl-api` over HTTP), `ingestion`, behind Nginx/TLS.
- **Reverse proxy**: Nginx runs on the VPS host (not in Docker Compose) — see
  `07ps-sales-dashboard-app/docker/nginx.conf`. Routing is **subdomain-based**, not path-based: the
  frontend serves the main domain, the backend serves a separate `api.` subdomain — they can't
  share one domain with a path prefix since backend routes aren't under `/api/` and some collide
  with frontend page paths (e.g. `/admin/etl-runs` is both a page and an API route).
- **Database**: an existing MySQL 8 instance — **not** containerized as part of this stack.

The compose file was intentionally left inside `07ps-sales-dashboard-app/` (not moved to a
top-level `deployment/` folder) because its build contexts (`context: .`) are relative to that
folder — moving it without updating every `Dockerfile`/context path would risk breaking the build.

## Quick Deploy

```bash
git clone <this repo> && cd 07PREPORT/07ps-sales-dashboard-app
cp backend/.env.example backend/.env       # fill in real DB/JWT/SMTP/Odoo/ETL_API_KEY values
cp data/etl/.env.example data/etl/.env     # fill in real DB/Odoo/ETL_API_KEY values (same key)
cp data/ingestion/.env.example data/ingestion/.env
docker compose up -d --build
```

Full step-by-step (DNS, Nginx, TLS, health checks): see `docs/vps-deployment.md` linked above.

## Things That Commonly Differ Between Local Dev and Production

- `REDIS_HOST` (`redis`) and `ETL_API_URL` (`http://etl-api:5001`) are set directly as
  `environment:` overrides in `docker-compose.yml` — don't rely on `backend/.env`'s local-dev
  defaults (`localhost`) under Docker Compose.
- `ETL_API_KEY` must be identical in `backend/.env` and `data/etl/.env` — one shared Bearer secret,
  two files because the ETL API is now its own container.
- `DB_HOST=localhost` will not resolve from inside a container if MySQL runs on the same host as
  the containers — use `host.docker.internal` (with the matching `extra_hosts` entry) or the
  host's real reachable address instead.
- `NEXT_PUBLIC_API_BASE_URL` is inlined into the frontend's client bundle at **build** time, not
  read at container start — changing it requires `docker compose build frontend` again, not just a
  restart.

## Operating the System

- **Check ETL run history**: Admin → ETL Runs in the web app, or `GET /admin/etl-runs/log`.
- **Trigger a manual ETL run**: `docker compose exec backend npm run etl:run` (or `-- --full`).
- **Change the ETL schedule**: edit `ETL_SCHEDULE_INCREMENTAL_CRON` / `ETL_SCHEDULE_FULL_CRON` in
  `backend/.env` and restart the `backend` service.
- **Troubleshoot**: Admin → ETL Runs first (pipeline-level errors/counts), then
  `docker compose logs etl-worker` (orchestration-level: job/queue/retry/exit-code detail) or
  `docker compose logs etl-api` (the pipeline's own raw stdout/stderr).

## Before You Deploy — Security Checklist

- [ ] `backend/.env`, `data/etl/.env`, and `data/ingestion/.env` contain **real, freshly-rotated**
      credentials (not values that were ever pasted into a chat, ticket, or the archived notes
      under [`docs/archive/`](archive/)).
- [ ] `.env` files are not committed (verify: `git status` shows none, `git check-ignore -v
      backend/.env` reports a match).
- [ ] TLS/Nginx is configured in front of the `frontend`/`backend` containers; the ETL API is
      **not** exposed externally (internal-only by default — see `docker/nginx.conf`).
- [ ] `NODE_ENV=production` (disables any dev-only auth shortcuts).

Full details: [`07ps-sales-dashboard-app/docs/etl-deployment.md`](../07ps-sales-dashboard-app/docs/etl-deployment.md)
and [`07ps-sales-dashboard-app/docs/vps-deployment.md`](../07ps-sales-dashboard-app/docs/vps-deployment.md).
