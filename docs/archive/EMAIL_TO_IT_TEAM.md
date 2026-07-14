# Email to Send to IT Team

---

**Subject**: Production Deployment Documents - 07PS Sales Dashboard (benmussa-invest.com)

---

**To**: IT Team Lead / Operations  
**Cc**: Management  
**From**: Nahla Burweiss (nahla.burweiss@gmail.com)  
**Date**: July 13, 2026

---

Dear IT Team,

I've attached a complete, production-ready deployment guide for the **07PS Sales Dashboard** application for **benmussa-invest.com**.

## Background

Our hosting provider informed us that they cannot run Python and Node.js together in a single cPanel environment. However, through analysis of our application architecture and your SSH access capabilities, I've designed an alternative deployment strategy that allows all components to coexist on a single server using standard Linux services.

## What You're Deploying

**3 Main Components:**
1. **Frontend** – Next.js web application (Node.js) → benmussa-invest.com
2. **Backend API** – Express.js REST API (Node.js) → api.benmussa-invest.com  
3. **Python ETL Workers** – Background data processing (Python) → systemd service

All three run independently but communicate through a shared MySQL database. The solution uses industry-standard practices and requires SSH access, which you have.

## Documentation Provided

I've prepared **4 comprehensive documents** (all attached to your project folder):

### 1. **QUICK_REFERENCE.md** (START HERE!)
- Printable 1-page cheat sheet with critical commands
- Print this and keep it at your desk during deployment
- Essential troubleshooting quick fixes
- Service management command reference

### 2. **DEPLOYMENT_SUMMARY.md** 
- Executive summary for management
- Architecture explanation (addressing hosting provider's concern)
- 9 phases overview
- Questions to ask your hosting provider
- Timeline & resource estimates

### 3. **DEPLOYMENT_TIMELINE.md** (FOLLOW THIS STEP-BY-STEP)
- Exact hour-by-hour breakdown of deployment
- Expected timestamps for each major milestone
- What output you should see at each step
- When to take breaks
- Success criteria for Go/No-Go decisions

### 4. **DEPLOYMENT_GUIDE.md** (TECHNICAL REFERENCE)
- Complete, detailed instructions for every phase
- All systemd service file templates (copy-paste ready)
- Nginx/reverse proxy configurations
- Database setup and migration procedures
- Security hardening checklist
- Monitoring and backup automation
- Troubleshooting procedures
- Update and rollback procedures

## Recommended Approach

```
DAY 1 (Staging):    7-8 hours → Deploy to staging server first, test everything
DAY 2 (Production): 7-8 hours → Deploy to production using exact same steps
```

This allows you to verify the process works before going live on the production domain.

## Timeline

| Phase | Duration | What Gets Done |
|-------|----------|---|
| Server Setup | 1-2 hrs | Install Node.js, Python, MySQL client |
| Deploy Code | 30 min | Clone repository, install dependencies |
| Database | 1 hr | Create DB, run migrations, load data |
| Configure | 30 min | Create .env files with credentials |
| Build | 45 min | Compile frontend and backend |
| Test Manually | 15 min | Verify services start correctly |
| SystemD Setup | 45 min | Create 3 service files, enable autostart |
| Reverse Proxy | 45 min | Configure Nginx, test routing |
| Final Verification | 45 min | Health checks, endpoint tests, logs review |
| **TOTAL** | **7-8 hours** | Complete deployment with testing |

## Key Facts

**What's Working:**
✅ Application fully built and tested locally  
✅ Database schema complete and migrations ready  
✅ All dependencies documented (package.json, requirements.txt)  
✅ Configuration templates prepared (.env.example files)  

**What You Need to Know:**
- This uses **systemd** (standard Linux service manager) – industry standard
- All services auto-restart if they crash
- Logs are centralized via journalctl
- Zero-downtime deployments possible (rolling updates)
- Backup automation included

**Prerequisites:**
- SSH access with sudo privileges (you have this)
- Ability to install system packages (you have this)
- Knowledge of: Linux commands, MySQL basics, Node.js/npm basics
- ~8 hours of uninterrupted time for first deployment

## Critical Success Factors

1. **Follow the TIMELINE document exactly** – it has the right sequence
2. **Use the QUICK_REFERENCE for commands** – reduces copy-paste errors
3. **Test after each phase** – don't skip verification steps
4. **Keep logs accessible** – troubleshooting relies on journalctl output
5. **Have a rollback plan** – included in the guide if needed

## Questions You Might Have

**Q: Can we run Python on this shared hosting plan?**  
A: Yes, via SSH/systemd. The hosting provider's concern was about mixing Python and Node.js in cPanel's sandbox environments, which is a cPanel limitation, not a server limitation. With SSH access, we bypass this.

**Q: Do we need multiple servers?**  
A: No. One server handles frontend, backend, and Python workers simultaneously.

**Q: What if something breaks during deployment?**  
A: The rollback procedure is documented. You can revert to the previous working version in ~5 minutes.

**Q: How do we update the application later?**  
A: Simple git pull + rebuild + systemctl restart. Zero-downtime procedure documented.

**Q: What about security?**  
A: Security checklist included. HTTPS/SSL, firewalls, limited DB permissions, secure .env files, etc.

## Next Steps

1. **Read DEPLOYMENT_SUMMARY.md** (quick overview)
2. **Ask your hosting provider the 7 questions** in DEPLOYMENT_SUMMARY.md (verify capabilities)
3. **Schedule staging deployment** (I recommend next week)
4. **Use DEPLOYMENT_TIMELINE.md as your step-by-step guide** during actual deployment
5. **Keep QUICK_REFERENCE.md printed** while deploying

## Support

All procedures are documented in detail. However:
- If you hit an issue, the troubleshooting section covers most problems
- If you need clarification, contact me: **nahla.burweiss@gmail.com**
- Common issues (port conflicts, permission errors, etc.) have documented solutions

## Deployment Window Recommendation

**Staging**: Any day this week (non-business-critical)  
**Production**: Schedule at a time with low traffic  
→ Maybe early morning or after business hours  
→ Plan ~8 hours from start to finish, with verification

---

## Files You're Receiving

All files are in your project folder at: **C:\Users\Lenovo\Desktop\07PREPORT**

```
QUICK_REFERENCE.md           ← PRINT THIS (1 page)
DEPLOYMENT_SUMMARY.md        ← Read this first (10 min)
DEPLOYMENT_TIMELINE.md       ← Follow this during deployment
DEPLOYMENT_GUIDE.md          ← Reference for details
EMAIL_TO_IT_TEAM.md          ← This file
```

All are markdown files – open in any text editor or markdown viewer.

---

## Thanks & Expectations

Thank you for taking on this deployment. This is a professional-grade setup that will serve the business well.

**Expectations**:
- ✅ Deployment in staging environment first (validation)
- ✅ All status checks passing before production
- ✅ Team trained on basic monitoring/troubleshooting
- ✅ Backup procedure tested and working
- ✅ Go-live notification to stakeholders

**You've Got This! 💪**

---

**Questions Before You Start?**

1. Does your team have Linux command-line experience?
2. Do you have a staging server available for testing?
3. Are there any known constraints on your server (firewall, proxies, etc.)?
4. When would you like to deploy?

Please reply with answers – I can adjust the timeline if needed.

---

**Contact**:  
Nahla Burweiss  
Email: nahla.burweiss@gmail.com  
Date: July 13, 2026

---

Feel free to adjust this email as needed and send it to your IT team!
