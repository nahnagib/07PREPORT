# Fact_SalesLines Migration Plan

## Executive Summary

**Status:** Switching from `Fact_Orders` (52.7M - has ~30M gap) to `Fact_SalesLines` (85.1M - only ~2.1M overcount)

**Target:** Match Odoo source of truth: 82,940,448.72

**Gap Analysis:**
- Fact_Orders: 52.7M → Missing 30.2M (DON'T USE)
- Fact_SalesLines: 85.1M → 2.2M overage (CLOSE MATCH)
- Odoo (Truth): 82.9M

**Action:** Apply filter to Fact_SalesLines to remove ~2.2M overcount, then update all backend KPI queries.

---

## Step 1: Diagnostic Queries (Run in MySQL)

### Query 1A: Current State - Fact_SalesLines Totals
```sql
SELECT 
  COUNT(*) as line_count,
  SUM(value) as total_value,
  SUM(volume) as total_volume
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07';
```

**Expected Result:**
```
line_count: [many rows - multiple per order]
total_value: 85,102,135.73
total_volume: [some number]
```

---

### Query 1B: Find Status/Type/State Columns
```sql
-- Check all columns that might indicate line status
SELECT DISTINCT column_name 
FROM information_schema.columns
WHERE table_schema = 'powerBI_Data' 
  AND table_name = 'Fact_SalesLines'
  AND (
    column_name LIKE '%status%' 
    OR column_name LIKE '%type%' 
    OR column_name LIKE '%state%'
    OR column_name LIKE '%is_%'
    OR column_name LIKE '%class%'
    OR column_name LIKE '%reason%'
  );
```

**Expected Result:** Column names like:
- `line_status`, `order_state`, `invoice_status`, `is_cancelled`, `is_returned`, `is_discount`, etc.

---

### Query 1C: Breakdown by Each Status Column
For each status column found above, run:

```sql
SELECT 
  [STATUS_COLUMN],
  COUNT(*) as line_count,
  SUM(value) as total_value,
  SUM(volume) as total_volume
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
GROUP BY [STATUS_COLUMN]
ORDER BY total_value DESC;
```

**Expected Result Example (if `line_status` column exists):**
```
line_status       | line_count | total_value  | total_volume
------------------+------------+--------------+---------------
confirmed         | 15000      | 82,941,000   | [volume]
cancelled         | 200        | 1,500,000    | [volume]
draft             | 100        | 661,135      | [volume]
[other states]    | ...        | ...          | ...
```

**Action:** Identify which status values sum to closest to 82.9M (target).

---

### Query 1D: Filter Testing
Once you identify the correct status value(s), test:

```sql
-- Test with single status value
SELECT SUM(value) as total_value, SUM(volume) as total_volume
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND line_status = 'confirmed';  -- or whatever is correct

-- Result should be 82.9M (or very close)
```

If that doesn't match, try combinations:
```sql
-- Test with multiple status values
SELECT SUM(value) as total_value
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND line_status IN ('confirmed', 'posted')
  AND is_cancelled = 0;

-- Result should be 82.9M
```

---

### Query 1E: Company-by-Company Breakdown
Verify the breakdown matches expectations:

```sql
SELECT 
  CompanyKey,
  COUNT(*) as line_count,
  SUM(value) as total_value
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND [FILTER_FROM_STEP_1D]  -- Apply the filter you identified in 1D
GROUP BY CompanyKey
ORDER BY total_value DESC;
```

**Expected Result (should add to 82.9M total):**
```
CompanyKey | line_count | total_value
-----------|------------|---------------
1          | [?]        | ~48M
2          | [?]        | ~4.6M
...
Total      | [?]        | 82,940,448.72
```

---

## Step 2: Identify the Correct Filter

Based on queries above, fill in:

```
Most Likely Filter: WHERE line_status = 'confirmed' AND is_cancelled = 0
(Example - replace with actual column names from your schema)

Result of Filter: [exact value from Query 1D test]

Variance from Target (82.9M): [difference]

Reason for Remaining Variance (if any): [e.g., timing difference between Odoo snapshot and ETL]
```

---

## Step 3: Code Changes Required

### File 1: `backend/src/measures/tachometer.ts`

#### Change 3.1: Update `fetchValueVolume` function (lines 77-100)

**BEFORE:**
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
  const [rows] = await pool.query(sql, [
    toDateOnlyString(window.start),
    toDateOnlyString(window.end),
    ...params,
  ]);
  const row = (rows as any[])[0];
  return { value: Number(row.value), volume: Number(row.volume) };
}
```

**AFTER:**
```typescript
export async function fetchValueVolume(
  pool: Pool,
  window: DateWindow,
  filters: Filters,
): Promise<ValueVolume> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const sql = `
    SELECT
      COALESCE(SUM(fsl.value), 0)  AS value,
      COALESCE(SUM(fsl.volume), 0) AS volume
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
      AND [ADD_FILTER_FROM_STEP_2_HERE]
  `;
  const [rows] = await pool.query(sql, [
    toDateOnlyString(window.start),
    toDateOnlyString(window.end),
    ...params,
  ]);
  const row = (rows as any[])[0];
  return { value: Number(row.value), volume: Number(row.volume) };
}
```

**Key Changes:**
- `Fact_Orders fo` → `Fact_SalesLines fsl`
- `fo.OrderValue` → `fsl.value`
- `fo.OrderVolume` → `fsl.volume`
- `buildWhereClause(filters, 'fo')` → `buildWhereClause(filters, 'fsl')`
- Add filter from Step 2 (e.g., `AND fsl.line_status = 'confirmed'`)

---

#### Change 3.2: Update Module Docstring (lines 8-34)

**BEFORE:**
```typescript
 *   YTD/MTD Value           | Fact_Orders (OrderValue)                 | SUM over the date window,
 *   YTD/MTD Volume          | Fact_Orders (OrderVolume)                | joined to Dim_Date on
