# SQL Data Reconciliation: YTD Value Source of Truth

## The Problem: Three Different YTD Value Numbers

| Source | YTD Value | Status |
|--------|-----------|--------|
| Dashboard | 52.7M | Currently displayed (wrong?) |
| Fact_Orders | TBD | Need to verify |
| Fact_SalesLines | 84.57M | Alternative source |

**Goal:** Identify which table is correct and why the discrepancy exists.

---

## Investigation Queries

### Query 1: Fact_Orders Baseline
```sql
-- Run this first to get the baseline from Fact_Orders
SELECT 
  COUNT(*) as order_count,
  SUM(OrderValue) as total_value,
  MIN(OrderDate) as earliest_order,
  MAX(OrderDate) as latest_order,
  COUNT(DISTINCT CompanyKey) as company_count
FROM Fact_Orders
WHERE OrderDate BETWEEN '2026-01-01' AND '2026-07-07';
```

**Expected output:**
```
order_count: [?]
total_value: [?]  (compare to 52.7M and 84.57M)
earliest_order: 2026-01-01 (or later?)
latest_order: 2026-07-07 (or earlier?)
company_count: [?]
```

### Query 2: Fact_SalesLines Baseline
```sql
-- Run this to understand Fact_SalesLines structure
SELECT 
  COUNT(*) as line_count,
  SUM(Value) as total_value,
  MIN(order_date_date) as earliest_order,  -- or OrderDate or DateKey - check column name
  MAX(order_date_date) as latest_order,
  COUNT(DISTINCT CompanyKey) as company_count
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07';
```

**Expected output:**
```
line_count: [?]  (will be higher than order_count if multiple lines per order)
total_value: 84.57M  (should match what you said)
earliest_order: 2026-01-01 (or later?)
latest_order: 2026-07-07 (or earlier?)
company_count: [?]
```

### Query 3: Identify All Status/Type Columns in Fact_SalesLines
```sql
-- Check what columns exist that might filter out non-revenue lines
SELECT COLUMN_NAME, COLUMN_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'Fact_SalesLines'
  AND (COLUMN_NAME LIKE '%status%' 
       OR COLUMN_NAME LIKE '%type%' 
       OR COLUMN_NAME LIKE '%state%'
       OR COLUMN_NAME LIKE '%class%'
       OR COLUMN_NAME LIKE '%is_%');

-- OR just look at the first few rows to see what columns exist:
SELECT * FROM Fact_SalesLines LIMIT 1\G
```

**Expected output:**
Columns like: `line_status`, `is_discount`, `is_cancelled`, `invoice_status`, `order_state`, etc.

### Query 4: Compare With Filters Applied

Once you identify status/type columns, test:

```sql
-- Fact_SalesLines - WITHOUT filters
SELECT SUM(Value) as total_value
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07';
-- Should show: 84.57M

-- Fact_SalesLines - WITH status filter (example - adjust based on actual columns)
SELECT SUM(Value) as total_value
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND (invoice_status = 'Paid' OR invoice_status = 'Posted')  -- Adjust based on what's valid
  AND is_discount = 0;  -- Exclude discount lines?
-- Result: [?]

-- Fact_SalesLines - Compare to Fact_Orders
-- (Orders represent confirmed orders, SalesLines represent line items)
-- One order might have multiple lines, so:
-- SUM(Fact_SalesLines.Value) should be >= SUM(Fact_Orders.OrderValue)
```

### Query 5: Identify Why Dashboard Shows 52.7M

```sql
-- Test: Is 52.7M the result of a single company/segment/channel?
SELECT 
  CompanyKey,
  SUM(OrderValue) as value_by_company
FROM Fact_Orders
WHERE OrderDate BETWEEN '2026-01-01' AND '2026-07-07'
GROUP BY CompanyKey
ORDER BY value_by_company DESC;

-- If one company has 52.7M and another has 32M, total = 84.57M (or close)
-- This would explain why dashboard shows only one company!

-- Similarly for Fact_SalesLines:
SELECT 
  CompanyKey,
  SUM(Value) as value_by_company
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
GROUP BY CompanyKey
ORDER BY value_by_company DESC;
```

### Query 6: Check Current Filter Applied on Dashboard

If the backend is filtering by `CompanyKey = 1` (for example):

```sql
-- Fact_Orders with CompanyKey filter
SELECT SUM(OrderValue)
FROM Fact_Orders
WHERE OrderDate BETWEEN '2026-01-01' AND '2026-07-07'
  AND CompanyKey = 1;  -- or whatever company is selected

-- If this returns 52.7M, then the dashboard is correct for THAT company
-- But the YTD should show 78M or 84.57M for ALL companies

-- Check: Is there a default CompanyKey=1 filter being applied somewhere?
```

---

## Key Questions to Answer

1. **Which table is the source of truth?**
   - Fact_Orders (order-header grain, one row per order)
   - Fact_SalesLines (line-item grain, multiple rows per order)
   - Both? (Use Fact_Orders for order counts, Fact_SalesLines for detail?)

2. **What does each number represent?**
   - 52.7M: One company's orders? (seems likely)
   - 84.57M: All companies' order lines? (seems likely)
   - What about discounts, cancelled lines, draft orders?

