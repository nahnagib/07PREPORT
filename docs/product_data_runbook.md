# Product data runbook

For whoever maintains `PRODUCTS.xlsx` and reads the Product pages: BCG Matrix, Stock Velocity, PIM Contribution
and Product Lifecycle.

---

## 1. Where the numbers come from

- **Every ETL run** rebuilds the product tables from the same Odoo data the Sales pages use:
  - incremental runs every 3 hours;
  - a full run every night.
- Nothing is sample, scaled or typed in by hand.
- Each Product page shows **"Data as of …"**, which is the time of the last successful ETL run. If the data is stale, the
  same warning bar as on the Sales pages appears.

| Step | What happens |
|---|---|
| 1 | The ETL reads Odoo **Sales Analysis** (`sale.report`) — the same numbers you see in *Sales > Reporting > Sales Analysis*. It is read-only; nothing is ever written to Odoo. |
| 2 | Every order line is matched to `PRODUCTS.xlsx` on **Company + Odoo product name** (rules in §3). |
| 3 | Stock on hand is read from Odoo (`stock.quant`), for internal locations only (rules in §5). |
| 4 | The ETL writes `Fact_ProductSalesDaily`, `Dim_ProductDashboard`, `Dim_ProductDashboardGroup` (BMH view), `QA_ProductUnmapped`, `QA_ProductDataQuality` and `ProductDashboard_Meta`. The pages read only these tables. |

---

## 2. Updating `PRODUCTS.xlsx`

The file lives in the ETL input folder (`07PREPORT/Input/PRODUCTS.xlsx`, mounted at `/etl/input` in Docker).

1. Keep **one row per Odoo product**, on the sheet named **`Products`**.
2. Required columns (exact names):
   - `ProductKey`, `Company`, `Category`, `Brand`, `SubBrand`, `Family`;
   - `ProductName`, `OdooProductName`, `ProductLevel`, `SKU`, `Size`, `IsActive`.
3. `Company` must be `Majaal` or `Tika`.
4. `OdooProductName` must be the Odoo product name exactly as in Odoo. The `[CODE]` prefix is optional; it is ignored.
5. **Company + OdooProductName must be unique.** Case, extra spaces and the `[CODE]` prefix don't count as a
   difference. `[GRVS-010] GROUT CREMA - C02` and `GROUT CREMA - C02` are the *same* name.
6. Check the file before replacing it:
   ```
   cd 07ps-sales-dashboard-app/data/etl
   python scripts/import_products.py path/to/PRODUCTS.xlsx --dry-run
   ```
   - The check prints the row count, rows per company, and rows with a blank Category, ProductName or SKU.
   - If anything is wrong, it prints the **Excel row numbers** and exits with an error.
   - It also prints **warnings**, which never reject the file (see §3, "Same product in both companies"):
     - rows that share a `ProductName` but have a different Category, Brand, SubBrand or Family;
     - a product that looks the same in both companies under different `ProductName`s (equal once spaces,
       punctuation and a `[CODE]` prefix are removed). Those are **not** combined until the names match.
7. Replace the file **in the input folder on the host** (`07PREPORT/Input`).
   - The folder is mounted **read-only** into the ETL, so the ETL can never change it.
   - This is expected: the input folder stays read-only, and PRODUCTS.xlsx is updated directly in the folder.
   - The ETL Control Center (Admin › ETL, "Input files") shows a note that the folder is read-only, and its button
     is **Check file**. It runs the same check:
     - a bad file is rejected with the reason and the Excel row numbers;
     - a good file gets "is valid … checked, not replaced": an information message, not an error. Nothing is saved.
8. The next ETL run re-matches **all** history. To load the table immediately, run the script without `--dry-run`.
   It writes `dim_product_master` in one transaction.

A rejected file never replaces the current one. If a bad file reaches the ETL anyway, the run stops with the same
message, and the pages keep showing the last good data.

`IsActive` is read from the sheet as you maintain it. The old automatic rewrite of `IsActive` from Odoo is now off
(`PRODUCTS_WRITE_BACK_ISACTIVE=false`).

---

## 3. How lines are matched to products

- Match key: **Company + Odoo product name**, normalized. The name is normalized by:
  - turning tabs and non-breaking spaces into spaces;
  - removing a leading `[code] `;
  - collapsing repeated spaces;
  - trimming;
  - uppercasing.
- **Never across companies.** For example, Tika's "Cem Air" and Majaal's "Cemair" are different products.
- The Odoo product id is kept on every sales line (`Fact_SalesLines.OdooProductID`). If an `OdooProductID` column is ever
  added to the sheet, an id match will take priority over the name.
- In a company view, a product is **Company + Odoo product name**, and the page shows the sheet's `ProductName`.
  - `ProductKey` is only used as a label. It is not unique, so it is never used to group.

### Same product in both companies (BMH view)

- With **no company selected** (BMH view), products are grouped by the sheet's **`ProductName`**, normalized the same
  way (code prefix, spaces, case), **across companies**. Majaal "Cemair" and Tika "Cem Air" both have ProductName
  "Cemair", so they are one row. Matching (above) is unchanged: every sale stays with its own company.
- Select a company and you see only that company's part. Example: BMH value 1,000 = Majaal 300 + Tika 700.
- Value, volume, stock and stock value are the exact sum of the company rows. Ratios are recomputed from the combined
  figures, never averaged:
  - velocity = combined volume ÷ days;
  - days of inventory = combined stock ÷ combined average daily sales;
  - margin = combined (value − cost) ÷ combined value;
  - BCG class and lifecycle are computed on the combined lines.
- Thresholds (BCG volume, overstock, stock-out risk) are those of the company that sold more of the product this
  calendar year (by value; if neither sold this year, all-time value). The ETL stores it as `ThresholdCompany`.
