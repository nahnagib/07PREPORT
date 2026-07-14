# 07PS Deployment - Quick Reference Card (Print This!)

```
═══════════════════════════════════════════════════════════════════════════════
                    07PS SALES DASHBOARD - DEPLOYMENT GUIDE
                          benmussa-invest.com
═══════════════════════════════════════════════════════════════════════════════
```

## Critical Phone Numbers / Emergency Contacts

**Hosting Provider Tech Support**: ________________  
**Database Admin**: ________________  
**App Owner (Nahla)**: nahla.burweiss@gmail.com  

---

## Pre-Deployment Checklist (Do This First!)

```
BEFORE YOU START:
☐ SSH access working: ssh user@server-ip
☐ MySQL running: mysql -u root -p -e "SELECT VERSION();"
☐ Git access confirmed: git clone <repo> /tmp/test
☐ cPanel login works
☐ All passwords documented and secured
☐ DNS records updated (both domains)
☐ Team notified of deployment time
```

---

## Critical Paths & Commands

### Server Access
```bash
# SSH to server
ssh user@your-server-ip

# Become appuser
su - appuser

# Back to root when needed
sudo su
exit
```

### Application Directories
```bash
/home/appuser/07ps-sales-dashboard/          ← Code lives here
  ├── frontend/                              ← Next.js app
  ├── backend/                               ← Express API
  ├── data/                                  ← Python ETL
  │   └── venv/                              ← Python virtual env
  └── .env files (SECURE THESE!)
```

### Log Locations
```bash
# View live logs
sudo journalctl -u 07ps-backend.service -f
sudo journalctl -u 07ps-frontend.service -f
sudo journalctl -u 07ps-etl-worker.service -f

# View historical logs
sudo journalctl -u 07ps-backend.service -n 50
```

---

## Phase Quickstart

### Phase 1: Server Setup (60 min)
```bash
sudo apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs npm python3 python3-pip git mysql-client
node --version  # Should be v20+
python3 --version  # Should be 3.10+
```

### Phase 2: Deploy Code (30 min)
```bash
su - appuser
cd ~
git clone <repo-url>
cd 07ps-sales-dashboard
npm install
cd data && python3 -m venv venv && source venv/bin/activate
pip install -r ingestion/requirements.txt -r warehouse/requirements.txt
deactivate && cd ..
```

### Phase 3: Database (45 min)
```bash
# Create database
mysql -u root -p -e "CREATE DATABASE ps_warehouse"
mysql -u root -p -e "CREATE USER 'ps_app'@'localhost' IDENTIFIED BY 'PASSWORD'"
mysql -u root -p -e "GRANT ALL ON ps_warehouse.* TO 'ps_app'@'localhost'"

# Apply migrations
cd data/warehouse && source ../../venv/bin/activate
python3 apply_migrations.py && deactivate && cd ../..

# Load test data
cd data/ingestion && source ../../venv/bin/activate
python3 orchestrator.py --run-once && deactivate && cd ../..
```

### Phase 4: Configuration (30 min)
```bash
# Backend .env
cat > backend/.env << 'EOF'
NODE_ENV=production
PORT=4000
API_HOST=0.0.0.0
DB_HOST=localhost
DB_USER=ps_app
DB_PASSWORD=your_password
DB_NAME=ps_warehouse
JWT_SECRET=$(openssl rand -base64 32)
API_URL=https://api.benmussa-invest.com
FRONTEND_URL=https://benmussa-invest.com
EOF
chmod 600 backend/.env

# Python .env
cat > data/ingestion/.env << 'EOF'
DB_HOST=localhost
DB_USER=ps_app
DB_PASSWORD=your_password
DB_NAME=ps_warehouse
EOF
chmod 600 data/ingestion/.env
```

### Phase 5: Build (45 min)
```bash
cd frontend && npm run build && cd ..
cd backend && npm run build && cd ..
ls -la frontend/.next/ backend/dist/
```

