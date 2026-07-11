# Power BI Compatibility

## Sheet Names Must Not Change

The Power BI report is linked to fixed Excel sheet names. This model revision intentionally replaces the overloaded `Fact_Pipeline` sheet with `Fact_Lead` and `Fact_Opportunity`; report queries that referenced `Fact_Pipeline` must be repointed to the new facts.

The original sales sheets remain available. CRM analysis now uses `Fact_Lead` and `Fact_Opportunity`, sales document analysis uses `Fact_Sales`, and delivery status analysis uses `Fact_Delivery`.

`Fact_Opportunity` now includes latest real-quotation fields sourced from `Fact_Sales`: `LastQuotationID`, `LastQuotationDate`, `LastQuotationValue`, `LastQuotationStatus`, and `DaysSinceLastQuotation`. These fields do not replace `FirstQuotationDate`; `FirstQuotationDate` is the first CRM/spine quotation date, while `LastQuotationDate` is the latest eligible real B2B quotation date for the opportunity.

SQL export preserves the same names as database table names. Because these names use mixed case, SQL clients should query them with quoted identifiers in PostgreSQL, for example `public."Fact_SalesLines"`.

## Column Names Must Not Change

Power Query steps and model relationships often reference exact column names. The pipeline keeps compatibility names such as `Invoice Class`, `company_final`, `CustomerKey`, `DateKey`, `ProductKey`, and `InvoiceKey`.

## Date Handling Rule

Odoo API datetime values are treated as UTC and converted to the configured business timezone before any reporting dates are derived. If `TIMEZONE` is not configured, the code default is `Asia/Riyadh`; this installation uses the value in `.env`.

For sales facts, keep these fields separate:

- `order_date` is the local business timestamp.
- `order_date_date` is the local business date normalized to midnight. It is the reporting date for YTD, DateKey, and Power BI date relationships.

Do not timezone-shift `order_date_date` after it has been normalized. Convert the raw Odoo UTC timestamp first, then derive `order_date_date`.

CRM and delivery dates use the same UTC-to-business-time conversion for `crm.lead`, `sale.order`, `stock.picking`, and `stock.move` datetime fields.

Power BI should relate sales tables to `Dim_Date` through `DateKey` generated from `order_date_date`, not through the `order_date` timestamp. YTD logic should filter the date field inclusively, for example `order_date_date >= start of year` and `order_date_date < current business date + 1 day`. Avoid timestamp filters such as `order_date <= CURRENT_DATE`, because that excludes the current day after midnight.

`Dim_Date` is bounded by actual sales order coverage plus the business refresh date, not by a static unrelated range or whole-year expansion. The pipeline starts at the minimum sales order date, ends at the later of the maximum sales order date or refresh date, and validates that sales/order date keys plus the refresh date key are present in `Dim_Date[DateKey]`.

For invoice relationships, use `Dim_Invoice[InvoiceKey]` as the one side and fact-table `InvoiceKey` columns as the many side. `Fact_Orders[InvoiceKey]` can contain duplicates; use `Fact_Orders[OrderKey]` for a unique order-level key.

The SQL exporter writes the same modeled columns produced for Excel. Integer keys remain integer columns where possible, timestamps are written as timestamp/datetime columns, booleans as boolean-compatible columns, and text as text-compatible columns.

## Recommended Refresh Process

1. Run `python -m sales_pipeline.main`.
2. Confirm `Exports\SalesModel_OneOutput.xlsx` was updated.
3. Open Power BI and refresh.
4. Review `QA_UnmappedProducts`.
5. Review `QA_CRM_DataQuality`.
6. Review `QA_CRM_MissingLinks`.
7. Review `QA_CRM_FieldAvailability`.
8. Review the separate `QA_UnmappedProducts.xlsx` workbook.
