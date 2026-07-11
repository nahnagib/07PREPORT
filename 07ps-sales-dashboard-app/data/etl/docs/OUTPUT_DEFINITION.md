# Output Definition

## Fact_Sales

Purpose: quotation and sales-order analysis. Grain: one Odoo `sale.order` document. Key columns: `SalesDocumentID`, `SalesDocumentType`, `QuotationID`, `SourceQuotationID`, `OrderID`, `SalesOrderID`, `OrderNumber`, `OpportunityID`, `LeadID`, `JourneyKey`, `IsLinkedToOpportunity`, `OrderDate`, `QuotationDate`, `SalesOrderDate`, `QuotationAgeMinutes`, `QuotationAgeHours`, `QuotationToSalesOrderMinutes`, `QuotationToSalesOrderHours`, `IsRealQuotation`, `IsSystemGeneratedQuotation`, `IsWonQuotation`, `QuotationClassification`, `QuotationRealReason`, `IsRealSalesOrder`, `SalesOrderClassification`, `DateKey`, customer/sales/team/company/segment/channel keys, `OrderValue`, `OrderVolume`, `InvoiceStatus`, `OrderState`, and `InvoiceKey`.

Sales orders keep their quotation linkage by setting `SourceQuotationID` and `QuotationID` to the originating Odoo sale-order record.

Real quotation classification is B2B-only and uses a configurable 24-hour threshold (`REAL_QUOTATION_THRESHOLD_HOURS = 24`, or 1,440 minutes). Converted quotations compare `SalesOrderDate - QuotationDate`; open and lost/cancelled quotations compare the pipeline refresh timestamp to `QuotationDate`. `QuotationRealReason` explains whether the record is converted after 24h, still open after 24h, lost/cancelled after 24h, system-converted within 24h, invalid, missing dates, or not applicable.

`IsWonQuotation` is true for quotation rows only when the quotation is real and a linked sales-order row exists with `IsRealSalesOrder = true`.

`IsRealSalesOrder` is true only for B2B `SalesDocumentType = Sales Order` rows with a quotation link (`QuotationID` or `SourceQuotationID`) whose linked quotation has `IsRealQuotation = true`. Other sales-order rows are classified as `System Generated / Non-CRM Sales Order`; non-sales-order rows are `Unclassified`.

## Fact_Lead

Purpose: CRM lead generation and lead-source analysis. Grain: one lead. Key columns: `LeadID`, `OdooLeadID`, `JourneyKey`, `LeadName`, `LeadType`, `LeadCreatedDate`, `LeadCreatedDateKey`, `LeadSource`, `Medium`, `Campaign`, `Tags`, owner/team/company/customer keys, `IsOdooCreatedLead`, `IsETLCreatedLead`, `LeadCreationSource`, `IsActiveLead`, `IsConvertedToOpportunity`, and `OpportunityID`.

`IsActiveLead` comes from Odoo `crm.lead.active`. Active source rows are `1`; inactive, null, or unavailable source values are `0`. Opportunities without an Odoo lead history row receive an analytical lead step with `LeadID = ETL-LEAD-{OpportunityID}` and `LeadCreatedDate = OpportunityCreatedDate - 1 minute`; that generated lead step inherits the source opportunity's active flag.

## Fact_Opportunity

Purpose: CRM opportunity and pipeline progression analysis. Grain: one opportunity. Key columns: `OpportunityID`, `LeadID`, `JourneyKey`, `OpportunityCreatedDate`, `ExpectedCloseDate`, `StageID`, `Stage`, `Probability`, `ExpectedRevenue`, `ProratedRevenue`, `IsActiveOpportunity`, `IsWon`, `IsLost`, `IsOpen`, `LostReason`, owner/team/company/customer keys, `HasQuotation`, `FirstQuotationDate`, and `OpportunityAge`.

`IsActiveOpportunity` uses the opportunity row's Odoo `crm.lead.active` value: active source rows are `1`; inactive, null, or unavailable source values are `0`.

## Fact_Delivery

Purpose: delivery progress analysis for sales orders. Grain: one picking row plus a `Not Delivered` placeholder row for sales orders with no picking. Key columns: `DeliveryFactID`, `PickingID`, `SalesOrderID`, `OrderNumber`, `SourceQuotationID`, `OpportunityID`, `LeadID`, customer/sales/team/company/segment keys, `OrderDate`, `OrderDateKey`, `ScheduledDate`, `ScheduledDateKey`, `DoneDate`, `DoneDateKey`, `DeliveryDate`, `DeliveryStatus`, `IsRealDelivery`, `DeliveryClassification`, `OrderedQuantity`, `DeliveredQuantity`, `RemainingQuantity`, and `DeliveryProgressPercent`.

`OrderDate` and `OrderDateKey` are inherited from the related sales order through `SalesOrderID` / `OrderNumber` so delivery analysis can be filtered by order date while keeping delivery lifecycle dates available.

`IsRealDelivery` is true only for actual delivery rows linked to a real sales order. Deliveries linked to non-real sales orders are classified as `System Generated / Non-CRM Delivery`; rows without an actual delivery or without a sales-order link are `Unclassified`.

## Fact_Orders

Purpose: backward-compatible order-level summary for existing report dependencies. Grain: one order number. It is enriched with `Fact_Sales` linkage columns so order logic does not conflict with the new sales fact.

Use `OrderKey` as the unique order-level key. `InvoiceKey` is allowed to repeat because multiple orders can point to the same invoice dimension row; relate it as the many side to `Dim_Invoice[InvoiceKey]`. Quotation and sales-order classification fields are inherited from the matching `Fact_Sales` sales-order row.

## Existing Support Tables

`Fact_SalesLines`, `Fact_Targets`, and `Fact_OffDays` remain available for existing detailed sales, target, and calendar logic.

## Dimensions And QA

Core dimensions: `Dim_Date`, `Dim_Customer`, `Dim_Salesperson`, `Dim_SalesTeam`, `Dim_Company`, `Dim_Product`, `Dim_DistributionChannel`, `Dim_Segment`, `Dim_Invoice`, `Dim_CRMStage`, and `Dim_LostReason`.

QA sheets: `QA_UnmappedProducts`, `QA_CRM_MissingLinks`, `QA_CRM_DataQuality`, `QA_CRM_UnmappedKeys`, and `QA_CRM_FieldAvailability`. In SQL incremental fast mode, expensive QA sheets are skipped unless `--include-qa` or `--full-validation` is passed.
