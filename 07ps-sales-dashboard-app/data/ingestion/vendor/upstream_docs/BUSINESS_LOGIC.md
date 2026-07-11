# Business Logic

This document reflects the implemented code. Where a source meaning is not explicit, it is marked **Needs confirmation**.

## Sales Line Cleaning

| Rule | Definition / exact condition | Source fields | Output fields | Implementation | Notes |
|---|---|---|---|---|---|
| Order number cleaning | Trim text; blank/`nan`/`None` becomes null. | `Related Order` -> `order_number` | `order_number` | `SalesCleaner.clean_order_numbers` | Preserves nonblank identifiers. |
| Customer cleaning | Preserve raw customer, normalize whitespace/text, and derive customer identifiers where available. | `Customer` | `customer`, `customer_raw`, `customer_id` | `SalesCleaner.clean_customer` | Missing IDs later receive deterministic synthetic IDs. |
| Product cleaning | Detect discount rows, clean product name, create normalized product name. | `Product` | `is_discount`, `product_name_clean`, `product_name_norm` | `SalesCleaner.clean_product_names` | Discount detection uses the compiled legacy pattern. |
| Quantity/value | Convert quantities and values to numeric using existing sign/discount rules. | `Qty Invoiced`, `Total`, `Untaxed Total` | `Quantity`, `Value`, `untaxed_total` | `SalesCleaner.clean_quantity`, `clean_value` | Exact legacy behavior retained. |
| Dates | Convert Odoo UTC timestamps to business timezone, normalize reporting date, remove invalid dates. | `Order Date` | `order_date`, `order_date_date`, `DateKey` | `odoo_utc_datetime_to_local`, `SalesCleaner.clean_order_dates`, `PowerBISalesPipeline.transform` | `DateKey = YYYYMMDD`. |
| Invoice filter | Unless `INCLUDE_UNINVOICED_SALES_LINES=true`, exclude `invoice_status='no'` quotation rows but retain confirmed `sale`/`done` rows. | `invoice_status`, `state` | Filtered sales rows | `PowerBISalesPipeline._filter_sales_dashboard_rows` | Logged before/after. |
| First purchase | Minimum order date at the implemented sales grain. | customer/company grain and `order_date_date` | `First_Purchase_Date` | `SalesCleaner.add_first_purchase_date` | Needs confirmation: exact grain follows code columns. |
| Invoice classification | Sum order values; classify positive, negative, or zero using `_classify_invoice`. | `order_number`, `Value` | `InvoiceValue`, `InvoiceClass` | `SalesCleaner.add_invoice_summary` | Exact class labels are code-defined. |

## CRM, Funnel, And Document Rules

| Rule | Definition / exact condition | Source fields | Output fields | Implementation | Notes |
|---|---|---|---|---|---|
| Lead vs opportunity | A row is an opportunity when `LeadType='opportunity'` or `OpenDate` exists. | `crm.lead.type`, open/create fields | `LeadID`, `OpportunityID` | `CrmCleaner.normalize_leads` | Opportunities without source lead history get an ETL lead row. |
| ETL lead history | `LeadID=ETL-LEAD-{OpportunityID}` and lead date is opportunity date minus one minute. | Opportunity row | Lead history fields | `CrmCleaner._append_etl_lead_history_rows` | Analytical only; never written to Odoo. |
| CRM active flags | Source `crm.lead.active=true` maps to 1; false/null/unavailable maps to 0. | `active` | `IsActiveLead`, `IsActiveOpportunity` | `crm.active_flags.coerce_nullable_bool`, fact builders | |
| CRM status | Win/loss/open is classified from stage/lost/active fields. | stage/lost/active fields | `IsWon`, `IsLost`, `IsOpen` | `crm_status_classifier.classify_status` | Needs confirmation for custom won-stage configuration. |
| Quotation logic | B2B-only. Real when quotation age reaches `REAL_QUOTATION_THRESHOLD_HOURS=24`; converted rows use sales-order minus quotation time, open/lost rows use refresh time. | quotation/order dates, segment, state | quotation age/classification flags | `facts.quotation_classification.add_quotation_classification` | Negative sequence is explicitly invalid. |
| Sales order logic | Real only when a B2B sales-order row links to a real quotation. | document type, quotation links, real quotation flag | `IsRealSalesOrder`, `SalesOrderClassification` | `add_sales_order_classification` | |
| Quotation outcome | Won quotation is a real quotation with a linked real sales order. | quotation link and classification | `IsWonQuotation` | `add_quotation_outcome_flags` | Runtime validation rejects inconsistent won flags. |
| Delivery logic | Move quantities drive status; picking state is fallback. Sales orders without pickings get `NO-PICK-{OrderID}` / `Not Delivered`. | `stock.picking`, `stock.move`, sales order | `Fact_Delivery`, `DeliveryStatus` | `DeliveryFactBuilder` | Allowed statuses: Not Delivered, Started, Partially Delivered, Fully Delivered. |
| Funnel logic | Funnel flags count only real quotation, real sales order, and real delivery stages. | CRM/sales/delivery facts | `HasQuotation`, `HasSalesOrder`, `HasDelivery`, `FlowType` | `PowerBISalesPipeline._attach_journey_flow_tracking` | System-generated paths remain auditable but do not inflate conversion. |

