# Deployment Automation Prompt for AI

Use this prompt with Claude or another AI assistant to automate and validate your deployment. This document serves as a structured template for deploying the 07 Ps Sales Dashboard to Libyan Spider shared hosting.

---

## Core Deployment Prompt Template

```
I need to deploy the 07 Ps Sales Dashboard to Libyan Spider shared hosting (Ubuntu 22.04+ VPS).

PROJECT DETAILS:
- Repository: 07ps-sales-dashboard-app (Node.js/React frontend + Express backend + Python ETL)
- Stack: Next.js 14, Express 4.19, Python 3.11 ETL, MySQL 8, Redis 7, Docker Compose
- Company: Ben Moussa Holding (Majaal & Tika)
- Environment: Production

INFRASTRUCTURE DETAILS:
- VPS Provider: Libyan Spider
- OS: Ubuntu 22.04 LTS
- Root Access: Yes
- Public IP: [VPS_PUBLIC_IP]
- Domain: [DOMAIN]
- DNS Control: [REGISTRAR]
- Estimated Deployment Time: 2-3 hours

DATABASE DETAILS:
- Type: MySQL 8 (external, NOT containerized)
- Host: [DB_HOST]
- Port: [3306]
- Root User: [DB_ROOT_USER]
- Root Password: [DB_ROOT_PASSWORD]
- App User: ps_app
- Database: ps_warehouse
- Size: ~50GB
- Backup Strategy: Daily at 2 AM UTC, retained 30 days

EXTERNAL SERVICES:
- Odoo ERP URL: [ODOO_URL]
- Odoo Database: [ODOO_DATABASE]
- Odoo Username: [ODOO_USERNAME]
- Odoo API Key: [ODOO_API_KEY]
- SMTP Host: [SMTP_SERVER]
- SMTP Port: [SMTP_PORT]
- SMTP User: [SENDER_EMAIL]
- SMTP Password: [APP_PASSWORD]

SUBDOMAINS TO CONFIGURE:
- Main: [DOMAIN]
- WWW: www.[DOMAIN]
- API: api.[DOMAIN]
- ETL (optional): etl-api.[DOMAIN]

DEPLOYMENT TASKS:
1. Validate environment prerequisites (OS, Docker, Git, etc.)
2. Update system packages and install dependencies
3. Install Docker Engine and Docker Compose
4. Install Nginx (systemd-managed) and Certbot
5. Clone the Git repository
6. Generate secure secrets (JWT, ETL_API_KEY)
7. Create environment files (.env) with proper credentials
8. Build Docker images (frontend, backend, ETL API, worker)
9. Start Docker Compose stack
10. Configure Nginx as reverse proxy
11. Request SSL/TLS certificates from Let's Encrypt
12. Set up automatic certificate renewal
13. Run database migrations
14. Create initial admin user
15. Verify all services are healthy
16. Test frontend, API, and ETL functionality
17. Configure backup automation
18. Set up monitoring and alerting (optional)

VALIDATION CHECKPOINTS:
- ✓ DNS resolves correctly for all subdomains
- ✓ SSL certificates valid (HTTPS working)
- ✓ All Docker containers healthy
- ✓ Backend API /health endpoint responds
- ✓ Frontend loads and renders correctly
- ✓ Admin user can log in
- ✓ Business unit selector works
- ✓ Dashboard displays sample data
- ✓ Filters functional
- ✓ ETL can be triggered and completes
- ✓ Database tables created
- ✓ SMTP connectivity verified
- ✓ Redis job queue working

DEPLOYMENT RISKS & MITIGATIONS:
- MySQL connection failures → Pre-test connectivity from VPS to DB server
- DNS propagation delays → Update DNS 15+ minutes before TLS setup
- CORS errors → Verify FRONTEND_ORIGIN and NEXT_PUBLIC_API_BASE_URL match
- ETL API failures → Check ETL_API_KEY matches in all .env files
- Disk space exhaustion → Ensure 100GB+ free space before build
- Certificate request failures → Ensure DNS resolves and port 80 accessible

INSTRUCTIONS:
- Execute each step in order; some steps depend on previous ones
- For all steps involving environment files, validate content before saving
- Monitor Docker logs during startup; fix errors before proceeding
- Perform health checks after each major step
- Create database backups before any production data migration
- Keep all credentials in a secure location (password manager)
- After successful deployment, delete plaintext credential files
- Document any customizations or deviations from this plan

ESTIMATED TIMELINE:
- Prerequisites & planning: 30 min
- System setup (steps 1-4): 30 min
- Repository & configuration (steps 5-7): 10 min
- Docker build (steps 8-9): 15-20 min
- Nginx & TLS (steps 10-12): 10 min
- Verification & testing (steps 13-17): 20 min
- Total: 2-3 hours (first deployment)
```

