# Libyan Spider Shared Hosting Deployment Guide

**07 Ps Sales Dashboard - Complete Production Deployment**

Version: 1.0 | Last Updated: July 2026 | Status: Production Ready

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Technology Stack](#technology-stack)
3. [Architecture Overview](#architecture-overview)
4. [Prerequisites & Requirements](#prerequisites--requirements)
5. [Pre-Deployment Checklist](#pre-deployment-checklist)
6. [Step 1: Environment Preparation](#step-1-environment-preparation)
7. [Step 2: Database Setup](#step-2-database-setup)
8. [Step 3: DNS Configuration](#step-3-dns-configuration)
9. [Step 4: Repository Clone & Configuration](#step-4-repository-clone--configuration)
10. [Step 5: Build & Deployment](#step-5-build--deployment)
11. [Step 6: Nginx & SSL/TLS Setup](#step-6-nginx--ssltls-setup)
12. [Step 7: Post-Deployment Verification](#step-7-post-deployment-verification)
13. [Step 8: Monitoring & Maintenance](#step-8-monitoring--maintenance)
14. [Troubleshooting](#troubleshooting)
15. [Rollback Procedures](#rollback-procedures)

---

## Project Overview

**Application Name:** 07 Ps Sales Dashboard  
**Purpose:** Real-time sales, promotion, and performance analytics for Ben Moussa Holding Group  
**Companies:** Majaal (Ceramics Manufacturing) & Tika (Chemical Solutions)  
**Hosting Target:** Libyan Spider VPS with Docker support  

### Key Features
- Multi-company dashboard (Majaal, Tika, BMH)
- Role-based data scoping (Row-Level Security)
- ETL pipeline (5x daily incremental + nightly full refresh)
- Real-time KPI tracking
- Excel import capability
- Responsive design (Desktop, Tablet, Mobile)

---

## Technology Stack

### Frontend
- **Framework:** Next.js 14.2.5
- **UI Library:** React 18.3
- **Styling:** Tailwind CSS 3.4.7
- **Components:** Custom UI Package (@07ps/ui)
- **Build Tool:** Node.js 20+

### Backend API
- **Runtime:** Node.js 20+
- **Framework:** Express.js 4.19
- **Language:** TypeScript 5.5
- **Authentication:** JWT + bcryptjs
- **Job Queue:** BullMQ + Redis
- **Database Driver:** mysql2 3.11
- **Email:** Nodemailer 6.9
- **Logging:** Winston 3.17

### Data Layer
- **Database:** MySQL 8 (external, NOT containerized)
- **ETL Language:** Python 3.11
- **ETL Framework:** Flask 3.0
- **Job Scheduler:** APScheduler 3.10
- **Data Processing:** pandas 2.2, openpyxl 3.1
- **ORM/SQL:** pymysql 1.1

### Infrastructure
- **Container Engine:** Docker 24.0+
- **Orchestration:** Docker Compose 3.9+
- **Reverse Proxy:** Nginx (systemd-managed, NOT containerized)
- **SSL/TLS:** Let's Encrypt + Certbot
- **Cache:** Redis 7 (Alpine)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Libyan Spider VPS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Nginx (Systemd) - TLS Termination & Routing             │  │
│  │  • benmussa-invest.com → Frontend:3000                  │  │
│  │  • api.benmussa-invest.com → Backend:4000              │  │
│  │  • etl-api.benmussa-invest.com → ETL API:5001 (opt)   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                            ↓                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Docker Compose Stack                                     │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │                                                           │  │
│  │  Frontend Container        Backend Container            │  │
│  │  ┌──────────────────┐      ┌──────────────────┐        │  │
│  │  │ Next.js :3000    │      │ Express :4000    │        │  │
│  │  │ PORT=3000        │      │ PORT=4000        │        │  │
│  │  │ Auto-scaled      │      │ Node Process     │        │  │
│  │  └──────────────────┘      └──────────────────┘        │  │
│  │                                   ↓                     │  │
│  │  ETL-API Container         ETL-Worker Container        │  │
│  │  ┌──────────────────┐      ┌──────────────────┐        │  │
│  │  │ Flask :5001      │      │ Node.js (BullMQ) │        │  │
│  │  │ Python 3.11      │      │ Consumes Queue   │        │  │
│  │  │ /etl/run         │      │ Spawns Pipeline  │        │  │
│  │  └──────────────────┘      └──────────────────┘        │  │
│  │          ↑                         ↑                    │  │
│  │          └────────────────┬────────┘                    │  │
│  │                           ↓                             │  │
│  │        ┌──────────────────────────────┐                │  │
│  │        │  Redis :6379 (Cache/Queue)   │                │  │
│  │        │  - Job persistence           │                │  │
│  │        │  - Session store             │                │  │
│  │        └──────────────────────────────┘                │  │
│  │                           ↓ (via TCP)                   │  │
│  │        ┌──────────────────────────────┐                │  │
│  │        │ Ingestion Container (Python) │                │  │
│  │        │ - Standalone ETL runner      │                │  │
│  │        │ - Excel file processing      │                │  │
│  │        └──────────────────────────────┘                │  │
│  └──────────────────────────────────────────────────────────┘  │
│                            ↓ (via TCP/IP)                      │
├─────────────────────────────────────────────────────────────────┤
│              External: MySQL 8 Database Server                  │
│         (Existing instance - managed separately)                │
│                                                                 │
│  • Database: ps_warehouse                                       │
│  • Tables: Star schema (Fact/Dimension)                         │
│  • Row-Level Security: Policy-based filtering                   │
│  • Size: Approx 50GB (Tika/Majaal combined)                     │
│  • Backup: Daily 2am UTC, retained 30 days                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Odoo ERP (Live)  Excel Files        Manual Logs
       ↓               ↓                 ↓
       └─────────┬─────────┬─────────────┘
                 ↓
       ┌─────────────────────────┐
       │  ETL Pipeline (Python)  │  (runs on schedule OR on-demand)
       │  • Odoo API connector   │
       │  • Excel loader         │
       │  • Data validation      │
       │  • Transformation       │
       │  • Star schema mapping  │
       └────────────┬────────────┘
                    ↓
         ┌──────────────────────┐
         │   MySQL 8 Database   │  (ps_warehouse)
         │   - Fact tables      │
         │   - Dimension tables │
         │   - RLS policies     │
         └─────────┬────────────┘
                   ↓
      ┌────────────────────────────┐
      │  Backend API (Node.js)     │
      │  - Authentication (JWT)    │
      │  - Filter endpoints        │
      │  - RLS session scoping     │
      │  - Metadata refresh        │
      └─────────────┬──────────────┘
                    ↓
      ┌────────────────────────────┐
      │  Frontend (Next.js)        │
      │  - Dashboard pages         │
      │  - Real-time charts        │
      │  - Role-based UI           │
      └────────────────────────────┘
            ↓           ↓
        Browser      Mobile App
```

---

## Prerequisites & Requirements

### VPS Specifications (Minimum Recommended)

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| **CPU** | 2 vCPU | 4 vCPU | Multi-core for parallel ETL |
| **RAM** | 4 GB | 8 GB | Docker containers + node processes |
| **Storage** | 50 GB SSD | 100 GB SSD | OS + container images + Redis logs |
| **Bandwidth** | 1 Mbps | 5 Mbps | Dashboard users + Odoo API calls |
| **OS** | Ubuntu 22.04+ | Ubuntu 24.04 LTS | Tested and supported |
| **Network** | Public IP | Static Public IP | Required for TLS/DNS |
| **Root Access** | Required | Required | Docker/Nginx installation |

### Software Prerequisites

```bash
# On the Libyan Spider VPS, you must have:

✓ Ubuntu 22.04+ (or compatible Linux distro)
✓ Docker Engine 24.0+ (with rootless mode optional)
✓ Docker Compose 2.0+ (included with Desktop, separate install for server)
✓ Nginx 1.24+ (from Ubuntu repos, systemd-managed)
✓ Certbot 1.32+ (Let's Encrypt client)
✓ Git 2.34+ (for repository cloning)
✓ curl & wget (for health checks)
✓ openssl (for generating keys)
```

### External Services & Credentials

You must have or provision these BEFORE deployment:

1. **MySQL 8 Database Server**
   - Hostname/IP reachable from VPS
   - Port 3306 (or custom) accessible
   - Root or privileged account for schema creation
   - At least 50 GB free space
   - Daily backup configured (outside scope of this guide)

2. **Domain Name**
   - Full control of DNS records (A, AAAA, CNAME, etc.)
   - Registrar: Any (we'll use Let's Encrypt for TLS)
   - Example: `benmussa-invest.com`

3. **Odoo ERP Instance** (for ETL)
   - Live Odoo environment with sales/production data
   - API access enabled
   - Credentials: URL, database name, username, API key

4. **Email (SMTP) "NOT NOW  FOR FETURE"**
   - SMTP server for password reset emails
   - Provider: Gmail, SendGrid, your corporate mail, etc.
   - Credentials: Host, port, username, password

5. **S3 or Local Storage** (Optional)
   - For file backups, logs archival
   - Not required for Phase 1

### Network & Firewall Rules

On the Libyan Spider VPS, ensure these ports are open **publicly**:

```
Port 80/tcp   → Nginx (HTTP, for Let's Encrypt challenge & redirect)
Port 443/tcp  → Nginx (HTTPS, production traffic)
Port 22/tcp   → SSH (restrict to your office IP if possible)
```

These ports are **private** (Docker internal):

```
Port 3000  → Frontend (only Nginx accesses this)
Port 4000  → Backend API (only Nginx accesses this)
Port 5001  → ETL API (only etl-worker & backend access this)
Port 6379  → Redis (only Docker containers access this)
Port 3306  → MySQL (external; VPS initiates outbound only)
```

### Required Credentials Checklist

**Before starting deployment, gather:**

```
☐ MySQL root username & password
☐ MySQL ps_warehouse DB name (or will create)
☐ Odoo URL (https://majaal.odoo.com)
☐ Odoo database name "odoo-ps-majaal-main-3380005"
☐ Odoo username (nahla.burweiss@bmh.com.ly)
☐ Odoo API key (see data/etl/.env -- never paste the real value into a doc)
☐ Domain name (e.g., benmussa-invest.com)
☐ SMTP host (e.g., smtp.gmail.com) (NOT NOW)
☐ SMTP port (usually 587 or 465) (NOT NOW)
☐ SMTP username (usually email address) (NOT NOW)
☐ SMTP password (app password for Gmail) (NOT NOW)
☐ Sender email address (e.g., noreply@benmussa-invest.com) (NOT NOW)
☐ VPS root SSH key or password
☐ VPS public IP address
```

---

## Pre-Deployment Checklist

### 1. Local Validation

Before touching the VPS:

```bash
# On your local machine, verify the repo is clean & buildable
git status                          # no uncommitted changes
git log --oneline -5                # recent history looks good
npm run build --workspace backend   # TypeScript compiles
npm run build --workspace frontend  # Next.js builds without error
npm run lint --workspace backend    # Linting passes
```

### 2. MySQL Database Validation

```bash
# Connect to your MySQL server (from your local machine if accessible, or from VPS)
mysql -h <DB_HOST> -u root -p

# Once inside MySQL:
SHOW DATABASES;                     # confirm ps_warehouse exists or you have CREATE DB permission
SHOW GRANTS FOR 'ps_app'@'%';       # if ps_app user exists, check its privileges
```

If `ps_warehouse` doesn't exist, that's OK - the migration scripts will create it.

### 3. Domain & DNS Validation

```bash
# From your local machine, confirm DNS resolves to the VPS IP
nslookup benmussa-invest.com
dig benmussa-invest.com             # check A record points to VPS IP

# Expected output:
# benmussa-invest.com. 3600 IN A <VPS_PUBLIC_IP>
```

### 4. VPS SSH Access Test

```bash
# From your local machine, test SSH connectivity
ssh -i /path/to/key.pem root@<VPS_IP>
# Or: ssh root@<VPS_IP>  (if password auth)

# Once connected, verify:
uname -a                            # OS version
lsb_release -a                      # Ubuntu version confirmation
free -h                             # available RAM
df -h                               # disk space
```

### 5. Credential File Preparation

On your **local machine**, create a secure file with all credentials:

```bash
# Create a file (DO NOT commit to git, keep local only)
cat > deployment-credentials.txt << 'EOF'
# MySQL Credentials
DB_HOST=<actual-db-host>
DB_PORT=3306
DB_USER=ps_app
DB_PASSWORD=<generate-strong-password>
DB_NAME=ps_warehouse

# JWT Secret (generate with: openssl rand -base64 32)
JWT_SECRET=<output-of-openssl-command>

# Odoo Credentials
ODOO_URL=https://odoo.example.internal
ODOO_DB=bmh_production
ODOO_USERNAME=<username>
ODOO_API_KEY=<api-key>

# SMTP Credentials
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@benmussa-invest.com
SMTP_PASSWORD=<app-password>
SMTP_FROM="BMH Sales Dashboard <noreply@benmussa-invest.com>"

# ETL API Key (generate with: openssl rand -base64 32)
ETL_API_KEY=<output-of-openssl-command>

# Frontend Origin (for CORS)
FRONTEND_ORIGIN=https://benmussa-invest.com
NEXT_PUBLIC_API_BASE_URL=https://api.benmussa-invest.com

# Domain & Hosting
DOMAIN=benmussa-invest.com
VPS_IP=<actual-vps-public-ip>
VPS_SSH_KEY=/path/to/key.pem  (or use password)
EOF

# Secure this file
chmod 600 deployment-credentials.txt
# Keep it in a password manager; delete after deployment is complete
```

---

## Step 1: Environment Preparation

### 1.1 SSH into the VPS

```bash
# From your local machine:
ssh -i /path/to/key.pem root@<VPS_IP>
# Or just: ssh root@<VPS_IP>  (if using password)

# Once inside VPS terminal, verify you're logged in:
whoami                          # should output "root"
pwd                             # should output "/root"
```

### 1.2 Update System Packages

```bash
# Update package manager cache
apt-get update

# Upgrade all packages to latest patches
apt-get upgrade -y

# Install required system utilities
apt-get install -y \
  git \
  curl \
  wget \
  openssl \
  make \
  build-essential \
  ca-certificates
```

### 1.3 Install Docker Engine

```bash
# Remove any old Docker installations
apt-get remove -y docker docker.io containerd runc 2>/dev/null || true

# Add Docker's official repository
apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo \
  "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine & Docker Compose
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Start Docker daemon
systemctl start docker
systemctl enable docker

# Verify installation
docker --version               # e.g., Docker version 24.0.6
docker compose version         # e.g., Docker Compose version 2.20.2
```

### 1.4 Install Nginx & Certbot

```bash
# Install Nginx and Certbot
apt-get install -y nginx certbot python3-certbot-nginx

# Start Nginx (will be managed via systemd, not Docker)
systemctl start nginx
systemctl enable nginx

# Verify Nginx is running
systemctl status nginx
nginx -v                       # e.g., nginx/1.24.0
```

### 1.5 Create Application Directory

```bash
# Create a dedicated directory for the app
mkdir -p /opt/07ps-dashboard
cd /opt/07ps-dashboard

# Verify permissions
ls -ld /opt/07ps-dashboard     # should be owned by root

# Create subdirectories for logs, backups
mkdir -p ./logs/etl ./backups ./data
chmod 755 ./logs ./backups ./data
```

### 1.6 Verify System Resources

```bash
# Check CPU cores
nproc                          # e.g., 4

# Check RAM
free -h                        # e.g., total 7.8G, available 6.2G

# Check disk space
df -h | grep -E "/$|/opt"      # should show 50+ GB free

# These checks confirm we have minimum resources
```

---

## Step 2: Database Setup

### 2.1 Create MySQL Database & User

**This assumes an external MySQL 8 server already exists.** Connect from the VPS:

```bash
# From the VPS, connect to MySQL server
mysql -h <DB_HOST> -P <DB_PORT> -u root -p

# Enter root password when prompted
```

### 2.2 Execute Database Initialization SQL

Once connected to MySQL:

```sql
-- Create the warehouse database
CREATE DATABASE IF NOT EXISTS ps_warehouse 
  CHARACTER SET utf8mb4 
  COLLATE utf8mb4_unicode_ci;

-- Create the application user
CREATE USER IF NOT EXISTS 'ps_app'@'%' IDENTIFIED BY '<DB_PASSWORD>';

-- Grant privileges on the warehouse
GRANT ALL PRIVILEGES ON ps_warehouse.* TO 'ps_app'@'%';

-- Grant additional privileges for migrations & backups
GRANT CREATE, ALTER, INDEX ON ps_warehouse.* TO 'ps_app'@'%';
GRANT SHOW VIEW ON ps_warehouse.* TO 'ps_app'@'%';

-- Flush privileges
FLUSH PRIVILEGES;

-- Verify the user was created
SELECT user, host FROM mysql.user WHERE user='ps_app';

-- Exit MySQL
EXIT;
```

### 2.3 Test Connectivity from VPS

```bash
# Test that VPS can reach MySQL
mysql -h <DB_HOST> -P <DB_PORT> -u ps_app -p<DB_PASSWORD> ps_warehouse -e "SELECT 1;"

# Expected output: Should not error and show: "1" in a table
```

### 2.4 Run Database Migrations

**Note:** The application's migrations are embedded in the Node backend and Python ETL. They will auto-run on first startup. But you can pre-run them if you want:

```bash
# This will be done later inside Docker after pulling the repo
# For now, just confirm MySQL is accessible from VPS
```

---

## Step 3: DNS Configuration

### 3.1 Update DNS Records

In your domain registrar (e.g., Route53, Namecheap, GoDaddy, etc.), add these A records:

| Subdomain | Type | Value | TTL |
|-----------|------|-------|-----|
| `benmussa-invest.com` | A | `<VPS_PUBLIC_IP>` | 300 |
| `www.benmussa-invest.com` | A | `<VPS_PUBLIC_IP>` | 300 |
| `api.benmussa-invest.com` | A | `<VPS_PUBLIC_IP>` | 300 |
| `etl-api.benmussa-invest.com` | A | `<VPS_PUBLIC_IP>` | 300 (optional) |

**Replace `<VPS_PUBLIC_IP>` with the actual IP address of your Libyan Spider VPS.**

### 3.2 Validate DNS Resolution

```bash
# From the VPS, verify DNS resolves
nslookup benmussa-invest.com
nslookup api.benmussa-invest.com

# Expected output: Should show the VPS IP address
# Example:
# Name:      benmussa-invest.com
# Address:   <VPS_PUBLIC_IP>
```

**Wait 5-10 minutes** for DNS to propagate globally before proceeding to TLS setup.

---

## Step 4: Repository Clone & Configuration

### 4.1 Clone the Repository

```bash
# From /opt/07ps-dashboard on the VPS:
cd /opt/07ps-dashboard

# Clone the repo (use https if no SSH key on VPS yet, or SSH if configured)
git clone https://github.com/<your-org>/07ps-sales-dashboard-app.git .
# Or: git clone git@github.com:<your-org>/07ps-sales-dashboard-app.git .

# Verify the clone
ls -la                         # should show .git, docker-compose.yml, backend/, frontend/, etc.
git log --oneline -1           # should show the latest commit
```

### 4.2 Create Backend Environment File

```bash
# Copy the template
cp backend/.env.example backend/.env

# Edit with your values
nano backend/.env
# (Or use your preferred editor: vim, vi, etc.)
```

**Contents of `backend/.env` with real values:**

```env
# Database (MySQL 8)
DB_HOST=<actual-db-host>
DB_PORT=3306
DB_USER=ps_app
DB_PASSWORD=<strong-password-from-step-2>
DB_NAME=ps_warehouse
DB_SOCKET=                          # leave empty for TCP

# API Configuration
PORT=4000
JWT_SECRET=<output-from-openssl-rand-base64-32>
FRONTEND_ORIGIN=https://benmussa-invest.com
NODE_ENV=production

# SMTP for Password Resets
SMTP_HOST=smtp.gmail.com            # or your SMTP provider
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@benmussa-invest.com
SMTP_PASSWORD=<app-password>
SMTP_FROM="BMH Sales Dashboard <noreply@benmussa-invest.com>"

# Rate Limiting & Security
RATE_LIMIT_LOGIN_MAX=10
RATE_LIMIT_LOGIN_WINDOW_MIN=15
ACCOUNT_LOCK_THRESHOLD=5
PASSWORD_RESET_TOKEN_TTL_MIN=60

# ETL Integration
ETL_API_URL=http://etl-api:5001     # Docker network DNS
ETL_API_KEY=<same-as-ETL_API_KEY-below>
ETL_API_POLL_INTERVAL_MS=1000
ETL_LOG_DIR=./logs/etl
ETL_SCHEDULE_INCREMENTAL_CRON=50 8,11,14,17,20 * * *
ETL_SCHEDULE_INCREMENTAL_ENABLED=true
ETL_SCHEDULE_FULL_CRON=0 2 * * *
ETL_SCHEDULE_FULL_ENABLED=true

# Redis (Job Queue)
REDIS_HOST=redis                    # Docker service name (not localhost)
REDIS_PORT=6379
```

Save and exit (Ctrl+X, then Y, then Enter if using nano).

### 4.3 Create Frontend Environment File

```bash
# Copy the template
cp frontend/.env.example frontend/.env.local

# Edit
nano frontend/.env.local
```

**Contents:**

```env
NEXT_PUBLIC_API_BASE_URL=https://api.benmussa-invest.com
```

### 4.4 Create ETL API Environment File

```bash
# Copy the template
cp data/etl/.env.example data/etl/.env

# Edit
nano data/etl/.env
```

**Contents:**

```env
# Database (same as backend)
DB_HOST=<actual-db-host>
DB_PORT=3306
DB_USER=ps_app
DB_PASSWORD=<strong-password>
DB_NAME=ps_warehouse
DB_SOCKET=

# Odoo ERP Connection
ALLOW_LIVE_ODOO=1                   # Enable live Odoo (set to 0 for mock/testing)
ODOO_URL=https://odoo.example.internal
ODOO_DB=bmh_production
ODOO_USERNAME=<odoo-username>
ODOO_API_KEY=<odoo-api-key>

# Input Files (Excel workbooks)
INPUT_DIR=/path/to/Input            # This will be a Docker volume, e.g., /app/data/Input

# ETL API Configuration
PORT=5001
ETL_API_KEY=<same-value-as-backend>
LOG_LEVEL=INFO
```

### 4.5 Create Data Ingestion Environment File

```bash
# Copy the template
cp data/ingestion/.env.example data/ingestion/.env

# Edit
nano data/ingestion/.env
```

**Contents:**

```env
# Database
DB_HOST=<actual-db-host>
DB_PORT=3306
DB_USER=root
DB_PASSWORD=<root-password>
DB_NAME=ps_warehouse
DB_SOCKET=

# Odoo (optional for this service)
ALLOW_LIVE_ODOO=0                   # Can mock, or set to 1 if needed

# Input Excel Files
INPUT_DIR=/app/data/Input           # Docker volume mount

# Flask API
PORT=5000
LOG_LEVEL=INFO
```

### 4.6 Update docker-compose.yml

The `docker-compose.yml` already has `NEXT_PUBLIC_API_BASE_URL` set to `https://api.benmussa-invest.com`. If your domain differs, update it:

```bash
# Edit docker-compose.yml
nano docker-compose.yml

# Find this line (around line 81):
#     NEXT_PUBLIC_API_BASE_URL: ${NEXT_PUBLIC_API_BASE_URL:-https://api.benmussa-invest.com}

# Replace with your actual domain
```

Or set the environment variable before building:

```bash
export NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com
```

### 4.7 Backup Input Excel Files (Optional)

If you have sample Excel files (SalesTeam.xlsx, sales_targets.xlsx, etc.), prepare them:

```bash
# Create input directory inside the project
mkdir -p ./data/input

# Copy your Excel files here (or they'll be provided during runtime)
# cp /path/to/SalesTeam.xlsx ./data/input/
# cp /path/to/sales_targets.xlsx ./data/input/
```

---

## Step 5: Build & Deployment

### 5.1 Verify Configuration Files

```bash
# From /opt/07ps-dashboard, verify all .env files exist and are readable
test -f backend/.env && echo "✓ backend/.env OK"
test -f frontend/.env.local && echo "✓ frontend/.env.local OK"
test -f data/etl/.env && echo "✓ data/etl/.env OK"
test -f data/ingestion/.env && echo "✓ data/ingestion/.env OK"

# Verify no sensitive data is in git
git status | grep -E "\.env$" && echo "⚠️ WARNING: .env files in git!"
```

### 5.2 Build Docker Images

This step compiles the frontend, backend, and ETL API into Docker images. **This can take 10-20 minutes.**

```bash
# From /opt/07ps-dashboard:
docker compose build

# This will:
# 1. Build backend image (Node.js + dependencies, TypeScript compilation)
# 2. Build frontend image (Next.js build, static export)
# 3. Build etl-api image (Python 3.11 + Flask + dependencies)
# 4. Build etl-worker image (Node.js + BullMQ)
# 5. Build ingestion image (Python 3.11 + pandas, openpyxl)
# 6. Pull Redis 7 image from Docker Hub

# Monitor build progress:
docker images | grep 07ps  # should show newly built images
```

### 5.3 Start the Docker Compose Stack

```bash
# Start all containers in background mode
docker compose up -d

# Wait 30 seconds for containers to initialize
sleep 30

# Check status
docker compose ps

# Expected output (all "healthy" or "running"):
# NAME              COMMAND              SERVICE         STATUS
# 07ps-redis-1      redis-server         redis           Up 2m (healthy)
# 07ps-etl-api-1    gunicorn app:app     etl-api         Up 2m (healthy)
# 07ps-backend-1    npm start            backend         Up 1m (healthy)
# 07ps-frontend-1   npm start            frontend        Up 50s (healthy)
# 07ps-etl-worker-1 npm run etl:worker   etl-worker      Up 45s
# 07ps-ingestion-1  python scheduler.py  ingestion       Up 1m
```

### 5.4 Monitor Initial Startup

```bash
# Watch logs in real-time (Ctrl+C to stop watching, containers keep running)
docker compose logs -f

# Specific service logs:
docker compose logs -f backend       # Node API startup
docker compose logs -f etl-api       # Python Flask startup
docker compose logs -f frontend      # Next.js build & startup
```

**Expected log messages:**

```
backend_1    | [2026-07-16T09:15:30.123Z] Server running on port 4000
frontend_1   | ▲ Next.js 14.2.5
frontend_1   | - Local:        http://localhost:3000
etl-api_1    | [2026-07-16 09:15:35] * Running on http://0.0.0.0:5001
redis_1      | * Ready to accept connections
```

### 5.5 Verify Database Migrations

```bash
# The backend auto-runs migrations on startup. Check if tables were created:
mysql -h <DB_HOST> -u ps_app -p<DB_PASSWORD> ps_warehouse -e "SHOW TABLES;"

# Expected output (some or all):
# Tables_in_ps_warehouse
# customers
# date_dim
# employees
# products
# sales_fact
# (etc.)
```

If no tables appear, check backend logs for errors:

```bash
docker compose logs backend | grep -i "migrat\|error\|failed"
```

---

## Step 6: Nginx & SSL/TLS Setup

### 6.1 Create Nginx Configuration

```bash
# Copy the template config from the repo to Nginx
cp docker/nginx.conf /etc/nginx/nginx.conf.backup
cp docker/nginx.conf /etc/nginx/nginx.conf

# Edit to match your domain
nano /etc/nginx/nginx.conf

# Find and replace all instances of "benmussa-invest.com" with your actual domain
# Verify the change:
grep "server_name" /etc/nginx/nginx.conf | head -10
```

**Key server blocks in the config:**

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name benmussa-invest.com www.benmussa-invest.com;
    
    # Let's Encrypt challenges
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    # Redirect to HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name benmussa-invest.com www.benmussa-invest.com;
    
    ssl_certificate /etc/letsencrypt/live/benmussa-invest.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/benmussa-invest.com/privkey.pem;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.benmussa-invest.com;
    
    ssl_certificate /etc/letsencrypt/live/benmussa-invest.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/benmussa-invest.com/privkey.pem;
    
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name etl-api.benmussa-invest.com;
    
    ssl_certificate /etc/letsencrypt/live/benmussa-invest.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/benmussa-invest.com/privkey.pem;
    
    location / {
        proxy_pass http://127.0.0.1:5001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 6.2 Test Nginx Configuration

```bash
# Verify Nginx config syntax (CRITICAL - do this before reloading!)
nginx -t

# Expected output:
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration will be successful
```

### 6.3 Request SSL/TLS Certificates from Let's Encrypt

```bash
# Create directory for ACME challenges
mkdir -p /var/www/certbot

# Reload Nginx with the new config (HTTP listener needed for ACME challenge)
systemctl reload nginx

# Request certificate for all subdomains
certbot certonly --nginx \
  -d benmussa-invest.com \
  -d www.benmussa-invest.com \
  -d api.benmussa-invest.com \
  -d etl-api.benmussa-invest.com \
  --email admin@benmussa-invest.com \
  --agree-tos \
  --no-eff-email

# Expected output:
# Congratulations! Your certificate has been issued.
# Certificate is saved at: /etc/letsencrypt/live/benmussa-invest.com/fullchain.pem
# Key is saved at: /etc/letsencrypt/live/benmussa-invest.com/privkey.pem
```

### 6.4 Enable HTTPS in Nginx

Now that certificates exist, reload Nginx with the full HTTPS config:

```bash
# Validate config again (now with SSL certs)
nginx -t

# Reload Nginx to apply SSL settings
systemctl reload nginx

# Verify Nginx is running
systemctl status nginx
```

### 6.5 Set Up Auto-Renewal of Certificates

```bash
# Test auto-renewal dry-run (doesn't actually renew, just checks)
certbot renew --dry-run

# Enable automatic renewal via systemd timer (already installed with certbot)
systemctl enable certbot.timer
systemctl start certbot.timer

# Verify renewal is scheduled
systemctl status certbot.timer
```

---

## Step 7: Post-Deployment Verification

### 7.1 Check Docker Container Health

```bash
# From the VPS:
docker compose ps

# All services should show "healthy" or "running":
# - redis: Up ... (healthy)
# - etl-api: Up ... (healthy)
# - backend: Up ... (healthy)
# - frontend: Up ... (healthy)
# - etl-worker: Up ... (running)
# - ingestion: Up ... (running)
```

### 7.2 Health Checks via Curl

```bash
# Test frontend (through Nginx/HTTPS)
curl -sf https://benmussa-invest.com/ | head -20
# Should return HTML, not an error page

# Test backend API health endpoint
curl -sf https://api.benmussa-invest.com/health | jq .
# Expected output: { "status": "ok", "uptime": 123 }

# Test ETL API health (internal only, from the VPS)
curl -sf http://127.0.0.1:5001/health | jq .
# Expected output: { "status": "ok" }
```

### 7.3 Verify Database Connectivity

```bash
# Check that backend can see tables:
docker compose exec backend npm run etl:run 2>&1 | head -50

# Or check backend logs for database connection messages:
docker compose logs backend | grep -i "connect\|pool\|database"
```

### 7.4 Create Initial Admin User

```bash
# From the VPS, inside the backend container:
docker compose exec backend npm run create-admin

# Follow the prompts to create a superuser account
# Email: admin@benmussa-invest.com
# Password: (create a strong one)
```

### 7.5 Access the Dashboard

Open your browser and navigate to:

```
https://benmussa-invest.com
```

**Expected:**
1. Nginx redirects `http://` → `https://`
2. SSL certificate is valid (green padlock)
3. Next.js frontend loads without errors
4. Login page appears
5. You can log in with the admin credentials created in 7.4

### 7.6 Test Business Unit Selection

After logging in:

1. Click on the Business Unit selector (top-left)
2. Select "Majaal" or "Tika"
3. Verify the dashboard displays data
4. Check that filters work

### 7.7 Test ETL Trigger

From the dashboard:

1. Navigate to **Admin → ETL Runs**
2. Click **"Trigger Incremental Refresh"**
3. Monitor the job progress
4. Wait for status to change from "QUEUED" → "RUNNING" → "COMPLETED"

Check logs:

```bash
# Watch ETL logs in real-time
docker compose logs -f etl-api | tail -50
docker compose logs -f etl-worker | tail -50
```

---

## Step 8: Monitoring & Maintenance

### 8.1 Useful Monitoring Commands

```bash
# Real-time container resource usage (CPU, memory, network)
docker stats

# Container log tailing (last 100 lines, follow new entries)
docker compose logs -f --tail=100

# Specific service logs
docker compose logs -f backend | tail -100
docker compose logs -f etl-api | tail -100

# Check container restarts (useful for detecting crashes)
docker compose ps | grep -i "restart"

# Inspect a running container
docker compose exec backend env | sort
docker compose exec frontend pwd
```

### 8.2 Automated Restart & Recovery

The `docker-compose.yml` includes `restart: unless-stopped` for all services. This means:

- If a container crashes, Docker automatically restarts it
- If you explicitly stop a container (`docker compose stop`), it won't auto-restart until you run `docker compose up -d` again

No additional configuration needed.

### 8.3 Log Rotation

Logs are automatically rotated by Docker (configured in `docker-compose.yml`):

```yaml
logging:
  driver: 'json-file'
  options: { max-size: '50m', max-file: '5' }
```

This means:
- Keep logs up to 50 MB per file
- Keep up to 5 old rotated files
- Older logs are deleted automatically

### 8.4 Disk Space Monitoring

```bash
# Check disk usage
df -h /

# Check Docker layer storage
du -sh /var/lib/docker

# List largest images
docker images --format "table {{.Repository}}\t{{.Size}}" | sort -k3 -h

# Prune unused images/volumes (WARNING: removes unused data)
docker system prune -a --volumes
```

### 8.5 Database Backups

**You must configure database backups outside this guide.** Recommended:

```bash
# Create a daily backup script (on VPS or via cron on MySQL server)
cat > /opt/07ps-dashboard/scripts/backup-db.sh << 'EOF'
#!/bin/bash
DB_HOST="<actual-db-host>"
DB_USER="ps_app"
DB_PASSWORD="<password>"
DB_NAME="ps_warehouse"
BACKUP_DIR="/opt/07ps-dashboard/backups"
DATE=$(date +%Y%m%d_%H%M%S)

mysqldump -h $DB_HOST -u $DB_USER -p$DB_PASSWORD $DB_NAME | gzip > $BACKUP_DIR/ps_warehouse_$DATE.sql.gz

# Keep backups for 30 days
find $BACKUP_DIR -name "*.sql.gz" -mtime +30 -delete
EOF

chmod +x /opt/07ps-dashboard/scripts/backup-db.sh

# Test the script
/opt/07ps-dashboard/scripts/backup-db.sh

# Add to crontab to run daily at 2 AM
echo "0 2 * * * /opt/07ps-dashboard/scripts/backup-db.sh" | crontab -
```

### 8.6 ETL Schedule Verification

The ETL runs on a cron schedule defined in `backend/.env`:

```env
# Incremental refresh: 8:50, 11:50, 14:50, 17:50, 20:50 (UTC)
ETL_SCHEDULE_INCREMENTAL_CRON=50 8,11,14,17,20 * * *
ETL_SCHEDULE_INCREMENTAL_ENABLED=true

# Full refresh: 2:00 AM (UTC)
ETL_SCHEDULE_FULL_CRON=0 2 * * *
ETL_SCHEDULE_FULL_ENABLED=true
```

**To verify these are running:**

```bash
# Check backend logs around the scheduled times
docker compose logs backend | grep -i "trigger\|schedule"

# Or check MySQL for pipeline run records
mysql -h <DB_HOST> -u ps_app -p<DB_PASSWORD> ps_warehouse \
  -e "SELECT run_id, status, start_time, end_time FROM pipeline_run_log ORDER BY start_time DESC LIMIT 10;"
```

### 8.7 Monitor ETL Performance

```bash
# Check pipeline_run_log for any failed runs
mysql -h <DB_HOST> -u ps_app -p<DB_PASSWORD> ps_warehouse \
  -e "SELECT run_id, status, total_records_processed, duration_seconds FROM pipeline_run_log WHERE status='FAILED' ORDER BY start_time DESC LIMIT 5;"

# Check for slow runs (>10 minutes)
mysql -h <DB_HOST> -u ps_app -p<DB_PASSWORD> ps_warehouse \
  -e "SELECT run_id, start_time, end_time, TIMESTAMPDIFF(MINUTE, start_time, end_time) AS duration_min FROM pipeline_run_log ORDER BY start_time DESC LIMIT 20;"
```

---

## Troubleshooting

### Issue: Docker Compose Won't Start

**Symptom:** `docker compose up -d` returns an error.

**Diagnosis:**

```bash
# Check what went wrong
docker compose logs

# Common causes:
# 1. docker-compose.yml syntax error
docker compose config > /dev/null   # validates YAML

# 2. Permission issues
ls -l docker-compose.yml            # should be readable by root

# 3. Port conflicts
netstat -tlnp | grep -E "3000|4000|5001|6379"
```

**Solution:**

```bash
# If YAML is invalid:
nano docker-compose.yml             # fix the error manually

# If ports are in use:
lsof -i :3000                       # find process using port 3000
kill -9 <PID>                       # kill the process

# If Docker daemon isn't running:
systemctl restart docker
docker ps                            # verify it's up
```

### Issue: Backend Can't Connect to MySQL

**Symptom:** `docker compose logs backend` shows connection errors like `ER_ACCESS_DENIED_FOR_USER`.

**Diagnosis:**

```bash
# Verify MySQL is reachable from VPS
mysql -h <DB_HOST> -u ps_app -p<DB_PASSWORD> ps_warehouse -e "SELECT 1;"

# Check backend/.env credentials
grep "DB_" backend/.env

# Verify firewall allows TCP 3306 from VPS to MySQL server
telnet <DB_HOST> 3306
```

**Solution:**

```bash
# Update credentials if wrong
nano backend/.env                   # fix DB_HOST, DB_USER, DB_PASSWORD

# Rebuild and restart backend
docker compose down backend
docker compose up -d backend
docker compose logs -f backend | head -50
```

### Issue: Frontend Can't Connect to Backend (CORS Error)

**Symptom:** Browser console shows `Access-Control-Allow-Origin` error.

**Diagnosis:**

```bash
# Check backend/.env for FRONTEND_ORIGIN
grep FRONTEND_ORIGIN backend/.env

# Check docker-compose.yml for NEXT_PUBLIC_API_BASE_URL
grep NEXT_PUBLIC_API_BASE_URL docker-compose.yml
```

**Solution:**

```bash
# Update FRONTEND_ORIGIN to match the frontend's actual origin
nano backend/.env
# Set FRONTEND_ORIGIN=https://benmussa-invest.com

# Update NEXT_PUBLIC_API_BASE_URL to match backend API origin
nano docker-compose.yml
# Set NEXT_PUBLIC_API_BASE_URL=https://api.benmussa-invest.com

# Rebuild frontend (NEXT_PUBLIC_* are baked in at build time)
docker compose build frontend
docker compose up -d frontend
```

### Issue: SSL Certificate Error (Nginx 502)

**Symptom:** HTTPS fails with 502 Bad Gateway or certificate errors.

**Diagnosis:**

```bash
# Check if certificates exist
ls -l /etc/letsencrypt/live/benmussa-invest.com/

# Check Nginx error log
tail -50 /var/log/nginx/error.log

# Check if backend is actually running
docker compose ps | grep backend   # should show "healthy"
```

**Solution:**

```bash
# Renew certificates manually
certbot renew --force-renewal

# Check Nginx config
nginx -t

# Restart Nginx
systemctl restart nginx

# Verify backend is healthy
docker compose ps backend
docker compose logs backend | tail -20
```

### Issue: ETL Jobs Not Running

**Symptom:** No ETL runs appear in **Admin → ETL Runs**, or status is stuck in "QUEUED".

**Diagnosis:**

```bash
# Check if etl-worker is running
docker compose ps etl-worker       # should be "running"

# Check if Redis is reachable
docker compose exec backend redis-cli -h redis ping  # should return "PONG"

# Check ETL logs
docker compose logs -f etl-worker | tail -100
docker compose logs -f etl-api | tail -100

# Verify ETL_API_KEY matches in both backend/.env and data/etl/.env
grep ETL_API_KEY backend/.env
grep ETL_API_KEY data/etl/.env
```

**Solution:**

```bash
# If ETL_API_KEY doesn't match:
nano backend/.env                   # update ETL_API_KEY
nano data/etl/.env                  # ensure it's identical
docker compose rebuild etl-worker backend
docker compose down && docker compose up -d

# If Redis is disconnected:
docker compose ps redis             # check if healthy
docker compose restart redis
sleep 10
docker compose logs -f etl-worker

# If Python dependencies are missing:
docker compose logs etl-api | grep -i "modulenotfound\|importerror"
# If so, rebuild the etl-api image:
docker compose build etl-api
docker compose up -d etl-api
```

### Issue: Out of Disk Space

**Symptom:** Containers crash with disk full errors, or `docker compose build` fails.

**Diagnosis:**

```bash
# Check disk usage
df -h

# Find what's taking space
du -sh /var/lib/docker /opt/07ps-dashboard /home /var/log
```

**Solution:**

```bash
# Clean up Docker unused resources (WARNING: removes orphaned images/volumes)
docker system prune -a --volumes -f

# Clean up logs if they're filling disk
find /var/log -name "*.log" -type f -mtime +30 -delete
find /opt/07ps-dashboard/logs -name "*.log" -type f -mtime +30 -delete

# Increase log rotation
nano /etc/docker/daemon.json
# Add: { "log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"} }
systemctl restart docker
```

### Issue: Login Fails / Session Problems

**Symptom:** Can't log in to dashboard, or session expires immediately.

**Diagnosis:**

```bash
# Check if JWT_SECRET is set correctly
grep JWT_SECRET backend/.env

# Check backend logs for auth errors
docker compose logs backend | grep -i "jwt\|auth\|token"
```

**Solution:**

```bash
# Regenerate JWT_SECRET (this will invalidate existing sessions)
openssl rand -base64 32

# Update backend/.env
nano backend/.env
# Change JWT_SECRET to the new value

# Restart backend
docker compose restart backend

# Test login again in a new browser tab (different session)
```

---

## Rollback Procedures

If a deployment fails or causes issues, here's how to roll back to a previous version.

### 8.1 Quick Rollback (Last Commit)

```bash
# From /opt/07ps-dashboard:
git log --oneline -3                # see recent commits

# Go back one commit
git checkout HEAD~1

# Verify the change
git log --oneline -1

# Rebuild and restart Docker
docker compose down
docker compose build
docker compose up -d

# Monitor startup
docker compose ps
docker compose logs -f
```

### 8.2 Rollback to Specific Tag

If you use git tags for releases:

```bash
# List available tags
git tag -l

# Checkout a specific tag
git checkout v1.2.3

# Rebuild
docker compose down
docker compose build
docker compose up -d
```

### 8.3 Rollback Database (Restore Backup)

If the database was corrupted by a migration:

```bash
# Stop containers to prevent new data writes
docker compose down

# Restore from backup
mysql -h <DB_HOST> -u root -p < /opt/07ps-dashboard/backups/ps_warehouse_20260715_120000.sql.gz

# Verify data is restored
mysql -h <DB_HOST> -u ps_app -p<DB_PASSWORD> ps_warehouse -e "SELECT COUNT(*) FROM sales_fact;"

# Restart containers
docker compose up -d
```

### 8.4 Full System Rollback

If everything is broken:

```bash
# Stop all containers
docker compose down

# Remove all Docker containers & images (WARNING: can't be undone)
docker system prune -a --volumes -f

# Revert code to known good state
git checkout v1.2.3

# Start fresh
docker compose build
docker compose up -d

# Wait for migrations
sleep 60
docker compose ps

# Verify health
curl https://benmussa-invest.com/
```

---

## Post-Deployment Checklist

- [ ] DNS resolves correctly for all subdomains
- [ ] SSL certificates are valid (green padlock in browser)
- [ ] Docker containers all show as "healthy"
- [ ] Backend API responds at `/health` endpoint
- [ ] Frontend loads at `https://benmussa-invest.com`
- [ ] Admin user account created and can log in
- [ ] Business unit selection works (Majaal, Tika)
- [ ] Dashboard displays sample data
- [ ] Filters are functional
- [ ] ETL can be triggered manually and completes successfully
- [ ] Database backups are configured and tested
- [ ] Nginx auto-reload on restart is verified
- [ ] SSL certificate auto-renewal is verified
- [ ] Monitoring/alerting is set up (optional)
- [ ] All 3 subdomains have working HTTPS
- [ ] Rate limiting is configured for login endpoint
- [ ] SMTP email verification (send test password reset)

---

## Support & Escalation

For issues not covered here:

1. **Check Docker logs first:**
   ```bash
   docker compose logs --tail=200 <service-name>
   ```

2. **Review the architecture document:**
   - `docs/07Ps_Phase1_Architecture_Standards.md`

3. **Check the ETL deployment guide:**
   - `docs/etl-deployment.md`

4. **VPS deployment reference:**
   - `docs/vps-deployment.md`

5. **Tech stack decisions:**
   - `docs/tech-stack-decision.md`

---

## Appendix A: Quick Reference Commands

```bash
# Basic operations
docker compose ps                          # status of all containers
docker compose logs -f                     # live tail all logs
docker compose restart                     # restart all services
docker compose down                        # stop all containers
docker compose up -d                       # start all containers (background)
docker compose build                       # rebuild images

# Specific service commands
docker compose logs <service>              # logs for one service
docker compose exec <service> bash         # shell into a container
docker compose restart <service>           # restart one service
docker compose build <service>             # rebuild one image

# Database commands
mysql -h <HOST> -u ps_app -p<PWD> ps_warehouse -e "SHOW TABLES;"
mysqldump -h <HOST> -u ps_app -p<PWD> ps_warehouse | gzip > backup.sql.gz

# Nginx/TLS commands
nginx -t                                   # validate Nginx config
systemctl reload nginx                     # reload Nginx
certbot certificates                       # list current certificates
certbot renew --dry-run                    # test certificate renewal

# System/monitoring commands
docker stats                               # live container resource usage
docker system df                           # Docker disk usage
df -h                                      # filesystem disk usage
free -h                                    # RAM usage
```

---

## Appendix B: Environment Variables Summary

### backend/.env

| Variable | Purpose | Example |
|----------|---------|---------|
| `DB_HOST` | MySQL hostname | `mysql.benmussa-invest.com` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_USER` | MySQL username | `ps_app` |
| `DB_PASSWORD` | MySQL password | Strong random password |
| `DB_NAME` | Database name | `ps_warehouse` |
| `PORT` | Express.js port (inside Docker) | `4000` |
| `JWT_SECRET` | Secret for JWT signing | Base64-encoded random string |
| `FRONTEND_ORIGIN` | CORS allowed origin | `https://benmussa-invest.com` |
| `SMTP_HOST` | SMTP server | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP port | `587` |
| `SMTP_USER` | SMTP username | `noreply@example.com` |
| `SMTP_PASSWORD` | SMTP app password | Gmail app password |
| `ETL_API_URL` | Flask ETL API URL (Docker DNS) | `http://etl-api:5001` |
| `ETL_API_KEY` | Bearer token for ETL API | Base64-encoded random string |
| `REDIS_HOST` | Redis hostname (Docker DNS) | `redis` |
| `REDIS_PORT` | Redis port | `6379` |

### frontend/.env.local

| Variable | Purpose | Example |
|----------|---------|---------|
| `NEXT_PUBLIC_API_BASE_URL` | Backend API URL (public/browser) | `https://api.benmussa-invest.com` |

### data/etl/.env

| Variable | Purpose | Example |
|----------|---------|---------|
| `DB_HOST` | MySQL hostname | `mysql.benmussa-invest.com` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_USER` | MySQL username | `ps_app` |
| `DB_PASSWORD` | MySQL password | Same as backend |
| `DB_NAME` | Database name | `ps_warehouse` |
| `ODOO_URL` | Odoo ERP base URL | `https://odoo.example.internal` |
| `ODOO_DB` | Odoo database name | `bmh_production` |
| `ODOO_USERNAME` | Odoo user | `admin` or service user |
| `ODOO_API_KEY` | Odoo API key | Long token from Odoo settings |
| `ETL_API_KEY` | Bearer token (must match backend) | Same as backend's ETL_API_KEY |
| `PORT` | Flask port (inside Docker) | `5001` |
| `LOG_LEVEL` | Python logging level | `INFO` or `DEBUG` |

---

**End of Deployment Guide**

*Last updated: July 16, 2026*  
*Prepared for: Ben Moussa Holding | Majaal & Tika*  
*Contact: Data Team*

