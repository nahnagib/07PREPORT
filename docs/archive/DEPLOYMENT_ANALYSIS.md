# Deployment Analysis: 07ps Sales Dashboard

## Executive Summary
The project is **partially ready for production deployment**. Docker Compose architecture is sound, but critical issues exist: database configuration mismatch (CI tests PostgreSQL, production needs MySQL 8), missing authentication layer, incomplete ETL orchestration, and gaps in monitoring/logging. Direct VPS deployment is feasible but requires remediation of these issues first.

---

## Current Architecture

### Services Stack (docker-compose.yml)
| Service | Runtime | Purpose | Status |
|---------|---------|---------|--------|
| **backend** | Node.js 20 | Express API, measures, RBAC, filter endpoints | ✅ Ready |
| **frontend** | Node.js 20 + Next.js | Dashboard UI (Tachometer page live) | ⚠️ Phase 1 only |
| **redis** | Redis 7 | Job queue (BullMQ), caching layer | ✅ Ready |
| **etl-worker** | Node.js 20 + Python 3 | Async job execution, data pipeline | ⚠️ Partial |
| **ingestion** | Python 3 | Mocked Odoo + Excel file ingestion | ⚠️ Mocked only |

### Key Dependencies
- **MySQL 8**: External (non-containerized), expected already running on VPS
- **Node workspaces**: `@07ps/ui` package shared across frontend/backend
- **Python venv**: Vendored in `data/etl/.venv` (42MB+), baked into etl-worker image

---

## Critical Deployment Issues

### 1. **Database Configuration Mismatch** 🔴
**Problem:**
- CI workflow (`.github/workflows/ci.yml`) tests migrations against **PostgreSQL 16**
- Production uses **MySQL 8** (per README Section 5, `docs/tech-stack-decision.md`)
- docker-compose.yml still lists stale `postgres` service (commented out but confusing)
- No MySQL service in docker-compose; assumes external connection via `DB_HOST`

**Risk:** SQL syntax differences between PostgreSQL and MySQL could pass CI but fail production. No validation that migrations run on the actual target DB.

**Action:**
```yaml
# Update docker-compose.yml CI testing:
# Option A: Add throwaway MySQL 8 service for local testing
# Option B: Update CI workflow to test against MySQL 8 instead of PostgreSQL
# Current: sed -i 's/postgres:16/mysql:8/g' .github/workflows/ci.yml
```

### 2. **No Production Authentication** 🔴
**Problem:**
- Backend uses dev-only role switcher (`backend/src/routes/devAuth.ts`)
- Refuses to run if `NODE_ENV=production` (good safety net)
- No real login/identity system built
- JWT secret required (`JWT_SECRET` in `.env`) but no user creation flow in deployment docs

**Risk:** Cannot deploy to production until authentication layer is implemented.

**Action:**
- Document real auth flow (OAuth, SAML, basic JWT + admin console?)
- Update `backend/src/routes/devAuth.ts` to throw if production + missing auth
- Create initial admin user procedure in deployment runbook

### 3. **ETL/Ingestion Pipeline Incomplete** 🟡
**Problem:**
- `ingestion` service connects to mocked Odoo (`data/ingestion/orchestrator.py --run-once`)
- Live Odoo disabled by default (`ALLOW_LIVE_ODOO` flag requires manual credentials)
- No scheduler visible in compose for recurring ETL jobs
- BullMQ queue set up in backend but no documented job definitions
- ETL worker expects `ETL_PYTHON_BIN=/repo/data/etl/.venv/bin/python`

**Risk:** Data loading is manual or fragile; no automated refresh schedule for production.

**Action:**
- Define recurring job schedule (daily? hourly refresh of which tables?)
- Document Odoo credentials handoff (vault? GitHub secrets?)
- Test live Odoo connection before deployment
- Add health check endpoint for ETL queue status

### 4. **Missing Environment Configuration Validation** 🟡
**Problem:**
- `.env.example` files exist but are not validated at startup
- Missing required vars (`DB_HOST`, `DB_USER`, `JWT_SECRET`, Odoo creds) will fail at runtime
- No startup script to verify all env vars before services start
- Frontend has no visible `.env.example` (uses backend/frontend/.env)

**Action:**
```bash
# Create startup validation script (backend/scripts/validateEnv.ts)
# Check all required vars exist before npm start
# Run as first step in each Dockerfile CMD
```

---

## Infrastructure Requirements

### VPS Minimum Specs (Libyan Spider or equivalent)
- **CPU**: 4 cores (2 for API, 1 for frontend, 1 for ETL)
- **RAM**: 8GB (2 Redis, 2 Node API, 2 Node frontend, 2 ETL worker)
- **Storage**: 50GB+ (Docker images ~2GB, MySQL data TBD, logs/backups)
- **Docker**: 20.10+ with compose
- **MySQL 8**: Separate instance or on-host, must be reachable from containers

