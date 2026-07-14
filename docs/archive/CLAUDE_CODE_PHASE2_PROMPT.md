# Claude Code Phase 2 Prompt: Node.js ETL Client Integration

## Executive Summary

The Python Flask ETL API is now live at `data/ingestion/app.py` with full end-to-end verification against mocked Odoo. Now build the Node.js backend layer to orchestrate it:

1. **HTTP Client** (`etlClient.ts`) — Call Python ETL service reliably with retry logic
2. **Cron Scheduler** (`etlScheduler.ts`) — Automate daily incremental refreshes  
3. **Express Routes** (`etl.ts`) — Expose ETL status/triggers to frontend
4. **Integration** — Wire into backend startup, update .env, add tests

**Deliverables**: 4 new TypeScript files + 1 updated file + test suite, all production-ready.

---

## Context & Dependencies

**What's already done (Phase 1):**
- Python Flask ETL API: `data/ingestion/app.py` (production-ready, tested live)
- All endpoints verified: `/health`, `/etl/run`, `/etl/load-export`, `/admin/test-db`
- Auth: Bearer token via `hmac.compare_digest`
- Existing Node.js backend: `backend/src/` with Express, MySQL, winston logger

**Tech stack:**
- Node.js 20, TypeScript 5.5+
- Express.js for routing
- Axios for HTTP (already in backend/package.json)
- node-cron for scheduling (add to backend/package.json)
- winston for logging (already in backend)
- vitest for testing

**Environment:**
- Python ETL API will run on: `https://api-etl.benmussa-invest.com` (cPanel subdomain)
- Node backend on: `https://benmussa-invest.com/api` (cPanel main domain)
- Both connect to same MySQL database
- Both have .env files with DB_* and ETL_* secrets

---

## Phase 2 Deliverables

### 1. ETL Client Service (`backend/src/services/etlClient.ts`) — NEW

**Purpose**: HTTP client to call Python Flask ETL API with reliability.

**Requirements:**
- Export `ETLClient` class with config in constructor
- Methods:
  - `healthCheck(): Promise<boolean>` — Quick health probe (5 sec timeout, no auth)
  - `runFullETL(options?: { skipMigrations?: boolean; validate?: boolean }): Promise<ETLJobResult>` — Trigger full load (10 min timeout)
  - `runIncrementalETL(sinceHours?: number): Promise<ETLJobResult>` — Trigger incremental (2 min timeout)
  - `runCustomersETL(): Promise<ETLJobResult>` — Customers only (1 min timeout)
  - `runSalesETL(): Promise<ETLJobResult>` — Sales fact table (5 min timeout)
  - `getDatabaseStatus(): Promise<any>` — Detailed DB info (admin endpoint)
- Features:
  - Axios instance with default Bearer auth header
  - Request/response logging via winston.Logger
  - Timeout handling per endpoint
  - Structured error responses (`{ status: 'error', jobId: 'unknown', error: '...' }`)
  - No retries on auth failure (401), but retries on 5xx/network errors (up to 3 times with exponential backoff)
- Export: Singleton `getETLClient()` function that lazy-loads from env vars `ETL_API_URL` and `ETL_API_KEY`
- Interface: `ETLJobResult = { status: 'success' | 'error', jobId: string, startedAt: string, rowsLoaded?: Record<string, number>, rowsUpdated?: Record<string, number>, durationSeconds?: number, error?: string }`

**Code style**: Match existing backend TypeScript (strict null checks, explicit types, no `any` except in interface returns).

**Location**: `backend/src/services/etlClient.ts`

**Reference**: See `CLAUDE_CODE_DEPLOYMENT_PROMPT.md` Section 2 for full code template.

---

### 2. ETL Scheduler Service (`backend/src/services/etlScheduler.ts`) — NEW

**Purpose**: Cron-based scheduler for automated daily ETL refresh.

