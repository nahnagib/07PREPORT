# 07PS Deployment - Executive Summary for IT Team

## Quick Facts

| Component | Technology | Port | Domain | Status |
|-----------|-----------|------|--------|--------|
| Frontend | Next.js (Node.js) | 3000 | benmussa-invest.com | Ready |
| Backend API | Express (Node.js) | 4000 | api.benmussa-invest.com | Ready |
| Database | MySQL 8 | 3306 | localhost | Requires setup |
| ETL Workers | Python 3.10+ | N/A | systemd service | Ready |
| Scheduler | Cron | N/A | crontab | Ready |

---

## The Real Solution (Addressing Hosting Provider's Concern)

### What They Said
> "Cannot run Python and Node.js together in shared hosting cPanel"

### Our Solution
Use **SSH access** to deploy each component as independent system services on the same server:

```
Server (via SSH)
│
├─ Nginx/Apache (reverse proxy)
│  ├─ http://localhost:3000 ← Frontend (Node.js)
│  └─ http://localhost:4000 ← Backend (Node.js)
│
├─ SystemD Services
│  ├─ 07ps-frontend.service
│  ├─ 07ps-backend.service
│  └─ 07ps-etl-worker.service
│
├─ MySQL Database
│  └─ ps_warehouse
│
└─ Cron Jobs
   ├─ Hourly ETL incremental
   ├─ Daily full ETL
   └─ Daily backups
```

---

## 9 Key Deployment Phases

### Phase 1: Server Preparation (1-2 hours)
- Install Node.js 20+
- Install Python 3.10+
- Install MySQL client
- Install systemd and PM2

### Phase 2: Application Deployment (30 mins)
- Clone repository
- Install npm dependencies
- Build Frontend & Backend
- Create Python venv

### Phase 3: Database Setup (1 hour)
- Create MySQL database
- Create app user
- Run migrations
- Load initial data

### Phase 4: Configuration (30 mins)
- Create `.env` files
- Set database credentials
- Set JWT secrets
- Configure logging

### Phase 5: System Services (1 hour)
- Create 3 systemd service files
- Enable and start services
- Verify all services running

### Phase 6: Reverse Proxy (1 hour)
- Configure Nginx/Apache
- Point domains to localhost ports
- Install SSL certificates

### Phase 7: Backups (30 mins)
- Create backup script
- Add to crontab
- Test backup process

### Phase 8: Monitoring (30 mins)
- Set up log monitoring
- Create health check script
- Configure alerts

### Phase 9: Updates & Maintenance (ongoing)
- Rolling update procedure
- Testing workflow
- Rollback procedure

---

## Estimated Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1 | 1-2 hrs | SSH access |
| Phase 2 | 30 min | Phase 1 complete |
| Phase 3 | 1 hr | Phase 2 complete |
| Phase 4 | 30 min | Phase 3 complete |
| Phase 5 | 1 hr | Phase 4 complete |
| Phase 6 | 1 hr | Phase 5 complete |
| Phase 7 | 30 min | Any time |
| Phase 8 | 30 min | Phase 5 complete |
| Phase 9 | 1 hr | Phase 8 complete |
| **TOTAL** | **7-8 hours** | Includes testing |

**Recommendation**: Execute in staging environment first (1 day), then production (1 day) for safe rollout.

---

## Critical Prerequisites

Before starting, ensure you have:

```
SERVER SIDE:
✓ SSH access with sudo privileges
✓ Terminal/command line capability
✓ Ability to edit system files
✓ Ability to manage systemd services
✓ Domain/subdomain creation in cPanel
✓ MySQL root access

DEVELOPMENT SIDE:
✓ Git repository access
✓ Application source code
✓ Database schema files
✓ All .env templates
✓ SSL certificate capability (Let's Encrypt OK)

KNOWLEDGE REQUIREMENTS:
✓ Linux command line basics
✓ Basic systemd service management
✓ MySQL administration basics
✓ Node.js / npm familiarity
✓ Basic shell scripting for automation
```

---

## What's Different Than Standard cPanel Deployment