### Networking
- Redis: Exposed only to localhost:6379 (good)
- Backend: Exposed to localhost:4000 (needs Nginx reverse proxy)
- Frontend: Exposed to localhost:3000 (needs Nginx reverse proxy)
- **Missing**: Nginx/TLS layer (README mentions "behind Nginx/TLS" but no nginx service in compose)

### Persistent Volumes
- `redisdata`: Redis snapshot storage (essential for job queue recovery)
- MySQL: Managed externally (no volume in compose)

---

## Deployment Readiness Checklist

| Item | Status | Notes |
|------|--------|-------|
| Docker Compose valid syntax | ✅ | No syntax errors |
| All Dockerfiles buildable | ⚠️ | Need to test `docker compose build` |
| CI/CD pipeline functional | ⚠️ | DB mismatch risk |
| Environment templates exist | ✅ | `.env.example` present |
| Health checks defined | ❌ | No health probes in compose |
| Logging configured | ❌ | No log aggregation setup |
| Secrets management | ❌ | Uses plaintext .env files |
| Nginx/TLS reverse proxy | ❌ | Not in compose, mentioned in README |
| Backup strategy | ❌ | Not documented |
| Rollback procedure | ❌ | Not documented |
| Monitoring/alerting | ❌ | No Prometheus, CloudWatch, etc. |
| Load balancing | ❌ | Single instance only |

---

## Deployment Recommendations

### Phase 1: Pre-Deployment (This Week)
1. **Fix CI/CD**: Update `.github/workflows/ci.yml` to test MySQL migrations, not PostgreSQL
   - Spin up MySQL 8 service in CI, apply migrations, validate schema matches production
   - Remove or comment out stale `postgres:16` references

2. **Auth Implementation**: Decide on production auth (OAuth2 via Azure AD? Basic JWT + admin dashboard?)
   - Implement user creation/login endpoint
   - Update devAuth.ts guard to fail loudly in production
   - Generate secure JWT_SECRET for VPS (use `openssl rand -base64 32`)

3. **Environment Validation**: Create startup check
   ```typescript
   // backend/scripts/validateEnv.ts
   const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET', ...];
   required.forEach(key => {
     if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
   });
   ```

4. **Update docker-compose.yml**:
   - Remove stale postgres service
   - Add health checks (`healthcheck:` blocks for each service)
   - Add Nginx reverse proxy service (port 80/443)
   - Document MySQL connection (add comment on external dependency)

### Phase 2: VPS Preparation (Week 2)
1. Provision VPS, install Docker + Docker Compose
2. Set up MySQL 8 instance (separate container or system package)
3. Create `.env` files with production secrets
4. Test `docker compose up -d --build` against throwaway data
5. Verify all services healthy: `docker compose ps`

### Phase 3: Data & Cutover (Week 3)
1. Load real historical data using `python data/ingestion/load_real_export.py <xlsx>`
2. Validate KPIs against expected figures (see `tachometer_kpi_validation.md`)
3. Configure live Odoo connector credentials
4. Run full ETL pipeline: `npm run etl:full`
5. Blue-green deploy: test on staging VPS first, then prod

### Phase 4: Post-Deployment (Ongoing)
1. Set up log aggregation (ELK stack or CloudWatch)
2. Add Prometheus metrics (Node.js + Redis exporters)
3. Create Grafana dashboards for ETL health, DB load, API latency
4. Document runbook: restart services, view logs, manual ETL trigger
5. Establish backup: MySQL daily snapshots, Redis RDB files

---

## Security Gaps

- **No TLS/HTTPS**: Nginx reverse proxy with Let's Encrypt needed
- **No auth**: Dev role switcher only (see above)
- **Secrets in .env**: Use Docker secrets or vault (HashiCorp, AWS Secrets Manager)
- **No rate limiting**: Express backend has `express-rate-limit` dependency but may not be wired up
- **No SQL injection protection**: MySQL2 prepared statements should be enforced (need code review)
- **No input validation**: Filters and form inputs not visible in Dockerfile/CI

---

## Monitoring & Observability Gaps

