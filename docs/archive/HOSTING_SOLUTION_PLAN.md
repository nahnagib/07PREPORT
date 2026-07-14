# Hosting Solution Plan: benmussa-invest.com

## Current Constraint
Shared cPanel hosting **cannot run Python + Node.js together** in one environment. Each runs in isolated virtual environments with no communication bridge.

---

## Option 1: Split Architecture via API (Recommended) ✅

**What:** Deploy Node.js (frontend + API) on main domain, Python ETL on subdomain.

**How it works:**
```
benmussa-invest.com/              ← Next.js frontend + Express API (Node.js)
├── Frontend: http://localhost:3000
├── Backend API: http://localhost:4000
└── Database: MySQL (external or managed)

api-etl.benmussa-invest.com/      ← Python ETL worker + data ingestion
├── Flask/FastAPI health endpoint
├── Data import endpoints
└── Same MySQL database
```

### Pros
- ✅ Uses your existing domain + subdomain (no extra cost)
- ✅ Leverages shared hosting's built-in Node.js and Python environments separately
- ✅ Your app architecture **already supports this** (backend is already API-first)
- ✅ Frontend doesn't need Python; ETL doesn't need Node.js
- ✅ Cheapest option (no new VPS/server cost)
- ✅ Both can access shared MySQL database

### Cons
- ⚠️ ETL must run as scheduled jobs (not continuous background service)
- ⚠️ Requires coordinating deployments across two cPanel apps
- ⚠️ Subdomain must be separately configured in cPanel

### Setup Steps
1. **On cPanel - Node.js App (Main Domain):**
   - Create Node.js app for `benmussa-invest.com`
   - Deploy `frontend/` + `backend/` code
   - Set `NODE_ENV=production`
   - Env vars: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `JWT_SECRET`
   - Create startup script: `npm run build && npm start` (runs both via npm workspaces)

2. **On cPanel - Python App (Subdomain):**
   - Create subdomain: `api-etl.benmussa-invest.com`
   - Create Python app on that subdomain
   - Deploy `data/ingestion/` code
   - Install requirements: `pip install -r requirements.txt`
   - Env vars: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `ODOO_URL`, `ODOO_USER`
   - Expose health endpoint at `/health` or `/ping`

3. **Configure Communication:**
   - Node.js backend can call Python ETL via HTTP:
     ```typescript
     // backend/src/etl/trigger.ts
     const response = await fetch('https://api-etl.benmussa-invest.com/run-full', {
       method: 'POST',
       headers: { 'Authorization': `Bearer ${ETL_API_KEY}` }
     });
     ```
   - Both share same MySQL database (connection string in .env)

4. **Schedule ETL:**
   - Use cPanel's "Cron Jobs" to trigger Python ETL daily:
     ```bash
     curl -X POST https://api-etl.benmussa-invest.com/run-incremental \
       -H "Authorization: Bearer YOUR_SECRET_KEY"
     ```
   - Or: Use Node.js backend's `node-cron` to trigger via HTTP

### Estimated Timeline
- **Setup:** 2-3 hours (configure both cPanel apps, deploy code)
- **Testing:** 4-6 hours (verify API communication, test ETL)
- **Go-live:** 1 hour

---

## Option 2: Rent a VPS (More Control) 🔹

**What:** Move from shared hosting to a $10-30/month VPS with full Docker support.

**Providers (Middle East friendly):**
- **DigitalOcean** ($5-6/month for small droplet) — available in Bahrain
- **Linode** ($5-10/month) — Middle East data centers
- **Libyan Spider** (mentioned in your README) — local ISP, lowest latency
- **AWS / Azure** — overkill for this size, but option

**How:**
- Deploy entire stack via `docker compose up -d` (as planned in your README)
- No cPanel limits; full control over Python + Node.js
- Set up Nginx reverse proxy for TLS/HTTPS
- Everything runs on same server, same network

### Pros
- ✅ No architecture changes needed (deploy as-is)
- ✅ Full Docker support; use existing docker-compose.yml
- ✅ Better performance (no shared resource contention)
- ✅ Can use Redis, multiple containers, load balancing
- ✅ Easier to scale later