---

## Pre-Deployment Questionnaire

Answer these questions BEFORE starting deployment. They ensure you have all required information:

### Infrastructure & Access

1. **VPS Details**
   - [ ] VPS IP address known and accessible?
   - [ ] SSH key or password prepared?
   - [ ] Root/sudo access confirmed?
   - [ ] OS is Ubuntu 22.04+?
   - [ ] At least 50GB disk free (100GB recommended)?
   - [ ] At least 4GB RAM (8GB recommended)?

2. **Domain & DNS**
   - [ ] Domain purchased and registered?
   - [ ] DNS registrar access available?
   - [ ] Can create/modify A records?
   - [ ] Domain: ________________

3. **Network & Firewall**
   - [ ] Public IP assigned to VPS?
   - [ ] Ports 80, 443 open and accessible?
   - [ ] SSH port (22) accessible from your location?
   - [ ] Firewall configured (if applicable)?

### Database Configuration

4. **MySQL Server**
   - [ ] MySQL 8 server exists and is accessible?
   - [ ] Server hostname/IP: ________________
   - [ ] Port (default 3306): ________________
   - [ ] Root username: ________________
   - [ ] Root password: ________________
   - [ ] Can create databases and users?
   - [ ] At least 50GB free space?
   - [ ] Backups configured (external to this deployment)?

### Odoo ERP Integration

5. **Odoo Connectivity**
   - [ ] Live Odoo instance available?
   - [ ] Odoo URL: ________________
   - [ ] Odoo database name: ________________
   - [ ] Odoo user account created?
   - [ ] Odoo username: ________________
   - [ ] Odoo API key generated?
   - [ ] XML-RPC API enabled in Odoo?
   - [ ] Odoo user has read access to Sales, HR, Finance modules?

### Email Configuration

6. **SMTP / Email**
   - [ ] SMTP server available?
   - [ ] SMTP hostname: ________________
   - [ ] SMTP port (usually 587 or 465): ________________
   - [ ] SMTP username: ________________
   - [ ] SMTP password/app password: ________________
   - [ ] Sender email address: ________________
   - [ ] Test email can be sent?

### Credentials & Secrets

7. **Security**
   - [ ] Will you use password manager to store credentials?
   - [ ] Have you generated random JWT_SECRET? `openssl rand -base64 32`
   - [ ] Have you generated random ETL_API_KEY? `openssl rand -base64 32`
   - [ ] Strong MySQL ps_app password generated?
   - [ ] All credentials documented securely?

### Git Repository

8. **Source Code**
   - [ ] Git repository URL known?
   - [ ] Repository URL: ________________
   - [ ] Private or public repo?
   - [ ] SSH key for Git access (if private)?
   - [ ] Branch to deploy: `main` or other?

### Stakeholders & Support

9. **Team & Handoff**
   - [ ] DevOps/sysadmin contact identified?
   - [ ] Database administrator identified?
   - [ ] Support contact for Odoo?
   - [ ] Support contact for email/SMTP?
   - [ ] Post-deployment monitoring plan?

---

## Credentials Checklist

Create a secure document (password manager, encrypted file, etc.) with these credentials. **Do NOT commit to git or leave in plaintext.**