Currently **no visibility into production**:
- No application logs (stdout to Docker only)
- No performance metrics (response times, ETL duration, queue backlog)
- No alerting (down services, failed ETL jobs, high error rates)
- No database monitoring (slow queries, connection pool exhaustion)
- No distributed tracing (can't follow requests across API → ETL → DB)

**Recommend:**
- Winston logging (already in backend deps) → structured logs to file/syslog
- Prometheus metrics from Node.js app + Redis exporter
- Grafana dashboards for ops team
- PagerDuty/OpsGenie alerts on critical errors

---

## Performance Considerations

### Current Bottlenecks
1. **ETL pipeline**: Loading 65MB Excel file "takes a few minutes" (see README line 67)
   - Consider async CSV streaming instead of openpyxl
   - Benchmark before production cutover

2. **MySQL external**: Network latency if VPS ≠ DB location
   - Verify connection pooling (`mysql2` defaults to 10 connections)
   - Add connection retry logic

3. **Redis on VPS**: Single instance, no replication
   - Fine for job queue, but no HA if Redis crashes
   - Consider separate Redis instance for production

### Recommendations
- Load test: Simulate 10 concurrent users, measure response time
- ETL profiling: Identify slowest SQL queries, add indexes if needed
- Connection pool monitoring: Alert if connections exhaust

---

## Docker Image Size & Build Time

### Current Images (estimated)
- `backend:latest`: ~500MB (Node 20 Alpine + deps)
- `frontend:latest`: ~600MB (Node 20 Alpine + Next.js build)
- `etl-worker:latest`: ~1.8GB (Node 20 Debian + Python 3 + venv)
- **Total stack**: ~3GB

### Optimization Opportunities
1. **etl-worker**: Use Python slim image instead of bookworm, or split Node/Python responsibility
2. **All images**: Multi-stage builds to exclude dev deps
3. **Frontend**: Next.js standalone mode to reduce build footprint

---

## File Structure for Deployment

```
07ps-sales-dashboard-app/
├── docker-compose.yml           ← Updated with nginx, health checks, mysql ref
├── .env.example                 ← Template for VPS deployment
├── backend/
│   ├── Dockerfile               ✅ Good
│   ├── Dockerfile.etl-worker    ⚠️ Large, multi-runtime
│   ├── .env.example             ✅ Has DB_*, JWT_*, ETL_* vars
│   └── scripts/
│       └── validateEnv.ts       ← TODO: Create this
├── frontend/
│   ├── Dockerfile               ✅ Good
│   └── .env.example             ❌ Missing (or baked into backend?)
├── data/
│   ├── etl/                     ⚠️ Vendored venv bloats image
│   ├── warehouse/migrations/    ✅ MySQL migrations
│   └── ingestion/
│       └── .env.example         ✅ Odoo + Excel config
└── docs/
    ├── tech-stack-decision.md   ← Confirms MySQL 8, VPS target
    └── etl-deployment.md        ← TODO: Create detailed runbook
```

---

## Deployment Runbook Template (TODO)

Create `docs/deployment-runbook.md`:
```markdown
# Production Deployment Runbook

## Prerequisites
- VPS with Docker 20.10+, 4 CPU, 8GB RAM
- MySQL 8 instance reachable from VPS
- Nginx installed on VPS (or docker service)

## Pre-Flight
1. Clone repo: `git clone https://...`
2. Create backend/.env (copy from .env.example)
3. Create data/ingestion/.env (copy from .env.example)
4. Verify MySQL connectivity: `mysql -h <host> -u <user> -p -e "SELECT 1"`

## Deploy
1. `docker compose build`
2. `docker compose up -d`
3. Check health: `docker compose ps`
4. Tail logs: `docker compose logs -f`

## Verify
- [x] Frontend loads at http://localhost:3000
- [x] Backend API responds at http://localhost:4000/health
- [x] Redis connected: `redis-cli -h 127.0.0.1 ping`
- [x] ETL health check passes

## Rollback
- Downtime acceptable: `docker compose down` then deploy previous image tag
```

---

## Summary: Go/No-Go Decision

### Current Status: **YELLOW - Conditional Go**

**Can deploy if:**
1. ✅ Dev auth replaced with real login (even if basic JWT)
2. ✅ CI/CD switched to MySQL 8 testing
3. ✅ Environment validation added to startups
4. ✅ Nginx reverse proxy configured (TLS certificates)
5. ✅ Live Odoo credentials acquired & tested
6. ✅ MySQL 8 instance prepared on VPS with schema applied

**Cannot deploy until:**
1. ❌ No authentication layer
2. ❌ DB configuration mismatch (CI ≠ production)

**Post-deployment priorities (can do after go-live):**
- Monitoring & observing (Prometheus/Grafana)
- Log aggregation (ELK or CloudWatch)
- Secrets management (move from .env to vault)
- Load testing & performance tuning
- Backup & disaster recovery procedures

---

## Questions for the Team

1. **Authentication**: What auth provider/flow? (OAuth2, SAML, basic JWT admin dashboard?)
2. **Odoo Integration**: When will live credentials be available? How are they managed securely?
3. **Data Refresh**: What's the required frequency? (Real-time websocket? Daily batch? Hourly?)
4. **Monitoring**: Do you have existing observability infrastructure (Datadog, New Relic, in-house)?
5. **Scaling**: Is single VPS sufficient, or should we plan for multi-instance setup from day one?
6. **Database**: Is MySQL 8 instance already running on VPS, or needs provisioning?
7. **TLS**: Self-signed certs OK for now, or need proper CA (Let's Encrypt)?