## Customer Rules

| Rule | Exact condition / formula | Implementation | Edge cases |
|---|---|---|---|
| Customer ID | Clean source ID; missing ID becomes `CUST-` plus first 8 uppercase MD5 characters of normalized customer name. | `CustomerDimensionBuilder._clean_customer_id`, `_make_synthetic_customer_id` | Blank names normalize to `UNKNOWN`. |
| New | First purchase is between current-year start and max sales date. | `_calc_status` | Blocked takes precedence. |
| Active Retained | `IsLYTD=1 AND IsYTD=1 AND IsLYFullYear=1`. | `_calc_status` | |
| Reactivated | `HasHistoryBeforeLYTD=1 AND IsLYTD=0 AND IsYTD=1`. | `_calc_status` | |
| Non Active | `IsLYTD=1 AND IsYTD=0`. | `_calc_status` | Remaining rows are `Other`. |
| Blocked | Latest blocked-customer match by CustomerID, then customer-name fallback; `IsBlocked=1` overrides status. | `_apply_blocked_customer_data`, `_calc_status` | Optional source file. |
| Customer class | B2B/B2C only: A > 600000; B 300000-599999; C 60000-299999; else D, based on `LY_Value`. | `_add_customer_class` | Boundary gap at 600000 follows current code and needs confirmation. |
| Segment | Any B2B sales => B2B; else any B2C => B2C; else Unknown. | `_add_customer_segment` | |
| YTD/LYTD/full year | Current year is based on maximum valid sales date. LYTD ends on same month/day last year; Feb 29 falls back to Feb 28. Full-year columns are fixed for 2023/2024/2025. | `CustomerDimensionBuilder.build` | Fixed full-year list needs confirmation for future years. |

## Mapping And Dimensions

| Rule | Definition | Implementation | Notes |
|---|---|---|---|
| Product mapping | Match the cleaned system product name and cleaned size to the manual product master using an exact left join. | `ProductMasterLoader`, `ProductMapper.attach` | No fuzzy or ambiguous mapping logic. |
| ProductKey | Preserve the first occurrence of each manual key and suffix later duplicate rows with a stable row number so Power BI can use `Dim_Product[ProductKey]` on the one side of the relationship. | `ProductKeyUtils.ensure_unique` | All manual-master rows remain in `Dim_Product`. |
| Salesperson/team | Active people map salesperson to TeamKey and distribution channel; team workbook supplies team, segment, city, company. | `SalesOrgRepository`, `SalesOrgEnricher` | Conflicting team channels resolve to unique value, mode, or Mixed. |
| Distribution channel | Built from active people and targets, with Unknown fallback. | `DistributionChannelDimensionBuilder` | |
| Date dimension | Starts at minimum actual sales date and ends at later of maximum sales/order date or refresh date. | `DateDimensionBuilder`, `_extend_dim_date_for_sales_and_delivery` | Includes configured weekly rest-day logic. |
| Off-days | Parse `DD/MM/YYYY`, normalize date, deduplicate Date/Type/Country/Company/Branch, create DateKey. | `OffDaysFactBuilder.build` | |

## QA Rules

Required sheets/tables, model keys, duplicate/null keys, date-key coverage, CRM linkage, delivery status, SQL row counts, incremental windows, latest-order freshness, and optional full SQL/DataFrame equality are validated in `PowerBISalesPipeline`, `ModelValidator`, `CrmModelBuilder`, and `DatabaseExporter`. Fast mode skips expensive QA exports, but structural checks and scoped SQL validation remain.
