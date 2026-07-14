# Deployment Strategy: cPanel Shared Hosting vs. VPS

## Problem Statement
The current Docker Compose setup assumes a **dedicated VPS or dedicated server** environment where Python and Node.js run in the same container orchestration layer. 

**Shared hosting (cPanel) cannot support this** because:
- Each language (Python/Node.js) runs in **completely isolated virtual environments**
- No tool exists to bridge them (no Docker, no container orchestration)
- Security restrictions prevent running multiple runtimes on the same port/process

---

## Option 1: Shared Hosting (cPanel) + API Separation ⭐ Recommended

**Feasibility: HIGH | Cost: Low | Complexity: Medium**

### Architecture
```
benmussa-invest.com (Node.js Frontend)
├── Frontend: Next.js deployed via "Setup Node.js App" in cPanel
├── Static assets, dashboard UI
└── Calls API endpoints

api.benmussa-invest.com (Python API Backend)
├── FastAPI or Flask backend
├── Database connections (MySQL 8)
└── ETL/data processing

MySQL 8 (External Database)
└── Shared hosting MySQL database OR external managed service
```

### Implementation Steps

#### 1. Frontend Deployment (benmussa-invest.com)
**On cPanel:**
```
1. SSH into hosting account
2. Create Node.js app via cPanel > Setup Node.js App
   - App Mode: Development
   - Node version: 20.x
   - App root: /home/benmussa/public_html
   - Application startup file: npm start
3. Upload frontend code:
   - Copy frontend/ files → public_html/
   - Copy packages/ui/ → public_html/packages/ui/
   - Copy frontend/package.json and package-lock.json
4. In cPanel terminal:
   npm install --omit=dev
   npm run build
5. Point domain to public_html/
```

**Environment (.env for frontend):**
```
NEXT_PUBLIC_API_URL=https://api.benmussa-invest.com
NEXT_PUBLIC_APP_ENV=production
```

#### 2. Backend API Deployment (api.benmussa-invest.com)
**Create subdomain in cPanel, deploy separately:**

**Choice A: Python FastAPI** (Simpler than Node backend)
```
1. Create addon domain: api.benmussa-invest.com
2. SSH and create Python app via cPanel > Setup Python App
   - Python version: 3.11+
   - App root: /home/benmussa/public_html/api/
   - Application startup file: main.py
3. Refactor backend/src/measures → Python FastAPI endpoints
4. Deploy to api.benmussa-invest.com
```

**Choice B: Keep Node backend** (If refactoring is too much)
```
1. Create addon domain: api.benmussa-invest.com
2. Setup Node.js App for the subdomain
3. Deploy backend/ code there
4. Ensure it points to same MySQL database
```

**Pros of separation:**
- ✅ Each runs in its own cPanel-managed environment
- ✅ Scales independently (more Node resources if needed, more Python if ETL is slow)
- ✅ Simpler to debug (logs visible per app in cPanel)
- ✅ Frontend can be updated without restarting API

**Cons:**
- ❌ Network latency between frontend → API (but minimal on same shared host)
- ❌ Two separate deployments to manage
- ❌ CORS headers must be configured correctly
- ❌ ETL/scheduler still needs solution

---

## Option 2: VPS/Dedicated Server ✅ Recommended for Production

**Feasibility: HIGHEST | Cost: Medium ($20-50/month) | Complexity: Medium**

### Why VPS is Better for This Project
1. **Docker Compose works as-is** (no code changes needed)
2. **Python + Node.js in same orchestration** (current architecture preserved)
3. **ETL scheduler can run continuously** (not interrupt by cPanel limits)
4. **Better security** (only your services exposed, not shared with other users)
5. **Unlimited scalability** (add more services later without limitations)
6. **Better performance** (dedicated resources, no noisy neighbors)

### Recommended VPS Providers
| Provider | Price | Features | Good For |
|----------|-------|----------|----------|
| **Linode** | $5-30/mo | 2-8 CPU, managed backups, API, monitoring | ⭐ Best all-around |
| **DigitalOcean** | $4-24/mo | Droplets, App Platform, simple UI | Easy to use |
| **Vultr** | $2.50-12/mo | Lightweight, bare metal options | Budget-friendly |
| **Hetzner** | $3-10/mo | Powerful, Europe-based, great specs | High performance |
| **Libyan Spider** (current target) | TBD | Local provider, Libyan Spider mentioned in README | ✅ Already planned |

### VPS Deployment (What You Planned Originally)
```bash
# SSH into VPS
ssh root@your-vps-ip

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Clone repo
git clone https://github.com/your-repo/07ps-sales-dashboard.git
cd 07ps-sales-dashboard

# Create .env files
cp backend/.env.example backend/.env
cp data/ingestion/.env.example data/ingestion/.env
# Edit .env with real values

# Deploy
docker compose up -d --build

# Verify
docker compose ps
```

