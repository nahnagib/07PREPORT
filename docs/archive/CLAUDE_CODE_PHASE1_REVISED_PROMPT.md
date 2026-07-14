# Claude Code Phase 1 (Revised): Wrap Real ETL Pipeline for cPanel

## Executive Summary

**Critical correction**: Phase 1 wrapped the wrong pipeline. `data/ingestion/` is a side sandbox for validation/mocking. The production pipeline is `data/etl/` — real Odoo extraction, real transformations, real DB load.

**Real constraint**: cPanel shared hosting can't run persistent Redis+BullMQ worker container. This breaks `data/etl` (which currently spawns subprocesses via worker).

**Real solution**: 
1. Build Flask API wrapper around **`data/etl/src/sales_pipeline/main.py`** (the real CLI entry point)
2. Rewrite `backend/src/pythonRunner.ts` to call Flask API over HTTP instead of spawning subprocess
3. Keep everything else unchanged (BullMQ, admin/etlControl.ts, `etlRunTracker.ts`, frontend `etl-runs` page)
4. Job state lives in-memory in Flask process (acceptable; can persist later if needed)

**Why this works:**
- `pythonRunner.ts` already has all the logic to manage runs (`onLine` callbacks, stage detection, result parsing)
- Flask API just needs to be a subprocess spawner + job tracker over HTTP
- No changes to `runPipelineJob.ts`, admin UI, frontend, or BullMQ integration logic
- `etlRunTracker.ts` still forwards logs to BullMQ exactly as before

---

## Context: Current Architecture

### Existing `data/etl/` Structure
```
data/etl/
├── src/
│   └── sales_pipeline/
│       └── main.py                 # CLI entry point (argparse-based)
├── requirements.txt                # pip dependencies
└── .env.example                    # DB_*, ODOO_* credentials
```

### Existing `backend/src/pythonRunner.ts`
```typescript
export async function runPipeline(
  mode: 'full' | 'incremental' | 'sql' | 'excel',
  options: { fast?: boolean; extra_args?: string[] },
  onLine: (line: string) => Promise<void>   // Log streaming callback
): Promise<PipelineRunResult> {
  // Currently spawns: python main.py --mode full --fast [args]
  // Streams stdout/stderr line-by-line to onLine()
  // Returns: { success, exitCode, summary, ... }
}
```

### Where `pythonRunner.ts` is Called
- **`backend/src/runPipelineJob.ts`** — BullMQ job handler (calls `runPipeline()`, catches errors, stores result)
- **`backend/src/routes/admin/etlControl.ts`** — Manual trigger endpoint (calls `runPipelineJob.ts`)
- **Frontend** — Dashboard shows `/api/etl-runs` history + live logs stream

### What Must NOT Change
- `runPipelineJob.ts` — expects `runPipeline()` to have same signature
- `admin/etlControl.ts` — expects same error handling
- `etlRunTracker.ts` — BullMQ worker forwarding logs
- Frontend — already subscribes to WebSocket logs
- `.env` format — same DB_*, ODOO_* vars

---

## Phase 1 (Revised) Deliverables

### 1. Flask ETL API (`data/etl/api/app.py`) — NEW

**Purpose**: HTTP wrapper around `data/etl/src/sales_pipeline/main.py` subprocess spawning.

**Location**: `data/etl/api/app.py` (alongside vendored `src/`, not inside it)

**Key Design**:
- Flask app that spawns `data/etl/src/sales_pipeline/main.py` as subprocess in background thread
- Jobs tracked in-memory with job_id (UUID)
- Each job tracks: subprocess handle, status (pending/running/completed/failed), stage, logs (last 100 lines), exit code
- No persistence layer (fine for MVP; lost on process recycle, but subprocess dies too)

**Endpoints**:

#### `POST /etl/run` — Start a pipeline run
```
Request body:
{
  "load_mode": "full" | "incremental" | "sql" | "excel",
  "output_mode": "json" | "csv" | "db" (optional, passed as --output-mode),
  "fast": true | false (optional, adds --fast flag),
  "extra_args": ["--arg1", "value1", ...] (optional),
  "label": "manual trigger from admin" (optional, for logging)
}

Response (202 Accepted):
{
  "job_id": "uuid",
  "status": "pending",
  "message": "Job queued for execution"
}

Error (409 Conflict):
{
  "error": "Run already in progress",
  "active_job_id": "uuid"
}

Error (400 Bad Request):
{
  "error": "Invalid load_mode"
}
```

**Behavior**:
- Check if a run is already active (subprocess still running)
- If yes, return 409 (mirrors `admin/etlControl.ts`'s existing check)
- If no, spawn subprocess in background thread with args: `python main.py --mode {load_mode} [--output-mode {output_mode}] [--fast] [extra_args]`
- Immediately return 202 with job_id
- Job tracker captures subprocess stdout/stderr line-by-line
- Track latest "Stage: ..." detection in logs (e.g., "Stage: Extracting from Odoo" → `stage: "Extracting from Odoo"`)

#### `GET /etl/jobs/<job_id>` — Get job status & logs
```
Response (200 OK):
{
  "job_id": "uuid",
  "status": "running" | "completed" | "failed" | "canceled",
  "stage": "Extracting from Odoo" | null,
  "exit_code": null (running) | 0 (success) | 1+ (error),
  "duration_ms": 45000,
  "recent_log": ["line1", "line2", ...],  // Last 100 lines
  "log_tail": "...\nLast few lines of output"  // For quick viewing
}

Response (404 Not Found):
{
  "error": "Job not found"
}
```

**Behavior**:
- Return current job status from in-memory tracker
- Include last 100 log lines (for frontend polling)
- Include `log_tail` (last ~500 chars) for easy viewing

#### `POST /etl/jobs/<job_id>/cancel` — Terminate a running job
```
Response (200 OK):
{
  "job_id": "uuid",
  "status": "canceled",
  "message": "Subprocess terminated"
}

Response (409 Conflict):
{
  "error": "Job is not running",
  "current_status": "completed"
}

Response (404 Not Found):
{
  "error": "Job not found"
}
```

**Behavior**:
- Find subprocess by job_id
- If running, send SIGTERM (or SIGKILL if needed)
- Set job status to "canceled"
- Return confirmation

#### `GET /etl/health` — Unauthenticated health check
```
Response (200 OK):
{
  "status": "ok",
  "active_job": null | { "job_id": "uuid", "stage": "..." },
  "timestamp": "2026-07-14T10:30:00Z"
}
```

**Auth**: All endpoints require Bearer token via `Authorization: Bearer {ETL_API_KEY}`, except `/health` (public).

---

### 2. Flask App Support Files — NEW

#### `data/etl/api/__init__.py`
Empty file to make `api` a Python package.

#### `data/etl/api/job_tracker.py`
```python
"""
In-memory job state management.

Tracks running subprocesses, logs, and exit codes.
No persistence — state lost on Flask process restart.
"""
from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime
import subprocess
import threading
import uuid
import re

@dataclass
class Job:
    job_id: str
    status: str  # "pending", "running", "completed", "failed", "canceled"
    load_mode: str
    output_mode: Optional[str]
    fast: bool
    extra_args: List[str]
    label: Optional[str]
    
    # Subprocess
    process: Optional[subprocess.Popen] = None
    thread: Optional[threading.Thread] = None
    
    # Tracking
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    exit_code: Optional[int] = None
    stage: Optional[str] = None
    logs: List[str] = field(default_factory=list)  # Last 100 lines
    
    def duration_ms(self) -> Optional[int]:
        if self.start_time and self.end_time:
            return int((self.end_time - self.start_time).total_seconds() * 1000)
        return None
    
    def add_log_line(self, line: str):
        self.logs.append(line)
        if len(self.logs) > 100:
            self.logs.pop(0)  # Keep last 100 lines
        
        # Detect stage from log (e.g., "Stage: Extracting from Odoo")
        stage_match = re.search(r'Stage:\s*(.+)', line)
        if stage_match:
            self.stage = stage_match.group(1)
    
    def log_tail(self, max_chars: int = 500) -> str:
        """Return last N characters of logs for quick viewing."""
        full_log = '\n'.join(self.logs)
        if len(full_log) > max_chars:
            return '...\n' + full_log[-max_chars:]
        return full_log

class JobTracker:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self.active_job_id: Optional[str] = None
        self.lock = threading.Lock()
    
    def create_job(self, load_mode: str, output_mode: Optional[str], 
                   fast: bool, extra_args: List[str], label: Optional[str]) -> str:
        """Create and return a new job ID."""
        job_id = str(uuid.uuid4())
        with self.lock:
            self.jobs[job_id] = Job(
                job_id=job_id,
                status="pending",
                load_mode=load_mode,
                output_mode=output_mode,
                fast=fast,
                extra_args=extra_args or [],
                label=label
            )
        return job_id
    
    def get_job(self, job_id: str) -> Optional[Job]:
        """Retrieve job by ID."""
        with self.lock:
            return self.jobs.get(job_id)
    
    def get_active_job_id(self) -> Optional[str]:
        """Get currently running job ID."""
        with self.lock:
            return self.active_job_id
    
    def has_active_job(self) -> bool:
        """Check if any job is currently running."""
        with self.lock:
            if self.active_job_id:
                job = self.jobs.get(self.active_job_id)
                return job and job.status == "running"
            return False
    
    def set_active(self, job_id: str):
        """Mark a job as the active running job."""
        with self.lock:
            self.active_job_id = job_id
    
    def clear_active(self):
        """Unset the active job."""
        with self.lock:
            self.active_job_id = None

# Global tracker instance
tracker = JobTracker()
```

#### `data/etl/api/wsgi.py`
```python
"""WSGI entry point for gunicorn (cPanel)."""
import sys
from pathlib import Path

# Add parent dir to path so app can import config_src, vendor, etc.
sys.path.insert(0, str(Path(__file__).parent.parent))

from app import app

if __name__ == '__main__':
    app.run()
```

#### `data/etl/api/config.py`
```python
"""Configuration for Flask ETL API."""
import os

class Config:
    FLASK_ENV = os.getenv('FLASK_ENV', 'production')
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
    
    # Database (same as backend)
    DB_HOST = os.getenv('DB_HOST')
    DB_USER = os.getenv('DB_USER')
    DB_PASSWORD = os.getenv('DB_PASSWORD')
    DB_NAME = os.getenv('DB_NAME', 'ps_warehouse')
    
    # Odoo
    ODOO_URL = os.getenv('ODOO_URL')
    ODOO_USER = os.getenv('ODOO_USER')
    ODOO_PASSWORD = os.getenv('ODOO_PASSWORD')
    
    # Security
    ETL_API_KEY = os.getenv('ETL_API_KEY')
    
    # Pipeline
    PYTHON_BIN = os.getenv('PYTHON_BIN', sys.executable)  # python or python3
    PIPELINE_SCRIPT = 'src/sales_pipeline/main.py'  # Relative to data/etl/
```

#### `data/etl/api/.env.example`
```bash
# Database (same as backend; read from here or inherited from host)
DB_HOST=localhost
DB_USER=ps_warehouse_user
DB_PASSWORD=YOUR_PASSWORD
DB_NAME=ps_warehouse

# Odoo
ODOO_URL=https://odoo.example.com
ODOO_USER=user@example.com
ODOO_PASSWORD=YOUR_PASSWORD

# Security
ETL_API_KEY=YOUR_RANDOM_KEY_HERE
# Generate: openssl rand -base64 32

# Python
PYTHON_BIN=python3

# Flask
FLASK_ENV=production
LOG_LEVEL=INFO
```

#### `data/etl/api/requirements.txt`
```
Flask==3.0.0
gunicorn==21.2.0
python-dotenv==1.0.0
```

---

### 3. Rewrite `pythonRunner.ts` — UPDATE

**Location**: `backend/src/pythonRunner.ts`

**Current behavior** (to preserve):
```typescript
export async function runPipeline(
  mode: 'full' | 'incremental' | 'sql' | 'excel',
  options?: { fast?: boolean; extra_args?: string[] },
  onLine?: (line: string) => Promise<void>
): Promise<PipelineRunResult>
```

Returns: `{ success: boolean, exitCode: number, summary: any, ... }`

**New implementation**:
- Call `POST /etl/run` to start job
- Poll `GET /etl/jobs/<id>` every 1 second
- Stream new log lines to `onLine()` callback
- On completion, parse logs and return same `PipelineRunResult` structure

**Key requirements**:
1. Same external signature — `runPipelineJob.ts` and `admin/etlControl.ts` call it unchanged
2. Same `PipelineRunResult` shape — stage detection, summary parsing still works
3. Stream lines to `onLine()` callback — frontend WebSocket logs still work
4. On error: throw or return failure status (same as before)
5. On cancel: POST to `/etl/jobs/<id>/cancel`

**Pseudo-code**:
```typescript
async function runPipeline(mode, options, onLine) {
  // 1. POST /etl/run
  const { job_id } = await axios.post('https://api-etl.benmussa-invest.com/etl/run', {
    load_mode: mode,
    fast: options?.fast,
    extra_args: options?.extra_args,
    label: 'triggered from admin'
  }, { headers: { Authorization: `Bearer ${ETL_API_KEY}` } });
  
  // 2. Poll /etl/jobs/<id> until done
  let lastLogLineCount = 0;
  while (true) {
    const job = await axios.get(`https://api-etl.benmussa-invest.com/etl/jobs/${job_id}`, ...);
    
    // Stream new log lines
    const newLines = job.recent_log.slice(lastLogLineCount);
    for (const line of newLines) {
      await onLine?.(line);
    }
    lastLogLineCount = job.recent_log.length;
    
    if (['completed', 'failed', 'canceled'].includes(job.status)) {
      // Job done
      break;
    }
    
    await sleep(1000);  // Poll every second
  }
  
  // 3. Parse final result and return PipelineRunResult
  return parsePipelineResult(job, lastLogLines);
}
```

**New helper functions**:
```typescript
async function parsePipelineResult(job: Job, allLogs: string[]): Promise<PipelineRunResult> {
  // Mimic existing result parsing logic
  // Stage detection from logs
  // Summary extraction from final output
  // Error detection from exit code / stderr
  return {
    success: job.exit_code === 0,
    exitCode: job.exit_code,
    summary: {...},
    stage: job.stage,
    ...
  };
}
```

**Error handling** (same as before):
- Network error calling Flask API → throw
- Job canceled → throw or return failure
- Subprocess failed (exit_code != 0) → return failure status

---

### 4. Environment Configuration — UPDATE

#### `data/etl/.env.example` (if doesn't exist)
```bash
DB_HOST=localhost
DB_USER=ps_warehouse_user
DB_PASSWORD=YOUR_PASSWORD
DB_NAME=ps_warehouse

