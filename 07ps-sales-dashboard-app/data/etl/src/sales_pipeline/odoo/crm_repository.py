from __future__ import annotations

from typing import Any

import pandas as pd

from sales_pipeline.odoo.base_repository import OdooRepositoryBase, flatten_many2many, flatten_many2one_columns
from sales_pipeline.odoo.client import OdooClient


# Keep `active` in the extraction field list for lead/opportunity active tracking facts.
CRM_LEAD_FIELDS = [
    "id", "name", "type", "active", "create_date", "write_date", "date_open", "date_closed",
    "date_deadline", "expected_revenue", "prorated_revenue", "probability", "automated_probability",
    "lead_id", "parent_id",
    "stage_id", "user_id", "team_id", "company_id", "partner_id", "contact_name", "email_from",
    "phone", "mobile", "city", "country_id", "source_id", "medium_id", "campaign_id", "tag_ids",
    "lost_reason_id", "won_status", "day_open", "day_close", "activity_date_deadline",
    "activity_summary", "activity_state", "activity_type_id", "activity_user_id", "recurring_revenue",
]

CRM_STAGE_FIELDS = ["id", "name", "sequence", "is_won", "fold", "team_id"]
CRM_LOST_REASON_FIELDS = ["id", "name", "active"]


class CrmRepository(OdooRepositoryBase):
    def __init__(self, client: OdooClient, batch_size: int = 500) -> None:
        super().__init__(client, batch_size)
        self.field_availability = pd.DataFrame()
        self.lead_field_meta: dict[str, Any] = {}
        self.stage_field_meta: dict[str, Any] = {}
        self.lost_reason_field_meta: dict[str, Any] = {}

    def fetch_leads(self, domain: list[Any] | None = None) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("crm.lead", CRM_LEAD_FIELDS)
        self.lead_field_meta = meta
        self.field_availability = pd.concat([self.field_availability, qa], ignore_index=True)
        if domain is None:
            domain = []
            if "type" in fields:
                domain = [["type", "in", ["lead", "opportunity"]]]
        df = self.search_read_all("crm.lead", domain, fields, context={"active_test": False})
        df = flatten_many2one_columns(df, meta)
        if "tag_ids" in df.columns:
            df["tag_ids"] = df["tag_ids"].apply(flatten_many2many)
        return df

    def fetch_stages(self) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("crm.stage", CRM_STAGE_FIELDS)
        self.stage_field_meta = meta
        self.field_availability = pd.concat([self.field_availability, qa], ignore_index=True)
        return flatten_many2one_columns(self.search_read_all("crm.stage", [], fields), meta)

    def fetch_lost_reasons(self) -> pd.DataFrame:
        fields, qa, meta = self.available_fields("crm.lost.reason", CRM_LOST_REASON_FIELDS)
        self.lost_reason_field_meta = meta
        self.field_availability = pd.concat([self.field_availability, qa], ignore_index=True)
        return self.search_read_all("crm.lost.reason", [], fields, context={"active_test": False})
