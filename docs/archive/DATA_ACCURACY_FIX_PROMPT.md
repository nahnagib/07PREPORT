# Dashboard Data Accuracy Fix Prompt

## Problem Summary

After connecting to the `powerBI_Data` database, the dashboard shows incorrect YTD values:
- **Dashboard shows:** YTD Value = 52.7M
- **Database query shows:** Should be ~78M (direct SQL query)
- **Root cause:** The date range filter (From Date / To Date) is likely overriding the YTD logic, or the query itself has a filtering issue

Also, "Last Refreshed" currently shows "—" instead of the actual last order date from the database.

---

## Issue 1: YTD Value Showing Wrong Numbers

### Investigation Checklist

1. **Test the SQL query directly** (to verify database data is correct):
   ```sql
   -- Should return ~78M
   SELECT SUM(OrderValue) as ytd_value
   FROM Fact_Orders fo
   JOIN Dim_Date dd ON fo.DateKey = dd.DateKey
   WHERE dd.Date >= '2026-01-01' AND dd.Date <= '2026-07-07'
   AND fo.CompanyKey IS NOT NULL;
   ```

2. **Check if the date range filter is interfering:**
   - When user applies a "From Date" and "To Date" filter, is it OVERRIDING the YTD logic?
   - The YTD should be "Year-to-date as of the anchor date" (Jan 1 - today), NOT affected by the From/To filter
   - The From/To filter should only affect the filter dropdowns/scope, NOT the YTD calculation itself

3. **Verify the query being sent to the API:**
   - Add logging to `fetchValueVolume()` in `tachometer.ts` to print the SQL query
   - Check the WHERE clause to see if `dd.Date` range is correct
   - Verify the date boundary: should be `dd.Date BETWEEN '2026-01-01' AND '2026-07-07'`

### Suspected Root Cause

The date range filter (`dateFromDate`/`dateToDate`) is likely being passed to the `fetchValueVolume()` function or the query builder, and it's restricting the date range beyond what YTD should be. YTD should ALWAYS be Jan 1 - today, regardless of the From/To filter.

### Fix Required

1. **Separate YTD calculation from user-selected date range:**
   - The `ytdWindow()` function in `filters.ts` correctly calculates Jan 1 - anchor date
   - Make sure this window is NOT being overridden by the user's From/To date selection
   - The From/To filter should only affect which rows are INCLUDED in breakdowns/tables, not the KPI card calculations

2. **Verify the query in `fetchValueVolume()`:**
   - Check that `dd.Date BETWEEN ? AND ?` uses `ytdWindow(anchor)` dates, not the user's From/To dates
   - The user's From/To dates should filter the FILTERS (which companies/segments/channels are shown), not the date range of the KPI itself

3. **Test both scenarios:**
   ```
   Scenario A: No date range selected
   -> YTD Value should be Jan 1 - today = 78M ✓
   
   Scenario B: Date range set to June 1 - June 30
   -> YTD Value should STILL be Jan 1 - today = 78M (unchanged)
   -> The From/To filter should only affect filter dropdowns/visibility, not YTD calculation
   ```

### Code Changes Needed