ODOO_URL=https://odoo.example.com
ODOO_USER=user@example.com
ODOO_PASSWORD=YOUR_PASSWORD

ETL_API_KEY=YOUR_RANDOM_KEY
PYTHON_BIN=python3
FLASK_ENV=production
```

#### `backend/.env.example` — ADD
```bash
# ... existing vars ...

# ETL API (Flask wrapper for data/etl)
ETL_API_URL=https://api-etl.benmussa-invest.com
ETL_API_KEY=YOUR_RANDOM_KEY  # Must match data/etl/.env ETL_API_KEY
```

---

### 5. Test Suite (`data/etl/api/tests/test_app.py`) — NEW

**Purpose**: Unit tests for Flask API endpoints (no real subprocesses, mocked).

**Tests** (7-10 total):
1. `test_health_check_public` — `/health` returns 200 without auth
2. `test_run_requires_auth` — `POST /etl/run` without Bearer → 401
3. `test_run_conflict` — Two concurrent runs → second gets 409
4. `test_run_success` — Valid run request → 202 with job_id
5. `test_get_job_running` — Fetch running job → status "running", stage, logs
6. `test_get_job_completed` — Fetch completed job → status "completed", exit_code, summary
7. `test_get_job_not_found` — Fetch nonexistent job → 404
8. `test_cancel_success` — Cancel running job → 200, status "canceled"
9. `test_cancel_not_running` → 409
10. `test_cancel_not_found` → 404

All tests mock subprocess via `unittest.mock.patch('subprocess.Popen')`.

---

### 6. Integration Test (Optional) — NEW

**File**: `backend/tests/pythonRunner.integration.test.ts`

**Purpose**: Test `pythonRunner.ts` against live Flask API (if API is running).

**Skip in CI** (no Flask API in GitHub CI); run locally only.

---

## Implementation Checklist

- [ ] Create `data/etl/api/app.py` with Flask app and 4 endpoints
- [ ] Create `data/etl/api/job_tracker.py` with `Job` and `JobTracker` classes
- [ ] Create `data/etl/api/wsgi.py` (WSGI entry for gunicorn)
- [ ] Create `data/etl/api/config.py` (environment config)
- [ ] Create `data/etl/api/.env.example` (template)
- [ ] Update `data/etl/requirements.txt` to add Flask, gunicorn
- [ ] Create `data/etl/api/tests/test_app.py` (10 unit tests)
- [ ] Rewrite `backend/src/pythonRunner.ts` (calls Flask API instead of spawn)
- [ ] Update `backend/.env.example` with `ETL_API_URL`, `ETL_API_KEY`
- [ ] Create `backend/tests/pythonRunner.integration.test.ts` (optional)
- [ ] Run `pytest data/etl/api/tests/` — all tests pass
- [ ] Run `npm run test` in backend — all tests pass, pythonRunner integration test skipped (marked as `.skip` in CI)
- [ ] Verify `npm run build` — zero TypeScript errors
- [ ] Verify `npm run lint` — passes

---

## Post-Implementation Verification

**Local test** (assuming Python ETL API running on port 5000, Flask):

1. Start Flask API:
   ```bash
   cd data/etl/api
   ETL_API_KEY=testkey123 python app.py  # Or: gunicorn -w 1 -b 0.0.0.0:5000 wsgi:app
   ```

2. Test endpoints:
   ```bash
   # Health check
   curl http://localhost:5000/api/etl/health
   
   # Start run
   curl -X POST http://localhost:5000/api/etl/run \
     -H "Authorization: Bearer testkey123" \
     -H "Content-Type: application/json" \
     -d '{"load_mode": "incremental", "fast": true}'
   # Returns: {"job_id": "uuid", ...}
   
   # Poll status
   curl -H "Authorization: Bearer testkey123" \
     http://localhost:5000/api/etl/jobs/UUID
   ```

3. Test `pythonRunner.ts` integration (in Node backend):
   ```bash
   cd backend
   ETL_API_URL=http://localhost:5000 \
   ETL_API_KEY=testkey123 \
   npm run test -- pythonRunner.test.ts
   ```

4. Verify frontend still works:
   - Trigger manual ETL via admin panel
   - Watch live logs stream to dashboard
   - Confirm completion in `/api/etl-runs` history

---

## Success Criteria

✅ Flask API spawns subprocesses correctly (no import-in-process)  
✅ `POST /etl/run` returns 202 immediately, runs in background  
✅ `GET /etl/jobs/<id>` returns current status and logs  
✅ `POST /etl/jobs/<id>/cancel` terminates subprocess  
✅ All 10 unit tests pass (mocked subprocesses, no network)  
✅ `pythonRunner.ts` calls Flask API instead of spawn (no behavior change from caller's perspective)  
✅ `runPipelineJob.ts` and `admin/etlControl.ts` unchanged  
✅ Frontend ETL logs still stream via WebSocket  
✅ Admin panel "Start Run" button still works  
✅ `/api/etl-runs` history still shows past runs  
✅ TypeScript builds with zero errors  
✅ ESLint passes  

---

## Known Limitations (Acceptable for MVP)

1. **No job state persistence**: Job state lives in-memory in Flask process
   - If cPanel recycles Flask process mid-run, Node loses track of job_id
   - Subprocess dies with parent, so no orphaned processes
   - **Future**: Add Redis job store for durability

2. **No multi-worker Flask**: Single-threaded Flask (gunicorn -w 1)
   - One run at a time (already enforced by 409 conflict check)
   - **Future**: Could add Redis lock for multi-process safety

3. **No webhook callbacks**: Node polls Flask; Flask doesn't notify Node
   - Polling interval is 1 second (acceptable latency)
   - **Future**: Could add server-sent events or WebSocket for push updates

---

## File Structure After Phase 1 (Revised)

```
data/etl/
├── src/
│   └── sales_pipeline/
│       └── main.py                     (unchanged)
├── api/
│   ├── __init__.py                     ✅ NEW
│   ├── app.py                          ✅ NEW (Flask app, 400+ lines)
│   ├── job_tracker.py                  ✅ NEW (Job/JobTracker classes)
│   ├── wsgi.py                         ✅ NEW (gunicorn entry point)
│   ├── config.py                       ✅ NEW (env config)
│   ├── .env.example                    ✅ NEW
│   └── tests/
│       ├── __init__.py                 ✅ NEW
│       └── test_app.py                 ✅ NEW (10 unit tests)
├── requirements.txt                    ✅ UPDATED (add Flask, gunicorn)
└── .env.example                        ✅ NEW/UPDATED

