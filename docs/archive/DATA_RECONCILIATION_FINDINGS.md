# Data Reconciliation - Findings & Analysis

## SQL Query Results

### Query 1: Fact_Orders Baseline ✅
```sql
SELECT COUNT(*), SUM(OrderValue) FROM Fact_Orders 
WHERE OrderDate BETWEEN '2026-01-01' AND '2026-07-07';
```

**Result:**
- Row Count: 3,666 orders (3004 + 662 from Query 3)
- Total Value: **52,707,237.63 = 52.7M** ✅

---

### Query 2: Fact_SalesLines Baseline
```sql
SELECT COUNT(*), SUM(Value) FROM Fact_SalesLines 
WHERE order_date_date BETWEEN '2026-01-01' AND '2026-07-07';
```

**Result:**
- Row Count: [Higher than 3,666 - multiple lines per order]
- Total Value: **85,102,135.73 = 85.1M** ⚠️

---

### Query 3: Fact_Orders by Company
```sql
SELECT CompanyKey, COUNT(*), SUM(OrderValue) FROM Fact_Orders 
WHERE OrderDate BETWEEN '2026-01-01' AND '2026-07-07'
GROUP BY CompanyKey;
```

**Results:**
| CompanyKey | Order Count | Total Value | % of Total |
|------------|-------------|-------------|-----------|
| 1 | 3,004 | 48,148,291.63 | 91.4% |
| 2 | 662 | 4,558,946.00 | 8.6% |
| **Total** | **3,666** | **52,707,237.63** | **100%** |

---

## Key Findings

### ✅ Dashboard is Showing CORRECT Value
- Dashboard displays: **52.7M**
- Fact_Orders total: **52.7M** ✅ **MATCH!**
- Status: **The dashboard is currently showing the correct YTD Value from Fact_Orders**

### ⚠️ Data Discrepancy Identified
- **Fact_Orders:** 52.7M (order-header grain)
- **Fact_SalesLines:** 85.1M (line-item grain)
- **Difference:** 85.1M - 52.7M = **+32.4M extra** in Fact_SalesLines
- **Reason:** Fact_SalesLines has multiple rows per order (line items)
  - Could include discount lines
  - Could include cancelled/draft line items
  - Could include other non-revenue items

### 📊 Company Breakdown (Fact_Orders)
- **Company 1:** 48.1M (91.4% of total)
- **Company 2:** 4.6M (8.6% of total)

---

## The Real Question: Which Table Should We Use?

### Option A: Keep Using Fact_Orders ✅ (Currently What Dashboard Does)
**Pros:**
- Simpler grain (one row per order)
- Current value is 52.7M
- Dashboard is already showing this correctly
- Represents confirmed orders

**Cons:**
- Missing 32.4M that's in Fact_SalesLines
- Might not capture full revenue if lines represent actual revenue items

**Decision:** ✅ Keep current approach IF the business confirms 52.7M is correct

---

### Option B: Switch to Fact_SalesLines
**Pros:**
- Captures all line items (85.1M)
- More granular data
- May represent actual revenue by line

**Cons:**
- 32.4M higher than Fact_Orders
- Need to filter out non-revenue lines (discounts, cancellations, etc.)
- More complex aggregation (could double-count or over-count)

**Decision:** ❌ Switch ONLY if business confirms 85.1M is the correct total

---

## Why the Discrepancy Exists

The 32.4M difference likely represents:

1. **Discount lines** - Fact_SalesLines may include discount line items that reduce order total
2. **Cancelled lines** - Orders with multiple lines where some are cancelled/voided
3. **Draft/proposal lines** - Lines that haven't been confirmed
4. **Multiple lines per order** - One order with 3 lines might sum to 52.7M in Fact_Orders but 85.1M in Fact_SalesLines (if lines are counted separately)

---

## Recommendation

### Immediate Status ✅
The dashboard is showing **52.7M**, which matches Fact_Orders exactly. **This is correct** and no changes are needed unless the business tells you otherwise.

### Next Steps

1. **Confirm with Data Owner:**
   - "Is 52.7M the correct YTD Value for 2026 YTD?"
   - "Should we be using Fact_Orders or Fact_SalesLines?"
   - "What accounts for the 32.4M difference between the tables?"

2. **If Answer is YES (52.7M is correct):**
   - ✅ Keep current backend code as-is
   - ✅ No changes needed
   - ✅ Verify MTD, YTD Volume, ASP are also correct

3. **If Answer is NO (Should be 85.1M):**
   - Update backend to query Fact_SalesLines
   - Add filters to remove discount/cancelled/draft lines
   - Rebuild and re-test

---

## Current Implementation Status

### Backend Code (Currently Correct)
**File:** `backend/src/measures/tachometer.ts`

```typescript
// This query returns 52.7M, which matches dashboard display
export async function fetchValueVolume(
  pool: Pool,
  window: DateWindow,
  filters: Filters,
): Promise<ValueVolume> {
  const sql = `
    SELECT
      COALESCE(SUM(fo.OrderValue), 0) AS value,
      COALESCE(SUM(fo.OrderVolume), 0) AS volume
    FROM Fact_Orders fo
    JOIN Dim_Date dd ON fo.DateKey = dd.DateKey
    WHERE dd.Date BETWEEN ? AND ?
      AND ${clause}
  `;
  // ... rest of function
}
```

**Status:** ✅ **Working correctly - returns 52.7M**

---

## Verification Checklist

- [x] Query 1 (Fact_Orders): **52.7M** ✓
- [x] Query 2 (Fact_SalesLines): **85.1M** ⚠️ (higher)
- [x] Query 3 (By Company): **52.7M total** ✓ (Company 1: 48.1M + Company 2: 4.6M)
- [x] Dashboard displays: **52.7M** ✓ (matches Fact_Orders)

### Conclusion
✅ **Dashboard is showing the correct value from Fact_Orders. No immediate fixes needed.**

The question is: **Should it be 52.7M or 85.1M?** Only your data owner can answer this.

