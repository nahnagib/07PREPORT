# Manual Action Plan - Pre-Release Preparation

**Repository:** 07PREPORT  
**Date:** July 11, 2026  
**Purpose:** Step-by-step checklist for completing pre-release preparation

---

## Overview

The automatic audit has created comprehensive documentation and templates. This guide provides specific manual steps to complete the preparation. Follow these in order.

**Estimated Time:** 2-3 hours  
**Difficulty:** Medium  
**Critical:** Yes - Must complete before GitHub push

---

## Phase 1: Security Scan (30-45 minutes)

### Step 1.1: Search for Hardcoded Credentials

Search your entire repository for common credential patterns. Use VS Code or your IDE's search functionality.

**Search Patterns to Use:**

```
# API Keys & Tokens
api_key
apiKey
API_KEY
secret_key
secretKey
SECRET_KEY
password =
passwd =
pwd =
credential
token =
TOKEN =
```

**Process:**

1. Open VS Code in the 07PREPORT folder
2. Use Ctrl+Shift+F (Find in Files)
3. Search for each pattern above
4. Review each result
5. Move any found credentials to `.env`
6. Update .gitignore if needed

**For Each Match Found:**

```
# BEFORE (in code)
const apiKey = "sk_live_xyz123abc";

# AFTER (in code)
const apiKey = process.env.API_KEY;

# IN .env
API_KEY=sk_live_xyz123abc
```

### Step 1.2: Search Configuration Files

Check these files specifically:

```bash
# ASP.NET
appsettings.json
appsettings.Development.json
web.config
*.config

# JavaScript/Node
config.js
config.ts
.env.local
.env.production
.env.test

# Python
config.py
settings.py
.env

# Database
connectionStrings.json
db.config.js
```

**For Each File:**
- [ ] Open and review
- [ ] Look for: passwords, keys, URLs, usernames
- [ ] Move to `.env` if found
- [ ] Add placeholder to `.env.example`

### Step 1.3: Check Markdown Files

Common mistake: credentials in documentation.

```bash
# Search all .md files for patterns
grep -r "password\|api.key\|token\|secret" *.md

# Also check these files explicitly:
- QUICK_DEBUG_STEPS.md
- FACT_SALESLINES_MIGRATION_PLAN.md
- Any implementation notes
```

**Action:** Remove or redact any actual credentials from .md files.

### Step 1.4: Review Git History (Optional but Recommended)

Check if any secrets were accidentally committed before.

```bash
cd 07PREPORT
git log --all -p | grep -i "password\|api.key\|secret"
```

If secrets found in history:
- ⚠️ Use `git-secrets` or `gitleaks` to scan
- Consider `git-filter-branch` if severe
- Rotate any exposed credentials immediately

---

## Phase 2: Secrets Externalization (15-20 minutes)

### Step 2.1: Identify All Configuration

List all configuration that needs to be environment-specific:

```
Database: [ ] Connection string
Odoo:     [ ] API key, URL, credentials
Email:    [ ] SMTP host, port, user, password
Auth:     [ ] JWT secret, session secret
Cache:    [ ] Redis URL
APIs:     [ ] External API keys
Logging:  [ ] Log paths, levels
```

### Step 2.2: Create/Update .env

Using your `.env.example` as a template:

```bash
# Copy template
cp .env.example .env

# Edit with actual values (local development)
nano .env
# or
code .env
```

**Critical: Never commit `.env`**
- Verify `.env` is in `.gitignore` ✓

### Step 2.3: Update Application Code

For each configuration item, update code to read from environment:

**Node.js Example:**

```javascript
// BEFORE
const dbUrl = 'postgresql://user:pass@localhost:5432/preport';

// AFTER
const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/preport';

// Handle missing critical vars
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable not set');
}
```

**Python Example:**

```python
# BEFORE
ODOO_URL = 'https://odoo.example.com'
ODOO_KEY = 'secret123key'

# AFTER
import os
ODOO_URL = os.getenv('ODOO_URL', 'https://localhost')
ODOO_KEY = os.getenv('ODOO_API_KEY')

if not ODOO_KEY:
    raise ValueError('ODOO_API_KEY must be set')
```

### Step 2.4: Test Configuration Loading

```bash
# Terminal 1: Verify .env loads
node -e "require('dotenv').config(); console.log(process.env.DATABASE_URL)"

# Terminal 2: Check Python config
python -c "import os; os.load_dotenv(); print(os.getenv('DATABASE_URL'))"
```