```
═══════════════════════════════════════════════════════════════
  07 Ps Sales Dashboard - Deployment Credentials
═══════════════════════════════════════════════════════════════

VPS & SSH Access
─────────────────
VPS IP Address:           [FILL IN]
VPS SSH Username:         root
VPS SSH Key Location:     /path/to/key.pem (or use password)
VPS SSH Password:         [FILL IN]

Domain & DNS
─────────────
Primary Domain:           [FILL IN] (e.g., benmussa-invest.com)
Registrar/DNS Provider:   [FILL IN]
DNS Registrar Username:   [FILL IN]
DNS Registrar Password:   [FILL IN]

MySQL Database Server
──────────────────────
Database Host:            [FILL IN]
Database Port:            3306
Database Root User:       root
Database Root Password:   [FILL IN]
App DB User:              ps_app
App DB Password:          [FILL IN - Generate: openssl rand -base64 32]
Database Name:            ps_warehouse

Secrets (Generate if not already done)
─────────────────────────────────────
JWT_SECRET:               [FILL IN - Generate: openssl rand -base64 32]
ETL_API_KEY:              [FILL IN - Generate: openssl rand -base64 32]

Odoo ERP
────────
Odoo URL:                 [FILL IN] (e.g., https://odoo.example.com)
Odoo Database Name:       [FILL IN]
Odoo Username:            [FILL IN]
Odoo API Key:             [FILL IN]

Email/SMTP
──────────
SMTP Host:                [FILL IN] (e.g., smtp.gmail.com)
SMTP Port:                [FILL IN] (usually 587 or 465)
SMTP Secure:              [FILL IN] (true/false)
SMTP Username:            [FILL IN] (usually email address)
SMTP Password:            [FILL IN] (app password for Gmail)
Sender Email:             [FILL IN] (noreply@benmussa-invest.com)
Sender Display Name:      BMH Sales Dashboard

GitHub/Git Repository
──────────────────────
Repository URL:           [FILL IN]
(If private) SSH Key:     [FILL IN or path to key]
Branch to Deploy:         main

═══════════════════════════════════════════════════════════════
SECURITY REMINDERS:
✓ Store this file securely (password manager or encrypted)
✓ Do NOT commit to git
✓ Do NOT share over unencrypted email
✓ Delete this file after deployment is complete
✓ Keep backups of credentials in a vault
═══════════════════════════════════════════════════════════════
```

---

## Deployment Success Criteria

After deployment, verify these success criteria to confirm the deployment is complete and production-ready:

### Tier 1: Critical (Deployment is Broken Without These)

- [ ] **Connectivity**: Can SSH into VPS from your local machine
- [ ] **Docker**: `docker compose ps` shows all containers (at least 4)
- [ ] **Frontend**: HTTPS loads at `https://[DOMAIN]` without SSL errors
- [ ] **Backend**: API endpoint responds at `https://api.[DOMAIN]/health`
- [ ] **Database**: MySQL `ps_warehouse` database exists with tables
- [ ] **Admin User**: Can log in to dashboard with admin credentials
- [ ] **No Critical Errors**: `docker compose logs` shows no `FATAL`, `ERROR`, or `CRITICAL` messages

### Tier 2: Important (Deployment is Incomplete Without These)

- [ ] **Filters**: Dashboard filters (Business Unit, Date Range, etc.) work
- [ ] **Data Display**: Dashboard displays sample data from database
- [ ] **ETL Triggered**: Admin can manually trigger ETL job in Admin panel
- [ ] **ETL Completes**: ETL job completes successfully (status: COMPLETED, not FAILED)
- [ ] **CORS**: No CORS errors in browser console
- [ ] **SSL Certificate**: Certificate is valid and auto-renewals configured
- [ ] **DNS**: All subdomains (main, www, api) resolve correctly

### Tier 3: Production Hardening (Required for Production)

- [ ] **SMTP Verified**: Test password reset email sent successfully
- [ ] **Odoo Connectivity**: ETL logs show successful Odoo API connection (if ALLOW_LIVE_ODOO=1)
- [ ] **Backups Configured**: Database backup script runs and creates backups
- [ ] **Monitoring**: Nginx/Docker container monitoring alerts configured
- [ ] **Rate Limiting**: Login endpoint has rate limiting enabled (RATE_LIMIT_LOGIN_MAX=10)
- [ ] **Secrets Rotated**: All .env files use strong random values
- [ ] **Logs Monitored**: Someone is assigned to monitor container logs daily

---

## Post-Deployment Maintenance

These tasks should be performed regularly after deployment:

### Daily
- [ ] Check Docker container health: `docker compose ps`
- [ ] Monitor ETL runs in **Admin → ETL Runs**
- [ ] Spot-check dashboard for obvious errors

### Weekly
- [ ] Review Docker logs for warnings: `docker compose logs | grep -i warn`
- [ ] Verify database backup was created
- [ ] Test at least one business unit's data

