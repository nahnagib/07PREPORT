from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from config.settings import Settings
from sales_pipeline.crm.active_flags import coerce_nullable_bool
from sales_pipeline.crm.crm_aging import aging_bucket
from sales_pipeline.crm.crm_status_classifier import classify_status
from sales_pipeline.odoo.sales_report_repository import odoo_utc_datetime_to_local, safe_datetime_to_local


def date_key(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series, errors="coerce").dt.strftime("%Y%m%d").astype("Int64")


def clean_text(series: pd.Series) -> pd.Series:
    return series.astype("string").str.replace(r"[\r\n\t]+", " ", regex=True).str.strip().replace({"": pd.NA, "False": pd.NA})


@dataclass
class CrmCleaner:
    settings: Settings

    def normalize_leads(self, leads: pd.DataFrame, stages: pd.DataFrame) -> pd.DataFrame:
        out = pd.DataFrame(index=leads.index)
        source = leads.copy()
        if not stages.empty and "is_won" in stages.columns and "id" in stages.columns:
            won_mask = stages["is_won"].fillna(False).astype(bool)
            won_stage_ids = set(pd.to_numeric(stages.loc[won_mask, "id"], errors="coerce").dropna().astype(int).tolist())
        else:
            won_stage_ids = set()

        mappings = {
            "LeadID": "id",
            "LeadName": "name",
            "LeadType": "type",
            "IsActive": "active",
            "ExpectedRevenue": "expected_revenue",
            "ProratedRevenue": "prorated_revenue",
            "Probability": "probability",
            "AutomatedProbability": "automated_probability",
            "SourceLeadID": "lead_id_id",
            "ParentLeadID": "parent_id_id",
            "StageID": "stage_id_id",
            "Stage": "stage_id",
            "Salesperson": "user_id",
            "SalespersonID": "user_id_id",
            "SalesTeam": "team_id",
            "SalesTeamID": "team_id_id",
            "Company": "company_id",
            "Customer": "partner_id",
            "CustomerID": "partner_id_id",
            "Source": "source_id",
            "Medium": "medium_id",
            "Campaign": "campaign_id",
            "Tags": "tag_ids",
            "LostReason": "lost_reason_id",
            "LostReasonID": "lost_reason_id_id",
            "WonStatus": "won_status",
            "ActivityState": "activity_state",
            "ActivitySummary": "activity_summary",
            "ActivityUser": "activity_user_id",
        }
        for target, src in mappings.items():
            out[target] = source[src] if src in source.columns else pd.NA

        date_mappings = {
            "CreatedDate": "create_date",
            "UpdatedDate": "write_date",
            "OpenDate": "date_open",
            "ClosedDate": "date_closed",
            "ExpectedCloseDate": "date_deadline",
            "NextActivityDate": "activity_date_deadline",
        }
        for target, src in date_mappings.items():
            out[target] = odoo_utc_datetime_to_local(source[src], self.settings.timezone) if src in source.columns else pd.NaT

        for col in ["LeadName", "LeadType", "Stage", "Salesperson", "SalesTeam", "Company", "Customer", "Source", "Medium", "Campaign", "Tags", "LostReason", "WonStatus", "ActivityState", "ActivitySummary"]:
            out[col] = clean_text(out[col])

        out["IsActive"] = coerce_nullable_bool(out["IsActive"])
        for col in ["ExpectedRevenue", "ProratedRevenue", "Probability", "AutomatedProbability"]:
            out[col] = pd.to_numeric(out[col], errors="coerce")
        for col in ["LeadID", "SourceLeadID", "ParentLeadID", "StageID", "SalespersonID", "SalesTeamID", "CustomerID", "LostReasonID"]:
            out[col] = pd.to_numeric(out[col], errors="coerce").astype("Int64")

        out["OdooLeadID"] = out["LeadID"]
        lead_type = out["LeadType"].astype("string").str.strip().str.lower()
        is_opportunity = lead_type.eq("opportunity") | out["OpenDate"].notna()
        source_lead_id = out["SourceLeadID"].combine_first(out["ParentLeadID"])

        out["OpportunityID"] = pd.Series(pd.NA, index=out.index, dtype="Int64")
        out.loc[is_opportunity, "OpportunityID"] = out.loc[is_opportunity, "OdooLeadID"]
        real_lead_ids = set(out.loc[~is_opportunity, "OdooLeadID"].dropna().astype("string").tolist())
        has_odoo_lead_history = source_lead_id.astype("string").isin(real_lead_ids)
        needs_etl_lead_history = is_opportunity & ~has_odoo_lead_history

        out["IsOdooCreatedLead"] = (~is_opportunity).astype(bool)
        out["IsETLCreatedLead"] = False
        out["IsSystemGeneratedLead"] = False
        out["LeadCreationSource"] = "Odoo"
        out["GeneratedLeadReason"] = pd.NA

        linked_lead = source_lead_id.astype("string")
        etl_lead = "ETL-LEAD-" + out["OpportunityID"].astype("string")
        out["LeadID"] = out["OdooLeadID"].astype("string")
        out.loc[is_opportunity & has_odoo_lead_history, "LeadID"] = linked_lead[is_opportunity & has_odoo_lead_history]
        out.loc[needs_etl_lead_history, "LeadID"] = etl_lead[needs_etl_lead_history]
        out["LeadID"] = out["LeadID"].replace({"<NA>": pd.NA, "nan": pd.NA})
        out["PipelineRecordID"] = "LEAD-" + out["LeadID"].astype("string")
        out.loc[is_opportunity, "PipelineRecordID"] = "OPP-" + out.loc[is_opportunity, "OpportunityID"].astype("string")

        status = out.apply(lambda row: classify_status(row, won_stage_ids), axis=1)
        out["IsWon"] = [item[0] for item in status]
        out["IsLost"] = [item[1] for item in status]
        out["IsOpen"] = [item[2] for item in status]

        now = pd.Timestamp.now(tz=self.settings.timezone).tz_localize(None)
        base_start = out["OpenDate"].combine_first(out["CreatedDate"])
        base_end = out["ClosedDate"].where(out["ClosedDate"].notna(), now)
        out["DaysInPipeline"] = (base_end - base_start).dt.days
        out["DaysSinceUpdate"] = (now - out["UpdatedDate"]).dt.days
        out["DaysUntilExpectedClose"] = (out["ExpectedCloseDate"] - now).dt.days
        out["AgingBucket"] = out["DaysInPipeline"].apply(aging_bucket)
        out["IsInactive"] = out["IsOpen"] & (out["DaysSinceUpdate"] > self.settings.crm_inactive_days_threshold)
        out["HasNextStep"] = out["NextActivityDate"].notna() | out["ActivitySummary"].notna()
        out["HasRecentActivity"] = out["UpdatedDate"].ge(now - pd.Timedelta(days=self.settings.crm_recent_activity_days))
        out["OpportunityCount"] = 1
        prob = out["Probability"].fillna(0).clip(0, 100)
        out["ProbabilityBucket"] = ((np.floor(prob / 10) * 10).astype(int)).astype(str) + "%"

        for col in ["CreatedDate", "UpdatedDate", "OpenDate", "ClosedDate", "ExpectedCloseDate"]:
            out[f"{col}Key"] = date_key(out[col])
        out = out.drop(columns=["ParentLeadID"], errors="ignore")
        return self._append_etl_lead_history_rows(out)

    def _append_etl_lead_history_rows(self, normalized: pd.DataFrame) -> pd.DataFrame:
        if normalized.empty or "OpportunityID" not in normalized.columns:
            return normalized
        lead_id = normalized.get("LeadID", pd.Series(pd.NA, index=normalized.index)).astype("string")
        opportunity_rows = normalized.loc[
            normalized["OpportunityID"].notna() & lead_id.str.startswith("ETL-LEAD-", na=False)
        ].copy()
        if opportunity_rows.empty:
            return normalized

        etl_rows = opportunity_rows.copy()
        opportunity_created = pd.to_datetime(etl_rows["OpenDate"], errors="coerce").combine_first(
            pd.to_datetime(etl_rows["CreatedDate"], errors="coerce")
        )
        lead_created = opportunity_created - pd.Timedelta(minutes=1)

        etl_rows["PipelineRecordID"] = "LEAD-" + etl_rows["LeadID"].astype("string")
        etl_rows["OdooLeadID"] = pd.NA
        etl_rows["SourceLeadID"] = pd.NA
        etl_rows["OpportunityID"] = pd.NA
        etl_rows["LeadName"] = "ETL lead history for " + opportunity_rows["LeadName"].astype("string").fillna(opportunity_rows["OpportunityID"].astype("string"))
        etl_rows["LeadType"] = "Systematic"
        etl_rows["CreatedDate"] = lead_created
        etl_rows["UpdatedDate"] = lead_created
        etl_rows["OpenDate"] = pd.NaT
        etl_rows["ClosedDate"] = pd.NaT
        etl_rows["ExpectedCloseDate"] = pd.NaT
        etl_rows["StageID"] = pd.NA
        etl_rows["Stage"] = pd.NA
        etl_rows["LostReason"] = pd.NA
        etl_rows["LostReasonID"] = pd.NA
        etl_rows["WonStatus"] = pd.NA
        etl_rows["IsOdooCreatedLead"] = False
        etl_rows["IsETLCreatedLead"] = True
        etl_rows["IsSystemGeneratedLead"] = True
        etl_rows["LeadCreationSource"] = "ETL"
        etl_rows["GeneratedLeadReason"] = "Missing Odoo lead history for opportunity"
        etl_rows["IsWon"] = False
        etl_rows["IsLost"] = False
        etl_rows["IsOpen"] = False
        etl_rows["IsInactive"] = False
        etl_rows["OpportunityCount"] = 0
        etl_rows["DaysInPipeline"] = pd.NA
        etl_rows["DaysSinceUpdate"] = pd.NA
        etl_rows["DaysUntilExpectedClose"] = pd.NA
        etl_rows["AgingBucket"] = pd.NA
        etl_rows["HasNextStep"] = False
        etl_rows["HasRecentActivity"] = False
        for col in ["CreatedDate", "UpdatedDate", "OpenDate", "ClosedDate", "ExpectedCloseDate"]:
            etl_rows[f"{col}Key"] = date_key(etl_rows[col])

        return pd.concat([normalized, etl_rows.dropna(axis=1, how="all")], ignore_index=True)

    def normalize_orders(self, orders: pd.DataFrame) -> pd.DataFrame:
        out = orders.copy()
        for col in ["date_order", "create_date", "write_date"]:
            if col in out.columns:
                out[col] = odoo_utc_datetime_to_local(out[col], self.settings.timezone)
            else:
                out[col] = pd.NaT
        if "validity_date" in out.columns:
            out["validity_date"] = safe_datetime_to_local(out["validity_date"], self.settings.timezone, False)
        else:
            out["validity_date"] = pd.NaT
        for col in ["amount_untaxed", "amount_total"]:
            out[col] = pd.to_numeric(out[col], errors="coerce") if col in out.columns else pd.NA
        if "state" not in out.columns:
            out["state"] = pd.NA
        if "invoice_status" not in out.columns:
            out["invoice_status"] = pd.NA
        if "delivery_status" not in out.columns:
            out["delivery_status"] = pd.NA
        state = out["state"].astype("string").str.lower()
        invoice_status = out["invoice_status"].astype("string").str.lower()
        delivery_status = out["delivery_status"].astype("string").str.lower()
        out["IsQuotation"] = state.isin(["draft", "sent", "cancel"])
        out["IsQuotationWon"] = state.isin(["sale", "done"])
        out["IsQuotationLost"] = state.eq("cancel")
        out["IsSalesOrder"] = state.isin(["sale", "done"])
        out["IsInvoice"] = invoice_status.eq("invoiced")
        out["IsDelivery"] = delivery_status.isin(["full", "done"])
        return out

    def normalize_activities(self, activities: pd.DataFrame) -> pd.DataFrame:
        out = activities.copy()
        if out.empty:
            return out
        if "date_deadline" in out.columns:
            out["date_deadline"] = safe_datetime_to_local(out["date_deadline"], self.settings.timezone, self.settings.assume_utc_for_naive)
        for col in ["create_date", "write_date"]:
            if col in out.columns:
                out[col] = odoo_utc_datetime_to_local(out[col], self.settings.timezone)
        return out

    def normalize_pickings(self, pickings: pd.DataFrame) -> pd.DataFrame:
        out = pickings.copy()
        for col in ["scheduled_date", "date_done", "create_date", "write_date"]:
            if col in out.columns:
                out[col] = odoo_utc_datetime_to_local(out[col], self.settings.timezone)
            else:
                out[col] = pd.NaT
        if "state" not in out.columns:
            out["state"] = pd.NA
        return out

    def normalize_moves(self, moves: pd.DataFrame) -> pd.DataFrame:
        out = moves.copy()
        for col in ["date", "create_date", "write_date"]:
            if col in out.columns:
                out[col] = odoo_utc_datetime_to_local(out[col], self.settings.timezone)
        for col in ["product_uom_qty", "product_qty", "quantity_done", "quantity"]:
            if col in out.columns:
                out[col] = pd.to_numeric(out[col], errors="coerce")
        if "state" not in out.columns:
            out["state"] = pd.NA
        return out
