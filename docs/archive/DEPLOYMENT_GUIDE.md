# 07PS Sales Dashboard - Production Deployment Guide
## For: benmussa-invest.com Hosting Environment

**Created**: July 13, 2026  
**App**: 07 Ps Sales Dashboard (Next.js Frontend + Express Backend + Python ETL Workers)  
**Domain**: benmussa-invest.com  
**Hosting**: cPanel Shared Hosting with SSH Access

---

## Overview & Architecture Solution

### The Challenge
The hosting provider's cPanel environment cannot run Python and Node.js in a single unified environment. However, with **SSH access**, we can deploy each component separately on the same server using system-level service managers.

### Solution Architecture
```
benmussa-invest.com
├── Frontend (Next.js)
│   └── Runs on Node.js on main domain
│
api.benmussa-invest.com
├── Backend (Express API)
│   └── Runs on Node.js on subdomain
│
System Services (via SSH/systemd)
├── Python ETL Workers
│   └── Background job processors (independent processes)
└── MySQL Database
    └── Shared data layer for all services
```

**Key Point**: All three components can coexist on the same server. The separation is logical (via different domains/ports), not physical. This gives you the benefits of cPanel for easy web management while leveraging SSH for complex services.

---

## Pre-Deployment Checklist

### Server Requirements
- [ ] Node.js 20+ installed on server
- [ ] Python 3.10+ installed on server
- [ ] MySQL 8 server running
- [ ] SSH access to server with sudo privileges
- [ ] Git installed on server (for version control)
- [ ] At least 2GB free disk space
- [ ] Ability to create subdomains in cPanel

### Credentials & Information Needed
- [ ] Database credentials (MySQL user, password, host)
- [ ] Server SSH connection details (host, user, port)
- [ ] cPanel access (for domain/subdomain setup)
- [ ] Git repository URL (if using GitHub/GitLab)
- [ ] API keys/secrets for external services (Odoo, etc.)

### Domain/Subdomain Setup
- [ ] `benmussa-invest.com` - points to Frontend
- [ ] `api.benmussa-invest.com` - points to Backend
- [ ] Both should have valid SSL certificates (via cPanel's AutoSSL or Let's Encrypt)

---

## Phase 1: Server Preparation (SSH Access)

### 1.1 Update Server Packages
```bash
ssh user@your-server-ip
sudo apt update && sudo apt upgrade -y
```

### 1.2 Install Required Software

#### Node.js (if not already installed)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs npm
node --version    # Verify (should be v20+)
npm --version
```

#### Python 3.10+
```bash
sudo apt install -y python3 python3-pip python3-venv
python3 --version  # Verify (should be 3.10+)
```

#### MySQL Client (for local connections)
```bash
sudo apt install -y mysql-client
```

#### PM2 (Process Manager for Node.js services)
```bash
sudo npm install -g pm2
pm2 startup
sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup -u ubuntu --hp /home/ubuntu
```

#### Git (for version control)
```bash
sudo apt install -y git
```

### 1.3 Create Application User (Optional but Recommended)
```bash
sudo useradd -m -s /bin/bash appuser
sudo usermod -aG sudo appuser  # Allow sudo without password for specific commands
```

---

## Phase 2: Application Deployment

### 2.1 Clone Repository to Server

```bash
# As appuser or your deployment user:
cd /home/appuser
git clone https://github.com/your-org/07ps-sales-dashboard.git
cd 07ps-sales-dashboard

# Or, if deploying from a prepared archive:
# scp -r path/to/07ps-sales-dashboard user@server:/home/appuser/
```

### 2.2 Install Dependencies

#### Install Node.js Dependencies (for frontend and backend)
```bash
# From project root:
npm install
# This installs frontend, backend, and shared packages (monorepo structure)

# Verify workspaces are set up
npm list --depth=0
```

#### Create Python Virtual Environment for ETL Workers
```bash
cd data
python3 -m venv venv
source venv/bin/activate
pip install -r ingestion/requirements.txt
pip install -r warehouse/requirements.txt
deactivate
cd ..
```

### 2.3 Build Applications for Production

#### Build Frontend (Next.js)
```bash
cd frontend
npm run build
cd ..
```

#### Build Backend (Express)
```bash
cd backend
npm run build
cd ..
```

---

## Phase 3: Database Setup

### 3.1 Create MySQL Database

```bash
# Connect to MySQL
mysql -h localhost -u root -p