### Traditional cPanel Approach (Limited)
- ❌ Python and Node.js can't coexist in cPanel's sandbox environments
- ❌ Limited control over service dependencies
- ❌ Hard to run background workers

### Our SSH-Based Approach (Recommended)
- ✅ Full control via systemd
- ✅ Can run Python workers + Node.js API on same server
- ✅ Easy monitoring and automated restarts
- ✅ Professional-grade production setup
- ✅ Cost-effective (no need for multiple servers)

---

## Key Configuration Files to Create

```
/home/appuser/
├── 07ps-sales-dashboard/          (cloned repo)
│   ├── backend/.env               (MUST CREATE - API config)
│   ├── data/ingestion/.env        (MUST CREATE - Python config)
│   ├── data/venv/                 (Python virtual environment)
│
/etc/systemd/system/
├── 07ps-frontend.service          (MUST CREATE)
├── 07ps-backend.service           (MUST CREATE)
├── 07ps-etl-worker.service        (MUST CREATE)
│
/etc/nginx/sites-available/
├── benmussa-invest.com            (reverse proxy config)
├── api.benmussa-invest.com        (reverse proxy config)
│
/var/log/07ps/                     (log directory)
│
Crontab entries:
├── backup_database.sh             (daily 3 AM)
├── ETL incremental                (hourly)
└── ETL full                        (daily 2 AM)
```

---

## Runtime Services Overview

### Frontend Service
- **Process**: Next.js dev/production server
- **Port**: 3000 → proxied to port 443 (HTTPS)
- **Memory**: ~200-300 MB
- **Restart**: Automatic on failure
- **Logs**: `journalctl -u 07ps-frontend`

### Backend API Service
- **Process**: Express.js API server
- **Port**: 4000 → proxied to port 443 (HTTPS)
- **Memory**: ~300-400 MB
- **Restart**: Automatic on failure
- **Logs**: `journalctl -u 07ps-backend`

### ETL Worker Service
- **Process**: Python script processing data jobs
- **Port**: N/A (background process)
- **Memory**: ~100-200 MB
- **Restart**: Automatic on failure
- **Logs**: `journalctl -u 07ps-etl-worker`

### Cron Jobs
- **Incremental ETL**: Every hour (5 min execution)
- **Full ETL**: Every night at 2 AM (20-30 min execution)
- **Database Backup**: Every night at 3 AM (10-15 min execution)

---

## Expected Resource Usage

| Resource | Frontend | Backend | ETL Worker | Database | Total |
|----------|----------|---------|-----------|----------|-------|
| CPU | ~5% idle | ~10% avg | ~30% ETL | 10% avg | ~55% average |
| Memory | 250 MB | 350 MB | 150 MB | 500 MB | ~1.25 GB |
| Disk | 150 MB | 100 MB | 50 MB | 1-5 GB | 1.5-5 GB+ |

**Minimum Server Requirements**: 2GB RAM, 20GB Disk, 1 CPU core

---

## Security Considerations

### Access Control
- One application user (not root)
- SSH key authentication (not password)
- Firewall allows only ports 22, 80, 443
- Database user has limited privileges

### Secrets Management
- All API keys in `.env` files (not in code)
- `.env` files have 600 permissions (read-only by owner)
- `.env` files in `.gitignore` (never committed)
- Different secrets per environment

### Network Security
- HTTPS/TLS for all external communication
- CORS headers restricted to domain
- JWT token expiry set (7 days)
- Rate limiting on API endpoints

### Database Security
- MySQL user has `ps_warehouse` database only
- Daily automated backups
- Backups encrypted (optional additional step)
- No direct root access from app

---

## Questions for Your Hosting Provider

Before starting, ask them to confirm:

1. **Python Support**: "Can we run Python scripts as systemd services?"
2. **Service Manager**: "Is systemd available on this server?"
3. **SSH Access**: "Confirm we have full SSH/terminal access with sudo?"
4. **Node.js**: "Can we install any version of Node.js we need?"
5. **Cron Jobs**: "Can we use crontab for scheduled tasks?"
6. **Ports**: "Can our services listen on arbitrary high-numbered ports (3000, 4000)?"
7. **MySQL**: "What are the database size limits?"
8. **Process Limits**: "How many simultaneous processes can we run?"

