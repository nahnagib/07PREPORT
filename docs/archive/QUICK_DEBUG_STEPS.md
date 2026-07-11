# Quick Debug Steps for YTD Value Discrepancy

## The Problem
- Dashboard shows: **52.7M** YTD Value
- Database shows: **~78M** YTD Value (correct)
- Need to find where the 26M difference is coming from

## The Good News
✅ The frontend is NOT passing the date range filter (`dateFromDate`/`dateToDate`) to the API
✅ The API query builder (`buildQuery` in api.ts) correctly only passes:
   - anchorDate
   - companyKey
   - segmentKey  
   - channelKey
   - salesTeamKey
   - salespersonKey

So the issue is either:
1. The SQL query itself is wrong
2. A filter is being applied that shouldn't be
3. The data aggregation is incorrect

## Step 1: Verify Database Data (Run in MySQL)

```sql
-- First, get the baseline - what SHOULD the YTD be?
-- (Change dates if today isn't 2026-07-07)

SELECT 
  SUM(OrderValue) as ytd_value,
  COUNT(*) as row_count,
  MIN(OrderDate) as earliest_order,
  MAX(OrderDate) as latest_order
FROM Fact_Orders
WHERE OrderDate >= '2026-01-01' 
  AND OrderDate <= '2026-07-07';

-- Should show ~78M (or whatever is correct)
```

## Step 2: Add Logging to Backend

Edit `backend/src/measures/tachometer.ts` in the `fetchValueVolume` function:

```typescript
export async function fetchValueVolume(
  pool: Pool,
  window: DateWindow,
  filters: Filters,
): Promise<ValueVolume> {
  const { clause, params } = buildWhereClause(filters, 'fo');
  const sql = `
    SELECT
      COALESCE(SUM(fo.OrderValue), 0)  AS value,
      COALESCE(SUM(fo.OrderVolume), 0) AS volume
    FROM Fact_Orders fo
    JOIN Dim_Date dd ON fo.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
  `;
  
  // ADD THIS LOGGING:
  const startDateStr = toDateOnlyString(window.start);
  const endDateStr = toDateOnlyString(window.end);
  console.log('fetchValueVolume query:');
  console.log('  SQL:', sql);
  console.log('  Params:', [startDateStr, endDateStr, ...params]);
  console.log('  Date window:', { start: startDateStr, end: endDateStr });
  
  const [rows] = await pool.query(sql, [
    toDateOnlyString(window.start),
    toDateOnlyString(window.end),
    ...params,
  ]);
  
  const row = (rows as any[])[0];
  console.log('fetchValueVolume result:', row); // ADD THIS
  return { value: Number(row.value), volume: Number(row.volume) };
}
```

## Step 3: Rebuild and Restart Backend

```powershell
cd C:\Users\Lenovo\Desktop\07PREPORT\07ps-sales-dashboard-app\backend
npm run build
npm start

# Watch the console for the logging output
```

## Step 4: Trigger the API Call

Open the dashboard and load the page. You should see in the backend console:

```
fetchValueVolume query:
  SQL: SELECT COALESCE(SUM(fo.OrderValue), 0) AS value, ...
  Params: [ '2026-01-01', '2026-07-07', ... ]
  Date window: { start: '2026-01-01', end: '2026-07-07' }
fetchValueVolume result: { value: 78000000, volume: ... }
```

**Compare this result** (78M) to what the dashboard displays (52.7M).

If they match → **Problem is in the frontend display logic**  
If they don't match → **Problem is in the backend query or filters**

## Step 5: If the API Returns Correct Value (78M) But Dashboard Shows 52.7M

Check the frontend calculation in `page.tsx`:

```typescript
// Look for where ytdValue is displayed
const ytdCard = overview.ytdValue; // Should have ytdCard.actual = 78000000

// Check if there's a transformation or calculation:
<KpiCard
  headline={formatCompactCurrency(ytdCard.actual)} 
  // This should format 78000000 correctly
/>
```

Test the formatting:
```typescript
import { formatCompactCurrency } from '../lib/format';
console.log(formatCompactCurrency(78000000)); // Should show "78M"
console.log(formatCompactCurrency(52700000)); // Should show "52.7M"
```

## Step 6: If API Returns Wrong Value (52.7M Instead of 78M)

The SQL query is either:
1. Filtering incorrectly (wrong date bounds)
2. Missing data (filtered out by mistake)
3. Using wrong columns

### Check the date window calculation:

```typescript
// In your frontend, log the anchorDate being sent:
console.log('Sending anchorDate:', anchorDate); // Should be '2026-07-07'

// Test ytdWindow in filters.ts:
function ytdWindow(anchor: Date): DateWindow {
  const y = anchor.getUTCFullYear(); // Should be 2026
  return { start: dateOnlyUTC(y, 1, 1), end: anchor }; // Jan 1 - today
}
```

### Check if filters are restricting rows:

```sql
-- Test with NO filters first
SELECT SUM(OrderValue) FROM Fact_Orders
WHERE OrderDate >= '2026-01-01' AND OrderDate <= '2026-07-07';

-- Then test with your current filters (e.g., if CompanyKey=1 is selected)
SELECT SUM(OrderValue) FROM Fact_Orders
WHERE OrderDate >= '2026-01-01' 
  AND OrderDate <= '2026-07-07'
  AND CompanyKey = 1;
```

If the first query returns 78M but the second returns 52.7M, then **CompanyKey=1 has only 52.7M**, which is correct behavior.

## Step 7: Last Refreshed Date Fix

```typescript
// Add logging to refreshStatus.ts too:

export async function fetchLastUpdate(pool: Pool): Promise<Date | null> {
  const sql = 'SELECT MAX(OrderDateTime) AS last_update FROM Fact_Orders';
  
  console.log('Fetching last update...');
  const [rows] = await pool.query(sql);
  const row = (rows as any[])[0];
  console.log('Last update row:', row);
  
  return row?.last_update ?? null;
}
```

Frontend check:
```typescript
// In page.tsx, verify the lastRefreshLabel is being displayed:
console.log('refreshStatus:', refreshStatus);
console.log('lastRefreshLabel:', lastRefreshLabel);
```

---

## Quick Checklist

- [ ] Run the SQL query in MySQL: `SELECT SUM(OrderValue) FROM Fact_Orders WHERE OrderDate >= '2026-01-01' AND OrderDate <= '2026-07-07';`
  Result: ______ (should be 78M)

- [ ] Add console.log to `fetchValueVolume()` in backend
- [ ] Rebuild and restart backend: `npm run build && npm start`
- [ ] Load dashboard and check backend console output
  API returns: ______  
  Dashboard shows: ______

- [ ] If they match → Problem is in **frontend display**
- [ ] If they don't match → Problem is in **backend query**

- [ ] Check what filters are selected when testing (Company? Segment? etc.)

---

## Most Likely Root Cause

Based on the numbers:
- 78M ÷ 52.7M = 1.48x difference

This suggests:
1. A single company/segment/channel has 52.7M
2. All companies have 78M total
3. The dashboard is filtering to one company accidentally

**Check:** When you open the dashboard, what filters are pre-selected?