### Cons
- ⚠️ Extra monthly cost ($10-30/month = $120-360/year)
- ⚠️ You manage server updates, security patches
- ⚠️ Need to learn VPS administration (or hire sysadmin)
- ⚠️ Must implement backups yourself

### Estimated Cost
```
VPS:           $10-20/month
MySQL hosting: $5-10/month (separate managed DB, or on VPS)
Domain:        ~$12/year (already have benmussa-invest.com)
─────────────────────────────
Total:         $15-30/month = $180-360/year
```

### Setup Timeline
- **Provision VPS:** 30 minutes
- **Deploy via Docker:** 1 hour
- **Configure DNS + TLS:** 1-2 hours
- **Testing:** 2-4 hours

---

## Option 3: Keep Shared Hosting + Run ETL Offline (Not Recommended) 🔴

**What:** Deploy only Node.js frontend/backend on shared hosting. ETL runs manually or on separate machine.

### Why Not
- ❌ No automated data refresh (manual Excel imports only)
- ❌ Outdated dashboards (data stale without regular ETL)
- ❌ Violates your architecture (Tachometer KPIs depend on fresh data)
- ❌ Production not feasible

---

## Recommendation: **Option 1 (Split via API)**

### Why This Makes Sense For You

1. **Zero extra cost**: Uses hosting you already paid for
2. **Your app is already designed for it**: Microservices-like separation
3. **Minimal changes**: Only add HTTP bridge between backend and ETL
4. **Best time-to-market**: Deploy this week, no waiting for new VPS
5. **Easy to migrate later**: Can move to VPS later without code changes

### Implementation Plan (This Week)

#### Step 1: Create Python ETL Flask App (2 hours)
```python
# data/ingestion/app.py
from flask import Flask, jsonify, request
from .orchestrator import run_full_etl, run_incremental_etl
import os

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'}), 200

@app.route('/run-full', methods=['POST'])
def trigger_full():
    # Verify API key
    if request.headers.get('Authorization') != f"Bearer {os.getenv('ETL_API_KEY')}":
        return {'error': 'Unauthorized'}, 401
    
    try:
        result = run_full_etl()
        return {'status': 'completed', 'rows_loaded': result}, 200
    except Exception as e:
        return {'error': str(e)}, 500

@app.route('/run-incremental', methods=['POST'])
def trigger_incremental():
    if request.headers.get('Authorization') != f"Bearer {os.getenv('ETL_API_KEY')}":
        return {'error': 'Unauthorized'}, 401
    
    try:
        result = run_incremental_etl()
        return {'status': 'completed', 'rows_updated': result}, 200
    except Exception as e:
        return {'error': str(e)}, 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
```

#### Step 2: Add Node.js ETL Trigger (1 hour)
```typescript
// backend/src/etl/etl-client.ts
import axios from 'axios';

const ETL_BASE_URL = process.env.ETL_API_URL; // https://api-etl.benmussa-invest.com
const ETL_API_KEY = process.env.ETL_API_KEY;

export async function triggerFullETL() {
  try {
    const response = await axios.post(`${ETL_BASE_URL}/run-full`, {}, {
      headers: { 'Authorization': `Bearer ${ETL_API_KEY}` },
      timeout: 300000 // 5 min timeout for large loads
    });
    return response.data;
  } catch (error) {
    console.error('ETL trigger failed:', error);
    throw error;
  }
}

export async function triggerIncrementalETL() {
  try {
    const response = await axios.post(`${ETL_BASE_URL}/run-incremental`, {}, {
      headers: { 'Authorization': `Bearer ${ETL_API_KEY}` },
      timeout: 60000 // 1 min timeout
    });
    return response.data;
  } catch (error) {
    console.error('ETL trigger failed:', error);
    throw error;
  }
}
```

