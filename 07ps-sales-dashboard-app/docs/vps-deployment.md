# VPS Deployment Guide

Deploys the full stack (frontend, backend, ETL Flask API, ETL worker, Redis) to a Libyan Spider
VPS (or any Docker-capable VPS with root access) via `docker compose up -d --build`, fronted by
Nginx for TLS termination and subdomain routing. See `docs/tech-stack-decision.md` Section 5 for
why this hosting tier was chosen, and `docs/etl-deployment.md` for how the ETL module itself works.

## Prerequisites

- VPS: Ubuntu 22.04+, 4 CPU / 8GB RAM recommended, public IP, root/sudo access
- A domain with DNS you control (this guide uses `benmussa-invest.com` as the example - replace
  with the real domain everywhere, including `docker-compose.yml`'s `NEXT_PUBLIC_API_BASE_URL`
  default and every `server_name` in `docker/nginx.conf`)
- MySQL 8: an existing instance this app connects to (not containerized - see
  `docs/tech-stack-decision.md`)

## 1. DNS setup

Point these A records at the VPS's public IP before requesting TLS certificates (Let's Encrypt's
HTTP-01 challenge needs them resolving already):

```
benmussa-invest.com          A   <VPS_IP>
www.benmussa-invest.com      A   <VPS_IP>
api.benmussa-invest.com      A   <VPS_IP>
```

`etl-api.benmussa-invest.com` is only needed if you uncomment the optional ETL API server block in
`docker/nginx.conf` - not required for normal operation.

## 2. Provision the VPS

```bash
ssh root@<VPS_IP>
apt-get update && apt-get upgrade -y
curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh
apt-get install -y nginx certbot python3-certbot-nginx
```

## 3. Clone and configure

```bash
git clone <this-repo-url> && cd 07ps-sales-dashboard-app
cp backend/.env.example backend/.env               # fill in real DB_*/JWT_SECRET/SMTP/ETL_API_KEY
cp data/etl/.env.example data/etl/.env             # fill in real DB_*/ODOO_*/ETL_API_KEY
cp data/ingestion/.env.example data/ingestion/.env # optional side sandbox, see its own README
```

`ETL_API_KEY` must be the **same** value in `backend/.env` and `data/etl/.env` - it's the Bearer
token the backend/etl-worker use to authenticate to the Flask ETL API. Generate one with:

```bash
openssl rand -base64 32
```

Set `NEXT_PUBLIC_API_BASE_URL` for the real domain, either by exporting it before the build or
editing `docker-compose.yml`'s default directly:

```bash
export NEXT_PUBLIC_API_BASE_URL=https://api.benmussa-invest.com
```

## 4. Build and start

```bash
docker compose build
docker compose up -d
docker compose ps          # wait for all services to report "healthy"
docker compose logs -f     # watch startup; Ctrl-C to stop tailing (containers keep running)
```

`ingestion` and `etl-worker` don't have HTTP health checks (no endpoint to check) - `docker compose
logs etl-worker` should show it connecting to Redis without errors instead.

## 5. Configure Nginx + TLS

```bash
cp docker/nginx.conf /etc/nginx/nginx.conf   # after replacing benmussa-invest.com with the real domain
nginx -t                                      # validate syntax before (re)starting
systemctl restart nginx
certbot certonly --nginx -d benmussa-invest.com -d www.benmussa-invest.com -d api.benmussa-invest.com
nginx -t && systemctl reload nginx
certbot renew --dry-run                       # confirms auto-renewal is wired up
```

## 6. Verify

```bash
bash scripts/health-check.sh benmussa-invest.com
```

Or manually:

```bash
curl -sf https://benmussa-invest.com/ > /dev/null && echo frontend OK
curl -sf https://api.benmussa-invest.com/health && echo
curl -sf http://127.0.0.1:5001/health && echo    # ETL API - internal only, run this on the VPS itself
```

Then from the admin panel: trigger an incremental ETL run and confirm it completes in
**Admin → ETL Runs**, and check `docker compose logs etl-api` shows the subprocess ran (no
`ModuleNotFoundError` - if you see one, `data/etl/Dockerfile.api` didn't copy the full tree, or
`data/etl/.env`'s `ODOO_*`/`DB_*` values are missing/wrong).

## Monitoring

```bash
docker stats                              # live CPU/memory per container
docker compose logs --tail=200 etl-api    # Flask API + spawned pipeline's stdout/stderr
docker compose logs --tail=200 etl-worker # BullMQ job lifecycle (queued/started/failed/retrying)
```

Detailed pipeline run history (rows loaded, QA issues, per-table counts) lives in MySQL
(`pipeline_run_log`/`pipeline_run_audit`), visible in-app at **Admin → ETL Runs** - not duplicated
in any of the above logs. See `docs/etl-deployment.md`.

## Troubleshooting

- **`docker compose ps` shows etl-api unhealthy**: `docker compose logs etl-api` - most likely
  `data/etl/.env` is missing or has a bad `DB_*`/`ODOO_*` value, or the image failed to build
  `sales_pipeline` as editable (check the build log for `pip install -e .` errors).
- **etl-worker logs show connection refused to etl-api**: confirm `ETL_API_URL=http://etl-api:5001`
  (Docker network DNS, not `localhost`) - already set in `docker-compose.yml`'s `etl-worker`
  service; don't override it via `backend/.env` unless you mean to.
- **Frontend can't reach the backend / CORS errors in browser console**: `NEXT_PUBLIC_API_BASE_URL`
  is baked into the frontend image at *build* time, not read at container start - if you change it,
  you must `docker compose build frontend` again, not just restart the container. Also confirm
  `backend/.env`'s `FRONTEND_ORIGIN` matches the frontend's real origin (CORS).
- **Nginx 502 on api.\<domain\>**: backend container isn't up/healthy yet, or crashed - check
  `docker compose logs backend`.
- **TLS certificate errors**: `certbot certificates` to check expiry/coverage; confirm DNS actually
  resolves to the VPS before re-running certbot (a stale/missing A record is the most common cause).

## Rollback

```bash
docker compose down
git checkout <previous-commit-or-tag>
docker compose up -d --build
```

MySQL is untouched by any of the above (it's external) - a rollback only affects the app
containers, never warehouse data.