### Phase 6a: Manual Test (15 min)
```bash
# Terminal 1:
npm start --prefix backend
# Watch for: "Server running on port 4000"

# Terminal 2:
npm start --prefix frontend
# Watch for: "Ready in 3.2s"

# Terminal 3:
curl http://localhost:4000/health
curl http://localhost:3000
# Both should respond

# Then Ctrl+C both to stop
```

### Phase 6b: SystemD Services (45 min)
```bash
# Frontend service
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

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable 07ps-frontend.service
sudo systemctl start 07ps-frontend.service

# Backend service (COPY TEMPLATE FROM FULL GUIDE)
# ETL service (COPY TEMPLATE FROM FULL GUIDE)

# Verify all running
sudo systemctl status 07ps-frontend.service 07ps-backend.service 07ps-etl-worker.service
```

### Phase 7: Reverse Proxy (45 min)
```bash
sudo apt install -y nginx

# Create frontend proxy config (SEE FULL GUIDE)
# Create backend proxy config (SEE FULL GUIDE)

sudo ln -s /etc/nginx/sites-available/benmussa-invest.com /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/api.benmussa-invest.com /etc/nginx/sites-enabled/

sudo nginx -t
sudo systemctl start nginx
sudo systemctl enable nginx
```

### Phase 8-9: Testing & Done!
```bash
# Test all services
sudo systemctl status 07ps-frontend 07ps-backend 07ps-etl-worker

# Test endpoints
curl http://localhost:3000
curl http://localhost:4000/health

# Check logs for errors
sudo journalctl -u 07ps-backend -n 50
sudo journalctl -u 07ps-frontend -n 50

# Test via domain (if DNS ready)
curl https://benmussa-invest.com
curl https://api.benmussa-invest.com/health
```

---

## Troubleshooting Quick Fixes

### "Port already in use"
```bash
sudo lsof -i :3000   # Find what's using port
sudo kill -9 <PID>   # Kill it
```

### "Cannot connect to database"
```bash
mysql -u ps_app -p ps_warehouse -e "SELECT 1;"
# Check password in .env is correct
```

### "npm: command not found"
```bash
which npm
# If empty, Node.js not in PATH
# Rerun: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
```

### "Permission denied" on .env
```bash
chmod 600 backend/.env
chmod 600 data/ingestion/.env
ls -la backend/.env  # Should show: -rw------- appuser appuser
```

### "Service won't start"
```bash
sudo journalctl -u 07ps-backend.service -n 50  # See error
cd /home/appuser/07ps-sales-dashboard
npm start --prefix backend  # Run manually to see error
```

### "502 Bad Gateway" from Nginx
```bash
# Check backend is actually running
sudo systemctl status 07ps-backend.service
curl http://localhost:4000/health

# Check Nginx config
sudo nginx -t
sudo systemctl reload nginx
```

---

## Service Management Commands

```bash
# START a service
sudo systemctl start 07ps-frontend.service

# STOP a service
sudo systemctl stop 07ps-frontend.service

# RESTART a service
sudo systemctl restart 07ps-frontend.service

# CHECK status
sudo systemctl status 07ps-frontend.service

# VIEW logs (last 50 lines)
sudo journalctl -u 07ps-frontend.service -n 50

# VIEW logs live (like tail -f)
sudo journalctl -u 07ps-frontend.service -f

# ENABLE autostart on reboot
sudo systemctl enable 07ps-frontend.service

# DISABLE autostart
sudo systemctl disable 07ps-frontend.service

# Check if service runs on boot
sudo systemctl is-enabled 07ps-frontend.service
```

---

## Database Commands Cheat Sheet

```bash
# Connect to database
mysql -h localhost -u ps_app -p ps_warehouse

# Inside MySQL:
SHOW DATABASES;
USE ps_warehouse;
SHOW TABLES;
SELECT COUNT(*) FROM customers;
SELECT COUNT(*) FROM sales;
EXIT;

# Backup database
mysqldump -u ps_app -p ps_warehouse > backup.sql

# Restore database
mysql -u ps_app -p ps_warehouse < backup.sql

# Check user permissions
mysql -u root -p -e "SHOW GRANTS FOR 'ps_app'@'localhost';"
```