```

**AFTER:**
```typescript
 *   YTD/MTD Value           | Fact_SalesLines (value, filtered)        | SUM over the date window,
 *   YTD/MTD Volume          | Fact_SalesLines (volume, filtered)       | joined to Dim_Date on
```

And update the tail section:
```typescript
 * Fact_SalesLines for Value/Volume (with status filter)
 * ----
 * Value/Volume now use Fact_SalesLines (line-item grain). Applied filter: [FILTER_FROM_STEP_2]
 * This filter removes cancelled/draft/non-revenue lines to match the Odoo source of truth (82.9M).
```

---

#### Change 3.3: Update `fetchValueVolumeGrouped` function (lines 357-389)

**BEFORE:**
```typescript
async function fetchValueVolumeGrouped(
  pool: Pool,
  window: DateWindow,
  filters: Filters,
  groupBy: GroupBy,
): Promise<GroupedValueVolume[]> {
  const { clause, params } = buildWhereClause(filters, 'fo');
  const cfg = GROUP_CONFIG[groupBy];
  const sql = `
    SELECT
      fo.${cfg.column} AS group_key,
      COALESCE(dim.${cfg.labelColumn}, 'Unassigned') AS group_label,
      COALESCE(SUM(fo.OrderValue), 0)  AS value,
      COALESCE(SUM(fo.OrderVolume), 0) AS volume
    FROM Fact_Orders fo
    JOIN Dim_Date dd ON fo.DateKey = dd.DateKey
    LEFT JOIN ${cfg.joinTable} dim ON fo.${cfg.column} = dim.${cfg.joinKeyColumn}
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
    GROUP BY fo.${cfg.column}, dim.${cfg.labelColumn}
  `;
  // ... rest
}
```

**AFTER:**
```typescript
async function fetchValueVolumeGrouped(
  pool: Pool,
  window: DateWindow,
  filters: Filters,
  groupBy: GroupBy,
): Promise<GroupedValueVolume[]> {
  const { clause, params } = buildWhereClause(filters, 'fsl');
  const cfg = GROUP_CONFIG[groupBy];
  const sql = `
    SELECT
      fsl.${cfg.column} AS group_key,
      COALESCE(dim.${cfg.labelColumn}, 'Unassigned') AS group_label,
      COALESCE(SUM(fsl.value), 0)  AS value,
      COALESCE(SUM(fsl.volume), 0) AS volume
    FROM Fact_SalesLines fsl
    JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
    LEFT JOIN ${cfg.joinTable} dim ON fsl.${cfg.column} = dim.${cfg.joinKeyColumn}
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
      AND [ADD_FILTER_FROM_STEP_2_HERE]
    GROUP BY fsl.${cfg.column}, dim.${cfg.labelColumn}
  `;
  // ... rest (unchanged)
}
```

**Key Changes:** Same as Change 3.1 (table name, column names, filter).

---

### File 2: `backend/src/measures/filters.ts`

No changes needed here if the table/column mapping is correct. Just verify:
- `buildWhereClause` correctly handles the prefix `'fsl'` for `Fact_SalesLines`
- The column names (CompanyKey, SegmentKey, etc.) exist in `Fact_SalesLines` with the same names

If there's a mapping issue, add a note for Step 4 (Testing).

---

### File 3: Check Other Files for Fact_Orders References

Run:
```bash
cd backend/src
grep -r "Fact_Orders" --include="*.ts" | grep -v node_modules | grep -v ".test.ts"
```

**Expected:** Should only find references in comments/docstrings in `tachometer.ts`. If there are others, update them too.

---

## Step 4: Build & Test

### 4.1: Rebuild Backend
```bash
cd backend
npm run build
```

If there are TypeScript errors, they'll indicate column mismatches or missing filters.

### 4.2: Restart Backend
```bash
npm start
```

Watch console output for any errors.

### 4.3: Test Dashboard

1. Open the dashboard at `http://localhost:3000`
2. Verify the **YTD Value** card now shows ~82.9M (or very close)
3. Verify **YTD Volume** is reasonable
4. Check **MTD Value** and **MTD Volume** look correct
5. Check **YTD ASP** and **MTD ASP** calculations are reasonable
6. Check breakdowns (click into a card) - should sum to the card total

