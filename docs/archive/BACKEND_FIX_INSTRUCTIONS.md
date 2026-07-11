# Backend Database Migration - Fix Instructions

## Issue
The backend TypeScript files got corrupted during editing with null bytes and special characters. The solution is to manually update them with the corrected code.

## Quick Fix (Recommended)

### Step 1: Navigate to Backend Directory
```powershell
cd C:\Users\Lenovo\Desktop\07PREPORT\07ps-sales-dashboard-app\backend
```

### Step 2: Close Any Open Files
If Visual Studio Code or any other editor has these files open, close them first.

### Step 3: Update .env File

Replace the contents of `backend\.env`:

```
# Backend service configuration - copy to .env and fill in per environment.
PORT=4000
# MySQL 8 connection (replaces the previous Postgres DATABASE_URL -- see docs/tech-stack-decision.md
# and src/db/pool.ts's header). Use DB_SOCKET for a local unix socket connection, or
# DB_HOST/DB_PORT for TCP; DB_SOCKET takes precedence if set.
DB_HOST=localhost
DB_PORT=3306
DB_USER=powerbi_user
DB_PASSWORD=[REDACTED-rotate-this-password]
DB_NAME=powerBI_Data
DB_SOCKET=
JWT_SECRET="[REDACTED-rotate-this-secret]"
# CORS origin for the Next.js frontend
FRONTEND_ORIGIN=http://localhost:3000
```

### Step 4: Fix the TypeScript Files

Use VS Code or any text editor to update these files with the corrected code below:

#### File 1: `backend/src/measures/filters.ts`

Replace lines 48-56 only:

**OLD:**
```typescript
// Column name each Filters field maps to on fact_order / fact_order_line / fact_target_plan --
// all three tables use identical column names for these five, so one clause-builder works for all.
const FILTER_COLUMNS: Record<keyof Filters, string> = {
  companyKey: 'company_key',
  segmentKey: 'segment_key',
  channelKey: 'channel_key',
  salesTeamKey: 'sales_team_key',
  salespersonKey: 'salesperson_key',
};
```

**NEW:**
```typescript
// Column name each Filters field maps to on Fact_Orders / Fact_Targets --
// all three tables use identical column names for these five, so one clause-builder works for all.
const FILTER_COLUMNS: Record<keyof Filters, string> = {
  companyKey: 'CompanyKey',
  segmentKey: 'SegmentKey',
  channelKey: 'ChannelKey',
  salesTeamKey: 'SalesTeamKey',
  salespersonKey: 'SalespersonKey',
};
```

#### File 2: `backend/src/measures/tachometer.ts`

Find and replace these 4 query functions:

**Function 1 - fetchValueVolume (line 81-103):**

Replace SQL from:
```typescript
const sql = `
    SELECT
      COALESCE(SUM(fo.order_value), 0)  AS value,
      COALESCE(SUM(fo.order_volume), 0) AS volume
    FROM fact_order fo
    JOIN dim_date dd ON fo.date_key = dd.date_key
    WHERE dd.calendar_date BETWEEN ? AND ?
      AND ${clause}
  `;
```

To:
```typescript
const sql = `
    SELECT
      COALESCE(SUM(fo.OrderValue), 0)  AS value,
      COALESCE(SUM(fo.OrderVolume), 0) AS volume
    FROM Fact_Orders fo
    JOIN Dim_Date dd ON fo.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
  `;
```

**Function 2 - fetchTargetForMonths (line 111-141):**

Replace SQL from:
```typescript
const conditions = ['ftp.target_year = ?'];
...
const sql = `
    SELECT
      COALESCE(SUM(ftp.target_revenue), 0) AS target_revenue,
      COALESCE(SUM(ftp.target_volume), 0)  AS target_volume
    FROM fact_target_plan ftp
    WHERE ${conditions.join(' AND ')} AND ${clause}
  `;
```

To:
```typescript
const conditions = ['ftp.Year = ?'];
...
const sql = `
    SELECT
      COALESCE(SUM(ftp.Target_Revenue), 0) AS target_revenue,
      COALESCE(SUM(ftp.Target_Volume), 0)  AS target_volume
    FROM Fact_Targets ftp
    WHERE ${conditions.join(' AND ')} AND ${clause}
  `;
```

