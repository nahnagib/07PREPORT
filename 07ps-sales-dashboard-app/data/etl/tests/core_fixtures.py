"""Fake Odoo data and Excel inputs for the core_dims tests. No network, no real names or keys."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

WD = "2026-09-30 10:00:00"

ODOO: dict[str, list[dict[str, Any]]] = {
    "res.company": [
        {"id": 1, "name": "Majaal", "currency_id": [102, "LYD"], "write_date": WD},
        {"id": 2, "name": "Namaa Al Bahr", "currency_id": [102, "LYD"], "write_date": WD},
        {"id": 3, "name": "TIKA", "currency_id": [102, "LYD"], "write_date": WD},
    ],
    "res.currency": [
        {"id": 102, "name": "LYD", "symbol": "LD", "decimal_places": 3, "active": True, "write_date": WD},
        {"id": 2, "name": "USD", "symbol": "$", "decimal_places": 2, "active": True, "write_date": WD},
    ],
    "res.users": [
        {"id": 10, "name": "Moftah Test", "partner_id": [900, "x"], "company_id": [3, "TIKA"], "share": False, "active": True, "write_date": WD},
        {"id": 11, "name": "Moftah Test", "partner_id": [901, "x"], "company_id": [1, "Majaal"], "share": False, "active": False, "write_date": WD},
        {"id": 12, "name": "Sara Seller", "partner_id": [902, "x"], "company_id": [1, "Majaal"], "share": False, "active": True, "write_date": WD},
        {"id": 13, "name": "Not In Excel", "partner_id": [903, "x"], "company_id": [1, "Majaal"], "share": False, "active": True, "write_date": WD},
    ],
    "crm.team": [
        {"id": 9, "name": "Main Showroom", "company_id": [1, "Majaal"], "active": True, "write_date": WD},
        {"id": 27, "name": "EXPORT", "company_id": [3, "TIKA"], "active": True, "write_date": WD},
        {"id": 2, "name": "Website", "company_id": False, "active": True, "write_date": WD},
    ],
    "res.partner": [
        {"id": 100, "name": "ACME Building", "display_name": "ACME Building", "commercial_partner_id": [100, "ACME"], "parent_id": False,
         "is_company": True, "customer_rank": 3, "supplier_rank": 0, "user_id": [10, "Moftah"], "company_id": False, "type": "contact",
         "ref": "C100", "active": True, "write_date": WD},
        {"id": 101, "name": "Omar", "display_name": "ACME Building, Omar", "commercial_partner_id": [100, "ACME"], "parent_id": [100, "ACME"],
         "is_company": False, "customer_rank": 1, "supplier_rank": 0, "user_id": False, "company_id": False, "type": "contact",
         "ref": False, "active": True, "write_date": WD},
        {"id": 102, "name": "Ali Individual", "display_name": "Ali Individual", "commercial_partner_id": [102, "Ali"], "parent_id": False,
         "is_company": False, "customer_rank": 1, "supplier_rank": 0, "user_id": [13, "Not In Excel"], "company_id": False, "type": "contact",
         "ref": False, "active": True, "write_date": WD},
        {"id": 103, "name": "Steel Vendor", "display_name": "Steel Vendor", "commercial_partner_id": [103, "Steel"], "parent_id": False,
         "is_company": True, "customer_rank": 0, "supplier_rank": 5, "user_id": False, "company_id": False, "type": "contact",
         "ref": False, "active": True, "write_date": WD},
    ],
    "product.product": [
        {"id": 500, "product_tmpl_id": [500, "t"], "name": "Grout Crema", "display_name": "[GR-1] Grout Crema", "default_code": "GR-1",
         "company_id": False, "categ_id": [5, "All / Grout"], "uom_id": [1, "Units"], "detailed_type": "product", "active": True, "write_date": WD},
        {"id": 501, "product_tmpl_id": [501, "t"], "name": "Cem Air", "display_name": "Cem Air", "default_code": False,
         "company_id": [3, "TIKA"], "categ_id": [6, "All / Cement"], "uom_id": [1, "Units"], "detailed_type": "product", "active": True, "write_date": WD},
        {"id": 502, "product_tmpl_id": [502, "t"], "name": "Mystery Item", "display_name": "Mystery Item", "default_code": False,
         "company_id": False, "categ_id": [7, "All"], "uom_id": [1, "Units"], "detailed_type": "consu", "active": False, "write_date": WD},
    ],
    "account.payment.term": [
        {"id": 7, "name": "30 Days", "company_id": False, "active": True, "write_date": WD},
        {"id": 8, "name": "30/60 Instalments", "company_id": [1, "Majaal"], "active": True, "write_date": WD},
    ],
    "account.payment.term.line": [
        {"id": 70, "payment_id": [7, "30 Days"], "value": "percent", "value_amount": 100.0, "nb_days": 30, "delay_type": "days_after", "write_date": WD},
        {"id": 80, "payment_id": [8, "x"], "value": "percent", "value_amount": 50.0, "nb_days": 30, "delay_type": "days_after", "write_date": WD},
        {"id": 81, "payment_id": [8, "x"], "value": "percent", "value_amount": 50.0, "nb_days": 60, "delay_type": "days_after", "write_date": WD},
    ],
}
# company-dependent values, per company
PARTNER_COMPANY = {
    1: {100: {"credit_limit": 5000.0, "property_payment_term_id": [8, "x"]}, 102: {"credit_limit": 0.0, "property_payment_term_id": False}},
    3: {100: {"credit_limit": 0.0, "property_payment_term_id": [7, "x"]}, 102: {"credit_limit": 0.0, "property_payment_term_id": False}},
}


class FakeOdooSource:
    """The subset of etl_platform.sources.odoo.OdooSource that core uses. Read-only by construction."""

    mode = "fake"
    server_version = "17.0-test"

    def __init__(self, data=None, partner_company=None):
        self.data = {k: [dict(r) for r in v] for k, v in (data or ODOO).items()}
        self.partner_company = partner_company or PARTNER_COMPANY
        self.calls: list[tuple[str, str]] = []

    def available_fields(self, model, requested):
        return list(requested), []

    def _rows(self, model, fields):
        return [{f: r.get(f, False) for f in fields} for r in sorted(self.data.get(model, []), key=lambda r: r["id"])]

    def search_read_incremental(self, model, domain, fields, *, since=None, field="write_date", include_archived=True):
        self.calls.append((model, "incremental" if since else "full"))
        rows = self._rows(model, fields)
        return [r for r in rows if since is None or r["write_date"] >= since.strftime("%Y-%m-%d %H:%M:%S")]

    def search_read_all(self, model, domain, fields, *, order="id", include_archived=False, company_ids=None):
        self.calls.append((model, f"all:{company_ids}"))
        if model == "res.partner" and company_ids:
            values = self.partner_company.get(company_ids[0], {})
            return [{"id": pid, "write_date": WD, **vals} for pid, vals in sorted(values.items())]
        return self._rows(model, fields)

    def search_ids(self, model, domain=(), *, include_archived=True):
        return sorted(r["id"] for r in self.data.get(model, []))

    # -- labels: Odoo's own selection labels per language (fake fields_get) --------------------------------------
    context = {"lang": "en_US"}
    id_chunk_size = 500
    languages = ["en_US", "ar_001"]

    @property
    def client(self):
        return self

    def active_languages(self):
        return list(self.languages)

    def field_labels(self, model, fields, lang):
        table = SELECTION_LABELS.get(lang, {}).get(model, {})
        return {f: {"string": f"{f} ({lang})", "selection": table.get(f, [])} for f in fields}

    def execute_kw(self, model, method, args=None, kwargs=None):
        if method == "read" and model == "account.journal":
            lang = ((kwargs or {}).get("context") or {}).get("lang", "en_US")
            ids, fields = args
            return [{**{f: r.get(f, False) for f in fields}, "name": r["name"][lang] if isinstance(r["name"], dict) else r["name"]}
                    for r in self.data.get(model, []) if r["id"] in ids]
        raise NotImplementedError(f"fake execute_kw {model}.{method}")


SELECTION_LABELS = {  # what Odoo's fields_get returns, per language (a subset; enough for the tests)
    "en_US": {
        "account.move": {"move_type": [["entry", "Journal Entry"], ["out_invoice", "Customer Invoice"], ["out_refund", "Customer Credit Note"]],
                         "payment_state": [["not_paid", "Not Paid"], ["paid", "Paid"]]},
        "account.payment": {"payment_type": [["outbound", "Send"], ["inbound", "Receive"]], "partner_type": [["customer", "Customer"], ["supplier", "Vendor"]]},
        "sale.order": {"delivery_status": [["pending", "Not Delivered"], ["started", "Started"], ["partial", "Partially Delivered"], ["full", "Fully Delivered"]]},
    },
    "ar_001": {
        "account.move": {"move_type": [["entry", "قيد اليومية"], ["out_invoice", "فاتورة العميل"], ["out_refund", "إشعار دائن للعميل "]],
                         "payment_state": [["not_paid", "غير مسدد "], ["paid", "مدفوع"]]},
        "account.payment": {"payment_type": [["outbound", "إرسال"], ["inbound", "استلام "]], "partner_type": [["customer", "العميل"], ["supplier", "المورد"]]},
        "sale.order": {"delivery_status": [["pending", "لم يتم توصيلها "], ["started", "بدأ"], ["partial", "تم التوصيل جزئياً "], ["full", "تم التوصيل بالكامل"]]},
    },
}


SALESPERSON = pd.DataFrame([
    {"Name": "Moftah Test", "TeamKey": "TK-BEN-BC-03", "Status": "Active", "DistributionChannel": "Retail", "SalespersonKey": 49, "ChannelKey": 3},
    {"Name": "Sara Seller", "TeamKey": "MJ-EST-BB", "Status": None, "DistributionChannel": "Projects", "SalespersonKey": 60, "ChannelKey": 2},
    {"Name": "Placeholder One", "TeamKey": "MJ-EST-BB", "Status": "Active", "DistributionChannel": None, "SalespersonKey": 79, "ChannelKey": None},
    {"Name": "New Odoo Seller", "TeamKey": None, "Status": "Inactive", "DistributionChannel": None, "SalespersonKey": 62, "ChannelKey": None},
    {"Name": "Stale Active", "TeamKey": None, "Status": "Active", "DistributionChannel": "Retail", "SalespersonKey": 63, "ChannelKey": 3},
])
TEAMS = pd.DataFrame([
    {"TeamKey": "TK-BEN-BC-03", "TeamName": "Hawari", "Company": "Tika", "City": "Benghazi", "Territory": "East", "Segment": "B2C", "Status": "Active", "CompanyKey": 3, "SegmentKey": 2},
    {"TeamKey": "MJ-EST-BB", "TeamName": "Corporate", "Company": "Majaal", "City": "Benghazi", "Territory": "East", "Segment": "B2B", "Status": "Active", "CompanyKey": 1, "SegmentKey": 1},
])
ODOO_USERS = pd.DataFrame([
    {"odoo_user_id": 10, "SalespersonKey": 49, "odoo_user_name": "Moftah Test", "note": "one person, several Odoo users"},
    {"odoo_user_id": 11, "SalespersonKey": 49, "odoo_user_name": "Moftah Test", "note": "one person, several Odoo users"},
    {"odoo_user_id": 12, "SalespersonKey": 60, "odoo_user_name": "Sara Seller", "note": None},
])
ODOO_TEAMS = pd.DataFrame([
    {"odoo_team_id": 9, "SalesTeamKey": "MJ-EST-BB", "odoo_team_name": "Main Showroom", "note": None},
    {"odoo_team_id": 27, "SalesTeamKey": "SALESPERSON", "odoo_team_name": "EXPORT", "note": "follows the salesperson"},
])
CHANNEL = pd.DataFrame({"ChannelKey": [2, 3, 4], "DistributionChannel": ["Projects", "Retail", "Wholesales"]})
SEGMENT = pd.DataFrame({"SegmentKey": [1, 2, 3, 4], "Segment": ["B2B", "B2C", "Backoffice", "Inter Company"]})
PRODUCTS = pd.DataFrame([
    {"ProductKey": "GR", "Company": "Majaal", "Category": "Tile Adhesives", "Brand": "Weber", "SubBrand": None, "Family": "Grout",
     "ProductName": "Grout Crema", "OdooProductName": "[GR-1] Grout Crema", "ProductLevel": "SKU", "SKU": "GR-1", "Size": "5kg", "IsActive": 1,
     "ProductMasterKey": "Majaal | GR-1 | 1"},
    {"ProductKey": "CEM", "Company": "Tika", "Category": "Cement", "Brand": "CemAir", "SubBrand": None, "Family": "Cement",
     "ProductName": None, "OdooProductName": "Cem Air", "ProductLevel": "SKU", "SKU": None, "Size": None, "IsActive": 1,
     "ProductMasterKey": None},
])
OFFDAYS = pd.DataFrame([
    {"Date": "18/1/2026", "OffDayType": "Unexpected", "HolidayName": None, "Reason": "storm", "Country": "Libya", "Company": "Majaal",
     "Branch": "MJ-EST-BB", "IsActive": 1, "Source": "HR", "Notes": None, "CompanyKey": 1},
    {"Date": "24/12/2026", "OffDayType": "Holiday", "HolidayName": "Independence", "Reason": None, "Country": "Libya", "Company": None,
     "Branch": None, "IsActive": 1, "Source": "HR", "Notes": None, "CompanyKey": None},
    {"Date": "25/12/2026", "OffDayType": "Holiday", "HolidayName": "Other", "Reason": None, "Country": "Egypt", "Company": None,
     "Branch": None, "IsActive": 1, "Source": "HR", "Notes": None, "CompanyKey": None},
])
BLOCKED = pd.DataFrame([
    {"CustomerID": "CUST-000001", "CustomerName": "ACME Building", "IsBlocked": 1, "BlockedDate": "01/03/2026", "UnblockedDate": None,
     "BlockedReason": "overdue", "Notes": None, "CustomerKey": 100},
    {"CustomerID": "CUST-000002", "CustomerName": "Unknown Shop", "IsBlocked": 1, "BlockedDate": None, "UnblockedDate": None,
     "BlockedReason": None, "Notes": None, "CustomerKey": None},
])


def write_inputs(folder: Path, *, salesperson: pd.DataFrame | None = None, users: pd.DataFrame | None = None) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(folder / "SalesTeam.xlsx") as w:
        (SALESPERSON if salesperson is None else salesperson).to_excel(w, sheet_name="salesperson", index=False)
        TEAMS.to_excel(w, sheet_name="salesteam", index=False)
        (ODOO_USERS if users is None else users).to_excel(w, sheet_name="OdooUsers", index=False)
        ODOO_TEAMS.to_excel(w, sheet_name="OdooTeams", index=False)
        CHANNEL.to_excel(w, sheet_name="channel", index=False)
        SEGMENT.to_excel(w, sheet_name="segment", index=False)
    PRODUCTS.to_excel(folder / "PRODUCTS.xlsx", sheet_name="Products", index=False)
    OFFDAYS.to_excel(folder / "OffDays.xlsx", sheet_name="Sheet1", index=False)
    BLOCKED.to_excel(folder / "BlockedCustomers.xlsx", sheet_name="BlockedCustomers", index=False)
    return folder
