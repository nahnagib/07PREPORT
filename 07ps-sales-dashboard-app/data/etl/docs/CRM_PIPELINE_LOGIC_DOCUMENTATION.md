# CRM Pipeline Logic Documentation

CRM reporting is built from Odoo `crm.lead`, `sale.order`, `stock.picking`, and `stock.move`, with CRM stage and lost-reason dimensions.

## Fact_Lead

`Fact_Lead` has one row per lead. Real CRM leads come from Odoo `crm.lead`; ETL-created history rows are added only when an opportunity has no source lead history in Odoo.

- `LeadID`: source lead reference when Odoo exposes one; otherwise deterministic ETL history ID `ETL-LEAD-{OpportunityID}`.
- `JourneyKey`: shared flow key. Odoo lead journeys use `LEAD-{LeadID}` and ETL lead-history journeys use `ETL-LEAD-{OpportunityID}`.
- `IsActiveLead`: source-active tracking from Odoo `crm.lead.active`. `true` maps to `1`; false, null, or unavailable source values map to `0`.
- `IsConvertedToOpportunity`: true when the lead journey has an opportunity.

When Odoo does not expose a lead history row for an opportunity, the ETL adds one analytical history row only. It does not write to Odoo. These rows have `LeadType = Systematic`, `LeadCreationSource = ETL`, `IsOdooCreatedLead = false`, `IsETLCreatedLead = true`, and `LeadCreatedDate = OpportunityCreatedDate - 1 minute`. The ETL-generated row inherits active tracking from the source opportunity record.

## Fact_Opportunity

`Fact_Opportunity` has one row per Odoo opportunity. It carries `OpportunityID`, `LeadID`, `JourneyKey`, opportunity creation date, expected close date, stage, probability, expected revenue, prorated revenue, `IsActiveOpportunity`, win/loss/open flags, owner/team/company/customer keys, `HasQuotation`, and `FirstQuotationDate`.

`IsActiveOpportunity` uses Odoo `crm.lead.active` from the opportunity row. `true` maps to `1`; false, null, or unavailable source values map to `0`.

## Fact_Sales

`Fact_Sales` is built from Odoo `sale.order` and includes both quotations and sales orders. Sales orders retain `QuotationID` and `SourceQuotationID`, because Odoo sales orders originate from quotations even when conversion is immediate.

CRM linkage comes from `sale.order.opportunity_id`; `LeadID` is resolved through the internal CRM journey spine before the final facts are exported.

`Fact_Sales` carries commercial document fields and the shared `JourneyKey`; it does not store delivery lifecycle columns.

## Fact_Delivery

`Fact_Delivery` is built from `stock.picking` and `stock.move`. It links deliveries to `Fact_Sales` through `SalesOrderID` / `OrderID`. Sales orders without pickings receive a deterministic `NO-PICK-{OrderID}` row with `DeliveryStatus = Not Delivered`.

`Fact_Delivery` inherits the same `JourneyKey` as its sales order. It also carries `OrderDate` and `OrderDateKey` from the related sales order so delivery rows can be filtered by order date while retaining `ScheduledDate`, `DoneDate`, and `DeliveryDate`.

Delivery status is calculated from move quantities first and picking state as fallback. Only these values are emitted:

- `Not Delivered`
- `Started`
- `Partially Delivered`
- `Fully Delivered`

## Journey And Conversion Analysis

Each journey is traceable through `JourneyKey` and the stage keys in the four facts. The QA checks validate lifecycle dates in this order:

```text
LeadCreatedDate -> OpportunityCreatedDate -> QuotationDate -> SalesOrderDate -> DeliveryDate
```

The separated facts support conversion measures for Leads to Opportunities, Opportunities to Quotations, Quotations to Sales Orders, and Sales Orders to Delivery without relying on a single overloaded pipeline fact.

Quotation classification is added during fact cleaning before Power BI. The rule is B2B-only and uses the 24-hour threshold in minutes. Converted quotations compare `SalesOrderDate - QuotationDate`; open and lost/cancelled quotations compare the pipeline refresh timestamp to `QuotationDate`. Gaps below 1,440 minutes on converted records are system-generated, gaps of 1,440 minutes or more are real, missing quotation dates are unclassified, and negative converted gaps are retained but flagged as invalid.

Quotation outcome tracking adds `IsWonQuotation` for quotation rows that are real and have a linked real sales order. `SalesSegment` is trimmed and uppercased before comparing to `B2B`.

Real funnel progression follows the document chain. A real sales order must be a `Sales Order` row whose related quotation is real, and a real delivery must be an actual delivery linked to a real sales order. Journey funnel flags count only real quotation, real sales order, and real delivery stages; system-generated quotation paths stay in the facts for audit but are excluded from funnel conversion counts.

The internal journey QA metadata classifies journeys as `Full Flow`, `Lead to Sales`, `Lead to Quotation`, `Lead to Opportunity Only`, `Lead Only`, `Opportunity to Sales`, `Opportunity to Quotation`, `Opportunity Only`, `Direct Quotation to Sales`, `Sales Without CRM`, `Direct Quotation Only`, or `Unknown`.

Internal furthest-stage values are `Delivered`, `Partially Delivered`, `Delivery Started`, `Delivery`, `Sales Order`, `Quotation`, `Opportunity`, `Lead`, and `Unknown`.

## Retired Facts

The following legacy facts are no longer generated and are dropped from SQL exports when present:

- `Fact_Pipeline`
- `Fact_PipelineFunnel`
- `Fact_PipelineEvents`
- `Fact_PipelineActivity`

Delivery status reporting now uses `Fact_Delivery[DeliveryStatus]`.