**Pros:**
- ✅ Docker Compose works exactly as designed
- ✅ All services (backend, frontend, redis, etl-worker, ingestion) run together
- ✅ Single point of deployment & monitoring
- ✅ Production-grade infrastructure

**Cons:**
- ❌ Slightly higher cost than shared hosting
- ❌ Requires basic Linux/Docker knowledge to maintain

---

## Option 3: Hybrid - cPanel Frontend + External Backend

**Feasibility: MEDIUM | Cost: Medium | Complexity: Medium**

Deploy frontend on cPanel, backend on separate cloud provider:
```
Frontend: benmussa-invest.com (Node.js on cPanel)
Backend: Deployed on AWS Lambda, Google Cloud Run, or Render.com
```

**Use case:** If you already have cPanel hosting and want to minimize changes.

**Pros:** ✅ Uses existing shared hosting
**Cons:** ❌ External backend costs more, ❌ More complex setup

---

## Decision Matrix

| Factor | cPanel | VPS | Hybrid |
|--------|--------|-----|--------|
| **Setup complexity** | Easy | Medium | Medium |
| **Monthly cost** | $5-10 | $5-30 | $15-50 |
| **Deployment time** | 2-4 hours | 1-2 hours | 3-6 hours |
| **Docker support** | ❌ No | ✅ Yes | ❌ No |
| **Python + Node together** | ❌ No | ✅ Yes | Partial |
| **ETL scheduler** | ❌ Hard | ✅ Easy | ❌ Hard |
| **Scaling** | Limited | Unlimited | Moderate |
| **Production-ready** | ⚠️ Marginal | ✅ Yes | Partial |

---

## Recommended Path Forward

### **BEST: Migrate to VPS** (Libyan Spider or similar)

**Why:**
1. Your architecture (Docker Compose) is designed for VPS
2. Python + Node.js work seamlessly together
3. ETL pipeline can run continuously
4. Minimal code changes needed
5. Production-grade setup from day one

**Action plan:**
1. Provision Libyan Spider VPS (or similar) with 4 CPU, 8GB RAM
2. Install Docker & Docker Compose
3. Set up MySQL 8 on VPS or connect to existing MySQL
4. Deploy using existing `docker-compose.yml` (after fixes from analysis)
5. Configure Nginx reverse proxy for TLS
6. Done in ~4 hours

---

## If You MUST Use cPanel Shared Hosting

### Architecture Changes Required

**Option A: Separate Frontend + Backend (Recommended for cPanel)**

Frontend (Node.js):
```yaml
# benmussa-invest.com
- Use cPanel's Node.js app setup
- Deploy frontend/ + packages/ui/
- Next.js SSR rendering
- Calls api.benmussa-invest.com for data
```

Backend (Python FastAPI):
```yaml
# api.benmussa-invest.com (subdomain)
- Refactor backend/src/measures → Python FastAPI
- Move from Express.js to FastAPI (1-2 day refactor)
- Deploy via cPanel Python app setup
- Connects to shared MySQL 8
```

Backend (Alternative: Keep Node):
```yaml
# If you don't want to refactor to Python
- Deploy Node backend on api.benmussa-invest.com subdomain
- Use cPanel Node.js setup for subdomain
- Same MySQL 8 database
```

**ETL Pipeline (cPanel Challenge):**
```
Option 1: Move to external service
  - Use AWS Lambda, Google Cloud Functions, or Render to run ETL
  - Trigger via cron job from main app
  - Data flows into same MySQL database

Option 2: Manual/On-demand ETL
  - Admin dashboard endpoint to trigger ETL
  - User clicks button to refresh data
  - No background scheduling

Option 3: Use third-party scheduler
  - Cronitor, EasyCron, or similar to HTTP-ping your ETL endpoint
```

### Code Changes for cPanel

#### 1. Split Backend into Microservices

**Current (Docker Compose):**
```
backend/ → Express + Python ETL + BullMQ
```

**For cPanel:**
```
api.benmussa-invest.com:
  ├── backend/src/measures/ → FastAPI endpoints
  ├── backend/src/middleware/ → FastAPI middleware
  └── database connection to MySQL

etl.benmussa-invest.com (optional third-party scheduler):
  ├── Cronitor → pings /api/etl/refresh-tachometer
  └── Backend API executes ETL in-process or async
```

#### 2. Update Environment Variables

**Frontend (.env):**
```
NEXT_PUBLIC_API_URL=https://api.benmussa-invest.com
```

**Backend (.env on api subdomain):**
```
DB_HOST=mysql-server.benmussa-invest.com
DB_USER=benmussa_user
DB_PASSWORD=***
DB_NAME=ps_warehouse
CORS_ORIGIN=https://benmussa-invest.com
```

