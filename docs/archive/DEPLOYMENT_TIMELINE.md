# 07PS Sales Dashboard - Deployment Timeline & Daily Tasks

## Overview

**Total Duration**: 7-8 hours (can be split across 1-2 days)  
**Recommended Approach**: Staging first (Day 1), then Production (Day 2)  
**Team Skills Needed**: Linux admin, database admin, Node.js developer

---

## Day 0: Pre-Deployment (Before You Start)

### Morning Checklist (1 hour)
- [ ] Verify SSH access to server: `ssh user@server-ip`
- [ ] Confirm sudo access: `sudo whoami`
- [ ] Confirm Node.js needed version: `node --version` (if already installed)
- [ ] Confirm MySQL is running: `mysql -u root -p -e "SELECT VERSION();"`
- [ ] Verify git is installed: `git --version`
- [ ] Confirm cPanel login works
- [ ] Gather all credentials and save securely:
  - SSH connection details
  - MySQL root password
  - cPanel admin access
  - GitHub/GitLab repo access
  - API keys for external services
  - Domain registration access

### DNS Preparation (30 mins)
- [ ] Log into cPanel
- [ ] Create subdomain `api.benmussa-invest.com` if not exists
- [ ] Point both domains to server IP
- [ ] Set TTL to 1 hour (for faster updates during testing)
- [ ] Verify DNS propagation: `nslookup benmussa-invest.com`

### Repository Access (15 mins)
- [ ] Test Git clone access: `git clone <repo-url> /tmp/test`
- [ ] Confirm you can access all branches
- [ ] Know the main/production branch name

---

## Day 1: Staging Deployment (7-8 hours)

### 08:00 - Phase 1: Server Preparation (60 mins)

#### 08:00 - 08:15: Initial Setup
```bash
ssh user@staging-server-ip
whoami  # Verify you're not root
sudo su  # Become root for installation

# Update packages
apt update && apt upgrade -y

# Create application user
useradd -m -s /bin/bash appuser
echo "appuser:temppassword" | chpasswd
```

**Status Check**: ✓ Server logged in, updates in progress

#### 08:15 - 08:35: Install Node.js
```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs npm

# Verify
node --version  # Should be v20+
npm --version   # Should be 10+
```

**Status Check**: ✓ Node.js installed, verify with `node --version`

#### 08:35 - 08:50: Install Python
```bash
apt install -y python3 python3-pip python3-venv

# Verify
python3 --version  # Should be 3.10 or higher
pip3 --version
```

**Status Check**: ✓ Python installed, verify with `python3 --version`

#### 08:50 - 09:00: Install Other Tools
```bash
apt install -y git mysql-client curl wget nano

# Verify git
git --version

# Install PM2 globally
npm install -g pm2
pm2 startup
```

**Status Check**: ✓ All tools installed, ready for code deployment

---

### 09:00 - Phase 2: Application Deployment (45 mins)

#### 09:00 - 09:05: Create App Directory
```bash
su - appuser
cd ~
pwd  # Should be /home/appuser
```

#### 09:05 - 09:25: Clone Repository
```bash
git clone https://github.com/your-org/07ps-sales-dashboard.git
cd 07ps-sales-dashboard
git log --oneline -1  # Verify correct branch

# List what we have
ls -la
```

**Expected Output**:
```
frontend/
backend/
data/
docs/
package.json
...
```

**Status Check**: ✓ Code cloned, correct branch verified

#### 09:25 - 09:45: Install Dependencies
```bash
# From project root
npm install

# This may take 5-10 minutes. Monitor output.
# Watch for any errors or warnings

# Verify workspaces
npm list --depth=0
```

**Expected Output**:
```
07ps-sales-dashboard@0.0.0
├── backend@0.1.0
├── frontend@0.1.0
└── packages/ui@0.0.1
```

**Status Check**: ✓ All npm dependencies installed

#### 09:45 - 09:50: Setup Python Environment
```bash
cd data
python3 -m venv venv
source venv/bin/activate

# Install requirements
pip install -r ingestion/requirements.txt
pip install -r warehouse/requirements.txt

deactivate
cd ..
```

**Status Check**: ✓ Python virtual environment ready

---

### 10:00 - Phase 3: Build Applications (45 mins)