# Create database
CREATE DATABASE ps_warehouse CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# Create application user
CREATE USER 'ps_app'@'localhost' IDENTIFIED BY 'strong_password_here';
GRANT ALL PRIVILEGES ON ps_warehouse.* TO 'ps_app'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 3.2 Apply Database Migrations

```bash
cd data/warehouse
source ../../venv/bin/activate
python3 apply_migrations.py
deactivate
cd ../..
```

### 3.3 Load Initial Data (One-Time)

```bash
cd data/ingestion
source ../../venv/bin/activate

# Option A: Load real historical data (if you have SalesModel_OneOutput.xlsx)
python3 load_real_export.py "/path/to/SalesModel_OneOutput.xlsx"

# Option B: Load sample/mocked data (for testing)
python3 orchestrator.py --run-once

deactivate
cd ../..
```

---

## Phase 4: Environment Configuration

### 4.1 Create Environment Files

#### Backend .env
```bash
# Copy template
cp backend/.env.example backend/.env

# Edit backend/.env with production values:
cat > backend/.env << 'EOF'
# Server
NODE_ENV=production
PORT=4000
API_HOST=0.0.0.0

# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=ps_app
DB_PASSWORD=strong_password_here
DB_NAME=ps_warehouse

# JWT & Security
JWT_SECRET=your_very_long_random_secret_key_at_least_32_chars
JWT_EXPIRY=7d
BCRYPT_ROUNDS=10

# Redis (for job queue - optional, can use in-memory fallback)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# API Configuration
API_URL=https://api.benmussa-invest.com
FRONTEND_URL=https://benmussa-invest.com
CORS_ORIGIN=https://benmussa-invest.com

# Odoo Connection (when available)
ODOO_HOST=your-odoo-instance.com
ODOO_DB=your_db_name
ODOO_USER=api_user
ODOO_PASSWORD=secure_password
ALLOW_LIVE_ODOO=0  # Change to 1 only when Odoo is ready

# Email Configuration (for notifications)
SMTP_HOST=your-smtp-server.com
SMTP_PORT=587
SMTP_USER=your-email@example.com
SMTP_PASSWORD=email-password
SMTP_FROM=noreply@benmussa-invest.com

# Logging
LOG_LEVEL=info
LOG_FILE=/var/log/07ps/backend.log
EOF
chmod 600 backend/.env
```

#### Data/ETL .env
```bash
cp data/ingestion/.env.example data/ingestion/.env

cat > data/ingestion/.env << 'EOF'
# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=ps_app
DB_PASSWORD=strong_password_here
DB_NAME=ps_warehouse

# Odoo (optional)
ODOO_HOST=your-odoo-instance.com
ODOO_DB=your_db_name
ODOO_USER=api_user
ODOO_PASSWORD=secure_password
ALLOW_LIVE_ODOO=0

# ETL Configuration
ETL_LOG_FILE=/var/log/07ps/etl.log
ETL_WORKER_COUNT=2
EOF
chmod 600 data/ingestion/.env
```

### 4.2 Create Log Directory
```bash
sudo mkdir -p /var/log/07ps
sudo chown appuser:appuser /var/log/07ps
chmod 755 /var/log/07ps
```

---

## Phase 5: Service Setup (SystemD)

### 5.1 Create Frontend Service

**File**: `/etc/systemd/system/07ps-frontend.service`

```bash
sudo tee /etc/systemd/system/07ps-frontend.service > /dev/null << 'EOF'
[Unit]
Description=07PS Sales Dashboard Frontend
After=network.target

[Service]
Type=simple
User=appuser
WorkingDirectory=/home/appuser/07ps-sales-dashboard
ExecStart=/usr/bin/npm start --prefix frontend
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=07ps-frontend

# Security
NoNewPrivileges=true
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/home/appuser/07ps-sales-dashboard

[Install]
WantedBy=multi-user.target
EOF
```

**Enable and Start**:
```bash
sudo systemctl daemon-reload
sudo systemctl enable 07ps-frontend.service
sudo systemctl start 07ps-frontend.service
sudo systemctl status 07ps-frontend.service
```

