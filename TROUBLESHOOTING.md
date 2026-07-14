# Troubleshooting

Common issues across local development and deployment. For VPS/Docker-specific problems, see also
[`07ps-sales-dashboard-app/docs/vps-deployment.md`](07ps-sales-dashboard-app/docs/vps-deployment.md#troubleshooting).

## Local Development

### `ModuleNotFoundError: No module named 'config'` or `'sales_pipeline'`

The vendored ETL pipeline (`data/etl/src/sales_pipeline/`) needs `data/etl/config/` (a sibling
package) and `data/etl/sitecustomize.py` (adds `src/` to `sys.path`) present alongside it, and must
be run with **`data/etl/` as the working directory** — not from inside `data/etl/api/` or
`data/etl/src/`. If you're invoking the pipeline directly (not through the Flask API or
`pythonRunner.ts`), make sure your `cwd` is `data/etl/` and you're using the pipeline's own venv
(`data/etl/.venv`), which has `sales_pipeline` installed as an editable package (`pip install -e .`).

### `Access denied for user '...'@'localhost'` from MySQL

Your local MySQL instance's credentials don't match what's in `backend/.env` / `data/etl/.env`.
This is an environment fact, not a code bug — check the actual root/app-user password for your
local MySQL install, or point `DB_HOST`/`DB_USER`/`DB_PASSWORD` at a MySQL instance you do have
credentials for.

### `npm run etl:run -- --sync` fails immediately with a connection error

The ETL pipeline runs behind a separate Flask API now (`data/etl/api/`) — `pythonRunner.ts` calls
it over HTTP even for `--sync` runs. Make sure that API is actually running locally
(`cd data/etl/api && python app.py`) and that `ETL_API_URL`/`ETL_API_KEY` in `backend/.env` point
at it and match its own `ETL_API_KEY`. See
[`07ps-sales-dashboard-app/docs/etl-deployment.md`](07ps-sales-dashboard-app/docs/etl-deployment.md#local-development).

### `PYTHONPATH` with multiple entries doesn't work on Windows

Use `;` as the separator on Windows (`PYTHONPATH=.;vendor;vendor/sales_pipeline_src`), not `:` —
`:` is the POSIX separator and Git Bash won't translate it for a native Windows Python process.
This is a shell/OS quirk, not a project bug.

### Vitest/Jest-style tests hang or a background process never exits

If a test (or a manual script) spawns a subprocess and reads its stdout/stderr on separate threads,
double-check any custom locking: a plain `threading.Lock` is **not reentrant** — calling a method
that re-acquires the same lock from inside a `with lock:` block deadlocks instantly. Check for this
pattern before assuming it's an I/O or timing issue.

## Deployment / Docker

### `docker compose build` fails with a Python import error inside `etl-api`

Almost always means `data/etl/Dockerfile.api` didn't copy the whole `data/etl/` tree. The pipeline
needs `config/`, `sitecustomize.py`, and `src/` all present as siblings — copying only `api/` and
`src/` reproduces the exact `ModuleNotFoundError` described above, just inside a container instead
of a local shell.

### `etl-worker` logs show "connection refused" reaching the ETL API

Confirm `ETL_API_URL=http://etl-api:5001` (the Docker Compose service name, not `localhost`) —
container-to-container traffic uses Docker's internal DNS, not the host loopback. This is already
set as an explicit `environment:` override in `docker-compose.yml`; don't override it again via
`backend/.env` unless you mean to point somewhere else.

### Frontend can't reach the backend / CORS errors in the browser console

`NEXT_PUBLIC_API_BASE_URL` is baked into the frontend's client bundle at **build** time (Next.js
inlines `NEXT_PUBLIC_*` vars when `next build` runs), not read at container start. If you change
it, you must rebuild the frontend image (`docker compose build frontend`), not just restart the
container. Also confirm `backend/.env`'s `FRONTEND_ORIGIN` matches the frontend's real origin.

### `docker compose config` printed real secrets to my terminal/logs

`docker compose config` resolves and prints the **fully merged environment**, including everything
from `env_file`-referenced `.env` files. Treat any credentials it prints as exposed wherever that
output was captured (terminal scrollback, CI logs, a pasted chat transcript) and rotate them.
Prefer `docker compose config --services` or piping through something that redacts values if you
just need to confirm the file parses.

### Nginx 502 on the API subdomain

The backend container isn't up or isn't healthy yet — check `docker compose ps` and
`docker compose logs backend`. If it's healthy but Nginx still 502s, confirm `proxy_pass` in
`docker/nginx.conf` points at the right port (`127.0.0.1:4000`) and that the backend's
`ports:` mapping in `docker-compose.yml` is actually published to that same port on the host.

### SSL certificate errors

Run `certbot certificates` to check expiry/coverage. The most common cause is DNS not actually
resolving to the VPS yet when `certbot` ran — confirm with `nslookup <domain>` before retrying.

## Still Stuck?

Check `docker compose logs -f <service>` for the specific failing service, then
[`07ps-sales-dashboard-app/docs/etl-deployment.md`](07ps-sales-dashboard-app/docs/etl-deployment.md)
or [`07ps-sales-dashboard-app/docs/vps-deployment.md`](07ps-sales-dashboard-app/docs/vps-deployment.md)
for the deeper architecture context behind whichever piece is failing. If none of the above covers
it, open a GitHub issue with the exact error, which environment (local/VPS), and what you already
tried.