**Requirements:**
- Export `ETLScheduler` class
- Constructor takes winston.Logger
- Methods:
  - `start(cronExpression?: string): void` — Start scheduler (default: `'0 2 * * *'` = 2 AM UTC daily)
  - `stop(): void` — Stop scheduler gracefully
  - `getStatus(): { lastRunTime: Date | null, lastRunStatus: 'success' | 'error' | null, isRunning: boolean }` — Query status
  - `runIncrementalETL(): Promise<void>` — Manually trigger (not cron-based)
- Features:
  - Uses `node-cron` library
  - Calls `getETLClient().runIncrementalETL(24)` on schedule
  - Tracks `lastRunTime` and `lastRunStatus` in memory
  - Logs every run (info on success, error on failure)
  - Handles exceptions gracefully (logs error, doesn't crash scheduler)
- Export: Singleton `getETLScheduler(logger: winston.Logger): ETLScheduler`

**Location**: `backend/src/services/etlScheduler.ts`

**Reference**: See `CLAUDE_CODE_DEPLOYMENT_PROMPT.md` Section 2 for template.

---

### 3. ETL Routes (`backend/src/routes/etl.ts`) — NEW

**Purpose**: Express endpoints for frontend to check/trigger ETL.

**Requirements:**
- Export: `setupETLRoutes(router: Router, logger: winston.Logger): void` — Function to attach routes to Express app
- Endpoints:
  1. `GET /api/etl/health` (public, no auth) → `{ status: 'ok' | 'unreachable', timestamp: ISO string }`
  2. `GET /api/etl/status` (authenticated) → `{ lastRunTime: Date | null, lastRunStatus: 'success' | 'error' | null, isSchedulerRunning: boolean }`
  3. `POST /api/etl/trigger-incremental` (authenticated, admin only) → `{ status, jobId, rowsUpdated, durationSeconds, error }`
  4. `POST /api/etl/trigger-full` (authenticated, admin only, with warning) → `{ status, jobId, rowsLoaded, durationSeconds, error }`
- Auth:
  - Public endpoint: no auth required
  - Other endpoints: require valid JWT token (use existing `authenticateToken` middleware)
  - Admin endpoints: check `req.user.role === 'admin'` (return 403 if not)
- Error handling: Return `{ error: '...' }` with appropriate HTTP status (401 for auth, 403 for permission, 500 for server error)

**Location**: `backend/src/routes/etl.ts`

**Reference**: See `CLAUDE_CODE_DEPLOYMENT_PROMPT.md` Section 2 for template.

---

### 4. Backend Server Integration (`backend/src/server.ts`) — UPDATE

**Changes needed:**
1. Import ETL scheduler and routes:
   ```typescript
   import { getETLScheduler } from './services/etlScheduler';
   import { setupETLRoutes } from './routes/etl';
   ```
2. After Express app setup, initialize scheduler:
   ```typescript
   const etlScheduler = getETLScheduler(logger);
   const etlCronExpression = process.env.ETL_CRON || '0 2 * * *';
   etlScheduler.start(etlCronExpression);
   ```
3. Setup routes:
   ```typescript
   setupETLRoutes(app, logger);
   ```
4. On graceful shutdown (SIGTERM), stop scheduler:
   ```typescript
   process.on('SIGTERM', () => {
     logger.info('SIGTERM received, shutting down');
     etlScheduler.stop();
     server.close(() => process.exit(0));
   });
   ```

**Location**: `backend/src/server.ts` (existing file, append to current logic)

---

### 5. Environment Configuration (`backend/.env.example`) — UPDATE

**Add these new variables:**
```bash
# ETL Microservice (Python API running on api-etl.benmussa-invest.com)
ETL_API_URL=https://api-etl.benmussa-invest.com
ETL_API_KEY=your_random_secure_key_here
# Generate with: openssl rand -base64 32

# ETL Scheduler
# Cron expression for daily incremental refresh (default: 0 2 * * * = 2 AM UTC daily)
# Cron format: minute hour day-of-month month day-of-week
ETL_CRON=0 2 * * *
```

**Note**: `ETL_API_KEY` must match the one set in `data/ingestion/.env` (same secret, both services use it).

---

### 6. Package Dependencies (`backend/package.json`) — UPDATE

**Add to `dependencies`:**
```json
"node-cron": "^3.0.3"
```

Already present: `axios`, `winston`, `express`, `typescript`.

Run `npm install` after updating package.json.

---

### 7. Test Suite (`backend/tests/etl.test.ts`) — NEW

**Purpose**: Unit tests for ETL client and scheduler (no real HTTP calls).

**Requirements:**
- Framework: vitest (already in backend/devDependencies)
- Mock strategy: Mock axios for HTTP, node-cron for scheduler ticks
- Tests to write (7-10 total):
  1. `etlClient: healthCheck returns true on 200`
  2. `etlClient: healthCheck returns false on network error`
  3. `etlClient: runFullETL requires valid API key`
  4. `etlClient: runFullETL returns jobId and rowsLoaded on 200`
  5. `etlClient: runIncrementalETL returns rowsUpdated on 200`
  6. `etlScheduler: start schedules cron job`
  7. `etlScheduler: getStatus returns null lastRunTime initially`
  8. `etlScheduler: runIncrementalETL calls ETL client and updates status`
  9. `etlRoutes: GET /api/etl/health returns 200 without auth`
  10. `etlRoutes: POST /api/etl/trigger-incremental requires admin role`
- All tests should pass with mocked dependencies (no real API calls, no real cron execution)

**Location**: `backend/tests/etl.test.ts`

**Example structure**:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { ETLClient, getETLClient } from '../src/services/etlClient';

vi.mock('axios');

describe('ETLClient', () => {
  let client: ETLClient;
  
  beforeEach(() => {
    process.env.ETL_API_URL = 'https://api-etl.example.com';
    process.env.ETL_API_KEY = 'test-key';
    client = new ETLClient({
      baseURL: 'https://api-etl.example.com',
      apiKey: 'test-key',
    });
  });
  
  it('healthCheck returns true on 200', async () => {
    vi.mocked(axios.create).mockReturnValue({
      get: vi.fn().mockResolvedValue({ status: 200 }),
    } as any);
    
    const result = await client.healthCheck();
    expect(result).toBe(true);
  });
  
  // ... more tests
});
```

---

## Implementation Checklist

- [ ] Create `backend/src/services/etlClient.ts` with `ETLClient` class and `getETLClient()` function
- [ ] Create `backend/src/services/etlScheduler.ts` with `ETLScheduler` class and `getETLScheduler()` function
- [ ] Create `backend/src/routes/etl.ts` with `setupETLRoutes()` function
- [ ] Update `backend/src/server.ts` to initialize scheduler and setup routes
- [ ] Update `backend/.env.example` with `ETL_API_URL`, `ETL_API_KEY`, `ETL_CRON`
- [ ] Update `backend/package.json` to add `node-cron` dependency
- [ ] Run `npm install` in backend directory
- [ ] Create `backend/tests/etl.test.ts` with 7-10 unit tests
- [ ] Run `npm run test` to verify all tests pass
- [ ] Verify `npm run build` completes with no TypeScript errors
- [ ] Verify `npm run lint` passes

---

## Post-Implementation Verification

After all files are created and tests pass:

1. **Local test** (assuming Python ETL running locally on port 5000):
   ```bash
   cd backend
   ETL_API_URL=http://localhost:5000 ETL_API_KEY=devtestkey npm run dev
   # In another terminal:
   curl -H "Authorization: Bearer <JWT>" http://localhost:4000/api/etl/health
   ```

2. **Verify scheduler starts**:
   - Check logs for: `[ETL Scheduler] Starting with cron expression: ...`
   - Check logs for: `[ETL] Triggering incremental ETL` at scheduled time

3. **Verify routes mounted**:
   ```bash
   curl http://localhost:4000/api/etl/health
   # Should return: { "status": "ok" | "unreachable", "timestamp": "..." }
   ```

4. **Test admin access control**:
   ```bash
   # Without JWT:
   curl -X POST http://localhost:4000/api/etl/trigger-incremental
   # Should return 401
   
   # With JWT but non-admin role:
   curl -X POST http://localhost:4000/api/etl/trigger-incremental \
     -H "Authorization: Bearer <USER_JWT>"
   # Should return 403
   
   # With admin JWT:
   curl -X POST http://localhost:4000/api/etl/trigger-incremental \
     -H "Authorization: Bearer <ADMIN_JWT>"
   # Should return 200 with job details
   ```

---

## Success Criteria

✅ All 7+ unit tests pass without real HTTP calls or cron execution  
✅ TypeScript builds with zero errors  
✅ ESLint passes  
✅ `etlClient.ts` exports `ETLClient` class and `getETLClient()` singleton  
✅ `etlScheduler.ts` starts/stops cleanly and tracks status  
✅ `etl.ts` routes mounted and require authentication properly  
✅ `server.ts` initializes scheduler at startup and stops on SIGTERM  
✅ `.env.example` documents all new variables  
✅ `package.json` includes `node-cron` dependency  

---

## File Structure After Phase 2

```
backend/
├── src/
│   ├── services/
│   │   ├── etlClient.ts            ✅ NEW (300 lines)
│   │   └── etlScheduler.ts         ✅ NEW (150 lines)
│   ├── routes/
│   │   └── etl.ts                  ✅ NEW (200 lines)
│   └── server.ts                   ✅ UPDATED (initialize scheduler + routes)
├── tests/
│   └── etl.test.ts                 ✅ NEW (200 lines, 10 tests)
├── .env.example                    ✅ UPDATED (add ETL_* vars)
└── package.json                    ✅ UPDATED (add node-cron)
```

---

## Next Steps After Phase 2

1. **Local Integration Testing**: Run both Python ETL API (port 5000) and Node backend (port 4000) locally, test full flow
2. **Frontend Integration** (Phase 3): Add UI components to dashboard for ETL status/manual trigger buttons
3. **cPanel Deployment** (Phase 4): Deploy both services to production cPanel
4. **Monitoring** (Phase 5): Set up logging aggregation and alerts for failed ETL jobs

---

## Code Quality Standards

- **TypeScript**: Strict mode, explicit types (no `any` except in specific cases)
- **Logging**: All user-facing operations logged via winston.Logger (info/error/warn levels)
- **Error Handling**: Catch all errors, return structured `{ status, error }` responses
- **Testing**: Mock external dependencies (axios, node-cron), test business logic, no real network calls
- **Naming**: Use camelCase for functions/variables, PascalCase for classes, UPPER_SNAKE_CASE for constants
- **Comments**: Add JSDoc for public methods, inline comments for complex logic only

---

## References

- **Python ETL API spec**: `data/ingestion/app.py` (endpoints, auth, response format)
- **Existing backend patterns**: `backend/src/routes/measures.ts`, `backend/src/middleware/auth.ts`
- **Full code templates**: `CLAUDE_CODE_DEPLOYMENT_PROMPT.md` Section 2 (etlClient.ts, etlScheduler.ts, etl.ts)

---

## Questions to Clarify Before Starting

1. **Scheduler time**: Should daily incremental ETL run at 2 AM UTC, or different time? (can be configured via `ETL_CRON` env var)
2. **Retry strategy**: On Python API 5xx errors, retry up to 3 times with exponential backoff? (recommended)
3. **Frontend status page**: Should the frontend dashboard display last ETL run time + success/error? (not in this phase, but good to know for Phase 3)
4. **Email alerts**: Should failed ETL jobs trigger email notification to admin? (out of scope for this phase; add to Phase 5)

---

## Ready to Build?

Copy everything above and paste into Claude Code with:

```
cd /sessions/brave-ecstatic-shannon/mnt/07PREPORT/07ps-sales-dashboard-app
```

Then run the build. Expected time: **2-3 hours** (implementation + testing).
