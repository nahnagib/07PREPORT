# Fix: Reports Must Read from Admin Layer, Not ETL

**Status:** BLOCKING — Admin changes not reflected in reports  
**Priority:** High — Data integrity issue  
**Issue:** Report queries read directly from Dim_* (ETL) instead of admin overlay tables  

---

## Problem Summary

**Admin page works correctly:**
- ✅ Admin edits Salesperson: name "Abdelraheam Berkhayal" → "Berkhayal" ✓ Saved in `salesperson_admin_profile.admin_name_override`
- ✅ Admin sets Target: "15,000,000" ✓ Saved in `salesperson_admin_profile.target_override_amount`
- ✅ Admin sets Customer Group: "B2B" ✓ Saved in `salesperson_admin_profile.segment_key_override`
- ✅ Admin sets Distribution Channel: "Wholesales" ✓ Saved in `salesperson_admin_profile.channel_key_override`

**Reports show wrong data:**
- ❌ Report still shows original ETL name (not admin override)
- ❌ Report still shows original ETL target (not admin 15M)
- ❌ Report still shows original ETL customer group (not admin B2B)
- ❌ Report still shows original ETL distribution channel (not admin Wholesales)

**Why this happens:**

Report queries are hardcoded to read from Dim_* tables (ETL source) instead of using admin overlay data. Example:

```sql
-- ❌ CURRENT (WRONG): Reads directly from ETL
SELECT 
  Dim_Salesperson.SalespersonName,
  Dim_Salesperson.SalesTarget,
  Dim_Segment.SegmentName,
  Dim_DistributionChannel.ChannelName
FROM Fact_Sales
JOIN Dim_Salesperson ON Fact_Sales.SalespersonKey = Dim_Salesperson.SalespersonKey
JOIN Dim_Segment ON Dim_Salesperson.SegmentKey = Dim_Segment.SegmentKey
JOIN Dim_DistributionChannel ON Dim_Salesperson.ChannelKey = Dim_DistributionChannel.ChannelKey
WHERE Dim_Salesperson.SalespersonKey = @salespersonKey

-- ✅ SHOULD BE: Reads admin overlay first, falls back to ETL
SELECT 
  COALESCE(sap.admin_name_override, Dim_Salesperson.SalespersonName) as SalespersonName,
  COALESCE(sap.target_override_amount, Dim_Salesperson.SalesTarget) as SalesTarget,
  COALESCE(acg.name, Dim_Segment.SegmentName) as SegmentName,
  COALESCE(adc.name, Dim_DistributionChannel.ChannelName) as ChannelName
FROM Fact_Sales
JOIN Dim_Salesperson ON Fact_Sales.SalespersonKey = Dim_Salesperson.SalespersonKey
LEFT JOIN salesperson_admin_profile sap ON Dim_Salesperson.SalespersonKey = sap.salesperson_key
LEFT JOIN admin_customer_group acg ON sap.segment_key_override = acg.customer_group_id OR (sap.segment_key_override IS NULL AND Dim_Salesperson.SegmentKey = acg.etl_segment_key)
LEFT JOIN admin_distribution_channel adc ON sap.channel_key_override = adc.distribution_channel_id OR (sap.channel_key_override IS NULL AND Dim_Salesperson.ChannelKey = adc.etl_channel_key)
```

---

## Root Cause Analysis

### Report Query Architecture (Current)

Most report queries in the system follow this pattern:

1. **Salesperson Reports** (`/api/reports/salesperson-performance`, etc.)
2. **Team Reports** (`/api/reports/team-performance`, etc.)
3. **Customer Group Reports** (`/api/reports/by-customer-group`, etc.)
4. **Distribution Channel Reports** (`/api/reports/by-distribution-channel`, etc.)

All of these queries directly reference:
- `Dim_Salesperson` table (name, target, segment, channel)
- `Dim_SalesTeam` table (team name, code)
- `Dim_Segment` table (customer group)
- `Dim_DistributionChannel` table (channel)
- `Dim_Company` table (company)

