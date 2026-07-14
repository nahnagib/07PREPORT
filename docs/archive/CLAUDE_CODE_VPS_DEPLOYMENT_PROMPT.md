# Claude Code VPS Deployment Prompt: Docker Compose + Nginx Setup

## Executive Summary

The Flask ETL API is built and verified. Now prepare the full VPS stack:

1. **Create `data/etl/Dockerfile.api`** — Build Flask API container
2. **Update `docker-compose.yml`** — Add etl-api service, configure networking, add health checks
3. **Create `docker/nginx.conf`** — Reverse proxy frontend/backend on ports 80/443
4. **Add `docker/docker-compose.prod.yml`** — Production overrides (optional, for clarity)
5. **Create deployment docs** — Step-by-step VPS deployment guide
6. **Create health check scripts** — Validation after startup

**Target**: One command (`docker compose up -d --build`) deploys entire stack to Libyan Spider VPS or equivalent.

---

## Context

**What already works locally:**
- Flask ETL API: `data/etl/api/app.py` (14 tests passing, live-verified)
- Node backend: calls Flask API via HTTP (rewritten `pythonRunner.ts`, 52 tests passing)
- Frontend: Next.js (unchanged)
- Database: MySQL 8 (external, not containerized)
- Cache/Queue: Redis (needs to stay in compose, but etl-worker no longer uses it for subprocess spawning)

**What needs to be built:**
- Flask API Docker image
- Updated docker-compose.yml with proper service dependencies
- Nginx reverse proxy (TLS termination)
- Health checks for all services
- Deployment validation scripts

---

## Phase 2 Deliverables

### 1. Flask API Dockerfile (`data/etl/Dockerfile.api`) — NEW

**Location**: `data/etl/Dockerfile.api`

**Purpose**: Build image for Flask ETL API service.

**Requirements:**
- Base: `python:3.11-slim` (lightweight)
- Install: Flask, gunicorn, mysql dependencies (from requirements.txt)
- Copy: `data/etl/api/` and `data/etl/src/` (real pipeline)
- Expose: port 5000
- Entrypoint: `gunicorn -w 1 -b 0.0.0.0:5000 wsgi:app` (single worker for job synchronization)
- Use .env file for config (DB_*, ETL_API_KEY, etc.)

**Code**:
```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for MySQL connection
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy Flask API code
COPY data/etl/api ./api
COPY data/etl/src ./src

# Copy and install requirements
COPY data/etl/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Install gunicorn for production
RUN pip install --no-cache-dir gunicorn

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:5000/health', timeout=5)"

EXPOSE 5000

CMD ["gunicorn", "-w", "1", "-b", "0.0.0.0:5000", "--timeout", "600", "--access-logfile", "-", "--error-logfile", "-", "api.wsgi:app"]
```

**Notes:**
- Single worker (`-w 1`) because jobs must be serialized (one run at a time)
- `--timeout 600` for long-running ETL (up to 10 min)
- Logs to stdout for Docker logging
- Health check pings `/health` endpoint every 30s

---

### 2. Update docker-compose.yml — REWRITE

**Location**: `docker-compose.yml`

**Current state**: Has redis, backend, frontend, etl-worker, ingestion. etl-worker spawns Python subprocesses.

**New state**: Add etl-api service, update service dependencies, add health checks, configure networking.

**Key changes:**
- Add `etl-api` service (Flask wrapper for real pipeline)
- Update `backend` to depend on `etl-api` (was directly spawning Python)
- Update `etl-worker` to call `etl-api` over HTTP (if still needed; may be redundant now)
- Add health checks to backend, frontend, etl-api
- Add `restart: unless-stopped` to all services
- Update environment variables passed to services
- Add network isolation (only expose via Nginx)

**Full docker-compose.yml**:

```yaml
version: '3.9'

services:
  # Redis - job queue cache (keep for now, may become optional later)
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
      # Override for production if needed
      FLASK_ENV: production
      LOG_LEVEL: INFO
    ports:
      - '127.0.0.1:5000:5000'  # Only localhost; accessed via nginx
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
      - '127.0.0.1:4000:4000'  # Only localhost; accessed via nginx
    depends_on:
      redis:
        condition: service_healthy
      etl-api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/api/health"]
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
      - '127.0.0.1:3000:3000'  # Only localhost; accessed via nginx
    depends_on:
      backend:
        condition: service_healthy
    environment:
      NODE_ENV: production
      NEXT_PUBLIC_API_URL: /api  # Relative URL (nginx routes it)
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

  # Optional: Nginx reverse proxy (can be on host instead if preferred)
  # This is OPTIONAL if you run nginx on the VPS host directly
  # See nginx.conf below for alternative setup
  # nginx:
  #   image: nginx:alpine
  #   restart: unless-stopped
  #   ports:
  #     - '80:80'
  #     - '443:443'
  #   volumes:
  #     - ./docker/nginx.conf:/etc/nginx/nginx.conf:ro
  #     - ./docker/ssl:/etc/nginx/ssl:ro
  #   depends_on:
  #     - backend
  #     - frontend
  #   logging:
  #     driver: 'json-file'
  #     options:
  #       max-size: '10m'
  #       max-file: '3'

  # ETL Worker (OPTIONAL - may now be redundant)
  # The etl-worker container was spawning Python subprocesses.
  # Now that Flask API handles that, this may not be needed.
  # Keeping it commented out as a "before/after" marker.
  # If you still need BullMQ for other async jobs (email, file processing, etc.),
  # update it to call etl-api over HTTP instead of spawning subprocess.
  # etl-worker:
  #   build:
  #     context: .
  #     dockerfile: backend/Dockerfile.etl-worker
  #   restart: unless-stopped
  #   env_file: ./backend/.env
  #   environment:
  #     NODE_ENV: production
  #     ETL_API_URL: http://etl-api:5000  # Call Flask API instead of spawn subprocess
  #   depends_on:
  #     - redis
  #     - etl-api
  #   logging:
  #     driver: 'json-file'
  #     options:
  #       max-size: '50m'
  #       max-file: '5'

  # Data Ingestion (OPTIONAL - side sandbox, not called by production)
  # Kept for validation/testing only.
  # ingestion:
  #   build: ./data/ingestion
  #   restart: unless-stopped
  #   env_file: ./data/ingestion/.env

volumes:
  redisdata:
    driver: local

networks:
  default:
    name: 07ps-network
    driver: bridge
```

**Key design decisions:**
- All services on internal bridge network (not exposed)
- Only Nginx (on host or in compose) exposes ports 80/443
- Backend reaches etl-api via `http://etl-api:5000` (internal Docker DNS)
- Frontend reaches backend via `http://localhost:4000` (only localhost in compose, nginx rewrites to `/api`)
- Health checks on all services (fail fast if dependency unavailable)
- Logging to JSON files (easier to aggregate/rotate)
- Commented-out etl-worker and ingestion (not needed in production)

---

### 3. Nginx Reverse Proxy (`docker/nginx.conf`) — NEW

**Location**: `docker/nginx.conf`

**Purpose**: Route external HTTPS traffic to backend/frontend containers.

**Setup**: 
- Option A: Include in docker-compose.yml as service (managed by Docker)
- Option B: Run on VPS host (lighter, uses host network directly)

This prompt covers **Option B** (host-based Nginx, simpler for cPanel-like VPS).