---

## Deployment Checklist Template

```
PRE-DEPLOYMENT:
☐ Server requirements confirmed with hosting provider
☐ SSH access verified and working
☐ MySQL 8 installed and accessible
☐ Node.js 20+ installed and verified
☐ Python 3.10+ installed and verified
☐ All credentials documented and secured

DEPLOYMENT:
☐ Repository cloned to /home/appuser
☐ npm install completed successfully
☐ Frontend built without errors
☐ Backend built without errors
☐ Python venv created with dependencies
☐ Database created and migrations applied
☐ Initial data loaded and verified

CONFIGURATION:
☐ backend/.env created with all values
☐ data/ingestion/.env created with all values
☐ Log directory created (/var/log/07ps)
☐ All .env files have 600 permissions

SERVICES:
☐ 07ps-frontend.service created and running
☐ 07ps-backend.service created and running
☐ 07ps-etl-worker.service created and running
☐ All services autostart on boot
☐ Service logs accessible and readable

NETWORKING:
☐ Reverse proxy configured (Nginx/Apache)
☐ benmussa-invest.com points to frontend
☐ api.benmussa-invest.com points to backend
☐ SSL certificates installed for both domains
☐ HTTP → HTTPS redirect working

AUTOMATION:
☐ Backup script created and tested
☐ Cron jobs configured
☐ First backup completed successfully
☐ Health check script working

FINAL VERIFICATION:
☐ Frontend loads at https://benmussa-invest.com
☐ Backend API responds at https://api.benmussa-invest.com
☐ Database integrity verified
☐ All logs are clean (no errors)
☐ Services restart automatically after reboot
```

---

## Common Issues & Quick Fixes

### "Command not found: node"
```bash
# Node.js not installed or not in PATH
which node
npm --version
# If not found, run Phase 1 install steps
```

### "Cannot connect to database"
```bash
# Check MySQL is running
sudo systemctl status mysql
# Check credentials in .env
cat backend/.env | grep DB_
# Test connection
mysql -h localhost -u ps_app -p
```

### "Port 3000/4000 already in use"
```bash
# Find process using port
sudo lsof -i :3000
# Kill it if needed
sudo kill -9 <PID>
```

### "Service won't start"
```bash
# Check error messages
sudo journalctl -u 07ps-backend.service -n 50
# Try running command manually
cd /home/appuser/07ps-sales-dashboard
npm start --prefix backend
```

### "Permission denied" on .env files
```bash
# Fix permissions
chmod 600 backend/.env
chmod 600 data/ingestion/.env
```

---

## Going Live Checklist

- [ ] All tests pass in staging
- [ ] Performance benchmarks acceptable
- [ ] Security audit completed
- [ ] Backup & restore procedure tested
- [ ] Team trained on monitoring/alerts
- [ ] Rollback procedure documented
- [ ] DNS records updated
- [ ] SSL certificates valid
- [ ] Monitoring and alerts enabled
- [ ] Stakeholders notified of go-live

---

## Post-Deployment Support

### First Week
- Daily health check: `/home/appuser/check_services.sh`
- Review logs for any errors or warnings
- Test backup/restore procedure
- Monitor performance and resource usage

### First Month
- Execute one planned update to test update procedure
- Verify all scheduled jobs are running
- Test failover/restart procedures
- Collect performance metrics

### Ongoing
- Monthly security updates
- Quarterly dependency updates
- Continuous backup verification
- Regular log review for issues

---

## Document References

This is a summary. Refer to **DEPLOYMENT_GUIDE.md** for:
- Detailed commands for each phase
- Complete systemd service file templates
- Nginx/Apache configuration examples
- Troubleshooting procedures
- Security best practices
- Update and rollback procedures

---

**Prepared by**: Nahla (nahla.burweiss@gmail.com)  
**Date**: July 13, 2026  
**Status**: Ready for IT Team Review
