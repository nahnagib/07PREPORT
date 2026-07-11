# Data Model

## Fact Tables

The sales and CRM model now uses these primary facts:

- `Fact_Lead`: one row per lead, including ETL-only lead history rows for opportunities that have no Odoo lead history. Active tracking is exposed as `IsActiveLead`.
- `Fact_Opportunity`: one row per Odoo opportunity. Active tracking is exposed as `IsActiveOpportunity`, and latest real-quotation metadata is exposed through `LastQuotationID`, `LastQuotationDate`, `LastQuotationValue`, `LastQuotationStatus`, and `DaysSinceLastQuotation`.
- `Fact_Sales`: one row per quotation or sales-order document from Odoo `sale.order`.
- `Fact_Delivery`: sales-order delivery status grain from Odoo `stock.picking` and `stock.move`.
- `Fact_Orders`: retained for backward compatibility with existing order-level report dependencies and aligned with `Fact_Sales` linkage columns. Its unique order-level key is `OrderKey`; `InvoiceKey` is intentionally not unique here.

The legacy overloaded CRM/funnel/activity facts are retired and are dropped from SQL exports: `Fact_Pipeline`, `Fact_PipelineFunnel`, `Fact_PipelineEvents`, and `Fact_PipelineActivity`.

The existing detailed sales support tables remain available where used by current reports: `Fact_SalesLines`, `Fact_Targets`, and `Fact_OffDays`.

## Dimension Tables

The model includes dimensions for date, customer, salesperson, sales team, company, product, distribution channel, segment, and invoice. CRM adds `Dim_CRMStage` and `Dim_LostReason`.

`Dim_LostReason` keeps the original Odoo reason text in `LostReason` and adds `LostReasonEnglish` for clean Power BI labels. Known Arabic and mixed-case English reasons are mapped to standardized English values; unmapped Arabic reasons are labeled `Other / Unmapped`, while unmapped English reasons keep their original text.

## Expected Power BI Relationships

- `Fact_Lead[LeadCreatedDateKey]`, `Fact_Opportunity[OpportunityCreatedDateKey]`, `Fact_Sales[DateKey]`, `Fact_Delivery[OrderDateKey]`, `Fact_Delivery[ScheduledDateKey]`, and existing sales date keys to `Dim_Date[DateKey]`
- `Fact_Lead[CustomerKey]`, `Fact_Opportunity[CustomerKey]`, `Fact_Sales[CustomerKey]`, `Fact_Delivery[CustomerKey]`, `Fact_Orders[CustomerKey]`, and `Fact_SalesLines[CustomerKey]` to `Dim_Customer[CustomerKey]`
- `Fact_Lead[SalespersonKey]`, `Fact_Opportunity[SalespersonKey]`, `Fact_Sales[SalespersonKey]`, `Fact_Delivery[SalespersonKey]`, `Fact_Orders[SalespersonKey]`, and `Fact_Targets[SalespersonKey]` to `Dim_Salesperson[SalespersonKey]`
- `Fact_Lead[SalesTeamKey]`, `Fact_Opportunity[SalesTeamKey]`, `Fact_Sales[SalesTeamKey]`, `Fact_Delivery[SalesTeamKey]`, `Fact_Orders[SalesTeamKey]`, and `Fact_Targets[SalesTeamKey]` to `Dim_SalesTeam[SalesTeamKey]`
- `Fact_Lead[CompanyKey]`, `Fact_Opportunity[CompanyKey]`, `Fact_Sales[CompanyKey]`, `Fact_Delivery[CompanyKey]`, and existing sales company keys to `Dim_Company[CompanyKey]`
- `Fact_Sales[ChannelKey]`, `Fact_Orders[ChannelKey]`, and `Fact_Targets[ChannelKey]` to `Dim_DistributionChannel[ChannelKey]`
- `Fact_Lead[SegmentKey]`, `Fact_Opportunity[SegmentKey]`, `Fact_Sales[SegmentKey]`, `Fact_Delivery[SegmentKey]`, and `Fact_Targets[SegmentKey]` to `Dim_Segment[SegmentKey]`
- `Dim_Invoice[InvoiceKey]` is the one side for invoice relationships. `Fact_Sales[InvoiceKey]` and `Fact_Orders[InvoiceKey]` are many-side columns; do not use `Fact_Orders[InvoiceKey]` as a primary key.
- `Fact_Opportunity[StageID]` to `Dim_CRMStage[StageID]`

Use `Fact_Delivery[DeliveryStatus]` for delivery status slicers. Valid values are `Not Delivered`, `Started`, `Partially Delivered`, and `Fully Delivered`.

Use `JourneyKey` plus the native fact keys (`LeadID`, `OpportunityID`, `QuotationID`, `SalesOrderID`, and `DeliveryID`) for conversion and leakage measures across the business journey.

`Fact_Opportunity[FirstQuotationDate]` remains the first quotation timestamp carried from the CRM journey spine. `Fact_Opportunity[LastQuotationDate]` is a separate lookup from `Fact_Sales`: for each opportunity, it selects the latest real B2B quotation where `SalesDocumentType = Quotation`, `IsRealQuotation = true`, `SalesSegment = B2B`, and both `OpportunityID` and `QuotationID` are present. Ties on `LastQuotationDate` are resolved deterministically by the highest `QuotationID` and then document number. `DaysSinceLastQuotation` is calculated from `LastQuotationDate` to the business refresh timestamp and is blank when no eligible quotation exists.

Real quotation classification is B2B-only and uses minute-level aging against a configurable 24-hour threshold (`REAL_QUOTATION_THRESHOLD_HOURS = 24`, 1,440 minutes). Converted quotations compare `SalesOrderDate - QuotationDate`; open and lost/cancelled quotations compare the pipeline refresh timestamp to `QuotationDate`. `QuotationRealReason` records the specific outcome, including converted after 24h, still open after 24h, lost/cancelled after 24h, system-converted within 24h, invalid date sequence, missing dates, or not applicable.

`IsWonQuotation` marks quotation rows that are real and have a linked real sales order. `IsRealSalesOrder` is true only for B2B sales-order rows with a quotation link whose linked quotation is real. `IsRealDelivery` is true only for delivery rows linked to a real sales order.

Funnel stage flags use real-stage logic: quotation counts use `IsRealQuotation`, sales-order counts use `IsRealSalesOrder`, and delivery counts use `IsRealDelivery`, so system-generated quotation paths remain in the facts but do not inflate funnel conversion metrics.

CRM active flags are sourced from Odoo `crm.lead.active`: `true` becomes `1`; `false`, null, or unavailable values become `0`. Existing CRM status fields are retained for backward compatibility.

`Dim_Date` is generated from the actual sales order date coverage and the business refresh date. It starts on the minimum sales order date and ends on the later of the maximum sales order date or the current refresh date in the configured business timezone. Model validation fails if any fact sales/order date key or the refresh date key is missing from `Dim_Date[DateKey]`.