3. **Are there filters that should apply?**
   - Should we exclude discount lines?
   - Should we exclude cancelled/draft orders?
   - Should we only count certain invoice statuses?

4. **Why is the dashboard showing 52.7M instead of 84.57M?**
   - Is a CompanyKey filter pre-selected?
   - Is the backend querying Fact_Orders when it should query Fact_SalesLines?
   - Is there a WHERE clause filtering out some lines?

---

## Expected Outcomes

### Scenario A: Fact_Orders is Correct
```
Fact_Orders total: 78M
Fact_SalesLines total: 84.57M (higher because of multiple lines per order, discounts, etc.)

Action: Keep using Fact_Orders
Dashboard should show: 78M (all companies) or 52.7M (one company if filtered)
Check: Why is dashboard showing 52.7M? Is CompanyKey=1 pre-selected?
```

### Scenario B: Fact_SalesLines is Correct
```
Fact_Orders total: 52.7M + other company X M = 78M total? (doesn't add up to 84.57M)
Fact_SalesLines total: 84.57M (correct, includes all line items)

Action: Update backend to query Fact_SalesLines instead
Dashboard should show: 84.57M (or filtered amount)
Note: Check if Fact_SalesLines needs status/type filters
```

### Scenario C: Data Quality Issue
```
Fact_Orders total: Some number
Fact_SalesLines total: Different number
Difference reason: Some orders are in one table but not the other

Action: Ask data owner which is authoritative
May need to reconcile the data sources
```

---

## Backend Code Location

Once you confirm the correct table and filters:

**File:** `backend/src/measures/tachometer.ts`

**Current code (lines ~81-100):**
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
  // ...
}
```

**Will need to change to** (if Fact_SalesLines is correct):
```typescript
const sql = `
  SELECT
    COALESCE(SUM(fsl.Value), 0) AS value,
    COALESCE(SUM(fsl.Volume), 0) AS volume
  FROM Fact_SalesLines fsl
  JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
  WHERE dd.Date BETWEEN ? AND ?
    AND ${clause}
    AND fsl.line_status IN ('Valid', 'Active')  -- Add filters as needed
`;
```

---

## Investigation Checklist

Run these in order and document results:

### Step 1: Run Query 1 (Fact_Orders)
```
[ ] Run: SELECT COUNT(*), SUM(OrderValue) FROM Fact_Orders WHERE OrderDate BETWEEN '2026-01-01' AND '2026-07-07';
Result: count=[?], sum=[?]M
```

### Step 2: Run Query 2 (Fact_SalesLines)
```
[ ] Run: SELECT COUNT(*), SUM(Value) FROM Fact_SalesLines WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07';
Result: count=[?], sum=[?]M (should be 84.57M)
```

### Step 3: Check Columns
```
[ ] Run: SHOW COLUMNS FROM Fact_SalesLines;
List any status/type/state columns: [?]
```

### Step 4: Run Query 5 (By Company)
```
[ ] Run: SELECT CompanyKey, SUM(OrderValue) FROM Fact_Orders WHERE ... GROUP BY CompanyKey;
Results:
  CompanyKey 1: [?]M
  CompanyKey 2: [?]M
  Total: [?]M
```

### Step 5: Confirm Source of Truth
```
[ ] Ask data owner: Is the correct YTD Value:
    - 52.7M (one company)?
    - 78M (Fact_Orders total)?
    - 84.57M (Fact_SalesLines total)?
    - Something else?

Answer: [?]

[ ] Ask data owner: Should we filter by status/type columns?
    Which columns? [?]
    Which values to include? [?]
```

### Step 6: Update Backend
```
[ ] Update fetchValueVolume() in tachometer.ts to use:
    - Table: [Fact_Orders / Fact_SalesLines]
    - Filters: [list any status/type filters]

[ ] Rebuild: npm run build
[ ] Restart: npm start
[ ] Test dashboard: Should show [?]M
```

---

## Data Owner Questions

When asking your data owner, provide them with these questions:

1. **For YTD Value reporting, which is the source of truth?**
   - Confirmed orders from Fact_Orders? (order-header grain)
   - All line items from Fact_SalesLines? (line-item grain)
   - A combination?

2. **What about these scenarios?**
   - An order with multiple lines: count once or multiple times?
   - A discount line: include or exclude?
   - A cancelled order: include or exclude?
   - A draft/not-yet-invoiced order: include or exclude?

3. **What filters should apply?**
   - Example: "Only include orders with `invoice_status = 'Posted'`"
   - Example: "Only include lines with `is_discount = 0`"

4. **Why the discrepancy?**
   - Has the ETL pipeline changed recently?
   - Are there known data quality issues?
   - Should we reconcile Fact_Orders vs Fact_SalesLines?

---

## Resolution Timeline

Once you have the answer from data owner:

**Today:** Run Queries 1-5 above, get answers
**Tomorrow:** Update backend code, test, verify
**Soon:** Update MTD Value, YTD Volume, YTD ASP using same logic
**Later:** Audit all KPI cards to ensure they're using correct tables/filters