Also change the month conditions:
- `ftp.target_month = ?` → `ftp.Month = ?`
- `ftp.target_month < ?` → `ftp.Month < ?`

**Function 3 - GROUP_CONFIG (line 325-344):**

Replace:
```typescript
const GROUP_CONFIG: Record<GroupBy, GroupConfig> = {
  salesperson: {
    column: 'salesperson_key',
    joinTable: 'dim_salesperson',
    joinKeyColumn: 'salesperson_key',
    labelColumn: 'salesperson_name',
  },
  salesTeam: {
    column: 'sales_team_key',
    joinTable: 'dim_sales_team',
    joinKeyColumn: 'sales_team_key',
    labelColumn: 'sales_team_name',
  },
  segment: {
    column: 'segment_key',
    joinTable: 'dim_segment',
    joinKeyColumn: 'segment_key',
    labelColumn: 'segment_name',
  },
};
```

With:
```typescript
const GROUP_CONFIG: Record<GroupBy, GroupConfig> = {
  salesperson: {
    column: 'SalespersonKey',
    joinTable: 'Dim_Salesperson',
    joinKeyColumn: 'SalespersonKey',
    labelColumn: 'salesperson',
  },
  salesTeam: {
    column: 'SalesTeamKey',
    joinTable: 'Dim_SalesTeam',
    joinKeyColumn: 'SalesTeamKey',
    labelColumn: 'SalesTeam',
  },
  segment: {
    column: 'SegmentKey',
    joinTable: 'Dim_Segment',
    joinKeyColumn: 'SegmentKey',
    labelColumn: 'Segment',
  },
};
```

**Function 4 - fetchValueVolumeGrouped (line 360-392):**

Replace FROM clause from:
```typescript
    FROM fact_order fo
    JOIN dim_date dd ON fo.date_key = dd.date_key
    LEFT JOIN ${cfg.joinTable} dim ON fo.${cfg.column} = dim.${cfg.joinKeyColumn}
    WHERE dd.calendar_date BETWEEN ? AND ?
```

To:
```typescript
    FROM Fact_Orders fo
    JOIN Dim_Date dd ON fo.DateKey = dd.DateKey
    LEFT JOIN ${cfg.joinTable} dim ON fo.${cfg.column} = dim.${cfg.joinKeyColumn}
    WHERE dd.Date BETWEEN ? AND ?
```

And update the SELECT:
- `fo.order_value` → `fo.OrderValue`
- `fo.order_volume` → `fo.OrderVolume`

**Function 5 - fetchTargetForMonthsGrouped (line 394-433):**

Replace conditions from:
```typescript
  const conditions = ['ftp.target_year = ?'];
  ...
  if (opts.month !== undefined) {
    conditions.push('ftp.target_month = ?');
  } else if (opts.monthLt !== undefined) {
    conditions.push('ftp.target_month < ?');
```

To:
```typescript
  const conditions = ['ftp.Year = ?'];
  ...
  if (opts.month !== undefined) {
    conditions.push('ftp.Month = ?');
  } else if (opts.monthLt !== undefined) {
    conditions.push('ftp.Month < ?');
```

And replace FROM/SELECT:
```typescript
    FROM fact_target_plan ftp
```
→
```typescript
    FROM Fact_Targets ftp
```

And:
- `ftp.target_revenue` → `ftp.Target_Revenue`
- `ftp.target_volume` → `ftp.Target_Volume`

#### File 3: `backend/src/measures/refreshStatus.ts`

Replace the entire file with:

