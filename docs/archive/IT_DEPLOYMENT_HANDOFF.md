# IT Deployment Handoff — VPS Deployment Instructions

**For**: IT Deployment Staff  
**Project**: 07ps Sales Dashboard — Web Application Migration  
**Target**: Libyan Spider VPS or equivalent  
**Domain**: benmussa-invest.com  

---

## What You Need to Do

1. **Provision VPS**
   - Ubuntu 22.04+, 4 CPU, 8GB RAM, public IP
   - Rent from Libyan Spider (or equivalent provider)

2. **Clone Repository**
   ```bash
   git clone https://github.com/your-org/07ps-dashboard.git
   cd 07ps-dashboard
   ```

3. **Create .env Files** (fill in real values)
   ```bash
   cp backend/.env.example backend/.env
   cp data/etl/.env.example data/etl/.env
   cp frontend/.env.example frontend/.env
   
   # Edit each file with:
   # - Database credentials (DB_HOST, DB_USER, DB_PASSWORD)
   # - Odoo credentials (if using live Odoo)
   # - JWT_SECRET (generate new: openssl rand -base64 32)
   # - ETL_API_KEY (generate new: openssl rand -base64 32)
   ```

4. **Install Docker**
   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   ```

5. **Build & Start**
   ```bash
   docker compose build
   docker compose up -d
   sleep 40
   docker compose logs -f  # Watch for errors (should be none)
   ```

6. **Setup DNS** (in your domain registrar)
   ```
   benmussa-invest.com        A  <VPS-IP>
   www.benmussa-invest.com    A  <VPS-IP>
   api.benmussa-invest.com    A  <VPS-IP>
   ```
   (Wait 5-30 min for propagation)

7. **Setup Nginx + SSL**
   ```bash
   sudo apt-get install nginx certbot python3-certbot-nginx
   sudo cp docker/nginx.conf /etc/nginx/nginx.conf
   sudo nginx -t
   sudo systemctl start nginx
   sudo certbot certonly --standalone \
     -d benmussa-invest.com \
     -d www.benmussa-invest.com \
     -d api.benmussa-invest.com
   ```

8. **Verify**
   ```bash
   bash scripts/health-check.sh benmussa-invest.com
   # Should show ✓ for frontend, backend, ETL API
   ```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `docker compose build` fails | Check Docker installed: `docker --version` |
| Services won't start | `docker compose logs -f` to see errors |
| Backend can't reach ETL API | Check `docker network ls` and service health |
| Certificate error | Ensure DNS A records point to VPS IP |
| Admin panel shows errors | Check `.env` files have correct DB/Odoo credentials |

---

## That's It

Once step 8 passes, the dashboard is live at **https://benmussa-invest.com**.

No additional configuration needed.

---

## Contact

If anything fails, check:
1. `docker compose logs -f` (shows all service logs)
2. `docs/vps-deployment.md` (full guide with details)
3. `scripts/health-check.sh` output (diagnostic info)

---

**Deployment Time**: ~1.5 hours (including VPS provisioning)