#### 10:00 - 10:20: Build Frontend
```bash
cd frontend
npm run build

# Should output "npm notice" and complete successfully
# Check for "next build" summary

cd ..
```

**Expected Output**:
```
✓ Compiled successfully
✓ Linting and type checking...
Route (app)
...
```

**Status Check**: ✓ Frontend built without errors. Verify `.next/` directory exists.

#### 10:20 - 10:40: Build Backend
```bash
cd backend
npm run build

# Should output TypeScript compilation messages
# Look for "Successfully compiled"

ls -la dist/  # Verify dist directory created
cd ..
```

**Expected Output**:
```
dist/
├── server.js
├── routes/
└── ...
```

**Status Check**: ✓ Backend built. Verify `backend/dist/server.js` exists.

#### 10:40 - 10:45: Verify Both Builds
```bash
# List build outputs
ls -la frontend/.next/
ls -la backend/dist/

echo "Both builds completed successfully!"
```

**Status Check**: ✓ Both frontend and backend ready for production

---

### 11:00 - BREAK (15 mins)
Take a 15-minute break. Grab water, stretch. This is a good pause point if things feel rushed.

---

### 11:15 - Phase 4: Database Setup (45 mins)

#### 11:15 - 11:25: Create Database & User
```bash
# Connect to MySQL as root (you may need sudo)
mysql -u root -p

# Type password when prompted

# Inside MySQL:
CREATE DATABASE ps_warehouse CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'ps_app'@'localhost' IDENTIFIED BY 'your_strong_password_here_min_12_chars';

GRANT ALL PRIVILEGES ON ps_warehouse.* TO 'ps_app'@'localhost';

FLUSH PRIVILEGES;

# Verify
SHOW DATABASES;
SELECT User FROM mysql.user;

EXIT;
```

**Status Check**: ✓ Database created, user created with permissions

#### 11:25 - 11:40: Run Migrations
```bash
# Back to appuser shell
cd data/warehouse

source ../../venv/bin/activate

python3 apply_migrations.py

# This will output migration files being applied
# Wait for it to complete (2-3 minutes)

deactivate
cd ../..
```

**Expected Output**:
```
Applying migration: 001_create_tables.sql
Applying migration: 002_create_indexes.sql
...
All migrations applied successfully!
```

**Status Check**: ✓ Database schema created, tables ready

#### 11:40 - 11:55: Load Sample Data
```bash
cd data/ingestion

source ../../venv/bin/activate

# For staging, use mocked data (faster)
python3 orchestrator.py --run-once

# This will create fake data in the database
# Should complete in 30-60 seconds

deactivate
cd ../..
```

**Expected Output**:
```
Loading mocked data...
Created 100 customers
Created 500 transactions
...
Data loading complete!
```

**Status Check**: ✓ Sample data in database, ready for testing

---

### 12:00 - Phase 5: Configuration & Environment (30 mins)

#### 12:00 - 12:15: Create Backend .env
```bash
# Create backend .env file
cat > backend/.env << 'EOF'
NODE_ENV=production
PORT=4000
API_HOST=0.0.0.0
DB_HOST=localhost
DB_PORT=3306
DB_USER=ps_app
DB_PASSWORD=your_strong_password_here_min_12_chars
DB_NAME=ps_warehouse
JWT_SECRET=your_very_long_random_secret_key_at_least_32_chars_$(openssl rand -base64 32)
JWT_EXPIRY=7d
API_URL=https://api.staging-benmussa-invest.com
FRONTEND_URL=https://staging-benmussa-invest.com
LOG_LEVEL=info
EOF

# Secure permissions
chmod 600 backend/.env

# Verify values are set
cat backend/.env
```

**Status Check**: ✓ Backend .env created with secure permissions

#### 12:15 - 12:30: Create Data .env
```bash
cat > data/ingestion/.env << 'EOF'
DB_HOST=localhost
DB_PORT=3306
DB_USER=ps_app
DB_PASSWORD=your_strong_password_here_min_12_chars
DB_NAME=ps_warehouse
ALLOW_LIVE_ODOO=0
EOF

chmod 600 data/ingestion/.env

# Verify
cat data/ingestion/.env
```

**Status Check**: ✓ Both .env files created and secured

---

### 12:30 - Phase 6a: Manual Service Testing (45 mins)

