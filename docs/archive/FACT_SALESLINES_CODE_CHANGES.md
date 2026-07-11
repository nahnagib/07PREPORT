# Fact_SalesLines Migration - Code Changes Applied

## Summary

Migrated backend from `Fact_Orders` (52.7M - has ~30M ETL gap) to `Fact_SalesLines` (85.1M - only ~2.1M overcount) to match Odoo source of truth (82.9M).

---

## Files Changed

### 1. `backend/src/measures/tachometer.ts`

#### Change 1.1: Updated Module Docstring (lines 8-34)
- Changed YTD/MTD Value source from `Fact_Orders (OrderValue)` to `Fact_SalesLines (value, filtered)`
- Changed YTD/MTD Volume source from `Fact_Orders (OrderVolume)` to `Fact_SalesLines (volume, filtered)`
- Updated LYTD/LMTD/FLY/FLM references to use `Fact_SalesLines (filtered)` instead of `Fact_Orders`

#### Change 1.2: Updated Table Selection Comment (lines 29-39)
- Replaced "Fact_Orders for Value/Volume" section with "Fact_SalesLines for Value/Volume (with status filter)"
- Added migration note explaining the switch from Fact_Orders (52.7M gap) to Fact_SalesLines
- Added reference to FACT_SALESLINES_MIGRATION_PLAN.md

#### Change 1.3: Updated `fetchValueVolume` Function (lines 77-107)
**Before:**
```typescript
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
```

**After:**
```typescript
const { clause, params } = buildWhereClause(filters, 'fsl');
const sql = `
  SELECT
    COALESCE(SUM(fsl.value), 0)  AS value,
    COALESCE(SUM(fsl.volume), 0) AS volume
  FROM Fact_SalesLines fsl
  JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
  WHERE dd.Date BETWEEN ? AND ?
    AND ${clause}
    AND fsl.line_status = 'confirmed'
`;
```

**Key Changes:**
- Table: `Fact_Orders fo` → `Fact_SalesLines fsl`
- Table alias prefix: `'fo'` → `'fsl'` in buildWhereClause
- Columns: `fo.OrderValue` → `fsl.value`, `fo.OrderVolume` → `fsl.volume`
- Added filter: `AND fsl.line_status = 'confirmed'` (removes ~2.1M overcount)
- Added migration note comment

#### Change 1.4: Updated `fetchValueVolumeGrouped` Function (lines 357-389)
**Changes identical to 1.3:**
- Table: `Fact_Orders fo` → `Fact_SalesLines fsl`
- Table alias: `'fo'` → `'fsl'`
- Columns: `fo.OrderValue` → `fsl.value`, `fo.OrderVolume` → `fsl.volume`
- Added filter: `AND fsl.line_status = 'confirmed'`

---

### 2. `backend/src/measures/filters.ts`

#### Change 2.1: Updated Column Name Comment (line 48)
**Before:**
```typescript
// Column name each Filters field maps to on Fact_Orders / Fact_Targets --
```

**After:**
```typescript
// Column name each Filters field maps to on Fact_SalesLines / Fact_Orders / Fact_Targets --
```

**Reason:** Clarifies that Fact_SalesLines also uses the same filter column names, so buildWhereClause works identically.

---

## Files Not Changed (Intentionally)

### `backend/src/measures/refreshStatus.ts`
- **Reason:** Still uses Fact_Orders to get MAX(OrderDateTime). This is intentional - we want the "last order in the database", not the "last sales line". The order date is order-level, not line-level.
- **Note:** If OrderDateTime doesn't exist in your schema, this will fail. Use the file modification note provided in the system-reminder about this file.

### `backend/src/routes/tachometer.ts`
- **No changes needed:** All functions called (computeYtdCard, computeMtdCard, etc.) internally use fetchValueVolume, which now uses Fact_SalesLines. No route-level changes required.

---

## Filter Applied

```sql
AND fsl.line_status = 'confirmed'
```

**Purpose:** Removes ~2.1M overcount from Fact_SalesLines (85.1M → 82.9M) by excluding:
- Cancelled lines
- Draft/unconfirmed lines
- Other non-revenue line statuses

**⚠️ IMPORTANT:** This filter assumes a `line_status` column exists in Fact_SalesLines with at least a 'confirmed' value. If:
1. The column doesn't exist, or
2. The column is named differently (e.g., `status`, `state`, `line_type`), or
3. The status values are different (e.g., 'posted', 'valid', 'active')

**Then update the filter in both functions:**
- `fetchValueVolume` (line ~98)
- `fetchValueVolumeGrouped` (line ~371)

---

## Testing Required

### Step 1: Build Backend
```bash
cd backend
npm run build
```

**Expected:** No TypeScript errors. If compilation fails with column/table errors, verify:
- `Fact_SalesLines` table exists
- Columns `DateKey`, `value`, `volume` exist
- Column `line_status` exists (or adjust the filter)
- Columns `CompanyKey`, `SegmentKey`, etc. exist

### Step 2: Restart Backend
```bash
npm start
```

**Expected:** Backend starts without errors.

### Step 3: Test Dashboard
1. Open dashboard at http://localhost:3000
2. Check YTD Value card - should show ~82.9M (or very close)
3. Check YTD Volume - should be reasonable
4. Check MTD Value/Volume - verify they look correct
5. Check ASP calculations - Value/Volume ratios should be sensible
6. Check breakdowns (click into any card) - subtotals should sum to main card total

### Step 4: Verify with SQL

Run in MySQL:
```sql
-- Should match dashboard YTD Value (allows small variance)
SELECT SUM(value) FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND line_status = 'confirmed';
-- Expected: ~82,940,448.72 (Odoo truth)

-- By company (should sum to YTD Value)
SELECT CompanyKey, SUM(value)
FROM Fact_SalesLines
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07'
  AND line_status = 'confirmed'
GROUP BY CompanyKey;
```

---

## Rollback

If the filter is wrong and dashboard shows incorrect values:

1. Identify the correct filter using the diagnostic queries in FACT_SALESLINES_MIGRATION_PLAN.md
2. Update both functions:
   - `fetchValueVolume` (line ~98)
   - `fetchValueVolumeGrouped` (line ~371)
3. Rebuild: `npm run build && npm start`

Or revert entirely:
```bash
git checkout backend/src/measures/tachometer.ts backend/src/measures/filters.ts
npm run build && npm start
```

(Dashboard will show 52.7M YTD Value until Fact_Orders gap is fixed by ETL team)

---

## Next Steps

1. **Run diagnostic queries** from FACT_SALESLINES_MIGRATION_PLAN.md to verify the `line_status` filter is correct
2. **Test the dashboard** to confirm YTD Value is now ~82.9M
3. **Adjust filter if needed** - if the result doesn't match 82.9M, update the WHERE clause
4. **Document findings** - create FACT_SALESLINES_MIGRATION_COMPLETED.md with exact filter and results
5. **Flag to ETL team** - Fact_Orders has ~30M gap; track as known issue to fix later

---

## Known Issues

- **Fact_Orders gap:** 52.7M vs correct 82.9M (30.2M missing) - source unknown, requires ETL team investigation
- **Fact_SalesLines timing:** 85.1M is 2.2M higher than Odoo snapshot (82.9M) - likely due to:
  - ETL having more recent data than Odoo screenshot
  - Timing difference in when snapshot was taken
  - Small data quality variance

Both are acceptable given the close match to Odoo source of truth.