**None of them LEFT JOIN with the admin overlay tables:**
- `salesperson_admin_profile`
- `sales_team_admin_profile`
- `admin_customer_group`
- `admin_distribution_channel`
- `admin_company`

**Result:** Admin changes are in the database but invisible to reports because queries don't reference them.

---

## Step 1: Identify All Report Queries

### 1.1 Find Report Endpoints in Backend

**File locations to search:**
- `backend/src/routes/reports/` — all report endpoints
- `backend/src/services/reportService.ts` or similar
- `backend/src/queries/` or `backend/src/db/queries/` — parameterized SQL queries

**Commands to find them:**

```bash
# Find all report routes
grep -r "router.get.*report" backend/src/routes/ | head -20

# Find all SQL queries that reference Dim_Salesperson
grep -r "Dim_Salesperson" backend/src/ --include="*.ts" --include="*.sql" | head -20

# Find all SQL queries that reference Dim_Segment
grep -r "Dim_Segment" backend/src/ --include="*.ts" --include="*.sql" | head -20

# Find all queries that reference Dim_DistributionChannel
grep -r "Dim_DistributionChannel" backend/src/ --include="*.ts" --include="*.sql" | head -20
```

### 1.2 List All Report Types That Need Fixing

For each query found above, categorize it:

| Report Type | Endpoint | Tables Used | Needs Admin Join? |
|-------------|----------|-------------|------------------|
| Salesperson Performance | `GET /reports/salesperson-performance` | Fact_Sales, Dim_Salesperson, Dim_Segment, Dim_DistributionChannel | ✅ YES |
| Team Performance | `GET /reports/team-performance` | Fact_Sales, Dim_SalesTeam, Dim_Segment | ✅ YES |
| Customer Group Breakdown | `GET /reports/by-customer-group` | Fact_Sales, Dim_Segment | ✅ YES |
| Distribution Channel Breakdown | `GET /reports/by-channel` | Fact_Sales, Dim_DistributionChannel | ✅ YES |
| Company Performance | `GET /reports/by-company` | Fact_Sales, Dim_Company | ✅ YES |
| Salesperson YTD | `GET /reports/ytd/:salespersonKey` | Fact_Sales, Dim_Salesperson | ✅ YES |
| ... (add all report endpoints) | | | |

---

## Step 2: Update Query Templates

For **each report query**, follow this pattern to add admin overlay logic:

### 2.1 Salesperson-Level Reports

**Old Query (ETL only):**
```sql
SELECT 
  ds.SalespersonKey,
  ds.SalespersonName,
  ds.SalesTarget,
  dsg.SegmentName,
  ddc.ChannelName,
  SUM(fs.SalesAmount) as TotalSales,
  SUM(fs.UnitsQty) as TotalUnits
FROM Fact_Sales fs
JOIN Dim_Salesperson ds ON fs.SalespersonKey = ds.SalespersonKey
JOIN Dim_Segment dsg ON ds.SegmentKey = dsg.SegmentKey
JOIN Dim_DistributionChannel ddc ON ds.ChannelKey = ddc.ChannelKey
WHERE YEAR(fs.SalesDate) = @year
GROUP BY ds.SalespersonKey, ds.SalespersonName, ds.SalesTarget, dsg.SegmentName, ddc.ChannelName
```