---

## Phase 3: Cleanup (45-60 minutes)

### Step 3.1: Remove Node.js Artifacts

```bash
# Find and remove node_modules
for /d /r . %d in (node_modules) do @if exist "%d" (
    echo Removing %d
    rmdir /s /q "%d"
)

# Or using PowerShell
Get-ChildItem -Path . -Filter "node_modules" -Recurse -Force |
    Remove-Item -Recurse -Force
```

### Step 3.2: Remove Python Cache

```bash
# Find and remove __pycache__
for /d /r . %d in (__pycache__) do @if exist "%d" (
    echo Removing %d
    rmdir /s /q "%d"
)

# Remove .pyc files
for /r . %%f in (*.pyc) do @if exist "%%f" (
    echo Deleting %%f
    del "%%f"
)

# Or using PowerShell
Get-ChildItem -Path . -Filter "__pycache__" -Recurse -Force |
    Remove-Item -Recurse -Force
Get-ChildItem -Path . -Filter "*.pyc" -Recurse -Force |
    Remove-Item -Force
```

### Step 3.3: Remove IDE Files

```bash
# Delete VS Code settings
rmdir /s /q ".vscode"

# Delete JetBrains
rmdir /s /q ".idea"

# Delete other IDE files
del /s *.sublime-workspace
del /s *.sublime-project
```

### Step 3.4: Remove Log Files

```bash
# Find and delete log files
for /r . %%f in (*.log) do del "%%f"

# Clear directories
rmdir /s /q "serverout"
rmdir /s /q "ODGPMLogs"

# Keep only necessary logs folder structure
```

### Step 3.5: Remove Temporary Files

```bash
# Delete temporary files
for /r . %%f in (*.tmp) do del "%%f"
for /r . %%f in (*.bak) do del "%%f"
for /r . %%f in (*.swp) do del "%%f"

# Remove temp directories
rmdir /s /q ".temp"
rmdir /s /q "temp"
```

### Step 3.6: Remove OS-Specific Files

```bash
# Windows
del /s Thumbs.db

# macOS (if any)
for /r . %%f in (.DS_Store) do del "%%f"
```

### Step 3.7: Verify Cleanup

```bash
# Check git status
git status

# Should only show:
# - Modified configuration files
# - Deleted node_modules, __pycache__, logs, etc.
# - .gitignore added/modified
# - New documentation files

# Verify nothing important was deleted
git diff --name-status
```

---

## Phase 4: Repository Organization (20-30 minutes)

### Step 4.1: Create Folder Structure

```bash
# Create directories
mkdir docs
mkdir deployment
mkdir modules
mkdir scripts
mkdir reference
mkdir assets
```

### Step 4.2: Organize Documentation

```bash
# Move markdown files to docs/
move FACT_SALESLINES_MIGRATION_PLAN.md docs/
move FINAL_CHANGES_SUMMARY.md docs/
move MIGRATION_STATUS_UPDATED.md docs/
# Move other documentation .md files

# Keep these in root:
# README.md
# LICENSE
# DEPLOYMENT_CHECKLIST.md
# PRE_RELEASE_AUDIT_REPORT.md
```

### Step 4.3: Organize Assets

```bash
# Move font files
move font\* assets\fonts\

# Move icons
move Icons\* assets\icons\

# Move screenshots
move Screenshots\* assets\screenshots\
```

### Step 4.4: Organize Reference Data

```bash
# Move reference files
move Inputs\* reference\
move salary_data reference\
move SKU reference\

# Keep Excel templates and reference CSVs
# Ignore generated Exports/
```

### Step 4.5: Update File Paths

**Critical:** Update any hardcoded paths in code.

Search for references to old paths:

```
References to find and update:
- "font/" → "../assets/fonts/"
- "Icons/" → "../assets/icons/"
- "Inputs/" → "../reference/Inputs/"
- "Exports/" → Keep as-is (in .gitignore)
```

### Step 4.6: Verify After Reorganization

```bash
# Check all imports still work
npm test

# Run linter
npm run lint

# Check Python imports
python -m py_compile scripts/*.py
```

---

## Phase 5: .gitignore Testing (10-15 minutes)

### Step 5.1: Verify .gitignore Works