**In `frontend/src/app/page.tsx`:**
- When calling `/api/tachometer/overview`, do NOT pass the user's `dateFromDate`/`dateToDate` as a filter
- Only pass `anchorDate` (which should be today's date)
- The anchorDate drives the YTD/MTD calculations; the From/To filter is separate

**In `backend/src/measures/tachometer.ts`:**
- Verify `fetchValueVolume(pool, ytdWindow(anchor), filters)` is being called correctly
- Confirm `ytdWindow(anchor)` is producing Jan 1 - anchor
- Make sure no additional WHERE clause is restricting this date range

---

## Issue 2: "Last Refreshed" Should Show Database's Latest Order Date

### Current State
- `refreshStatus.ts` has `fetchLastUpdate()` which queries `SELECT MAX(OrderDateTime) FROM Fact_Orders`
- This should be returning the latest order timestamp
- But the frontend is showing "—" (null/empty)

### Root Cause
Either:
1. The `fetchLastUpdate()` query is failing silently (try-catch is swallowing error)
2. The column name is wrong (`OrderDateTime` vs `OrderDate` vs something else)
3. The frontend isn't displaying the value correctly

### Fix Required

1. **Verify the column name** in Fact_Orders:
   ```sql
   -- Check which columns exist in Fact_Orders
   DESCRIBE Fact_Orders;
   -- Or check data:
   SELECT OrderDateTime, OrderDate FROM Fact_Orders LIMIT 1;
   ```

2. **Update `refreshStatus.ts`** if needed:
   ```typescript
   // Current code:
   const [rows] = await pool.query('SELECT MAX(OrderDateTime) AS last_update FROM Fact_Orders');
   
   // If the column is actually OrderDate, change to:
   const [rows] = await pool.query('SELECT MAX(OrderDate) AS last_update FROM Fact_Orders');
   ```

3. **Add logging** to see what's actually being returned:
   ```typescript
   export async function fetchLastUpdate(pool: Pool): Promise<Date | null> {
     const [rows] = await pool.query('SELECT MAX(OrderDateTime) AS last_update FROM Fact_Orders');
     const row = (rows as any[])[0];
     console.log('Last update from DB:', row); // Debug log
     return row?.last_update ?? null;
   }
   ```

4. **Check the frontend display** in `frontend/src/app/page.tsx`:
   - Verify `lastRefreshLabel` is being set correctly
   - Make sure the value is formatted as date/time string
   - Check if there's a bug in the display logic (e.g., formatting a null value)

### Expected Result

When dashboard loads:
```
Last Refreshed: 07/07/2026 14:30  (or whatever the latest order timestamp is)
```

Not:
```
Last Refreshed: —  (current broken state)
```

---

## Debugging Steps (In Order)

### Step 1: Verify Database Data
```sql
-- MySQL prompt
mysql> SELECT SUM(OrderValue) FROM Fact_Orders 
   WHERE DATE(OrderDateTime) >= '2026-01-01' 
   AND DATE(OrderDateTime) <= '2026-07-07';

-- Should show ~78M (or whatever the correct YTD is)

mysql> SELECT MAX(OrderDateTime) FROM Fact_Orders;
-- Should show the latest order date/time
```

### Step 2: Check API Response
```bash
# Get JWT token first, then:
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/tachometer/overview?anchorDate=2026-07-07

# Look at the response:
# Should show ytdValue.actual = 78000000 (or similar)
# Should show lastRefreshLabel with a proper date
```

### Step 3: Add Logging & Retest
- Add `console.log()` statements in `tachometer.ts` to print SQL queries
- Add `console.log()` statements in `refreshStatus.ts` to print query results
- Rebuild backend and test again
- Check backend console for the logs

### Step 4: Compare Query Results
- Take the SQL from the logs
- Run it directly in MySQL
- Compare the result to what the API returned
- If they match, the issue is in frontend logic
- If they don't match, the issue is in backend query logic

---

## Implementation Checklist

- [ ] Test SQL query directly in MySQL for correct YTD value (~78M)
- [ ] Test SQL query for latest OrderDateTime/OrderDate
- [ ] Add logging to `fetchValueVolume()` to see actual SQL query
- [ ] Add logging to `fetchLastUpdate()` to see what's returned
- [ ] Verify anchorDate is being passed correctly (should be today: 2026-07-07)
- [ ] Verify dateFromDate/dateToDate is NOT overriding YTD logic
- [ ] Verify column names in Fact_Orders (OrderDateTime vs OrderDate)
- [ ] Rebuild backend: `npm run build`
- [ ] Restart backend: `npm start`
- [ ] Test dashboard and check browser console + backend console logs
- [ ] Verify YTD Value now shows 78M
- [ ] Verify "Last Refreshed" shows actual date, not "—"

---

## Expected Outcome After Fix

**Before:**
```
YTD Value: 52.7M  (WRONG)
Last Refreshed: —  (BLANK)
```

**After:**
```
YTD Value: 78M  (CORRECT - matches database query)
Last Refreshed: 07/07/2026 14:30 (or latest order timestamp)
```

---

## If Issue Persists

1. **Check if `From Date / To Date` is being passed to the API call:**
   - The frontend should only pass `anchorDate` to `/api/tachometer/overview`
   - It should NOT pass the user's date range filter to the KPI calculation
   - The date range filter should only affect the filter dropdowns, not the YTD calculation

2. **Verify `dateFromDate` and `dateToDate` are not in the tachometer API call:**
   ```typescript
   // WRONG - would restrict YTD:
   const response = await fetch(`/api/tachometer/overview?anchorDate=2026-07-07&dateFrom=2026-06-01&dateTo=2026-06-30`);
   
   // CORRECT - only uses anchor:
   const response = await fetch(`/api/tachometer/overview?anchorDate=2026-07-07`);
   ```

3. **Check that `buildFilterSummary()` correctly reads date range:**
   - The date range should appear in PDF exports
   - But it should NOT affect the YTD calculation itself

---

## Questions for Developer

1. Is the user's `From Date / To Date` filter being passed to the `/api/tachometer/overview` endpoint? (It shouldn't be)
2. What exact column name does `Fact_Orders` have for the order date? (`OrderDateTime`, `OrderDate`, `order_datetime`?)
3. Can you verify the raw SQL query that's being executed? (Add logging to see)
4. Does the issue occur even when no date range filter is selected?