#### 3. Enable CORS

**FastAPI (if refactoring to Python):**
```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://benmussa-invest.com"],
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Express (if keeping Node):**
```typescript
import cors from 'cors';

app.use(cors({
  origin: 'https://benmussa-invest.com',
  credentials: true,
}));
```

---

## Comparison: cPanel API Separation vs. VPS

| Need | cPanel Path | VPS Path |
|------|-----------|----------|
| Refactoring | Medium (split services) | None (use as-is) |
| Time to deploy | 4-6 hours | 1-2 hours |
| Cost | $5-10/mo | $10-30/mo |
| Production-ready | ⚠️ Yes, with limitations | ✅ Yes, fully |
| Scaling | Difficult | Easy (add services) |
| Support from hosting | ❌ Limited | ✅ Full |
| Security | Shared (risky) | Dedicated (safe) |
| Maintenance burden | Medium-high | Low |
| **Recommendation** | Only if cost is critical | **RECOMMENDED** |

---

## Recommendation Summary

### 🎯 Go with **VPS** (Libyan Spider or similar)

**Because:**
1. ✅ Your entire codebase is designed for it (Docker Compose)
2. ✅ No refactoring needed (save 2-3 days of dev work)
3. ✅ Cost is minimal (~$15-30/month) vs. refactoring time (~40 hours dev + 20 hours testing)
4. ✅ Better security, performance, and reliability
5. ✅ Can scale easily as dashboard grows
6. ✅ ETL scheduler works out of the box

### ⚠️ Only use cPanel **IF:**
- You already have it and need to minimize new costs
- You're willing to refactor backend to Python FastAPI
- You accept ETL limitations (manual triggering or external scheduler)
- This is a temporary/MVP deployment only

---

## Next Steps

1. **Decide: cPanel or VPS?**
   - If VPS → Use original DEPLOYMENT_ANALYSIS.md
   - If cPanel → Continue with steps below

2. **If VPS:**
   - Provision Libyan Spider account
   - Follow docker-compose.yml deployment (after fixes)
   - Timeline: 1-2 weeks to production

3. **If cPanel:**
   - Refactor backend/src/measures to FastAPI OR split Node.js backend to subdomain
   - Set up CORS headers
   - Deploy frontend → benmussa-invest.com
   - Deploy backend → api.benmussa-invest.com
   - Configure ETL trigger (manual or external scheduler)
   - Timeline: 2-3 weeks to production (due to refactoring)

---

## Questions for IT Support / Hosting Provider

1. **cPanel vs. VPS?** Which approach does the team prefer?
2. **MySQL database**: Is it available on the shared host, or do we need to provision a separate MySQL server?
3. **Subdomain support**: Can cPanel create addon domains (subdomains) for separate apps?
4. **Node.js version**: Does cPanel support Node 20.x?
5. **Python version**: Does cPanel support Python 3.11+?
6. **VPS alternative**: Would it be possible to provision a simple VPS instead of cPanel?

---

## File: Quick Reference - cPanel Deployment Checklist

If choosing cPanel path, use this checklist:

```markdown
# cPanel Deployment Checklist

## Prerequisites
- [ ] cPanel shared hosting account with Node.js and Python support
- [ ] MySQL 8 database access
- [ ] Subdomain (api.benmussa-invest.com) created in cPanel

## Frontend (benmussa-invest.com)
- [ ] cPanel > Setup Node.js App → Node 20.x
- [ ] Upload frontend/ + packages/ui/ files
- [ ] Create .env with NEXT_PUBLIC_API_URL=https://api.benmussa-invest.com
- [ ] npm install --omit=dev && npm run build
- [ ] Test http://benmussa-invest.com

## Backend (api.benmussa-invest.com)
- [ ] Create addon domain in cPanel
- [ ] cPanel > Setup Node.js App OR Python App
- [ ] Upload backend/ files
- [ ] Create .env with DB_* and CORS_ORIGIN settings
- [ ] npm install --omit=dev && npm run build (Node)
- [ ] Test http://api.benmussa-invest.com/health

## Database
- [ ] MySQL 8 provisioned and accessible
- [ ] Run data/warehouse/apply_migrations.py against MySQL
- [ ] Load initial data (real export or mock)

## ETL
- [ ] Set up cronitor.com or similar for scheduled ETL
- [ ] Create endpoint /api/etl/refresh-tachometer
- [ ] Test manual ETL trigger

## Frontend-Backend Integration
- [ ] Test CORS: Frontend can call API endpoints
- [ ] Verify authentication flow works
- [ ] Test dashboard loads Tachometer data

## Go-Live
- [ ] Point benmussa-invest.com domain
- [ ] Point api.benmussa-invest.com subdomain
- [ ] Enable HTTPS/TLS (cPanel AutoSSL)
- [ ] Monitor logs for errors
```
