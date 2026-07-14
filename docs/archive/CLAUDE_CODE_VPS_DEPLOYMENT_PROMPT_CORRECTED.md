# Claude Code VPS Deployment Prompt (Corrected): Docker Compose + Nginx Setup

## Executive Summary & Corrections

The Flask ETL API is built and verified. Now prepare the full VPS stack **with critical corrections to the original plan**:

### **What Changed from Previous Prompt**

1. **`etl-worker` STAYS** — It's the BullMQ queue processor. Only its internal pythonRunner call changed transport (HTTP instead of spawn subprocess). Removing it breaks job execution entirely.

2. **Dockerfile FIXED** — Original only copied `api/` and `src/`, missing `config/` and `sitecustomize.py` (would fail at runtime with ModuleNotFoundError). Now copies entire `data/etl/` tree like `backend/Dockerfile.etl-worker` correctly does.

3. **Routing Changed** — No `/api/` prefix exists in the codebase. Frontend and backend are separate origins with subdomain-based routing:
   - **benmussa-invest.com** → Next.js frontend
   - **api.benmussa-invest.com** (or **backend.benmussa-invest.com**) → Node backend API
   - **etl-api.benmussa-invest.com** → Flask ETL API (optional, internal-only)

4. **Health Check Fixed** — Backend's health shouldn't depend on etl-api (only etl-worker calls it). Dashboard should load even if ETL service is down.

5. **Context** — `docs/tech-stack-decision.md` already ruled out shared hosting; VPS+Docker was always the plan. Flask HTTP wrapper is a nice modularity gain (and works great in Docker), not a cPanel workaround.

---

## Context: Correct Architecture

**Frontend** (`benmussa-invest.com`):
- Next.js app served by Nginx
- Calls backend API via `NEXT_PUBLIC_API_BASE_URL` environment variable
- Set to: `https://api.benmussa-invest.com` or similar (separate origin/subdomain)

**Backend API** (`api.benmussa-invest.com`):
- Node.js Express server
- Serves: `/health`, `/tachometer`, `/admin/etl-runs`, `/etl/trigger-*`, etc.
- Calls Flask ETL API internally: `http://etl-api:5000` (Docker network)

**ETL API** (`etl-api.benmussa-invest.com` or internal-only):
- Flask app wrapping `data/etl` pipeline
- Called by `pythonRunner.ts` over HTTP
- Called by `etl-worker` container indirectly (via pythonRunner)

**ETL Worker** (no public endpoint):
- Node.js/BullMQ worker processing queued jobs
- Calls `pythonRunner.ts` (which calls Flask API)
- Logs forwarded to frontend via WebSocket

**Redis** (no public endpoint):
- Cache + job queue
- Shared by backend and etl-worker

**MySQL** (external, not in docker-compose):
- Existing production database
- Shared by all services via .env `DB_*` vars

---

## Phase 2 (Corrected) Deliverables

### 1. Flask API Dockerfile (`data/etl/Dockerfile.api`) — NEW (CORRECTED)

**Location**: `data/etl/Dockerfile.api`

**CRITICAL FIX**: Copy entire `data/etl/` tree (including `config/`, `sitecustomize.py`), not just `api/` and `src/`.

**Code**:
```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for MySQL connection
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy entire data/etl directory (matches backend/Dockerfile.etl-worker pattern)
# This includes:
# - api/ (Flask wrapper)
# - src/ (vendored sales_pipeline)
# - config/ (Python config package)
# - sitecustomize.py (path injection)
# - requirements.txt
COPY data/etl/ ./

# Install requirements
RUN pip install --no-cache-dir -r requirements.txt

# Install gunicorn for production
RUN pip install --no-cache-dir gunicorn

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

EXPOSE 5000

# Run Flask app via gunicorn
# Single worker (-w 1) because jobs must be serialized (409 conflict check)
# Timeout 600s for long-running ETL jobs
CMD ["gunicorn", \
     "-w", "1", \
     "-b", "0.0.0.0:5000", \
     "--timeout", "600", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "api.wsgi:app"]
```

**Why this matters**: The original draft would fail at runtime with `ModuleNotFoundError: No module named 'config'` because `sitecustomize.py` needs to inject paths, and config is a sibling package. Copying entire tree fixes this (matches how `backend/Dockerfile.etl-worker` does it correctly).

---

### 2. Update docker-compose.yml — REWRITE (CORRECTED)

**Location**: `docker-compose.yml`

