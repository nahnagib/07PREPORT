# Data Source Clarification Request for YTD Value

## Context
We're connecting a sales dashboard to the `powerBI_Data` MySQL database. The dashboard is showing three different YTD Value numbers depending on the data source, and we need your guidance on which is correct.

## The Three Numbers

**Dashboard currently shows:** 52.7M  
**Query on Fact_Orders (Jan 1 - Jul 7, 2026):** [PENDING - need to run query]  
**Query on Fact_SalesLines (Jan 1 - Jul 7, 2026):** 84.57M

## The Question

**For YTD Value reporting in the dashboard, which table should be the source of truth?**

Option A: **Fact_Orders** (order-header grain)
- One row per confirmed order
- Contains: OrderValue, OrderVolume, OrderDate, OrderDateTime
- Simpler, aggregates to order level
- Example: "Order #12345 has OrderValue = 1000"

Option B: **Fact_SalesLines** (line-item grain)
- Multiple rows per order (one row per line item)
- Contains: Value, Volume, order_date_date, order_datetime, and possibly: is_discount, invoice_status, order_state, line_status
- More granular, includes item-level details
- Example: "Order #12345 has 3 line items: 500 + 300 + 200 = 1000"

Option C: **Other** (combination or different table entirely)
- Please specify which table and which columns

---

## Secondary Questions

### 1. Line-Item Handling
**If using Fact_SalesLines:**
- Should discount lines be included or excluded?
- Should we sum all rows regardless of `invoice_status` / `order_state`?
- Are there any status values that should filter out non-revenue items?

### 2. Data Quality
**Known issues:**
- Are Fact_Orders and Fact_SalesLines always in sync?
- Should we filter by specific status values? (e.g., "only Paid or Posted invoices")
- Any recent ETL pipeline changes that might explain the discrepancy?

### 3. Business Definition
**What does "YTD Value" mean?**
- Year-to-date revenue from all confirmed orders?
- Year-to-date revenue only from invoiced/paid orders?
- Year-to-date revenue from all lines in all orders (including potential discounts)?

---

## What We'll Do Based on Your Answer

Once you confirm the source of truth, we will:

1. Update the dashboard backend to query the correct table
2. Apply any necessary filters (status, type, etc.)
3. Verify the displayed value matches the correct number
4. Apply the same logic to MTD Value, YTD Volume, and YTD ASP
5. Test end-to-end with the corrected data

---

## Recommended Response Format

Please provide:

```
Source of Truth Table: [Fact_Orders / Fact_SalesLines / Other]

Filters to Apply: [e.g., "Only include lines where invoice_status IN ('Paid', 'Posted')"]

Reason for Discrepancy: [e.g., "Fact_SalesLines includes discounts; use Fact_Orders for revenue"]

Known Issues: [e.g., "ETL pipeline was updated on 2026-06-15"]

Contact for Questions: [name/email]
```

---

## Data Team Technical Details (For Reference)

The current backend code is in: `backend/src/measures/tachometer.ts`

Current query (fetches from Fact_Orders):
```sql
SELECT SUM(OrderValue) as value, SUM(OrderVolume) as volume
FROM Fact_Orders fo
JOIN Dim_Date dd ON fo.DateKey = dd.DateKey
WHERE dd.Date BETWEEN '2026-01-01' AND '2026-07-07'
```

If you need to change to Fact_SalesLines, the query would be:
```sql
SELECT SUM(Value) as value, SUM(Volume) as volume
FROM Fact_SalesLines fsl
JOIN Dim_Date dd ON fsl.DateKey = dd.DateKey
WHERE dd.Date BETWEEN '2026-01-01' AND '2026-07-07'
```

Plus any filters you recommend (status, type, is_discount, etc.)

---

## Timeline

**This week:** Confirm source of truth with data owner  
**Next:** Update dashboard backend code  
**Then:** Re-test and validate all KPI cards show correct values