```bash
# Check what git sees as ignored
git check-ignore -v * > ignored_files.txt

# Review the output
cat ignored_files.txt

# Should include:
# node_modules/
# .env
# *.log
# __pycache__/
# dist/
# build/
```

### Step 5.2: Remove Accidentally Tracked Items

```bash
# List files that would be removed
git clean -ndx

# Actually remove untracked files (with caution)
git clean -fd

# Remove files from git cache (if already committed)
git rm --cached .env
git rm --cached node_modules/ -r
git commit -m "Remove secrets and build artifacts from tracking"
```

### Step 5.3: Final Verification

```bash
# Git status should be clean or only show intentional changes
git status

# Check no secrets are tracked
git log -p --all | grep -i "password\|api.key\|secret" | head -5
```

---

## Phase 6: Documentation Verification (15 minutes)

### Step 6.1: Review Generated Files

- [ ] README.md - Complete and accurate?
- [ ] .env.example - All variables included?
- [ ] .gitignore - Comprehensive?
- [ ] PRE_RELEASE_AUDIT_REPORT.md - Detailed?
- [ ] DEPLOYMENT_CHECKLIST.md - Complete?

### Step 6.2: Test Setup Instructions

Try following your own README:

```bash
# In a temporary directory
git clone . test-clone
cd test-clone
cp .env.example .env
# Edit .env with test values
npm install
npm start
```

**Verify:**
- [ ] Clone works
- [ ] Installation completes
- [ ] Application starts
- [ ] No hardcoded paths break things

### Step 6.3: Update Links & References

Review all markdown files:

```bash
# Find any broken references
grep -r "C:\\" docs/
grep -r "localhost" docs/
grep -r "TODO\|FIXME" docs/
```

Update any:
- Absolute paths → relative paths
- Internal links → working links
- Placeholder text → actual values
- TODO comments → completed or noted

---

## Phase 7: Final Verification (10-15 minutes)

### Step 7.1: Pre-Commit Checklist

Run through these checks:

```bash
# Check for any remaining .env files
find . -name ".env" -not -name ".env.example"

# Check for credentials
grep -r "password\|api.key\|secret" --include="*.js" --include="*.py" --include="*.json" .

# Check file sizes
du -sh .

# Check git repository size
du -sh .git

# List all files that will be committed
git ls-files
```

### Step 7.2: Security Verification

```bash
# Node dependencies
npm audit

# Python dependencies
pip audit

# Git secrets (if installed)
git secrets --scan
```

### Step 7.3: Final Cleanup Check

```bash
# Verify all large folders removed
ls -lah | grep -E "node_modules|__pycache__|\.vscode|\.idea"

# Should show nothing

# Verify .gitignore effectiveness
git check-ignore -v dist/ bin/ node_modules/ .env

# Should show all as ignored
```

---

## Phase 8: Create Initial Commit

### Step 8.1: Stage Everything

```bash
# Add all files
git add -A

# Review what's being committed
git status

# Should NOT include:
# .env (local copy)
# node_modules/
# __pycache__/
# .vscode/
# *.log
```

### Step 8.2: Create Initial Commit

```bash
# Make initial commit
git commit -m "feat: Initial production-ready release

- Repository reorganized for production
- Security: All credentials moved to .env
- Documentation: Comprehensive setup and deployment guides
- Cleanup: Removed development artifacts and logs
- .gitignore: Production-grade configuration
- Ready for GitHub public/private release"
```

### Step 8.3: Verify Commit

```bash
# See what's in the commit
git show --stat

# Verify no secrets in the commit
git show | grep -i "password\|api.key\|secret"

# Should return nothing
```

---

## Phase 9: GitHub Preparation

### Step 9.1: Create GitHub Repository

1. Go to GitHub.com
2. Click "New Repository"
3. Name: `07PREPORT`
4. Description: "Sales Dashboard & ETL System - Production Release"
5. Choose Public or Private based on requirements
6. DO NOT initialize with README (you have one)
7. Click "Create repository"

### Step 9.2: Add Remote & Push

```bash
# Add remote (replace with your GitHub URL)
git remote add origin https://github.com/your-org/07PREPORT.git

# Verify remote
git remote -v

# Push to GitHub
git push -u origin main

# For first time, might need:
# git branch -M main
# git push -u origin main
```

### Step 9.3: Configure GitHub Settings

On GitHub:

1. Go to Settings → Security
   - [ ] Enable branch protection for main
   - [ ] Require PR reviews
   - [ ] Require status checks to pass

2. Go to Settings → Collaborators
   - [ ] Add team members with appropriate permissions

3. Go to Settings → Secrets & Variables
   - [ ] Add environment variables for production
   - [ ] DO NOT add .env values (use GitHub Actions secrets)

4. Go to Actions
   - [ ] Enable GitHub Actions
   - [ ] Configure CI/CD if needed

---

## Phase 10: Post-Release Verification

### Step 10.1: Clone & Test

Fresh clone test from GitHub:

```bash
# Clone repository
git clone https://github.com/your-org/07PREPORT.git 07PREPORT-test
cd 07PREPORT-test

# Setup
cp .env.example .env
# Edit .env with values

# Install & Run
npm install
npm start

# Verify it works
curl http://localhost:3000
```

### Step 10.2: Verify No Secrets Exposed

```bash
# Check commit history
git log --all -p | grep -i "password\|secret\|api.key" | head -10

# Should return nothing

# Check files
git ls-files | xargs grep -l "password\|secret" | head -10

# Should return nothing
```

### Step 10.3: Update Repository Description

On GitHub repository page:
- [ ] Add description
- [ ] Add topics (tags)
- [ ] Add website link if applicable
- [ ] Update README if needed

---

## Troubleshooting

### Issue: .env Still Visible in Git

```bash
# Remove from git tracking
git rm --cached .env
git add .gitignore
git commit -m "Remove .env from tracking"
```

### Issue: node_modules Still Present

```bash
# Add to .gitignore if missing
echo "node_modules/" >> .gitignore

# Remove from git
git rm --cached -r node_modules/
git commit -m "Remove node_modules from tracking"
```

### Issue: Large File Can't Push

```bash
# Check for large files
git ls-files -l | sort -k5 -rh | head -10

# Remove if possible, or use Git LFS
git lfs install
git lfs track "*.{psd,zip,exe,dmg,iso,rar,7z}"
git add .gitattributes
git commit -m "Add Git LFS tracking"
```

### Issue: Merge Conflicts During Setup

```bash
# Abort the merge
git merge --abort

# Try fresh approach
git reset --hard HEAD
```

---

## Success Criteria

You're ready for GitHub when:

- ✅ All credentials in `.env` (not in code)
- ✅ `.env` in `.gitignore`
- ✅ No `node_modules/`, `__pycache__/`, `.vscode/` directories
- ✅ No `*.log` or temporary files
- ✅ Comprehensive README.md
- ✅ Documentation complete
- ✅ `.gitignore` tested and working
- ✅ Fresh clone works without errors
- ✅ No secrets in git history
- ✅ `npm audit` passes
- ✅ `pip audit` passes (if Python)
- ✅ All tests passing
- ✅ GitHub repository created
- ✅ Initial push successful

---

## Timeline

| Phase | Task | Time | Status |
|-------|------|------|--------|
| 1 | Security Scan | 45 min | [ ] |
| 2 | Secrets Externalization | 20 min | [ ] |
| 3 | Cleanup | 60 min | [ ] |
| 4 | Organization | 30 min | [ ] |
| 5 | .gitignore Testing | 15 min | [ ] |
| 6 | Documentation | 15 min | [ ] |
| 7 | Final Verification | 15 min | [ ] |
| 8 | Initial Commit | 10 min | [ ] |
| 9 | GitHub Setup | 10 min | [ ] |
| 10 | Post-Release | 15 min | [ ] |
| **TOTAL** | | **225 min (3.75 hr)** | [ ] |

---

## Quick Reference: Commands by Platform

### PowerShell (Windows)

```powershell
# Remove directories
Remove-Item -Path ".\node_modules" -Recurse -Force
Remove-Item -Path ".\.vscode" -Recurse -Force

# Search for patterns
Select-String -Path "*.js" -Pattern "password|api_key"

# Check gitignore
git check-ignore -v $(git ls-files)
```

### Bash (Linux/macOS)

```bash
# Remove directories
rm -rf node_modules .vscode __pycache__

# Search for patterns
grep -r "password\|api_key" *.js

# Check gitignore
git check-ignore -v $(git ls-files)
```

---

**Start Date:** _______  
**Completion Date:** _______  
**Completed By:** _______

---

**Need Help?** See PRE_RELEASE_AUDIT_REPORT.md for detailed context.