```typescript
/**
 * Last Update / Last Refresh Time -- required at the bottom of the Tachometer page.
 *
 * Ported 1:1 from data/warehouse/measures/refresh_status.py.
 *
 * Manual definitions:
 *   Last Update       - "the latest Odoo sales invoice date included in the page" /
 *                       "the latest sales order date included in the page"
 *   Last Refresh Time - "the time when the page last read and loaded the data"
 *
 *   Last Update       -> MAX(Fact_Orders.OrderDateTime)
 *   Last Refresh Time -> pipeline_run_log.pipeline_end_time for the most recent row with
 *                         status = 'SUCCESS' (not simply the most recent row regardless of
 *                         status -- a failed run's timestamp is not "when the page last loaded
 *                         the data")
 */

import type { Pool } from 'mysql2/promise';

export interface RefreshStatus {
  lastUpdate: Date | null;
  lastRefreshTime: Date | null;
  isStale: boolean;
}

const EXPECTED_CYCLE_MINUTES = 180;
const STALE_AFTER_MS = EXPECTED_CYCLE_MINUTES * 60 * 1000 * 1.5;

export async function fetchLastUpdate(pool: Pool): Promise<Date | null> {
  const [rows] = await pool.query('SELECT MAX(OrderDateTime) AS last_update FROM Fact_Orders');
  const row = (rows as any[])[0];
  return row?.last_update ?? null;
}

export async function fetchLastRefreshTime(pool: Pool): Promise<Date | null> {
  try {
    const [rows] = await pool.query(
      `SELECT pipeline_end_time
       FROM pipeline_run_log
       WHERE status = 'SUCCESS'
       ORDER BY pipeline_end_time DESC
       LIMIT 1`,
    );
    const row = (rows as any[])[0];
    return row?.pipeline_end_time ?? null;
  } catch (err) {
    return null;
  }
}

export async function fetchRefreshStatus(pool: Pool): Promise<RefreshStatus> {
  const [lastUpdate, lastRefreshTime] = await Promise.all([
    fetchLastUpdate(pool),
    fetchLastRefreshTime(pool),
  ]);
  const isStale =
    lastRefreshTime === null || Date.now() - lastRefreshTime.getTime() > STALE_AFTER_MS;
  return { lastUpdate, lastRefreshTime, isStale };
}
```

#### File 4: `backend/src/routes/filters.ts`

Replace all 5 query functions to use column aliases:

```typescript
filtersRouter.get('/business-units', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT CompanyKey as company_key, Company as company_name FROM Dim_Company ORDER BY Company',
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/customer-groups', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT SegmentKey as segment_key, Segment as segment_name FROM Dim_Segment ORDER BY Segment',
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/distribution-channels', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT ChannelKey as channel_key, DistributionChannel as channel_name FROM Dim_DistributionChannel ORDER BY DistributionChannel',
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/branches', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT SalesTeamKey as sales_team_key, SalesTeam as sales_team_name, SalesCity as city, CompanyKey as company_key
       FROM Dim_SalesTeam
       ORDER BY SalesTeam`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

filtersRouter.get('/salespersons', async (req, res, next) => {
  try {
    if (req.userContext?.roleCode === 'SALESPERSON') {
      const [rows] = await pool.query(
        'SELECT SalespersonKey as salesperson_key, salesperson as salesperson_name FROM Dim_Salesperson WHERE SalespersonKey = ?',
        [req.userContext.salespersonKey],
      );
      res.json(rows);
      return;
    }
    const [rows] = await pool.query(
      'SELECT SalespersonKey as salesperson_key, salesperson as salesperson_name FROM Dim_Salesperson ORDER BY salesperson',
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
```

### Step 5: Build and Start Backend

```powershell
# Clean install
npm install

# Build
npm run build

# Start
npm start
```

### Step 6: Verify Connection

In another PowerShell window:
```powershell
curl http://localhost:4000/api/filters/business-units
```

You should get JSON with company data.

## If Files Are Locked

If you get "file is locked" errors, try:

1. Close all editors and terminals
2. Open PowerShell as Administrator
3. Navigate to backend folder
4. Run:
   ```powershell
   # Force remove read-only attributes
   attrib -r -s src\measures\*.ts
   attrib -r -s src\routes\*.ts
   attrib -r -s src\middleware\*.ts
   ```

5. Then try the updates again

## Alternative: Full Restore from Git

If the files are too corrupted, use PowerShell to restore from git:

```powershell
cd C:\Users\Lenovo\Desktop\07PREPORT\07ps-sales-dashboard-app\backend
git checkout -- .
```

Then reapply only the `.env` change (DB_NAME=powerBI_Data) and the code updates above.

## Support

If you encounter issues:
1. Check the error message carefully
2. Verify .env has correct DB credentials
3. Ensure MySQL is running
4. Test connection: `mysql -h localhost -u powerbi_user -p powerBI_Data -e "SELECT 1;"`

---

**Status:** Ready for manual fix  
**Time to fix:** 10-15 minutes  
**Next:** Build → Start → Test
