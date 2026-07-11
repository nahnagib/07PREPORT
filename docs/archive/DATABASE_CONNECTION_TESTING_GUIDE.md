# Database Connection Testing Guide

## Quick Start

### 1. Start the Backend Server

```bash
cd 07ps-sales-dashboard-app/backend
npm install  # If dependencies not installed yet
npm start
```

Expected output:
```
Server running on http://localhost:4000
Connected to MySQL database: powerBI_Data
```

### 2. Test Filter Endpoints

Test each filter endpoint to verify the database connection is working:

#### Test: Business Units / Companies
```bash
curl http://localhost:4000/api/filters/business-units
```

Expected response:
```json
[
  { "company_key": 1, "company_name": "Majaal" },
  { "company_key": 2, "company_name": "Tika" }
]
```

---

#### Test: Customer Groups / Segments
```bash
curl http://localhost:4000/api/filters/customer-groups
```

Expected response:
```json
[
  { "segment_key": 1, "segment_name": "B2B" },
  { "segment_key": 2, "segment_name": "B2C" },
  { "segment_key": 3, "segment_name": "Backoffice" },
  { "segment_key": 4, "segment_name": "Inter Company" }
]
```

---

#### Test: Distribution Channels
```bash
curl http://localhost:4000/api/filters/distribution-channels
```

Expected response:
```json
[
  { "channel_key": 1, "channel_name": "Direct" },
  { "channel_key": 2, "channel_name": "Indirect" }
]
```

---

#### Test: Branches / Sales Teams
```bash
curl http://localhost:4000/api/filters/branches
```

Expected response:
```json
[
  {
    "sales_team_key": "some_key",
    "sales_team_name": "Cairo",
    "city": "Cairo",
    "company_key": 1
  },
  {
    "sales_team_key": "another_key",
    "sales_team_name": "Alexandria",
    "city": "Alexandria",
    "company_key": 1
  }
]
```

---

#### Test: Salespersons
```bash
curl http://localhost:4000/api/filters/salespersons
```

Expected response:
```json
[
  { "salesperson_key": 1, "salesperson_name": "Ahmed Mohamed" },
  { "salesperson_key": 2, "salesperson_name": "Fatima Hassan" }
]
```

---

### 3. Test KPI Endpoints

Once filters are working, test the main KPI endpoints:

#### Test: Dashboard Overview (YTD/MTD KPI Cards)
```bash
curl "http://localhost:4000/api/tachometer/overview?anchorDate=2026-07-07"
```

Expected response:
```json
{
  "anchorDate": "2026-07-07",
  "ytdValue": {
    "actual": 1234567,
    "targetToDate": 1000000,
    "status": "ON_TRACK",
    "variancePct": 23.46,
    "lastYearSamePeriod": 1100000,
    "fullLastPeriodActual": 2000000,
    "fullPeriodTarget": 1800000
  },
  "ytdVolume": { /* similar structure */ },
  "mtdValue": { /* similar structure */ },
  "mtdVolume": { /* similar structure */ },
  "aspYtd": {
    "actualAsp": 567.89,
    "targetAsp": 523.45,
    "status": "ON_TRACK"
  },
  "aspMtd": { /* similar structure */ }
}
```

---

#### Test: Breakdown by Dimension
```bash
curl "http://localhost:4000/api/tachometer/breakdown?anchorDate=2026-07-07&metric=ytdValue&groupBy=salesperson"
```

Expected response:
```json
{
  "anchorDate": "2026-07-07",
  "metric": "ytdValue",
  "groupBy": "salesperson",
  "rows": [
    {
      "groupKey": 1,
      "groupLabel": "Ahmed Mohamed",
      "actual": 500000,
      "targetToDate": 450000,
      "status": "ON_TRACK",
      "variancePct": 11.11
    },
    {
      "groupKey": 2,
      "groupLabel": "Fatima Hassan",
      "actual": 400000,
      "targetToDate": 400000,
      "status": "ON_TRACK",
      "variancePct": 0.0
    }
  ]
}
```