**New Query (Admin overlay + ETL fallback):**
```sql
SELECT 
  ds.SalespersonKey,
  COALESCE(sap.admin_name_override, ds.SalespersonName) as SalespersonName,
  COALESCE(sap.target_override_amount, ds.SalesTarget) as SalesTarget,
  
  -- Customer Group: Use admin override if exists, else use ETL + admin lookup, else raw ETL
  COALESCE(
    acg.name,
    (SELECT name FROM admin_customer_group WHERE etl_segment_key = ds.SegmentKey LIMIT 1),
    dsg.SegmentName
  ) as SegmentName,
  
  -- Distribution Channel: Same pattern
  COALESCE(
    adc.name,
    (SELECT name FROM admin_distribution_channel WHERE etl_channel_key = ds.ChannelKey LIMIT 1),
    ddc.ChannelName
  ) as ChannelName,
  
  SUM(fs.SalesAmount) as TotalSales,
  SUM(fs.UnitsQty) as TotalUnits
FROM Fact_Sales fs
JOIN Dim_Salesperson ds ON fs.SalespersonKey = ds.SalespersonKey
LEFT JOIN salesperson_admin_profile sap ON ds.SalespersonKey = sap.salesperson_key
LEFT JOIN admin_customer_group acg ON sap.segment_key_override = acg.customer_group_id
LEFT JOIN admin_distribution_channel adc ON sap.channel_key_override = adc.distribution_channel_id
JOIN Dim_Segment dsg ON ds.SegmentKey = dsg.SegmentKey
JOIN Dim_DistributionChannel ddc ON ds.ChannelKey = ddc.ChannelKey
WHERE YEAR(fs.SalesDate) = @year
  AND ds.SalespersonKey = @salespersonKey  -- Optional filter
GROUP BY 
  ds.SalespersonKey,
  COALESCE(sap.admin_name_override, ds.SalespersonName),
  COALESCE(sap.target_override_amount, ds.SalesTarget),
  acg.name,
  adc.name
```

### 2.2 Sales Team Level Reports

**Old Query:**
```sql
SELECT 
  dst.SalesTeamKey,
  dst.SalesTeamName,
  SUM(fs.SalesAmount) as TotalSales
FROM Fact_Sales fs
JOIN Dim_SalesTeam dst ON fs.SalesTeamKey = dst.SalesTeamKey
WHERE YEAR(fs.SalesDate) = @year
GROUP BY dst.SalesTeamKey, dst.SalesTeamName
```

**New Query:**
```sql
SELECT 
  dst.SalesTeamKey,
  COALESCE(stap.name, dst.SalesTeamName) as SalesTeamName,
  COALESCE(stap.target_override_amount, dst.SalesTeamTarget) as Target,
  COALESCE(acg.name, dsg.SegmentName) as SegmentName,
  SUM(fs.SalesAmount) as TotalSales
FROM Fact_Sales fs
JOIN Dim_SalesTeam dst ON fs.SalesTeamKey = dst.SalesTeamKey
LEFT JOIN sales_team_admin_profile stap ON dst.SalesTeamKey = stap.sales_team_key
LEFT JOIN admin_customer_group acg ON stap.segment_key_override = acg.customer_group_id
LEFT JOIN Dim_Segment dsg ON dst.SegmentKey = dsg.SegmentKey
WHERE YEAR(fs.SalesDate) = @year
GROUP BY dst.SalesTeamKey, COALESCE(stap.name, dst.SalesTeamName), COALESCE(stap.target_override_amount, dst.SalesTeamTarget)
```

### 2.3 Customer Group Reports

**Old Query:**
```sql
SELECT 
  dsg.SegmentKey,
  dsg.SegmentName,
  SUM(fs.SalesAmount) as TotalSales
FROM Fact_Sales fs
JOIN Dim_Segment dsg ON fs.SegmentKey = dsg.SegmentKey
WHERE YEAR(fs.SalesDate) = @year
GROUP BY dsg.SegmentKey, dsg.SegmentName
```

**New Query:**
```sql
SELECT 
  COALESCE(acg.customer_group_id, dsg.SegmentKey) as SegmentKey,
  COALESCE(acg.name, dsg.SegmentName) as SegmentName,
  COALESCE(acg.definition, '') as Definition,
  SUM(fs.SalesAmount) as TotalSales
FROM Fact_Sales fs
JOIN Dim_Segment dsg ON fs.SegmentKey = dsg.SegmentKey
LEFT JOIN admin_customer_group acg ON dsg.SegmentKey = acg.etl_segment_key AND acg.is_active = true
WHERE YEAR(fs.SalesDate) = @year
GROUP BY COALESCE(acg.customer_group_id, dsg.SegmentKey), COALESCE(acg.name, dsg.SegmentName)
```