- Volumes are still never added across units of measure.
- Unmapped products are never grouped.
- To combine two rows, give them the same `ProductName` in the sheet. The import check warns about likely pairs.
- A user whose role is limited to one company always gets that company's view.
- Matching never adds or drops a line. A test and a runtime check both assert that row counts and totals are
  identical before and after the join.

---

## 4. The Unmapped list

- A sales or stock line whose Company + name is not in the sheet is **Unmapped**. It is not dropped.
  - It is included in every total.
  - Each page shows a line like "Unmapped: LYD 12K · 340 UNIT · 7 products".
- To see which names are unmapped, query `QA_ProductUnmapped`:
  ```sql
  SELECT Source, Company, OdooProductName, OdooProductIDs, Lines, Value, Qty, UoM, FirstSeen, LastSeen, StockQty
  FROM qa_productunmapped ORDER BY Value DESC;
  ```
  - `Source = Sales` means sold but not in the sheet.
  - `Source = Stock` means in stock but not in the sheet.
- To fix a row, add it to `PRODUCTS.xlsx` with that exact `Company` and `OdooProductName`, then re-upload.

---

## 5. Metric definitions

| Metric | Definition |
|---|---|
| **Sales included** | Confirmed orders only (Odoo state `sale`/`done`); no quotations, no cancelled orders. Order date is in Africa/Tripoli time. Companies are Majaal and TIKA — the same scope as the Sales pages. |
| **Intercompany** | Sales to group companies are **included**, like on the Sales pages. They are flagged `IsIntercompany` for information only; the list is in `data/etl/config/product_dashboard.json`. |
| **Value** | Sum of the untaxed line amount (LYD) in the selected period. The default period is 1 Jan to today. |
| **Volume** | Sum of the **invoiced** quantity (the same quantity as the Sales pages), in the product's unit of measure. |
| **Units of measure** | Quantities in different units are **never added together**. A product sold in two units shows each unit separately. Totals across products are shown per unit (for example "12K UNIT · 450 m²") or in LYD. |
| **Velocity (/day)** | Volume in the period ÷ days in the period (the end date is capped at today). |
| **Stock on hand** | Odoo quantity in internal locations of finished-goods warehouses. Raw-materials warehouses are excluded. In-transit stock (Vessel) is shown separately and never counted as on hand. Negative quants count as 0 and are listed in the data-quality log. |
| **LYD tied up / Inventory value** | Odoo's own stock valuation of that on-hand stock. |
| **Days of inventory (DOH)** | Stock on hand ÷ average daily sales. Average daily sales = invoiced quantity in the last **90 days** ÷ 90. The look-back is `days_of_inventory.lookback_days` in the config. |
| **Stock band** | Overstock if DOH is above the company threshold (Majaal 180 days, Tika 60). Stock-out risk if DOH is below the threshold (Majaal 60, Tika 30). **Stock with no sales in the look-back is "No movement" and counts as Overstocked** — never as stock-out risk. |
| **Avg Days of Inventory (KPI)** | Average DOH across products that sold in the period, weighted by their sales value (the existing rule). |
| **Fast vs Slow movers** | Products sold in the period (positive value; discount pseudo-products excluded) are split at the median velocity. The "Fast Movers" KPI is the top third by velocity. Bars show LYD, because units differ between products. |
| **BCG class** | Calendar YTD. HV = YTD volume ≥ 3,500 (Majaal) or 25,000 (Tika). HP = gross profit ≥ 35%, where GP% = (Value − Qty × Odoo standard cost) ÷ Value, with cost read **per company** in Odoo. Stars = HV/HP, Cash Cows = HV/LP, Strategic = LV/HP, Dogs = LV/LP. Paper Bags and Raw Materials are excluded. **Products sold without a standard cost are "Unclassified (no cost)"** and listed in the data-quality log. |
| **BCG movement** | YTD class vs the same period last year: New, Stable, Improved, Drop (Declined), or Discontinued (sold last year, not this year). |

### Lifecycle rule

All thresholds are in `lifecycle` in the config. They are applied in this order:

1. **Never sold**: no sale in the whole history. This is its own segment; these products are not Discontinued.
2. **Discontinued**: `IsActive = 0` in the sheet, **or** no sale in the last 365 days.
3. **New**: first sale in the last 180 days.
4. **Growing**: invoiced quantity in the last 90 days is more than 20% above the previous 90 days. A product with sales
   now and none in the previous 90 days is also Growing.
5. **Declining**: more than 20% below the previous 90 days.
6. **Mature**: within ±20%.

---

## 6. Data-quality log

To see the data-quality items, query `QA_ProductDataQuality`:

```sql
SELECT `Check`, Company, ProductName, Detail, Qty, Value FROM qa_productdataquality ORDER BY `Check`, Value DESC;
```

- `NegativeStock`: a location with negative on-hand stock (counted as 0).
- `NoCost`: sold this year without a standard cost in Odoo, so it is excluded from BCG.
- `MixedUoM`: sold in more than one unit of measure.

---

## 7. Changing a rule

- Edit `data/etl/config/product_dashboard.json`. It holds:
  - the look-back;
  - the thresholds;
  - the lifecycle rule;
  - the stock warehouse classes;
  - the intercompany list.
- The next ETL run applies the change. The rules actually used are stored with each run in `ProductDashboard_Meta`.

---

## 8. Checking the numbers

Run the reconciliation script:

```
python 07ps-sales-dashboard-app/scripts/reconcile_products.py --api-url http://localhost:4000 --odoo
```

It compares 10 products (the top 5 plus 5 random) against the source rows. It checks that all products + Unmapped equal
the Sales pages' total, and reconciles CemAir per company against live Odoo. It exits non-zero on any mismatch.
