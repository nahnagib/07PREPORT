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
- **Thresholds for a shared product** (BCG volume, overstock, stock-out risk) are those of the company that sold more
  of it this calendar year, by value. If neither company sold it this year, the larger all-time value decides.
  - The ETL stores the chosen company as `ThresholdCompany` in `Dim_ProductDashboardGroup`.
  - Example: CemAir uses Tika's thresholds.
  - This rule was approved by the business owner on 2026-09-30.
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

It is read-only against Odoo. It exits non-zero on any mismatch. It checks:

- 10 products (the top 5 plus 5 random), each in its company view, against the source rows;
- that every BMH row equals the sum of its company parts;
- that all products + Unmapped equal the Sales pages' total, per company and for BMH;
- CemAir per company and BMH against live Odoo;
- with `--odoo`, stock on hand and unit cost per company against live Odoo. Stock that Odoo changed after the ETL's
  snapshot is reported as "moved since snapshot", not as a mismatch.

It needs an admin API token in `DASHBOARD_TOKEN`. The local test account it used before (`claude.test.admin@bmh.local`)
was disabled on 2026-09-30.


---

## 9. Local test stack

Production runs on this PC (Docker project `07ps-sales-dashboard-app`, ports 3000/4000/5001). A separate **test stack**
runs next to it, so code can be tried on a copy of the real data first.

| | Test stack |
|---|---|
| Start | `test-stack-start.cmd` in the repo root. It copies the production database (a read-only `mysqldump --single-transaction`), loads it into the test database, then builds and starts the stack. `test-stack-start.cmd /keepdata` skips the copy. |
| Stop | `test-stack-stop.cmd`. The test database is kept. `test-stack-stop.cmd /purge` also deletes it. |
| Docker project | `07ps-test`, with its own network, volumes and images (`07ps/*:test`). Production's containers and `07ps/*:local` images are never touched. |
| Addresses | Dashboard http://localhost:3202/Dashboard, backend http://localhost:4201, ETL API http://localhost:4202, MySQL 127.0.0.1:33309. |
| Database | Its own MySQL container (`test-mysql`). All services use `test-mysql:3306`. The start script refuses to run if any service points at the production database host. |
| ETL | Schedules are off. Start a run from Admin › ETL Control Center. The input folder is mounted read-only. Odoo is only read. |
| Sign-in | The same accounts as production, as of the copy. |
| Defined in | `07ps-sales-dashboard-app/docker-compose.test-stack.yml` |

The copy is written to `07ps-sales-dashboard-app/db_backups/test-stack-copy.sql`. That file holds production data and is
gitignored; delete it when it is no longer needed.

---

## 10. Open items (recorded 2026-09-30, not fixed)

| Item | Detail |
|---|---|
| `Fact_Orders.CustomerKey` drift | `CustomerKey` is a row number after sorting customers by name (`legacy_transform._add_customer_key`). A new customer shifts every later key. Incremental runs rewrite `Fact_Orders` only for the recent window, so older orders keep stale keys (38,655 of 38,902 orders differed in the test warehouse). `Fact_SalesLines` and `Dim_Customer` are fully rewritten each run and agree. No dashboard number reads `Fact_Orders.CustomerKey` today. Fix: stable customer keys (reuse the existing key per CustomerID). |
| Tests and lint already failing on `main` | 4 ETL tests: `test_input_check.py::test_wrong_case_file_name_gets_a_near_match_hint` (case-insensitive Windows disk) and 3 Excel-workbook tests in `test_product_dimension.py` that expect `QA_UnmappedProducts.xlsx`, which the exporter now deletes on purpose. Lint: 70 backend errors, 8 frontend errors. All of these were already on `main` (`d9957a8`) before the Product pages work. |
| New customers 2,244 vs 2,245 | In the test warehouse, the YTD new-customer count at anchor 28 Sep went from 2,244 to 2,245 between test runs 3 and 4. The state before run 4 was not kept, so the one customer could not be identified. The Odoo orders changed between those runs all belong to customers with orders before 2026. Today `Dim_Customer.First_Purchase_Date` matches `Fact_SalesLines` exactly. |
| Test accounts in production | `kaizen.admin`, `kaizen.em`, `kaizen.viewer` and `kaizen.sales` @kaizen-test.local are ACTIVE. They belong to the Kaizen work; decide when that work ships. `claude.test.admin@bmh.local` is disabled (status INACTIVE, sessions revoked), not deleted. |
| Scheduled runs need the PC awake and online | The production stack runs on this Windows PC. When it sleeps, no ETL runs. On 30 Sep it slept from 18:12 to 09:38, so the 21:00, 00:00, 02:00 (full), 03:00, 06:00 and 09:00 runs did not happen. Runs at 17:00 and 20:00 on 29 Sep and at 15:00 on 30 Sep failed on DNS (`majaal.odoo.com: Name or service not known`). |