### 2.4 Distribution Channel Reports

**Same pattern as Customer Group** — LEFT JOIN with `admin_distribution_channel` on `etl_channel_key`, use COALESCE to prefer admin data.

### 2.5 Company Reports

**Same pattern** — LEFT JOIN with `admin_company` on `etl_company_key`.

---

## Step 3: Update Report Service Methods

### File: `backend/src/services/reportService.ts` (or equivalent)

For each report method, update the SQL query to follow the COALESCE pattern above.

**Example method:**

```typescript
// OLD
async getSalespersonPerformance(salespersonKey: string, year: number) {
  const query = `
    SELECT 
      ds.SalespersonKey,
      ds.SalespersonName,
      ds.SalesTarget,
      dsg.SegmentName,
      SUM(fs.SalesAmount) as TotalSales
    FROM Fact_Sales fs
    JOIN Dim_Salesperson ds ON fs.SalespersonKey = ds.SalespersonKey
    JOIN Dim_Segment dsg ON ds.SegmentKey = dsg.SegmentKey
    WHERE YEAR(fs.SalesDate) = ? AND ds.SalespersonKey = ?
    GROUP BY ds.SalespersonKey, ds.SalespersonName, ds.SalesTarget, dsg.SegmentName
  `;
  
  return await db.query(query, [year, salespersonKey]);
}

// NEW
async getSalespersonPerformance(salespersonKey: string, year: number) {
  const query = `
    SELECT 
      ds.SalespersonKey,
      COALESCE(sap.admin_name_override, ds.SalespersonName) as SalespersonName,
      COALESCE(sap.target_override_amount, ds.SalesTarget) as SalesTarget,
      COALESCE(acg.name, dsg.SegmentName) as SegmentName,
      SUM(fs.SalesAmount) as TotalSales
    FROM Fact_Sales fs
    JOIN Dim_Salesperson ds ON fs.SalespersonKey = ds.SalespersonKey
    LEFT JOIN salesperson_admin_profile sap ON ds.SalespersonKey = sap.salesperson_key
    LEFT JOIN admin_customer_group acg ON sap.segment_key_override = acg.customer_group_id
    JOIN Dim_Segment dsg ON ds.SegmentKey = dsg.SegmentKey
    WHERE YEAR(fs.SalesDate) = ? AND ds.SalespersonKey = ?
    GROUP BY ds.SalespersonKey, SalespersonName, SalesTarget, SegmentName
  `;
  
  return await db.query(query, [year, salespersonKey]);
}
```

---

## Step 4: Update All Report Endpoints

Go through `backend/src/routes/reports/` and update each endpoint to use the new service methods.

**Before:**
```typescript
router.get('/salesperson-performance/:salespersonKey', async (req, res) => {
  const data = await reportService.getSalespersonPerformance(req.params.salespersonKey, new Date().getFullYear());
  res.json(data);
});
```

**After:** (Same endpoint, but now calls updated service method)
```typescript
router.get('/salesperson-performance/:salespersonKey', async (req, res) => {
  const data = await reportService.getSalespersonPerformance(req.params.salespersonKey, new Date().getFullYear());
  // Now returns admin-overridden values
  res.json(data);
});
```

(No code change needed here — just verify the service method was updated.)

---

## Step 5: Frontend Filter Integration

### Filter Dropdowns Must Also Use Admin Data

**File:** `frontend/src/hooks/useFilters.ts` or equivalent

**Current (Wrong):**
```typescript
async loadCustomerGroups() {
  const data = await fetch('/api/filters/customer-groups'); // Reads from ETL
  setCustomerGroups(data);
}
```

**Updated (Correct):**
```typescript
async loadCustomerGroups() {
  // Endpoint already reads from admin layer first (from earlier implementation)
  const data = await fetch('/api/filters/customer-groups'); 
  // This should now return admin_customer_group rows instead of Dim_Segment
  setCustomerGroups(data);
}
```