Before setting up systemd, test that services start manually.

#### 12:30 - 12:40: Test Backend Manually
```bash
# Open new terminal, stay as appuser
cd /home/appuser/07ps-sales-dashboard

# Load environment
export $(cat backend/.env | xargs)

# Start backend
npm start --prefix backend

# Should output something like:
# Server is running on http://localhost:4000
```

**Status Check** (in another terminal):
```bash
curl http://localhost:4000/health
# Should return: {"status":"ok"}
```

⏰ **Keep this running. Open another terminal for the next step.**

#### 12:40 - 12:50: Test Frontend Manually
```bash
# Open another new terminal, stay as appuser
cd /home/appuser/07ps-sales-dashboard

npm start --prefix frontend

# Should output something like:
# Ready in 3.2s
# ▲ Next.js 14.2.5
# - Local: http://localhost:3000
```

**Status Check** (in yet another terminal):
```bash
curl http://localhost:3000
# Should return HTML of the Next.js app
```

⏰ **Keep both services running.**

#### 12:50 - 13:00: Verify Both Services
```bash
# New terminal - test both are accessible
curl -s http://localhost:3000 | head -20  # Check frontend
curl -s http://localhost:4000/health     # Check backend

# Both should return data
# If either fails, check logs in the service terminals
```

**Status Check**: ✓ Both services responding to requests

#### 13:00: STOP SERVICES
```bash
# In both service terminals, press Ctrl+C to stop

# Verify they stopped
curl http://localhost:3000  # Should fail
curl http://localhost:4000  # Should fail
```

**Status Check**: ✓ Services stopped cleanly

---

### 13:00 - LUNCH BREAK (60 mins)
Good work! This is a perfect time to take an hour break. You've completed the core setup and verified everything works.

---

### 14:00 - Phase 6b: SystemD Service Setup (45 mins)

Now we'll configure services to run automatically.

#### 14:00 - 14:15: Create Log Directory
```bash
# Back to appuser
mkdir -p /home/appuser/logs

# Create systemd service files
# We'll do this as root
```

#### 14:15 - 14:25: Create Frontend Service
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

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable 07ps-frontend.service
sudo systemctl start 07ps-frontend.service

# Check status
sudo systemctl status 07ps-frontend.service
```

**Expected Output**:
```
● 07ps-frontend.service - 07PS Sales Dashboard Frontend
   Loaded: loaded (/etc/systemd/system/07ps-frontend.service; enabled; vendor preset: enabled)
   Active: active (running)
```

**Status Check**: ✓ Frontend service running

#### 14:25 - 14:35: Create Backend Service
```bash
sudo tee /etc/systemd/system/07ps-backend.service > /dev/null << 'EOF'
[Unit]
Description=07PS Sales Dashboard Backend API
After=network.target

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

sudo systemctl daemon-reload
sudo systemctl enable 07ps-backend.service
sudo systemctl start 07ps-backend.service
sudo systemctl status 07ps-backend.service
```

**Status Check**: ✓ Backend service running

#### 14:35 - 14:45: Create Python ETL Worker Service
```bash
sudo tee /etc/systemd/system/07ps-etl-worker.service > /dev/null << 'EOF'
[Unit]
Description=07PS ETL Worker Service
After=network.target

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

sudo systemctl daemon-reload
sudo systemctl enable 07ps-etl-worker.service
sudo systemctl start 07ps-etl-worker.service
sudo systemctl status 07ps-etl-worker.service
```

**Status Check**: ✓ All three services running

#### 14:45: Verify All Services Running
```bash
# Check all three
sudo systemctl status 07ps-frontend.service 07ps-backend.service 07ps-etl-worker.service

# All should show "Active: active (running)"

# Alternative: use journalctl to see logs
sudo journalctl -u 07ps-backend.service -n 20
```

**Status Check**: ✓ All services active and running

---

### 15:00 - Phase 7: Reverse Proxy Setup (45 mins)

#### 15:00 - 15:20: Install Nginx
```bash
# As root or with sudo
sudo apt install -y nginx

# Verify
sudo systemctl start nginx
sudo systemctl status nginx
sudo systemctl enable nginx