### Monthly
- [ ] Review disk usage: `du -sh /opt/07ps-dashboard /var/lib/docker`
- [ ] Review ETL performance: Check for slow/failed runs
- [ ] Rotate logs if needed: `docker system prune`
- [ ] Update documentation with any customizations

### Quarterly
- [ ] Review SSL certificate expiry: `certbot certificates`
- [ ] Update system packages: `apt-get update && apt-get upgrade -y`
- [ ] Test disaster recovery: Practice restoring from database backup
- [ ] Review and update credential access (revoke old SSH keys, etc.)

---

## Rollback & Recovery Procedures

If deployment fails or you need to rollback:

### Quick Rollback (Last Commit)
```bash
cd /opt/07ps-dashboard
git checkout HEAD~1
docker compose down
docker compose build
docker compose up -d
```

### Rollback to Tagged Release
```bash
cd /opt/07ps-dashboard
git tag -l                    # List available versions
git checkout v1.2.3           # Checkout specific version
docker compose down
docker compose build
docker compose up -d
```

### Restore Database from Backup
```bash
cd /opt/07ps-dashboard
# Find your latest backup
ls -t backups/*.sql.gz | head -1

# Restore (warning: overwrites current data!)
mysql -h <DB_HOST> -u root -p < backups/ps_warehouse_YYYYMMDD_HHMMSS.sql.gz
```

### Full System Restore
```bash
# Stop everything
docker compose down
systemctl stop nginx

# Remove all containers/images
docker system prune -a --volumes -f

# Restore code to known-good version
git checkout <known-good-tag>

# Start fresh
docker compose build
docker compose up -d
systemctl start nginx
```

---

## Quick Reference: Common Commands

```bash
# Docker operations
docker compose ps                    # Status of all services
docker compose logs -f               # Live logs (Ctrl+C to exit)
docker compose logs -f backend       # Logs for one service
docker compose restart               # Restart all services
docker compose restart backend       # Restart one service
docker compose build                 # Rebuild all images
docker compose build backend         # Rebuild one image
docker compose down                  # Stop and remove all containers
docker compose up -d                 # Start all services

# Database operations
mysql -h <HOST> -u ps_app -p<PWD> ps_warehouse -e "SELECT 1;"  # Test connection
mysqldump -h <HOST> -u ps_app -p<PWD> ps_warehouse | gzip > backup.sql.gz  # Backup

# Nginx/SSL
nginx -t                             # Validate config
systemctl reload nginx               # Reload without stopping
certbot certificates                 # List current certificates
certbot renew --dry-run              # Test renewal process

# Monitoring
docker stats                         # Real-time resource usage
df -h                                # Disk space
free -h                              # RAM usage
uptime                               # System uptime

# ETL operations
docker compose exec backend npm run etl:run              # Trigger ETL
docker compose logs -f etl-api | tail -100              # Monitor Python ETL
docker compose logs -f etl-worker | tail -100           # Monitor job queue
```

---

## Support & Escalation Contacts

Who to contact if deployment fails:

| Issue | Contact | Information |
|-------|---------|-------------|
| VPS/Infrastructure | Libyan Spider Support | Ticket: [TICKET_ID], Account: [ACCOUNT_ID] |
| Domain/DNS | Registrar Support | Domain: [DOMAIN], Registrar: [REGISTRAR] |
| MySQL Database | DBA / Database Team | Host: [DB_HOST], Database: [DB_NAME] |
| Odoo ERP | Odoo Administrator | URL: [ODOO_URL], Credentials: [USERNAME] |
| Email/SMTP | IT/Email Team | Provider: [PROVIDER], Account: [ACCOUNT] |
| Git Repository | DevOps / GitHub Admin | Repository: [REPO_URL] |
| General Deployment | DevOps Engineer | Name: [NAME], Contact: [EMAIL/PHONE] |

---

## Appendix: Full Documentation Links

- **Complete Deployment Guide:** `docs/libyan-spider-deployment.md`
- **Quick Setup Script:** `docs/libyan-spider-quick-setup.sh`
- **Architecture Standards:** `docs/07Ps_Phase1_Architecture_Standards.md`
- **ETL Deployment Guide:** `docs/etl-deployment.md`
- **VPS Deployment (VPC/Docker):** `docs/vps-deployment.md`
- **Tech Stack Decision:** `docs/tech-stack-decision.md`

---

**Document Version:** 1.0  
**Last Updated:** July 16, 2026  
**Next Review Date:** October 16, 2026