backend/
├── src/
│   └── pythonRunner.ts                 ✅ REWRITTEN (call Flask API)
├── tests/
│   └── pythonRunner.integration.test.ts ✅ NEW (optional)
├── .env.example                        ✅ UPDATED (add ETL_API_URL, ETL_API_KEY)
└── package.json                        (unchanged)
```

---

## Comparison: Before vs. After

| Aspect | Before | After |
|--------|--------|-------|
| **Python entry point** | `child_process.spawn('python', [...main.py...])` from Node | Flask HTTP API wraps spawn |
| **Where subprocess runs** | Node's child process tree | Flask process's background thread |
| **Job tracking** | In-memory in `pythonRunner.ts` | In-memory in Flask `JobTracker` |
| **Log streaming** | stdout captured by Node | Flask captures, Node polls |
| **cPanel compatibility** | ❌ No (persistent subprocess) | ✅ Yes (HTTP stateless) |
| **Admin panel** | Still works | Still works (unchanged) |
| **Frontend logs** | Still streams | Still streams (unchanged) |

---

## Next After Phase 1 (Revised)

Once this is verified locally:

1. Deploy `data/etl/api/` to cPanel Python app on `api-etl.benmussa-invest.com`
2. Deploy `backend/` to cPanel Node.js app on `benmussa-invest.com`
3. Set `.env` vars on both services (share same DB_*, same ETL_API_KEY)
4. Test manual ETL trigger via admin panel
5. Monitor first run via live logs in dashboard

---

## Questions Before Starting

1. **Job state persistence**: Acceptable to lose tracking if cPanel process restarts? (answer: yes for MVP)
2. **Logging format**: Should Flask logs go to stdout only (captured by cPanel), or file + stdout?
3. **Timeout**: What's max acceptable time for a single run? (for subprocess timeout in Flask)
4. **Result summary**: How does `pythonRunner.ts` currently parse `PipelineRunResult.summary` from subprocess output? (need to mimic in new code)

---

## References

- **Current `pythonRunner.ts`**: `backend/src/pythonRunner.ts` (what to rewrite)
- **Current `runPipelineJob.ts`**: `backend/src/runPipelineJob.ts` (what must not change)
- **Current `etlControl.ts`**: `backend/src/routes/admin/etlControl.ts` (what must not change)
- **Real pipeline entry**: `data/etl/src/sales_pipeline/main.py` (what Flask wraps)
- **Full Phase 1 template**: `CLAUDE_CODE_DEPLOYMENT_PROMPT.md` Section 1 (can adapt some patterns)

---

## Ready to Build?

This revised Phase 1 is scoped to replace the wrong pipeline (ingestion) with the right one (etl). All external APIs (Node/admin/frontend) remain unchanged.

Estimated time: **3-4 hours** (Flask API + pythonRunner.ts rewrite + tests + verification).

**Proceed?**