---

## Ports & Services Mapping

```
Port 3000  ← Frontend (Next.js)
Port 4000  ← Backend API (Express)
Port 3306  ← MySQL Database
Port 80    ← Nginx (HTTP redirect)
Port 443   ← Nginx (HTTPS)

All proxied through Nginx:
  benmussa-invest.com     → localhost:3000
  api.benmussa-invest.com → localhost:4000
```

---

## File Permissions

```bash
# Application files (appuser owns)
sudo chown -R appuser:appuser /home/appuser/07ps-sales-dashboard

# .env files (most secure - readonly by owner only)
chmod 600 backend/.env
chmod 600 data/ingestion/.env

# Scripts (executable)
chmod +x /home/appuser/backup_database.sh

# Logs directory
sudo chown -R appuser:appuser /var/log/07ps
chmod 755 /var/log/07ps
```

---

## Health Check Script (Run Regularly)

```bash
#!/bin/bash
echo "=== 07PS Deployment Health Check ==="

echo "Frontend (port 3000):"
sudo systemctl is-active 07ps-frontend.service
curl -s http://localhost:3000 > /dev/null && echo "✓ Responding" || echo "✗ Not responding"

echo ""
echo "Backend (port 4000):"
sudo systemctl is-active 07ps-backend.service
curl -s http://localhost:4000/health && echo "" || echo "✗ Not responding"

echo ""
echo "Database:"
mysql -u ps_app -p -e "SELECT 1;" > /dev/null 2>&1 && echo "✓ Connected" || echo "✗ Not connected"

echo ""
echo "Services on startup:"
sudo systemctl is-enabled 07ps-frontend.service
sudo systemctl is-enabled 07ps-backend.service
sudo systemctl is-enabled 07ps-etl-worker.service
```

---

## Git Deployment Process

```bash
cd /home/appuser/07ps-sales-dashboard

# Pull latest code
git pull origin main

# Rebuild
npm run build

# Restart services (zero downtime)
sudo systemctl restart 07ps-backend.service 07ps-frontend.service

# Verify
sudo systemctl status 07ps-backend.service 07ps-frontend.service
```

---

## When Things Go Wrong

```bash
1. STOP everything
   sudo systemctl stop 07ps-frontend.service 07ps-backend.service 07ps-etl-worker.service

2. CHECK logs for errors
   sudo journalctl -u 07ps-backend.service -n 100

3. VERIFY database
   mysql -u ps_app -p ps_warehouse -e "SELECT 1;"

4. TEST service manually
   cd /home/appuser/07ps-sales-dashboard
   npm start --prefix backend

5. If it works manually:
   - Check systemd file (might have wrong path/user)
   - Restart service: sudo systemctl restart 07ps-backend.service

6. If it doesn't work manually:
   - Check .env file exists and has correct values
   - Check dependencies: npm install
   - Check build: npm run build

7. RESTART services once fixed
   sudo systemctl start 07ps-backend.service 07ps-frontend.service

8. VERIFY
   curl http://localhost:4000/health
```

---

## Document References

**Detailed Deployment Guide**: DEPLOYMENT_GUIDE.md  
**Summary Overview**: DEPLOYMENT_SUMMARY.md  
**Step-by-Step Timeline**: DEPLOYMENT_TIMELINE.md  
**This Quick Reference**: QUICK_REFERENCE.md

---

## Success Checklist

```
☐ All 3 services running (systemctl status)
☐ Frontend loads at domain
☐ Backend API responds at /health
☐ Database queries work
☐ No errors in journalctl logs
☐ Services auto-start (is-enabled)
☐ Reverse proxy working (curl through nginx)
☐ SSL/HTTPS working (production only)
☐ Backups configured and tested
```

---

```
═══════════════════════════════════════════════════════════════════════════════
                        🎉 DEPLOYMENT COMPLETE! 🎉
═══════════════════════════════════════════════════════════════════════════════
```

**Print This Document** for easier reference during deployment!

**Contact**: Nahla (nahla.burweiss@gmail.com) - July 13, 2026