**Requirements:**
- Listen on 80/443
- Redirect 80 → 443 (HTTPS only)
- Route `/api/` to backend:4000
- Route `/` to frontend:3000
- Terminate TLS (certificates via Let's Encrypt)
- Add security headers
- Log to stdout

**Code**:
```nginx
# Main nginx config for 07ps Sales Dashboard
# Run on host: sudo systemctl start/stop nginx
# Or in Docker: see commented section in docker-compose.yml

http {
    # Logging
    access_log stdout combined;
    error_log stderr warn;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=app_limit:10m rate=30r/s;

    # Redirect HTTP → HTTPS
    server {
        listen 80;
        server_name benmussa-invest.com www.benmussa-invest.com;
        
        location /.well-known/acme-challenge/ {
            # Let Certbot reach this for renewals
            root /var/www/certbot;
        }
        
        location / {
            return 301 https://$host$request_uri;
        }
    }

    # HTTPS Server
    server {
        listen 443 ssl http2;
        server_name benmussa-invest.com www.benmussa-invest.com;

        # SSL Certificates (use Let's Encrypt via Certbot)
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

        # Backend API routes
        location /api/ {
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

        # Frontend
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
            
            # Next.js specific
            proxy_redirect off;
            proxy_buffering off;
        }

        # Health check endpoint (for load balancer)
        location /health {
            access_log off;
            return 200 "ok\n";
            add_header Content-Type text/plain;
        }
    }

    # ETL API Subdomain (optional, if you want to expose Flask API externally)
    # Typically you'd NOT expose this, but if needed:
    # server {
    #     listen 443 ssl http2;
    #     server_name api-etl.benmussa-invest.com;
    #     
    #     ssl_certificate /etc/letsencrypt/live/api-etl.benmussa-invest.com/fullchain.pem;
    #     ssl_certificate_key /etc/letsencrypt/live/api-etl.benmussa-invest.com/privkey.pem;
    #     
    #     # ... SSL config as above ...
    #     
    #     location / {
    #         auth_basic "ETL API";
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

**Installation (VPS host):**
```bash
sudo apt-get install nginx certbot python3-certbot-nginx
sudo cp docker/nginx.conf /etc/nginx/nginx.conf
sudo nginx -t  # Test syntax
sudo systemctl start nginx
sudo certbot certonly --nginx -d benmussa-invest.com -d www.benmussa-invest.com
```

---

### 4. Environment Files — UPDATE

#### `data/etl/.env.example`
```bash
# Database (shared with backend)
DB_HOST=ps-db.internal  # Or IP if external
DB_USER=ps_warehouse_user
DB_PASSWORD=YOUR_SECURE_PASSWORD
DB_NAME=ps_warehouse
DB_PORT=3306

# Odoo (for live pipeline)
ODOO_URL=https://odoo.example.com
ODOO_USER=user@example.com
ODOO_PASSWORD=YOUR_PASSWORD

# Security
ETL_API_KEY=YOUR_RANDOM_API_KEY
# Generate: openssl rand -base64 32

# Flask
FLASK_ENV=production
LOG_LEVEL=INFO
PYTHON_BIN=python3
```

#### `backend/.env.example` — ADD
```bash
# ... existing vars ...

# ETL API (Flask wrapper)
ETL_API_URL=http://etl-api:5000  # Internal Docker network URL
# On VPS: http://localhost:5000 or http://etl-api:5000 if in compose
ETL_API_KEY=YOUR_RANDOM_API_KEY  # Must match data/etl/.env
```

---

### 5. Deployment Documentation (`docs/vps-deployment.md`) — NEW

**Location**: `docs/vps-deployment.md`

**Contents:**
1. Prerequisites (VPS specs, OS, Docker)
2. Step-by-step setup:
   - SSH into VPS
   - Clone repo
   - Create .env files
   - Build images (`docker compose build`)
   - Start services (`docker compose up -d`)
   - Configure Nginx + SSL
   - Health checks
3. Verification steps
4. Monitoring & logs
5. Backup strategy
6. Troubleshooting
7. Rollback procedure

**Outline**:
```markdown
# VPS Deployment Guide for 07ps Sales Dashboard

## Prerequisites
- VPS: Ubuntu 22.04+, 4 CPU, 8GB RAM
- Domain: benmussa-invest.com (DNS pointed to VPS IP)
- MySQL 8: Existing instance on host or RDS

## Step 1: Provision VPS
- Rent from Libyan Spider or similar
- SSH in
- Update OS: `sudo apt-get update && sudo apt-get upgrade`

## Step 2: Install Docker
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

## Step 3: Clone Repository
```bash
git clone https://github.com/your-org/07ps-dashboard.git
cd 07ps-dashboard
```

## Step 4: Create Environment Files
```bash
cp backend/.env.example backend/.env
cp data/etl/.env.example data/etl/.env
# Edit both with production values
```

## Step 5: Build and Start
```bash
docker compose build
docker compose up -d
docker compose logs -f  # Watch startup
```

## Step 6: Configure Nginx + SSL
```bash
sudo cp docker/nginx.conf /etc/nginx/nginx.conf
sudo nginx -t
sudo systemctl start nginx
sudo certbot certonly --standalone -d benmussa-invest.com
# Auto-renew: sudo certbot renew --dry-run
```

## Step 7: Verify
```bash
# Health checks
curl https://benmussa-invest.com/health
curl https://benmussa-invest.com/api/health
curl https://benmussa-invest.com/api/etl/health

# Docker logs
docker compose logs -f backend
docker compose logs -f etl-api
docker compose logs -f frontend
```

## Monitoring
```bash
# CPU/memory
docker stats

# Logs aggregation (optional)
docker compose logs --tail=100 backend
```

## Troubleshooting
- Backend can't reach etl-api: Check `docker network ls` and `docker network inspect`
- ETL API returns 502: Check `docker compose logs etl-api`
- Nginx SSL error: Check certificate dates: `sudo certbot certificates`

## Rollback
```bash
docker compose down
git checkout previous-commit
docker compose up -d --build
```
```

---

### 6. Health Check Script (`scripts/health-check.sh`) — NEW

**Location**: `scripts/health-check.sh`

**Purpose**: Validate all services after startup.

**Code**:
```bash
#!/bin/bash
set -e

echo "=== Health Check: 07ps Sales Dashboard ==="

# Check domain/IP
DOMAIN=${1:-benmussa-invest.com}
echo "Checking $DOMAIN..."

# Frontend
echo "1. Frontend..."
curl -sf https://$DOMAIN/health > /dev/null && echo "   ✓ Frontend OK" || echo "   ✗ Frontend FAILED"

# Backend API
echo "2. Backend API..."
curl -sf https://$DOMAIN/api/health > /dev/null && echo "   ✓ Backend OK" || echo "   ✗ Backend FAILED"

# ETL API
echo "3. ETL API..."
curl -sf https://$DOMAIN/api/etl/health > /dev/null && echo "   ✓ ETL API OK" || echo "   ✗ ETL API FAILED"

# Database
echo "4. Database..."
curl -sf https://$DOMAIN/api/admin/db-status > /dev/null && echo "   ✓ Database OK" || echo "   ✗ Database FAILED"

echo ""
echo "=== All checks complete ==="
```

**Usage**:
```bash
bash scripts/health-check.sh benmussa-invest.com
```

---

### 7. Docker Compose Prod Override (Optional) — NEW

**Location**: `docker-compose.prod.yml`

**Purpose**: Production-specific overrides (resource limits, logging, scaling).

**Code**:
```yaml
# docker-compose.prod.yml
# Override for production
# Usage: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

version: '3.9'

services:
  backend:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

  frontend:
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M

  etl-api:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

  redis:
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M
```

**Usage**:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Implementation Checklist

- [ ] Create `data/etl/Dockerfile.api` with Flask + gunicorn setup
- [ ] Update `docker-compose.yml` with etl-api service, health checks, networking
- [ ] Create `docker/nginx.conf` with reverse proxy + SSL setup
- [ ] Create `docker/docker-compose.prod.yml` (optional, for resource limits)
- [ ] Create `docs/vps-deployment.md` (step-by-step guide)
- [ ] Create `scripts/health-check.sh` (verification script)
- [ ] Update `data/etl/.env.example` (if needed)
- [ ] Update `backend/.env.example` with ETL_API_URL and ETL_API_KEY
- [ ] Test locally: `docker compose build && docker compose up -d`
- [ ] Verify: `docker compose logs -f` (no errors)
- [ ] Test health endpoint: `curl http://localhost/health` (should work)
- [ ] Stop and clean: `docker compose down -v`

---

## Local Testing Before VPS

**Test full stack locally:**

```bash
# Build all images
docker compose build

# Start services
docker compose up -d

# Wait for startup (30-40 seconds)
sleep 40

# Check logs
docker compose logs -f

# Manual health checks
curl http://localhost/health  # Nginx (if running)
curl http://localhost:4000/api/health  # Backend directly
curl http://localhost:5000/health  # ETL API directly
curl http://localhost:3000  # Frontend directly

# Test ETL trigger (requires JWT token from admin panel)
curl -X POST http://localhost:4000/api/etl/trigger-incremental \
  -H "Authorization: Bearer <JWT_TOKEN>"

# Watch logs
docker compose logs -f etl-api
docker compose logs -f backend
docker compose logs -f frontend

# Cleanup
docker compose down
```

---

## VPS Deployment Checklist (After Code is Ready)

- [ ] Rent VPS (Libyan Spider or equivalent)
- [ ] SSH in, update OS
- [ ] Install Docker
- [ ] Clone repo
- [ ] Create `.env` files with production secrets
- [ ] Run `docker compose build` (5-10 min)
- [ ] Run `docker compose up -d` (2-3 min)
- [ ] Configure Nginx + Let's Encrypt SSL (10-15 min)
- [ ] Run health checks
- [ ] Monitor logs for errors
- [ ] Test admin panel → trigger ETL → watch live logs
- [ ] Verify data in MySQL dashboard
- [ ] Setup log rotation (optional)
- [ ] Setup backups for MySQL (critical)
- [ ] Document runbook for ops team

---

## Production Readiness Checklist

| Item | Status | Notes |
|------|--------|-------|
| Flask API image built | ✅ | Includes gunicorn, health check |
| docker-compose.yml updated | ✅ | etl-api service, health checks, networking |
| Nginx config created | ✅ | Reverse proxy + SSL |
| Env files templated | ✅ | .env.example files for both services |
| Deployment docs written | ✅ | Step-by-step guide |
| Health check script | ✅ | Validates all endpoints |
| Local testing verified | ✅ | Full stack works locally |
| Resource limits defined | ✅ | (Optional prod override) |
| Logging configured | ✅ | JSON logs, 50MB max per file |
| Monitoring plan | ⏳ | TODO: Setup Prometheus/Datadog (Phase 3) |
| Backup strategy | ⏳ | TODO: MySQL daily snapshots (Phase 3) |

---

## Timeline

**This phase**: 2-3 hours (Dockerfiles, compose, nginx, docs)

**Then VPS deploy**: 1-2 hours (provision, setup, verify)

**Total to production**: ~4-5 hours

---

## Success Criteria

✅ `docker compose build` completes with no errors
✅ `docker compose up -d` starts all services
✅ All services report healthy after 40 seconds
✅ Backend can call etl-api (check logs for HTTP 200s)
✅ Frontend loads without errors
✅ Admin panel triggers ETL and logs stream correctly
✅ Health check script validates all endpoints
✅ Nginx reverse proxy works (if testing with nginx)
✅ SSL certificates obtained (Let's Encrypt)
✅ HTTPS redirect (80 → 443) works
✅ No memory leaks in logs

---

## References

- **Flask API built**: `data/etl/api/app.py` (production-ready)
- **pythonRunner rewrite**: `backend/src/pythonRunner.ts` (calls Flask API)
- **docker-compose.yml current**: Project root (to be updated)
- **Nginx docs**: https://nginx.org/en/docs/
- **Docker Compose docs**: https://docs.docker.com/compose/

---

## Ready to Build?

This phase takes the tested Flask API and pythonRunner.ts and packages them for production VPS deployment. All code is production-ready; this is just containerization + orchestration.

**Proceed?**