### 5.2 Create Backend API Service

**File**: `/etc/systemd/system/07ps-backend.service`

```bash
sudo tee /etc/systemd/system/07ps-backend.service > /dev/null << 'EOF'
[Unit]
Description=07PS Sales Dashboard Backend API
After=network.target mysql.service

[Service]
Type=simple
User=appuser
WorkingDirectory=/home/appuser/07ps-sales-dashboard
EnvironmentFile=/home/appuser/07ps-sales-dashboard/backend/.env
ExecStart=/usr/bin/npm start --prefix backend
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=07ps-backend

[Install]
WantedBy=multi-user.target
EOF
```

**Enable and Start**:
```bash
sudo systemctl daemon-reload
sudo systemctl enable 07ps-backend.service
sudo systemctl start 07ps-backend.service
sudo systemctl status 07ps-backend.service
```

### 5.3 Create Python ETL Worker Service

**File**: `/etc/systemd/system/07ps-etl-worker.service`

```bash
sudo tee /etc/systemd/system/07ps-etl-worker.service > /dev/null << 'EOF'
[Unit]
Description=07PS ETL Worker Service
After=network.target mysql.service
Requires=07ps-backend.service

[Service]
Type=simple
User=appuser
WorkingDirectory=/home/appuser/07ps-sales-dashboard/data/etl
EnvironmentFile=/home/appuser/07ps-sales-dashboard/data/ingestion/.env
ExecStart=/home/appuser/07ps-sales-dashboard/data/venv/bin/python3 run_pipeline.py
Restart=always
RestartSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=07ps-etl-worker

[Install]
WantedBy=multi-user.target
EOF
```

**Enable and Start**:
```bash
sudo systemctl daemon-reload
sudo systemctl enable 07ps-etl-worker.service
sudo systemctl start 07ps-etl-worker.service
sudo systemctl status 07ps-etl-worker.service
```

### 5.4 Create Python ETL Scheduler (Cron-based)

**Edit crontab**:
```bash
crontab -e
```

**Add scheduled ETL jobs**:
```cron
# Run incremental ETL every hour
0 * * * * cd /home/appuser/07ps-sales-dashboard && source data/venv/bin/activate && python3 data/etl/run_pipeline.py incremental >> /var/log/07ps/etl-cron.log 2>&1

# Run full ETL every night at 2 AM
0 2 * * * cd /home/appuser/07ps-sales-dashboard && source data/venv/bin/activate && python3 data/etl/run_pipeline.py full >> /var/log/07ps/etl-full.log 2>&1

# Run customer sync every 6 hours
0 */6 * * * cd /home/appuser/07ps-sales-dashboard && source data/venv/bin/activate && python3 data/etl/run_pipeline.py customers >> /var/log/07ps/etl-customers.log 2>&1
```

---

## Phase 6: Reverse Proxy & Domain Setup (cPanel/Nginx)

### 6.1 Configure Nginx Reverse Proxy (if using Nginx)

**Frontend Reverse Proxy** - `/etc/nginx/sites-available/benmussa-invest.com`

```nginx
upstream frontend {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    listen [::]:80;
    server_name benmussa-invest.com www.benmussa-invest.com;
    
    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name benmussa-invest.com www.benmussa-invest.com;

    # SSL Certificate (via cPanel's AutoSSL)
    ssl_certificate /etc/ssl/certs/benmussa-invest.com.crt;
    ssl_certificate_key /etc/ssl/private/benmussa-invest.com.key;

    location / {
        proxy_pass http://frontend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**Backend Reverse Proxy** - `/etc/nginx/sites-available/api.benmussa-invest.com`

```nginx
upstream backend {
    server 127.0.0.1:4000;
}

