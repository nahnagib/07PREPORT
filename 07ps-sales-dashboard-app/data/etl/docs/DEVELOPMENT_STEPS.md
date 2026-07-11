# Development Steps

## Step 1: Move From Scraping To Odoo API

The old script logged into the Odoo web UI and called web session endpoints. The new project uses XML-RPC with API key authentication through `OdooClient`.

## Step 2: Fetch `sale.report`

`SalesReportRepository` calls `search_count` and batched `search_read` on `sale.report`. The default batch size is `500` and can be changed with `BATCH_SIZE`.

## Step 3: Normalize Raw Sales Columns

Odoo fields are mapped to the old export names, then normalized to the cleaning pipeline names such as `order_date`, `order_number`, `customer`, `product_name`, and `invoice_status`.

## Step 4: Load Excel Reference Files

The pipeline loads:

- `sales_targets.xlsx`
- `SalesTeam.xlsx`
- `OffDays.xlsx`
- `PRODUCTS.xlsx`
- `BlockedCustomers.xlsx`

If `BlockedCustomers.xlsx` is missing, an empty template is created.

## Step 5: Apply Cleaning Rules

The existing business logic is preserved: order/customer/product cleanup, discount detection, numeric cleanup, invoice filtering, first purchase date, sales org enrichment, company normalization, invoice classification, and product mapping.

## Step 6: Build Dimensions

Dimension builders create date, customer, salesperson, sales team, company, product, distribution channel, segment, and invoice dimensions.

## Step 7: Build Facts

Fact builders create sales lines, orders, targets, and off days.

## Step 8: Export Workbook

`WorkbookExporter` writes every Power BI sheet to `SalesModel_OneOutput.xlsx`.

## Step 9: Validate With Power BI

Refresh Power BI against the exported workbook and confirm that sheet and column names are unchanged.