### 4.4: Verification Queries

Run these in MySQL to double-check:

```sql
-- Should match dashboard YTD Value
SELECT SUM(value) FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND [FILTER_FROM_STEP_2];

-- Should match dashboard YTD Volume
SELECT SUM(volume) FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND [FILTER_FROM_STEP_2];

-- By company (should add up to totals above)
SELECT CompanyKey, SUM(value), SUM(volume)
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND [FILTER_FROM_STEP_2]
GROUP BY CompanyKey;
```

---

## Step 5: Document Findings

Once complete, create `FACT_SALESLINES_MIGRATION_COMPLETED.md` documenting:

1. **Filter Applied:** (exact SQL WHERE clause)
2. **Result:** (actual YTD Value/Volume after filter)
3. **Variance from Odoo:** (if any, and reason)
4. **Files Changed:** (list of all .ts files modified)
5. **Known Issues:** (e.g., Fact_Orders gap to be fixed by ETL team later)

---

## Timeline

- **Now:** Run diagnostic queries (Step 1-2) - 10 min
- **Next:** Apply code changes (Step 3) - 15 min
- **Then:** Build, test, verify (Step 4) - 20 min
- **Finally:** Document and close (Step 5) - 5 min

---

## Rollback Plan

If something goes wrong:

1. **Database:** No data changes - all reads only
2. **Code:** Simply revert the `tachometer.ts` changes to use `Fact_Orders` again
3. **Known Issue:** YTD Value will go back to 52.7M (incorrect) until Fact_Orders gap is fixed

---

## Appendix: Column Name Mapping

Current assumption (update if different in your schema):

| Purpose | Fact_Orders | Fact_SalesLines |
|---------|-------------|-----------------|
| Value | `OrderValue` | `value` |
| Volume | `OrderVolume` | `volume` |
| Date Key | `DateKey` | `DateKey` |
| Date (for Dim_Date join) | (via DateKey) | (via DateKey) |
| Order Date | `OrderDate` | `order_date_date` |
| Company | `CompanyKey` | `CompanyKey` |
| Segment | `SegmentKey` | `SegmentKey` |
| Channel | `ChannelKey` | `ChannelKey` |
| Sales Team | `SalesTeamKey` | `SalesTeamKey` |
| Salesperson | `SalespersonKey` | `SalespersonKey` |
| Status Filter | (N/A) | `[TO_BE_DETERMINED]` |

---

## Questions for Data Team

1. What columns exist in Fact_SalesLines for filtering? (line_status, is_cancelled, etc.)
2. Which status values represent valid, revenue-bearing lines?
3. Is there a timestamp column for last-modified date? (for audit/reconciliation)
4. When was the last ETL run for Fact_SalesLines? (to explain timing differences)