#### Step 3: cPanel Configuration (3 hours)
```bash
# 1. Main domain (benmussa-invest.com)
#    - Create Node.js app
#    - Upload: frontend/, backend/, packages/
#    - package.json: setup to run full stack
#    - .env: DB_* vars + ETL_API_URL + ETL_API_KEY

# 2. Subdomain (api-etl.benmussa-invest.com)
#    - Create Python app
#    - Upload: data/ingestion/
#    - requirements.txt: add Flask
#    - .env: DB_* vars, ODOO_* vars
#    - app.py: startup script
```

#### Step 4: Schedule ETL via cPanel Cron (30 minutes)
```bash
# cPanel → Cron Jobs → Add New Cron Job
# Run daily at 2 AM:
0 2 * * * curl -X POST https://api-etl.benmussa-invest.com/run-incremental \
  -H "Authorization: Bearer YOUR_ETL_API_KEY" \
  -H "Content-Type: application/json"
```

#### Step 5: Test & Monitor (2 hours)
- Verify frontend loads at benmussa-invest.com
- Verify backend API responds at benmussa-invest.com/api/...
- Manually trigger `/run-incremental` via curl
- Check cron logs in cPanel

---

## If You Later Want to Upgrade to VPS

Once you outgrow shared hosting:
1. Rent VPS (DigitalOcean, Linode, or Libyan Spider)
2. Deploy via your existing `docker-compose.yml` unchanged
3. Update DNS to point to VPS
4. No code changes needed—everything works identically

---

## What NOT to Do

❌ **Don't run both Python & Node in shared hosting's single cPanel app** — the hosting company already said this won't work.

❌ **Don't create fake "virtual machines" in cPanel** — they're not real VMs; cPanel doesn't support app-level isolation like that.

❌ **Don't try to use Apache workarounds** — hosting company confirmed they don't support this.

---

## Decision Matrix

| Criteria | Option 1 (Split API) | Option 2 (VPS) |
|----------|----------------------|----------------|
| **Cost** | $0 extra | $180-360/year |
| **Setup time** | 1-2 days | 3-4 hours |
| **Complexity** | Low (HTTP bridge) | Medium (server ops) |
| **Scalability** | Limited | High |
| **Automation** | cPanel Cron jobs | Docker orchestration |
| **Best for** | MVP / Phase 1 | Production at scale |

---

## Action Items (Priority Order)

### This Week
- [ ] Tell hosting company: "We'll use separate cPanel apps for Node.js (main) and Python (subdomain)"
- [ ] Ask cPanel support: "Can you create subdomain `api-etl.benmussa-invest.com` with Python 3.10+?"
- [ ] Create Flask ETL app wrapper (see Step 1 above)
- [ ] Add Node.js ETL client (see Step 2 above)
- [ ] Test locally: frontend → backend → Python ETL flow

### Next Week
- [ ] Deploy Node.js app to benmussa-invest.com via cPanel
- [ ] Deploy Python app to api-etl.benmussa-invest.com via cPanel
- [ ] Configure .env files with correct DB credentials
- [ ] Test end-to-end: UI → API → ETL → DB → UI
- [ ] Set up cron job for daily ETL refresh

### After Go-Live
- [ ] Monitor cron job success/failure
- [ ] Log ETL runs for debugging
- [ ] Plan VPS migration for 6+ months out (if business grows)

---

## Questions for Your IT Support

1. **Can cPanel create a subdomain `api-etl.benmussa-invest.com` with Python?**
2. **What Python version is available?** (Need 3.10+)
3. **What's the max execution time for Python scripts?** (ETL may take 10+ minutes)
4. **Can cPanel set environment variables (.env files)?**
5. **Is MySQL connection available from both Node and Python apps?**
6. **Can we use cPanel's Cron Jobs feature to trigger HTTP requests?**

---

## Summary

**Recommendation: Use Option 1 (Split API) this month, then upgrade to VPS in 6 months.**

This gives you:
- ✅ Fast deployment (no new infrastructure to provision)
- ✅ No extra cost (use hosting you paid for)
- ✅ Clear upgrade path (move to VPS later)
- ✅ Time to validate product before investing in servers

Start with shared hosting split architecture. Once you're confident in the product + user base grows, migrate to VPS for better performance & control.
