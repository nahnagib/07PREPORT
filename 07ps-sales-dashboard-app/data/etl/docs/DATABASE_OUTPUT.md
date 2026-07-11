# Database Output

The pipeline can export the complete modeled output to SQL in addition to the Excel workbook.

## Run Commands

```powershell
python -m sales_pipeline.main --output sql
python -m sales_pipeline.main --output both
```

## Tables Created

The database table names match the workbook sheet names exactly. The primary lifecycle facts are:

```text
Fact_Lead
Fact_Opportunity
Fact_Sales
Fact_Delivery
```

Existing support tables and dimensions are also exported, including backward-compatible `Fact_Orders`, `Fact_SalesLines`, `Fact_Targets`, `Fact_OffDays`, all core dimensions, CRM dimensions, and QA sheets.

`Fact_Sales` includes quotation and sales-order classification fields: `QuotationAgeMinutes`, `QuotationAgeHours`, `QuotationToSalesOrderMinutes`, `QuotationToSalesOrderHours`, `IsRealQuotation`, `IsSystemGeneratedQuotation`, `IsWonQuotation`, `QuotationClassification`, `QuotationRealReason`, `IsRealSalesOrder`, and `SalesOrderClassification`. Real quotation aging uses the 24-hour threshold against either `SalesOrderDate` for converted quotations or the pipeline refresh timestamp for open/lost quotations. `Fact_Orders` inherits those fields for matching sales orders.

`Fact_Delivery` includes `IsRealDelivery` and `DeliveryClassification`. Delivery funnel metrics should count only `IsRealDelivery = true`, which excludes deliveries from system-generated quotation paths.

Retired fact tables are dropped during SQL export if they exist:

```text
Fact_Pipeline
Fact_PipelineFunnel
Fact_PipelineEvents
Fact_PipelineActivity
```

## Verify Row Counts

The pipeline logs SQL row-count validation after export. Useful checks:

```sql
SELECT COUNT(*) FROM `Fact_Lead`;
SELECT COUNT(*) FROM `Fact_Opportunity`;
SELECT COUNT(*) FROM `Fact_Sales`;
SELECT COUNT(*) FROM `Fact_Delivery`;
```

Delivery status filters should use `Fact_Delivery`.`DeliveryStatus`, with values limited to `Not Delivered`, `Started`, `Partially Delivered`, and `Fully Delivered`.

For incremental loading details and force/full-refresh commands, see `INCREMENTAL_LOADING.md`.