**Verify the filter endpoint** `GET /api/filters/customer-groups` is reading from `admin_customer_group` first:

```typescript
// Backend: GET /api/filters/customer-groups
router.get('/customer-groups', async (req, res) => {
  let rows = await db.query(`
    SELECT customer_group_id as id, name
    FROM admin_customer_group
    WHERE is_active = true
    ORDER BY display_order, name
  `);
  
  // Fallback to ETL if admin layer is empty
  if (rows.length === 0) {
    rows = await db.query(`
      SELECT SegmentKey as id, SegmentName as name
      FROM Dim_Segment
      ORDER BY SegmentKey
    `);
  }
  
  res.json({ rows });
});
```

---

## Implementation Checklist

- [ ] **Find all report queries** that reference Dim_Salesperson, Dim_SalesTeam, Dim_Segment, Dim_DistributionChannel, Dim_Company
- [ ] **Update Salesperson reports** to JOIN with salesperson_admin_profile, use COALESCE for name/target/segment/channel
- [ ] **Update Team reports** to JOIN with sales_team_admin_profile, use COALESCE for name/target/segment
- [ ] **Update Customer Group reports** to LEFT JOIN admin_customer_group on etl_segment_key
- [ ] **Update Distribution Channel reports** to LEFT JOIN admin_distribution_channel on etl_channel_key
- [ ] **Update Company reports** to LEFT JOIN admin_company on etl_company_key
- [ ] **Verify filter endpoints** read from admin tables first (GET /filters/customer-groups, etc.)
- [ ] **Test end-to-end:**
  - [ ] Edit salesperson name in admin → reload report → name updated ✓
  - [ ] Edit salesperson target in admin → reload report → target updated ✓
  - [ ] Edit salesperson customer group in admin → reload report → group updated ✓
  - [ ] Edit salesperson distribution channel in admin → reload report → channel updated ✓
  - [ ] Create new customer group in admin → appears in report filter dropdown ✓

---

## Verification Test Case

**Setup:**
- Salesperson: "Abdelraheam Berkhayal" (original ETL name)
- Admin override name: "Berkhayal"
- Admin override target: 15,000,000
- Admin override customer group: "B2B"

**Expected behavior after fix:**
1. Open report filtered to this salesperson
2. Report shows:
   - Name: "Berkhayal" (admin override, not "Abdelraheam Berkhayal")
   - Target: 15,000,000 (admin override)
   - Customer Group: "B2B" (admin override)
   - Distribution Channel: (admin override if set)

**If report still shows original ETL values:**
- ❌ Report query not updated
- ❌ Service method not using new query
- ❌ Endpoint not calling updated service method

---

## Notes

- **COALESCE order matters:** Always check admin override first, then fall back to ETL
- **LEFT JOINs required:** Use LEFT JOIN, not INNER JOIN, in case admin data doesn't exist yet
- **is_active filtering:** For customer groups/channels/companies, filter on `is_active = true` in admin tables
- **Timezone/locale:** Admin data should be exactly as entered; no formatting needed
- **Performance:** Adding LEFT JOINs with admin tables should have minimal impact; they're small tables (< 1000 rows typically)

---

**Estimated effort:** 1-2 hours (find all report queries, update each one with COALESCE + LEFT JOIN pattern, test)  
**Priority:** High — Admin changes must be visible in reports for system to work as designed  

---

## Summary

**What needs to happen:**
1. Report queries LEFT JOIN with admin overlay tables
2. Use COALESCE to prefer admin data over ETL
3. All report endpoints updated simultaneously
4. Filter dropdowns already read from admin layer (from earlier implementation)
5. Test: admin edits → report updates

**Once complete:**
- ✅ Admin edits salesperson name → report updates
- ✅ Admin sets target → report updates
- ✅ Admin changes customer group → report updates
- ✅ Admin changes distribution channel → report updates
- ✅ Admin manages reference data → dropdowns update