server {
    listen 80;
    listen [::]:80;
    server_name api.benmussa-invest.com;
    
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.benmussa-invest.com;

    ssl_certificate /etc/ssl/certs/api.benmussa-invest.com.crt;
    ssl_certificate_key /etc/ssl/private/api.benmussa-invest.com.key;

    # Increase upload size for file uploads
    client_max_body_size 50M;

    location / {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeout settings for long-running requests
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

**Enable Sites**:
```bash
sudo ln -s /etc/nginx/sites-available/benmussa-invest.com /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/api.benmussa-invest.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 6.2 Configure via cPanel (Alternative Approach)

If your hosting provider's cPanel has Nginx/Apache reverse proxy support:

1. Create addon domain: `api.benmussa-invest.com`
2. Set it to point to `http://127.0.0.1:4000`
3. Enable SSL/TLS for both domains
4. Configure CORS properly in Backend API

---

## Phase 7: Database Backup Strategy

### 7.1 Automated Daily Backup Script

**File**: `/home/appuser/backup_database.sh`

```bash
#!/bin/bash

BACKUP_DIR="/home/appuser/backups"
DB_NAME="ps_warehouse"
DB_USER="ps_app"
DB_PASSWORD="strong_password_here"
RETENTION_DAYS=30

# Create backup directory
mkdir -p $BACKUP_DIR

# Create backup filename with timestamp
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_$(date +%Y%m%d_%H%M%S).sql.gz"

# Backup database
mysqldump -h localhost -u $DB_USER -p"$DB_PASSWORD" $DB_NAME | gzip > $BACKUP_FILE

# Check if backup was successful
if [ $? -eq 0 ]; then
    echo "Backup completed: $BACKUP_FILE" >> /var/log/07ps/backup.log
    
    # Delete backups older than retention period
    find $BACKUP_DIR -name "${DB_NAME}_*.sql.gz" -mtime +$RETENTION_DAYS -delete
else
    echo "Backup failed at $(date)" >> /var/log/07ps/backup.log
    exit 1
fi
```

**Make it executable and add to crontab**:
```bash
chmod +x /home/appuser/backup_database.sh

# Add to crontab
crontab -e
```

**Add this line** (daily at 3 AM):
```cron
0 3 * * * /home/appuser/backup_database.sh
```

---

## Phase 8: Monitoring & Health Checks

### 8.1 Service Status Monitoring

```bash
#!/bin/bash
# File: /home/appuser/check_services.sh

echo "=== Service Status Check ==="
echo ""

# Check Frontend
echo "Frontend (port 3000):"
sudo systemctl status 07ps-frontend.service | grep Active
curl -s http://localhost:3000 > /dev/null && echo "✓ Frontend is responding" || echo "✗ Frontend is DOWN"

echo ""

# Check Backend
echo "Backend (port 4000):"
sudo systemctl status 07ps-backend.service | grep Active
curl -s http://localhost:4000/health > /dev/null && echo "✓ Backend is responding" || echo "✗ Backend is DOWN"

echo ""

# Check Database
echo "MySQL Database:"
mysql -h localhost -u ps_app -p"$DB_PASSWORD" -e "SELECT VERSION();" > /dev/null 2>&1 && echo "✓ MySQL is running" || echo "✗ MySQL is DOWN"

echo ""

# Check Python Worker
echo "Python ETL Worker:"
sudo systemctl status 07ps-etl-worker.service | grep Active
```

**Run health check**:
```bash
chmod +x /home/appuser/check_services.sh
/home/appuser/check_services.sh
```

### 8.2 View Service Logs

```bash
# Frontend logs
sudo journalctl -u 07ps-frontend.service -n 100 -f

# Backend logs
sudo journalctl -u 07ps-backend.service -n 100 -f

# ETL worker logs
sudo journalctl -u 07ps-etl-worker.service -n 100 -f

# All application logs
sudo tail -f /var/log/07ps/*.log
```

---

## Phase 9: Updates & Maintenance

### 9.1 Rolling Update Procedure

```bash
# 1. Pull latest code
cd /home/appuser/07ps-sales-dashboard
git pull origin main

# 2. Install any new dependencies
npm install

# 3. Build applications
npm run build

# 4. Stop services gracefully
sudo systemctl stop 07ps-frontend.service 07ps-backend.service

# 5. Run database migrations (if applicable)
cd data/warehouse
source ../../venv/bin/activate
python3 apply_migrations.py
deactivate

# 6. Restart services
sudo systemctl start 07ps-backend.service 07ps-frontend.service

# 7. Verify health
/home/appuser/check_services.sh
```

---

## Troubleshooting Guide

### Issue: "Cannot find module" or dependency errors

```bash
# Reinstall dependencies
npm install

# Clear cache
rm -rf node_modules package-lock.json
npm install
```

### Issue: Database connection errors

```bash
# Test database connection
mysql -h localhost -u ps_app -p"$DB_PASSWORD" -e "SELECT 1;"

# Check backend env variables
cat backend/.env

# Check MySQL is running
sudo systemctl status mysql
```

### Issue: Services won't start

```bash
# Check service logs
sudo journalctl -u 07ps-backend.service -n 50

# Manually test the command
cd /home/appuser/07ps-sales-dashboard
npm start --prefix backend
```

### Issue: High memory/CPU usage

```bash
# Check process usage
ps aux | grep node
ps aux | grep python3

# Restart problematic service
sudo systemctl restart 07ps-backend.service
```

### Issue: Port already in use

```bash
# Check what's using the port
sudo lsof -i :3000   # Frontend
sudo lsof -i :4000   # Backend

# Kill process if needed
sudo kill -9 <PID>
```

---

## Security Best Practices Checklist

- [ ] Change all default passwords in `.env` files
- [ ] Set restrictive file permissions: `chmod 600` for `.env` files
- [ ] Enable firewall and only allow ports 22 (SSH), 80 (HTTP), 443 (HTTPS)
  ```bash
  sudo ufw enable
  sudo ufw allow 22/tcp
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  ```
- [ ] Set up automated security updates:
  ```bash
  sudo apt install unattended-upgrades
  sudo dpkg-reconfigure unattended-upgrades
  ```
- [ ] Configure fail2ban to prevent brute-force attacks:
  ```bash
  sudo apt install fail2ban
  sudo systemctl enable fail2ban
  ```
- [ ] Enable HTTPS for all domains (via cPanel's AutoSSL)
- [ ] Regularly backup the database (configured in Phase 7)
- [ ] Monitor logs regularly for suspicious activity
- [ ] Keep Node.js and Python dependencies updated regularly

---

## Rollback Procedure (If Deployment Fails)

```bash
# 1. Stop all services
sudo systemctl stop 07ps-frontend.service 07ps-backend.service 07ps-etl-worker.service

# 2. Revert to previous code version
cd /home/appuser/07ps-sales-dashboard
git log --oneline | head -5  # See recent commits
git checkout <previous_commit_hash>

# 3. Rebuild
npm run build

# 4. Check database state (if migrations ran)
# Manually verify no data was corrupted

# 5. Restart services
sudo systemctl start 07ps-backend.service 07ps-frontend.service 07ps-etl-worker.service

# 6. Verify
/home/appuser/check_services.sh
```

---

## Support & Escalation

### Common Questions for Hosting Provider

1. **Can we run Python as a system service via systemd?**
   - Required for: ETL workers, scheduled jobs
   
2. **What are MySQL resource limits?**
   - Needed for: Capacity planning, performance optimization
   
3. **Can we install custom system packages?**
   - Required for: Node.js, Python 3.10+, other dependencies
   
4. **Is there a process limit?**
   - Needed for: Running Frontend + Backend + ETL Worker simultaneously
   
5. **Can we use cron jobs for scheduled tasks?**
   - Required for: Database backups, ETL scheduling
   
6. **What's the total disk space available?**
   - Needed for: Database backups, application code, logs

---

## Deployment Checklist

- [ ] Server requirements verified
- [ ] Dependencies installed (Node.js, Python, MySQL, PM2)
- [ ] Repository cloned to server
- [ ] All .env files created and configured
- [ ] Database created and migrations applied
- [ ] Frontend built successfully
- [ ] Backend built successfully
- [ ] Python virtual environment created
- [ ] SystemD services created and running
- [ ] Reverse proxy configured
- [ ] SSL certificates installed
- [ ] Health checks passing
- [ ] Logs accessible and readable
- [ ] Backup script installed and tested
- [ ] Firewall configured
- [ ] Security settings reviewed

---

## Next Steps

1. **Immediate**: Share this guide with your IT team
2. **This week**: Execute Phases 1-4 in a staging environment first
3. **QA**: Test all functionality on staging before moving to production
4. **Production**: Follow the guide step-by-step, executing one phase per day
5. **Monitoring**: Set up alerts and monitoring after going live

---

**Document Version**: 1.0  
**Last Updated**: July 13, 2026  
**Contact**: Nahla (nahla.burweiss@gmail.com)