# Check it's responding
curl http://localhost:80
# Should return HTML
```

**Status Check**: ✓ Nginx installed and running

#### 15:20 - 15:35: Configure Reverse Proxy
```bash
# Create frontend proxy config
sudo tee /etc/nginx/sites-available/staging-frontend > /dev/null << 'EOF'
upstream frontend {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name staging-benmussa-invest.com;
    
    location / {
        proxy_pass http://frontend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

# Enable site
sudo ln -s /etc/nginx/sites-available/staging-frontend /etc/nginx/sites-enabled/
```

#### 15:35 - 15:45: Configure Backend Proxy
```bash
sudo tee /etc/nginx/sites-available/api-staging > /dev/null << 'EOF'
upstream backend {
    server 127.0.0.1:4000;
}

server {
    listen 80;
    server_name api.staging-benmussa-invest.com;
    
    location / {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

# Enable site
sudo ln -s /etc/nginx/sites-available/api-staging /etc/nginx/sites-enabled/

# Test Nginx config
sudo nginx -t

# Reload
sudo systemctl reload nginx
```

**Expected Output**:
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

**Status Check**: ✓ Nginx reverse proxy configured

---

### 16:00 - Phase 8: Testing & Verification (45 mins)

#### 16:00 - 16:15: Service Health Check
```bash
# Check all services are running
sudo systemctl status 07ps-frontend.service 07ps-backend.service 07ps-etl-worker.service

# All should show: Active: active (running)

# Test database connection
mysql -h localhost -u ps_app -p ps_warehouse -e "SELECT COUNT(*) FROM customers;"

# Should return a number (from test data)
```

**Status Check**: ✓ All services healthy

#### 16:15 - 16:30: Test Endpoints
```bash
# Test Frontend (through reverse proxy)
curl -H "Host: staging-benmussa-invest.com" http://localhost
# Should return HTML

# Test Backend API (through reverse proxy)  
curl -H "Host: api.staging-benmussa-invest.com" http://localhost/health
# Should return {"status":"ok"}

# Test direct backend
curl http://localhost:4000/health
curl http://localhost:3000
```

**Status Check**: ✓ All endpoints responding

#### 16:30 - 16:45: View Logs
```bash
# Check frontend logs
sudo journalctl -u 07ps-frontend.service -n 30

# Check backend logs
sudo journalctl -u 07ps-backend.service -n 30

# Check if there are any errors
# Errors would look like: ERROR, error, failed, Failed

# Should see: app started, listening on port, etc.
```

**Status Check**: ✓ Logs clean, no errors

#### 16:45: Test via Browser (if accessible)
```bash
# If staging server is internet-accessible:
# Visit: http://staging-benmussa-invest.com
# Check: http://api.staging-benmussa-invest.com/health

# Should see:
# - Frontend loads
# - No 502/503 errors
# - API returns JSON
```

**Status Check**: ✓ Frontend and API accessible

---

### 17:00 - Phase 9: Deployment Checklist (30 mins)

#### Staging Deployment Verification:
```bash
# Run this checklist:
echo "=== STAGING DEPLOYMENT VERIFICATION ==="

echo "✓ Server:"
node --version
python3 --version
mysql --version

echo "✓ Services running:"
sudo systemctl is-active 07ps-frontend.service
sudo systemctl is-active 07ps-backend.service  
sudo systemctl is-active 07ps-etl-worker.service

echo "✓ Database:"
mysql -h localhost -u ps_app -p ps_warehouse -e "SELECT COUNT(*) FROM customers;"

echo "✓ Services auto-start:"
sudo systemctl is-enabled 07ps-frontend.service
sudo systemctl is-enabled 07ps-backend.service
sudo systemctl is-enabled 07ps-etl-worker.service

echo "✓ Endpoints:"
curl -s http://localhost:3000 | head -5
curl -s http://localhost:4000/health

echo "=== ALL CHECKS PASSED ==="
```

**Status Check**: ✓ Staging deployment complete and verified

---

### 17:30 - End of Day 1

**Staging Summary**:
- ✅ All software installed
- ✅ Code deployed and built
- ✅ Database created and populated
- ✅ Services running and auto-starting
- ✅ Reverse proxy configured
- ✅ All endpoints tested and working
- ✅ Logs verified clean

**Ready for**: Production deployment (Day 2)

---

## Day 2: Production Deployment (7-8 hours)

Follow **exactly the same steps as Day 1**, but:

1. **Server**: Point to production server instead of staging
2. **Domains**: Use `benmussa-invest.com` and `api.benmussa-invest.com` (not staging-*)
3. **Data**: Use real historical data instead of mocked data (Phase 3, step 11:40)
4. **.env files**: Point to production databases and set `NODE_ENV=production`
5. **Testing**: More thorough testing before declaring complete

### Key Differences for Production:

#### Phase 3 - Load Real Data (instead of mocked)
```bash
cd data/ingestion
source ../../venv/bin/activate

# Only if you have SalesModel_OneOutput.xlsx:
python3 load_real_export.py "/path/to/SalesModel_OneOutput.xlsx"

# If not, use mocked data as backup
python3 orchestrator.py --run-once

deactivate
```

#### Phase 4 - Production .env Settings
```bash
# Backend .env should have:
NODE_ENV=production  # NOT development
JWT_EXPIRY=7d
ALLOW_LIVE_ODOO=0    # Start with false, enable after Odoo is ready

# Log level for production
LOG_LEVEL=info       # More restricted than debug
```

#### Additional: Enable SSL/HTTPS
```bash
# Use Let's Encrypt with Certbot
sudo apt install -y certbot python3-certbot-nginx

# Get certificates
sudo certbot --nginx -d benmussa-invest.com -d www.benmussa-invest.com
sudo certbot --nginx -d api.benmussa-invest.com

# Certbot will auto-update Nginx config to use HTTPS
sudo systemctl reload nginx
```

#### Additional: Setup Backups
```bash
# Create backup script
cat > /home/appuser/backup_database.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/home/appuser/backups"
mkdir -p $BACKUP_DIR
mysqldump -h localhost -u ps_app -p"your_password" ps_warehouse | gzip > $BACKUP_DIR/ps_warehouse_$(date +%Y%m%d_%H%M%S).sql.gz
echo "Backup completed: $BACKUP_DIR/ps_warehouse_$(date +%Y%m%d_%H%M%S).sql.gz"
EOF

chmod +x /home/appuser/backup_database.sh

# Test it
/home/appuser/backup_database.sh

# Add to crontab
crontab -e
# Add: 0 3 * * * /home/appuser/backup_database.sh
```

---

## Critical Times & Milestones

| Time | Milestone | Status |
|------|-----------|--------|
| 08:00 | Server access verified | Go/No-Go |
| 09:00 | Dependencies installed | Go/No-Go |
| 10:00 | Code deployed | Go/No-Go |
| 10:45 | Applications built | Go/No-Go |
| 11:15 | Database ready | Go/No-Go |
| 12:00 | Configuration complete | Go/No-Go |
| 13:00 | Manual testing successful | Go/No-Go |
| 14:00 | SystemD services running | Go/No-Go |
| 15:00 | Reverse proxy active | Go/No-Go |
| 16:00 | All endpoints tested | Go/No-Go |
| 17:00 | **DEPLOYMENT COMPLETE** | ✅ |

---

## Rollback Plan

If anything goes wrong, you can roll back with:

```bash
# 1. Stop services
sudo systemctl stop 07ps-frontend.service 07ps-backend.service 07ps-etl-worker.service

# 2. Restore previous code
cd /home/appuser/07ps-sales-dashboard
git log --oneline | head -10
git checkout <hash_of_previous_working_version>

# 3. Rebuild
npm run build

# 4. Restart
sudo systemctl start 07ps-backend.service 07ps-frontend.service

# 5. Verify
sudo systemctl status 07ps-backend.service 07ps-frontend.service
curl http://localhost:4000/health
```

---

## Success Criteria

Deployment is successful when:

- [ ] All 3 systemd services show "Active: active (running)"
- [ ] Nginx is running and proxying correctly
- [ ] Frontend loads without errors at domain
- [ ] Backend API responds at /health endpoint
- [ ] Database has data and queries work
- [ ] No errors in systemd logs (`journalctl`)
- [ ] Services auto-start after system reboot
- [ ] SSL/HTTPS working (production only)
- [ ] Backups run successfully (production only)

---

**Document Created**: July 13, 2026  
**Version**: 1.0  
**Contact**: Nahla (nahla.burweiss@gmail.com)