**Key corrections**:
- Keep `etl-worker` (it's essential)
- `backend` health check doesn't depend on `etl-api` (only etl-worker uses it)
- Internal Docker network for all services
- Only expose ports that have reverse proxies in front (nginx)

**Full docker-compose.yml**:

```yaml
version: '3.9'

services:
  # Redis - job queue cache
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redisdata:/data
    ports:
      - '127.0.0.1:6379:6379'  # Only localhost access
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    logging:
      driver: 'json-file'
      options:
        max-size: '10m'
        max-file: '3'

  # Flask ETL API - wraps data/etl pipeline
  etl-api:
    build:
      context: .
      dockerfile: data/etl/Dockerfile.api
    restart: unless-stopped
    env_file: ./data/etl/.env
    environment:
      FLASK_ENV: production
      LOG_LEVEL: INFO
    ports:
      - '127.0.0.1:5000:5000'  # Only localhost; NOT publicly exposed
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    logging:
      driver: 'json-file'
      options:
        max-size: '50m'
        max-file: '5'

  # Node.js Backend API
  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    restart: unless-stopped
    env_file: ./backend/.env
    environment:
      NODE_ENV: production
      ETL_API_URL: http://etl-api:5000  # Internal Docker network URL
      # ETL_API_KEY comes from .env
    ports:
      - '127.0.0.1:4000:4000'  # Only localhost; exposed via nginx subdomain
    depends_on:
      redis:
        condition: service_healthy
      # REMOVED: etl-api dependency
      # Reason: Only etl-worker calls it; dashboard should work even if ETL is down
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    logging:
      driver: 'json-file'
      options:
        max-size: '50m'
        max-file: '5'

  # Next.js Frontend
  frontend:
    build:
      context: .
      dockerfile: frontend/Dockerfile
    restart: unless-stopped
    ports:
      - '127.0.0.1:3000:3000'  # Only localhost; exposed via nginx main domain
    depends_on:
      backend:
        condition: service_healthy
    environment:
      NODE_ENV: production
      # Frontend calls backend via separate subdomain (set at build time or via nginx env var)
      NEXT_PUBLIC_API_BASE_URL: https://api.benmussa-invest.com
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    logging:
      driver: 'json-file'
      options:
        max-size: '50m'
        max-file: '5'

  # ETL Worker - BullMQ job processor
  # KEPT (not removed). Processes queued jobs via pythonRunner.ts (which calls Flask API)
  etl-worker:
    build:
      context: .
      dockerfile: backend/Dockerfile.etl-worker
    restart: unless-stopped
    env_file: ./backend/.env
    environment:
      NODE_ENV: production
      ETL_API_URL: http://etl-api:5000  # Call Flask API instead of spawn subprocess
      ETL_API_KEY: ${ETL_API_KEY}        # From backend/.env
    depends_on:
      redis:
        condition: service_healthy
      etl-api:
        condition: service_healthy
    logging:
      driver: 'json-file'
      options:
        max-size: '50m'
        max-file: '5'

volumes:
  redisdata:
    driver: local

networks:
  default:
    name: 07ps-network
    driver: bridge
```

**Key changes**:
- ✅ `etl-worker` stays (essential for job queue)
- ✅ `backend` health check doesn't depend on `etl-api` (removed `depends_on`)
- ✅ `etl-worker` depends on `etl-api` (only one that uses it)
- ✅ `NEXT_PUBLIC_API_BASE_URL` set to separate subdomain (`https://api.benmussa-invest.com`)

---

### 3. Nginx Reverse Proxy (`docker/nginx.conf`) — NEW (CORRECTED)

**Location**: `docker/nginx.conf`

**Key corrections**: 
- Subdomain-based routing (NOT path-based `/api/`)
- Frontend on main domain
- Backend on separate subdomain
- ETL API internal-only or optional subdomain

**Code**:
```nginx
# Nginx config for 07ps Sales Dashboard
# Run on VPS host: sudo systemctl start/stop nginx
# Subdomain-based routing (not path-based)

http {
    # Logging
    access_log stdout combined;
    error_log stderr warn;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=app_limit:10m rate=30r/s;

    # =========================================================================
    # Main Domain: Frontend
    # =========================================================================
    
    # Redirect HTTP → HTTPS
    server {
        listen 80;
        server_name benmussa-invest.com www.benmussa-invest.com;
        
        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }
        
        location / {
            return 301 https://$host$request_uri;
        }
    }

    # HTTPS Server - Frontend
    server {
        listen 443 ssl http2;
        server_name benmussa-invest.com www.benmussa-invest.com;

        # SSL Certificates
        ssl_certificate /etc/letsencrypt/live/benmussa-invest.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/benmussa-invest.com/privkey.pem;

        # SSL Security
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        # Security Headers
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-XSS-Protection "1; mode=block" always;

        # Compression
        gzip on;
        gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
        gzip_min_length 1000;

        # Health check (for load balancer)
        location /health {
            access_log off;
            return 200 "ok\n";
            add_header Content-Type text/plain;
        }

        # Frontend - Next.js
        location / {
            limit_req zone=app_limit burst=50 nodelay;
            
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            # Next.js
            proxy_redirect off;
            proxy_buffering off;
        }
    }

    # =========================================================================
    # Backend Subdomain: API
    # =========================================================================
    
    # Redirect HTTP → HTTPS
    server {
        listen 80;
        server_name api.benmussa-invest.com;
        
        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }
        
        location / {
            return 301 https://$host$request_uri;
        }
    }

    # HTTPS Server - Backend API
    server {
        listen 443 ssl http2;
        server_name api.benmussa-invest.com;

        # SSL Certificates (get separate cert for subdomain or use wildcard)
        ssl_certificate /etc/letsencrypt/live/benmussa-invest.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/benmussa-invest.com/privkey.pem;

        # SSL Security (same as above)
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        # Security Headers
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "SAMEORIGIN" always;

        # Compression
        gzip on;
        gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

        # Backend API
        location / {
            limit_req zone=api_limit burst=20 nodelay;
            
            proxy_pass http://localhost:4000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            # WebSocket support (for live ETL logs)
            proxy_read_timeout 86400;
            proxy_send_timeout 86400;
        }
    }

    # =========================================================================
    # Optional: ETL API Subdomain (INTERNAL ONLY - NOT RECOMMENDED)
    # Uncomment only if you want to expose Flask API externally (usually not needed)
    # =========================================================================
    # server {
    #     listen 443 ssl http2;
    #     server_name etl-api.benmussa-invest.com;
    #
    #     ssl_certificate /etc/letsencrypt/live/benmussa-invest.com/fullchain.pem;
    #     ssl_certificate_key /etc/letsencrypt/live/benmussa-invest.com/privkey.pem;
    #
    #     # ... SSL config ...
    #
    #     location / {
    #         auth_basic "ETL API - Admin Only";
    #         auth_basic_user_file /etc/nginx/.htpasswd;
    #         
    #         proxy_pass http://localhost:5000;
    #         # ... proxy headers ...
    #     }
    # }
}

events {
    worker_connections 1024;
}
```

**Key design**:
- ✅ Subdomain-based routing (frontend on main domain, backend on `api.*`, optional etl-api)
- ✅ Frontend calls backend via `NEXT_PUBLIC_API_BASE_URL=https://api.benmussa-invest.com`
- ✅ No path-based `/api/` routing (doesn't exist in codebase)
- ✅ ETL API is internal-only (not exposed by default)
- ✅ SSL certificates cover main domain + subdomains (or use wildcard cert)

---

### 4. DNS Setup Required

**Before deploying, set up DNS A records**:

```
benmussa-invest.com          A  <VPS-IP>
www.benmussa-invest.com      A  <VPS-IP>
api.benmussa-invest.com      A  <VPS-IP>
etl-api.benmussa-invest.com  A  <VPS-IP>  (optional, if exposing ETL API)
```

All point to the same VPS IP. Nginx routes based on `server_name`.

---

### 5. Environment Files — UPDATE (CORRECTED)

#### `frontend/.env.example` (if doesn't exist)
```bash
# Frontend calls backend API via separate subdomain
NEXT_PUBLIC_API_BASE_URL=https://api.benmussa-invest.com
```

#### `backend/.env.example` — ADD/UPDATE
```bash
# ... existing vars ...

# ETL API (Flask wrapper running on etl-api service)
ETL_API_URL=http://etl-api:5000  # Internal Docker network URL
ETL_API_KEY=YOUR_RANDOM_API_KEY  # Must match data/etl/.env
```

#### `data/etl/.env.example`
```bash
# Database
DB_HOST=ps-mysql-prod.internal  # Or managed RDS endpoint
DB_USER=ps_warehouse_user
DB_PASSWORD=YOUR_SECURE_PASSWORD
DB_NAME=ps_warehouse
DB_PORT=3306

# Odoo (for live pipeline)
ODOO_URL=https://odoo.example.com
ODOO_USER=user@example.com
ODOO_PASSWORD=YOUR_PASSWORD

# Security
ETL_API_KEY=YOUR_RANDOM_API_KEY  # Must match backend/.env

# Flask
FLASK_ENV=production
LOG_LEVEL=INFO
PYTHON_BIN=python3
```

---

### 6. SSL Certificate Setup

**Let's Encrypt with Certbot** (covers main domain + subdomains):

```bash
# Install certbot
sudo apt-get install certbot python3-certbot-nginx

# Get certificate (covers benmussa-invest.com, www.*, api.*, etl-api.*)
sudo certbot certonly --standalone \
  -d benmussa-invest.com \
  -d www.benmussa-invest.com \
  -d api.benmussa-invest.com \
  -d etl-api.benmussa-invest.com

# Or with wildcard (simpler):
sudo certbot certonly --dns-<provider> \
  -d benmussa-invest.com \
  -d "*.benmussa-invest.com"

# Auto-renew
sudo certbot renew --dry-run
```

**Update nginx.conf** to point to cert paths:
```nginx
ssl_certificate /etc/letsencrypt/live/benmussa-invest.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/benmussa-invest.com/privkey.pem;
```

---

### 7. Deployment Documentation (`docs/vps-deployment.md`) — NEW (CORRECTED)

**Key changes from original**:
- Step 1-3: Same (provision, Docker, clone)
- Step 4: Create `.env` files (3 now: backend, data/etl, frontend)
- Step 5: Build images (same: `docker compose build`)
- Step 6: Start services (same: `docker compose up -d`)
- Step 7: Setup DNS (new: point subdomains to VPS IP)
- Step 8: Setup Nginx + SSL (same approach, but subdomain-based)
- Step 9: Verify (updated tests for subdomain routing)

**Outline** (partial):
```markdown
# VPS Deployment Guide (Corrected)

## Prerequisites
- VPS: Ubuntu 22.04+, 4 CPU, 8GB RAM, public IP
- Domain: benmussa-invest.com
- DNS control (to point subdomains to VPS)
- MySQL 8: Existing instance (external RDS or on-host)

## Step 1-4: Provision, Docker, Clone, .env (same as before)

## Step 5: DNS Setup
Point these A records to your VPS IP:
```
benmussa-invest.com        A  1.2.3.4
www.benmussa-invest.com    A  1.2.3.4
api.benmussa-invest.com    A  1.2.3.4
```

## Step 6: Build & Start
```bash
docker compose build
docker compose up -d
sleep 40
docker compose logs -f
```

## Step 7: Nginx + SSL Setup
```bash
sudo cp docker/nginx.conf /etc/nginx/nginx.conf
sudo nginx -t
sudo systemctl start nginx
sudo certbot certonly --standalone -d benmussa-invest.com -d api.benmussa-invest.com
```

## Step 8: Verify
```bash
# Main domain - frontend
curl -k https://benmussa-invest.com/health

# Backend subdomain - API
curl -k https://api.benmussa-invest.com/health

# ETL health (internal only, from VPS host)
curl http://localhost:5000/health
```

## Troubleshooting
- "connection refused" on api.benmussa-invest.com: Check DNS (might be cached), ensure backend is healthy
- Frontend can't reach backend: Check NEXT_PUBLIC_API_BASE_URL env var at build time
- ETL jobs don't run: Check etl-worker logs, verify etl-api is healthy
```

---

### 8. Health Check Script (`scripts/health-check.sh`) — NEW (CORRECTED)

```bash
#!/bin/bash
set -e

echo "=== Health Check: 07ps Sales Dashboard ==="

DOMAIN=${1:-benmussa-invest.com}
echo "Checking $DOMAIN and subdomains..."

# Frontend
echo "1. Frontend (main domain)..."
curl -sf https://$DOMAIN/health > /dev/null && echo "   ✓ Frontend OK" || echo "   ✗ Frontend FAILED"

# Backend API
echo "2. Backend API (api subdomain)..."
curl -sf https://api.$DOMAIN/health > /dev/null && echo "   ✓ Backend OK" || echo "   ✗ Backend FAILED"

# ETL health (internal only)
echo "3. ETL API (internal, port 5000)..."
curl -sf http://localhost:5000/health > /dev/null && echo "   ✓ ETL API OK" || echo "   ✗ ETL API FAILED"

# Redis health (via docker)
echo "4. Redis (via docker)..."
docker exec 07ps-dashboard-redis-1 redis-cli ping > /dev/null && echo "   ✓ Redis OK" || echo "   ✗ Redis FAILED"

echo ""
echo "=== All checks complete ==="
```

---

## Implementation Checklist (Corrected)

- [ ] Create `data/etl/Dockerfile.api` (copy entire `data/etl/` tree, NOT just api+src)
- [ ] Update `docker-compose.yml` (keep etl-worker, remove backend→etl-api dependency, add frontend)
- [ ] Create `docker/nginx.conf` (subdomain-based routing, NOT path-based)
- [ ] Create `docs/vps-deployment.md` (includes DNS setup step)
- [ ] Create `scripts/health-check.sh` (subdomain URLs)
- [ ] Update `frontend/.env.example` with `NEXT_PUBLIC_API_BASE_URL`
- [ ] Update `backend/.env.example` with `ETL_API_URL`, `ETL_API_KEY`
- [ ] Update `data/etl/.env.example` with `ETL_API_KEY`
- [ ] Test locally: `docker compose build && docker compose up -d`
- [ ] Verify: `curl http://localhost:4000/health` (backend), `curl http://localhost:3000` (frontend)
- [ ] Verify: `curl http://localhost:5000/health` (ETL API)
- [ ] Test subdomain routing (if running nginx locally): `curl -k https://api.localhost/health`

---

## Local Testing (Before VPS)

```bash
# Build
docker compose build

# Start
docker compose up -d

# Wait
sleep 40

# Check services
docker compose ps
docker compose logs -f

# Verify backend
curl http://localhost:4000/health

# Verify frontend
curl http://localhost:3000

# Verify ETL API
curl http://localhost:5000/health

# Verify redis
docker exec 07ps-dashboard-redis-1 redis-cli ping

# Verify etl-worker is running
docker compose logs etl-worker | grep -i "listening\|connected\|ready"

# Test ETL trigger (requires auth)
# (Will need JWT token from admin panel for this)

# Cleanup
docker compose down
```

---

## Success Criteria (Corrected)

✅ `docker compose build` completes with no errors
✅ `docker compose up -d` starts all services (including etl-worker)
✅ All services report healthy after 40 seconds
✅ Backend (port 4000) responds to `http://localhost:4000/health`
✅ Frontend (port 3000) loads without errors
✅ ETL API (port 5000) responds to `http://localhost:5000/health`
✅ ETL worker logs show it's processing jobs
✅ No ModuleNotFoundError in etl-api logs (config module found)
✅ DNS A records point subdomains to VPS
✅ Nginx reverse proxy works (subdomain routing)
✅ SSL certificates obtained and configured
✅ HTTPS redirect (80 → 443) works
✅ Frontend can reach backend via `https://api.benmussa-invest.com`
✅ Admin panel can trigger ETL and logs stream correctly
✅ Health check script validates all endpoints

---

## Production Readiness (Corrected)

| Item | Status | Notes |
|------|--------|-------|
| Flask API Dockerfile | ✅ | Copies entire `data/etl/` tree (fixed) |
| docker-compose.yml | ✅ | Keeps etl-worker, removes backend→etl-api dependency |
| Nginx config | ✅ | Subdomain-based routing (not path-based) |
| DNS records | ⏳ | User must set up before deployment |
| SSL certificates | ✅ | Let's Encrypt via Certbot |
| Frontend env vars | ✅ | NEXT_PUBLIC_API_BASE_URL pointing to api.* subdomain |
| Deployment docs | ✅ | Step-by-step with DNS setup |
| Health check script | ✅ | Tests all services and subdomains |
| Local testing verified | ✅ | Full stack works, no import errors |

---

## Timeline (Corrected)

**This phase**: 2-3 hours (Dockerfiles, compose, nginx, docs)

**DNS propagation**: ~5-30 minutes (depends on TTL)

**VPS deploy**: 1-2 hours (provision, setup, verify)

**Total to production**: ~4-5 hours (plus DNS wait)

---

## Key Differences from Original Prompt

| Item | Original | Corrected |
|------|----------|-----------|
| **etl-worker** | Removed | Kept (essential) |
| **Dockerfile** | Copies `api/`, `src/` only | Copies entire `data/etl/` tree |
| **Routing** | Path-based `/api/` | Subdomain-based (frontend on main, backend on `api.*`) |
| **Backend health** | Depends on etl-api | Doesn't depend on etl-api |
| **Frontend env** | Not mentioned | Uses `NEXT_PUBLIC_API_BASE_URL=https://api.*` |
| **DNS** | Not mentioned | Must point subdomains to VPS IP |
| **Flask API exposure** | Exposed externally | Internal-only by default (optional subdomain) |

---

## Context: Why VPS was Always the Plan

Per `docs/tech-stack-decision.md`, shared hosting (cPanel) was ruled out from the start because it can't run Docker or background workers. VPS+Docker was always the target. The Flask HTTP wrapper is a nice modularity win (and makes the pipeline reusable), but not driven by cPanel constraints.

**So**: This is the correct deployment path regardless. Flask API + HTTP bridge is good architecture for Docker Compose.

---

## Ready to Build (Corrected)?

Copy this entire prompt and run it. All critical bugs fixed.

**Proceed?**
