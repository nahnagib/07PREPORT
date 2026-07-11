from __future__ import annotations

import pandas as pd

from sales_pipeline.facts.quotation_classification import add_quotation_classification


class PipelineFactBuilder:
    COLUMNS = [
        "PipelineRecordID", "LeadID", "OpportunityID", "OdooLeadID", "SourceLeadID",
        "IsOdooCreatedLead", "IsETLCreatedLead", "IsSystemGeneratedLead",
        "GeneratedLeadReason", "LeadCreationSource", "JourneyKey", "JourneyType", "FlowType",
        "HasLead", "HasOpportunity", "HasQuotation", "HasSalesOrder", "HasDelivery",
        "QuotationID", "SalesOrderID", "DeliveryID", "DeliveryStatus",
        "LeadCreatedDate", "OpportunityCreatedDate", "QuotationDate", "SalesOrderDate",
        "QuotationToSalesOrderMinutes", "QuotationToSalesOrderHours",
        "IsRealQuotation", "IsSystemGeneratedQuotation", "QuotationClassification",
        "DeliveryDate",
        "LeadName", "LeadType", "CreatedDate", "CreatedDateKey", "UpdatedDate",
        "UpdatedDateKey", "OpenDate", "OpenDateKey", "ClosedDate", "ClosedDateKey",
        "ExpectedCloseDate", "ExpectedCloseDateKey", "ExpectedRevenue", "ProratedRevenue",
        "Probability", "ProbabilityBucket", "StageID", "Stage", "Salesperson", "SalespersonID",
        "SalespersonKey", "SalesTeam", "SalesTeamID", "SalesTeamKey", "SalesSegment",
        "SegmentKey", "Company", "CompanyKey", "Customer", "CustomerID", "Source", "Medium",
        "Campaign", "Tags", "LostReason", "LostReasonID", "IsActive",
        "IsWon", "IsLost", "IsOpen", "IsInactive",
        "DaysInPipeline", "DaysSinceUpdate", "DaysUntilExpectedClose", "AgingBucket",
        "ActivityState", "NextActivityDate", "HasNextStep", "HasRecentActivity", "OpportunityCount",
    ]

    def build(self, leads: pd.DataFrame) -> pd.DataFrame:
        out = add_quotation_classification(leads)
        for col in self.COLUMNS:
            if col not in out.columns:
                out[col] = pd.NA
        return out[self.COLUMNS]