---

#### Test: Monthly Trend Series
```bash
curl "http://localhost:4000/api/tachometer/trend?anchorDate=2026-07-07"
```

Expected response:
```json
{
  "anchorDate": "2026-07-07",
  "points": [
    {
      "month": 1,
      "year": 2026,
      "label": "Jan",
      "value": 200000,
      "volume": 350,
      "targetValue": 180000,
      "targetVolume": 330,
      "valueStatus": "ON_TRACK",
      "volumeStatus": "ON_TRACK",
      "asp": 571.43,
      "targetAsp": 545.45,
      "aspStatus": "ON_TRACK"
    },
    // ... more months through current month
  ]
}
```

---

#### Test: Refresh Status
```bash
curl http://localhost:4000/api/meta/refresh-status
```

Expected response:
```json
{
  "lastUpdate": "2026-07-07T10:30:00.000Z",
  "lastRefreshTime": null,
  "isStale": false
}
```

Note: `lastRefreshTime` will be `null` if pipeline_run_log table is not available.

---

### 4. Test with Filters

#### Test: KPI Card with Company Filter
```bash
curl "http://localhost:4000/api/tachometer/overview?anchorDate=2026-07-07&company=1"
```

Expected: Returns KPI data only for company_key=1

---

#### Test: Breakdown with Multiple Filters
```bash
curl "http://localhost:4000/api/tachometer/breakdown?anchorDate=2026-07-07&metric=ytdValue&groupBy=salesperson&company=1&segment=2"
```

Expected: Returns breakdown filtered by both company and segment

---

## Troubleshooting

### Issue: Cannot connect to database

**Error:**
```
Error: connect ECONNREFUSED 127.0.0.1:3306
```

**Solutions:**
1. Verify MySQL is running
2. Check DB_HOST/DB_PORT in `.env` (should be localhost:3306)
3. Verify database name is `powerBI_Data`
4. Test connection manually:
   ```bash
   mysql -h localhost -u powerbi_user -p powerBI_Data -e "SELECT COUNT(*) FROM Fact_Orders"
   ```

---

### Issue: Table not found

**Error:**
```
Error: Table 'powerBI_Data.fact_order' doesn't exist
```

**Causes & Solutions:**
1. Wrong table name (case sensitivity)
   - Expected: `Fact_Orders`, not `fact_order`
   - Verify .ts file has correct table name
   
2. Connected to wrong database
   - Run: `SELECT DATABASE();` in MySQL
   - Should return `powerBI_Data`

---

### Issue: Column not found

**Error:**
```
Error: Unknown column 'order_value' in field list
```

**Causes & Solutions:**
1. Wrong column name
   - Expected: `OrderValue`, not `order_value`
   - Check tachometer.ts for correct column names
   
2. Typo in SQL query
   - Look for recent changes in the .ts file
   - Verify case sensitivity

---

### Issue: Access Denied

**Error:**
```
Error: Access denied for user 'powerbi_user'@'localhost'
```

**Solutions:**
1. Verify password in `.env`:
   ```
   DB_PASSWORD=[REDACTED-rotate-this-password]
   ```

2. Check MySQL user permissions:
   ```sql
   GRANT ALL ON powerBI_Data.* TO 'powerbi_user'@'localhost';
   FLUSH PRIVILEGES;
   ```

---

### Issue: Empty results

**Problem:** Endpoints return empty arrays `[]`

**Causes:**
1. No data in the dimension table
2. Filter is too restrictive
3. User permissions issue

**Debugging:**
```bash
# Check if data exists in database
mysql -u powerbi_user -p powerBI_Data -e "SELECT COUNT(*) FROM Dim_Company;"
mysql -u powerbi_user -p powerBI_Data -e "SELECT * FROM Dim_Company LIMIT 5;"
```

---

## Frontend Testing

Once backend endpoints are verified:

### 1. Start Frontend
```bash
cd 07ps-sales-dashboard-app/frontend
npm install
npm run dev
```

### 2. Check Filter Dropdowns
- Navigate to dashboard
- Open filter dropdowns
- Verify they populate with data from `/api/filters/*` endpoints

### 3. Verify KPI Cards Display
- Check if YTD Value, YTD Volume cards show numbers
- Check MTD Value, MTD Volume cards
- Check ASP YTD and ASP MTD cards
- Values should match database data

### 4. Test Filters
- Select different companies
- Select different customer groups
- Verify KPI cards update
- Verify data changes appropriately

### 5. Check Breakdown Pages
- Click on a KPI card
- Should navigate to breakdown page
- Should show table grouped by dimension
- Should show correct filtered values

### 6. Test PDF Export
- On dashboard or breakdown page
- Click "Export PDF" button
- Verify PDF includes:
  - Table title
  - Current filters
  - All data rows
  - Timestamp

---

## Performance Checklist

After verifying functionality, check performance:

- [ ] `/api/filters/*` endpoints return in < 100ms
- [ ] `/api/tachometer/overview` returns in < 500ms
- [ ] `/api/tachometer/breakdown` returns in < 500ms
- [ ] `/api/tachometer/trend` returns in < 500ms
- [ ] Dashboard loads and renders in < 2 seconds
- [ ] Filters apply without lag
- [ ] PDF export completes in < 5 seconds

If any endpoint is slow:
1. Check database indexes
2. Verify no N+1 queries
3. Consider caching for frequently accessed data

---

## Common Expected Values

Based on the powerBI_Data schema:

### Companies
- Majaal (typically company_key = 1)
- Tika (typically company_key = 2)

### Segments
- B2B (segment_key = 1)
- B2C (segment_key = 2)
- Backoffice (segment_key = 3)
- Inter Company (segment_key = 4)

### Channels
- Direct, Indirect (or similar)

### Branches
- Cairo, Alexandria, etc.

### Salespersons
- Names from Dim_Salesperson table

### Date Range
- Should support current year (2026)
- Should include data from beginning of year through current date

---

## Success Indicators

✅ **Connection is successful when:**
1. All filter endpoints return data
2. KPI endpoints return valid numbers
3. Breakdown endpoints return grouped data
4. Filters apply correctly and values change
5. No SQL errors in backend logs
6. Frontend displays data correctly

✅ **Data is current when:**
1. Last update date is today or recent
2. YTD values are reasonable
3. MTD values are less than YTD
4. Targets are visible in the data

✅ **System is production-ready when:**
1. All tests pass
2. Performance is acceptable
3. PDF exports work
4. All filters function correctly
5. Data accuracy matches expectations

---

## Next Steps if Issues

1. **Check backend logs** - Look for SQL errors
2. **Verify .env file** - Ensure all credentials are correct
3. **Test MySQL directly** - Run queries manually
4. **Review recent changes** - Check if table/column names match
5. **Restart backend** - Sometimes connection issues resolve with restart
6. **Check database permissions** - Ensure user can read all tables

---

## Testing Checklist

- [ ] Backend starts without errors
- [ ] /api/filters/business-units returns data
- [ ] /api/filters/customer-groups returns data
- [ ] /api/filters/distribution-channels returns data
- [ ] /api/filters/branches returns data
- [ ] /api/filters/salespersons returns data
- [ ] /api/tachometer/overview returns KPI data
- [ ] /api/tachometer/breakdown returns breakdown data
- [ ] /api/tachometer/trend returns trend data
- [ ] /api/meta/refresh-status returns status
- [ ] Frontend filter dropdowns populate
- [ ] Frontend KPI cards display values
- [ ] Frontend filters update data correctly
- [ ] Breakdown pages load correctly
- [ ] PDF export works and includes filters
- [ ] Performance is acceptable

---

**Last Updated:** 2026-07-07  
**Database:** powerBI_Data  
**Expected Status:** All Tests Passing ✅
