# CRM And Delivery Module

## Odoo Models Used

The module reads these Odoo models through the API:

- `crm.lead`
- `crm.stage`
- `crm.lost.reason`
- `sale.order`
- `stock.picking`
- `stock.move`

The pipeline calls `fields_get` before reading data and skips optional fields that do not exist in the current Odoo database.

## Fact Logic

`Fact_Lead` keeps one row per lead and includes ETL-only lead history rows when an opportunity has no source lead history in Odoo. `IsActiveLead` is sourced from Odoo `crm.lead.active`: active records map to `1`, and inactive, null, or unavailable source values map to `0`.

Opportunities keep `LeadID` from Odoo when Odoo exposes a real linked lead. When Odoo has no lead history row, the ETL creates a history-only lead step with `LeadID = ETL-LEAD-{OpportunityID}`, `LeadType = Systematic`, `LeadCreationSource = ETL`, `IsOdooCreatedLead = false`, and `IsETLCreatedLead = true`. Its `LeadCreatedDate` is one minute before the opportunity date, and its active flag is inherited from the source opportunity.

`Fact_Opportunity` keeps one row per Odoo opportunity and carries its `LeadID`, `JourneyKey`, stage, probability, expected revenue, `IsActiveOpportunity`, win/loss flags, and first quotation metadata. `IsActiveOpportunity` uses the opportunity row's `crm.lead.active` value with the same active `1`, inactive/null `0` mapping.

`JourneyKey` is the analytical flow key shared across `Fact_Lead`, `Fact_Opportunity`, `Fact_Sales`, and `Fact_Delivery`.

`Fact_Sales` is built from `sale.order` and includes both quotations and sales orders. It stores `OpportunityID`, `LeadID`, `IsLinkedToOpportunity`, and quotation linkage for every sales order through `QuotationID` and `SourceQuotationID`. Real quotations are B2B quotations aged at least 24 hours, using `SalesOrderDate` for converted quotations and the pipeline refresh timestamp for open or lost/cancelled quotations. `IsWonQuotation` identifies real quotation rows with a linked real sales order. Real funnel sales-order counts use `IsRealSalesOrder`, which is true only when the B2B sales order is linked to a real quotation.

`Fact_Delivery` is built from `stock.picking` and `stock.move`. It links each delivery row to `SalesOrderID` / `OrderID`, carries the related sales order `OrderDate` and `OrderDateKey` for order-date filtering, and calculates `DeliveryStatus` from move quantities when available, with picking state as fallback. Real funnel delivery counts use `IsRealDelivery`, which is true only for actual deliveries linked to real sales orders.

## Delivery Status

Allowed delivery status values are:

- `Not Delivered`
- `Started`
- `Partially Delivered`
- `Fully Delivered`

Move quantities are preferred:

- zero delivered quantity and not started: `Not Delivered`
- zero delivered quantity and started: `Started`
- delivered quantity between zero and total demand: `Partially Delivered`
- delivered quantity greater than or equal to demand: `Fully Delivered`

Picking state fallback maps draft, cancel, waiting, and confirmed to `Not Delivered`; assigned to `Started`; done to `Fully Delivered`; and partially available or mixed move states to `Partially Delivered`.

## Flow Values

The internal journey QA metadata classifies journeys as `Full Flow`, `Lead to Sales`, `Lead to Quotation`, `Lead to Opportunity Only`, `Lead Only`, `Opportunity to Sales`, `Opportunity to Quotation`, `Opportunity Only`, `Direct Quotation to Sales`, `Sales Without CRM`, `Direct Quotation Only`, or `Unknown`.

Internal furthest-stage values are `Delivered`, `Partially Delivered`, `Delivery Started`, `Delivery`, `Sales Order`, `Quotation`, `Opportunity`, `Lead`, and `Unknown`.
