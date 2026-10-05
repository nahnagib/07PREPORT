"""Sales: legacy-keyed sheets (sales_pipeline.PowerBISalesPipeline.build_sheets) -> conformed sales marts.

The business logic (cleaning, enrichment, fact construction, customer growth, product pages, BCG) is the legacy code,
unchanged. This module replaces only the KEYS, resolving every one from Odoo ids through core (core.resolve.KeyMaps):

  fact                    document ids used
  sales lines             OdooOrderID -> sale.order (user, team, company); OdooPartnerID (customer)
  orders, documents       SalesDocumentID -> sale.order
  deliveries              SalesOrderID -> sale.order only (a picking without a sale order: every org key -1)
  leads, opportunities    OdooLeadID / OpportunityID -> crm.lead (partner, company); SalespersonID, SalesTeamID
  targets                 SalesTeam.xlsx / sales_targets.xlsx key columns (frozen codes)
  product daily, BCG,     rebuilt by the legacy product builders FROM THE CONFORMED sales lines, so they carry the same
  product dashboard       keys by construction

No Odoo team on the document (or its OdooTeams row says SALESPERSON): sales lines and orders take the salesperson's
effective team; documents, deliveries, leads and opportunities take '-1' Unknown -- what the legacy pipeline did for
each fact (TEAM_FALLBACK_TO_SALESPERSON).

Every -1 fallback is returned per key for RunContext.record_fallback. ``legacy_key_parity`` compares the conformed keys
with the legacy keys (translated: Tika 2 -> 3, Unknown -> -1) so any unexplained difference is visible in the run log.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from core.keys import UNKNOWN, UNKNOWN_TEXT
from core.resolve import KeyMaps, _int_or_none

LEGACY_UNKNOWN_TEAM = "MJ-TIK-00"
# fact -> does a document without an Odoo team take its salesperson's team? (legacy behaviour per fact, measured on
# 2026-10-04: lines and orders did; documents, deliveries, leads and opportunities left the team Unknown)
TEAM_FALLBACK_TO_SALESPERSON = {"fact_sales_lines": True, "fact_sales_orders": True, "fact_sales_documents": False,
                                "fact_sales_deliveries": False, "fact_sales_leads": False, "fact_sales_opportunities": False}
DATE_KEY_COLUMNS = ("DateKey", "OrderDateKey", "ScheduledDateKey", "DoneDateKey", "LeadCreatedDateKey",
                    "OpportunityCreatedDateKey", "ExpectedCloseDateKey", "FirstQuotationDateKey", "SnapshotDateKey")


@dataclass
class Conformed:
    tables: dict[str, pd.DataFrame] = field(default_factory=dict)
    fallbacks: dict[str, list[Any]] = field(default_factory=dict)
    parity: dict[str, dict[str, int]] = field(default_factory=dict)
    notes: dict[str, Any] = field(default_factory=dict)

    def fell(self, key: str, ids) -> None:
        ids = list(ids)
        if ids:
            self.fallbacks.setdefault(key, []).extend(ids)


def _index(raw: pd.DataFrame, cols: list[str]) -> dict[int, dict[str, Any]]:
    if raw is None or raw.empty or "id" not in raw.columns:
        return {}
    present = [c for c in cols if c in raw.columns]
    return {int(r["id"]): r for r in raw[["id", *present]].to_dict("records") if _int_or_none(r["id"]) is not None}


def _col(df: pd.DataFrame, name: str) -> pd.Series:
    return df[name] if name in df.columns else pd.Series([None] * len(df), index=df.index, dtype=object)


def _date_keys(df: pd.DataFrame) -> pd.DataFrame:
    for c in DATE_KEY_COLUMNS:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").fillna(UNKNOWN).astype("int64")
    return df


def apply_org_keys(df: pd.DataFrame, maps: KeyMaps, out: Conformed, fact: str, *, partner_ids, user_ids, team_ids,
                   company_ids) -> pd.DataFrame:
    """Sets CustomerKey, SalespersonKey, SalesTeamKey (+ legacy mirror sales_team_key), SegmentKey, ChannelKey, CompanyKey."""
    df = df.copy()
    customers, f1 = maps.customers(partner_ids)
    people, f2 = maps.salespeople(user_ids)
    teams, f3 = maps.teams(team_ids, people, person_fallback=TEAM_FALLBACK_TO_SALESPERSON.get(fact, True))
    companies, f4 = maps.companies(company_ids)
    out.fell(f"{fact}.CustomerKey (partner id)", f1)
    out.fell(f"{fact}.SalespersonKey (Odoo user id)", f2)
    out.fell(f"{fact}.SalesTeamKey (Odoo team id not in OdooTeams)", f3)
    out.fell(f"{fact}.CompanyKey (company id)", f4)
    legacy = {c: df[c].copy() for c in ("SalespersonKey", "SalesTeamKey", "ChannelKey", "SegmentKey", "CompanyKey") if c in df.columns}
    if "CustomerKey" in df.columns or partner_ids is not None:
        df["CustomerKey"] = customers
    df["SalespersonKey"] = people
    df["SalesTeamKey"] = teams
    if "sales_team_key" in df.columns:
        df["sales_team_key"] = teams
    if "SegmentKey" in df.columns:
        df["SegmentKey"] = maps.segments(teams)
    if "ChannelKey" in df.columns:
        df["ChannelKey"] = maps.channels(people)
    df["CompanyKey"] = companies
    out.parity[fact] = legacy_key_parity(legacy, df)
    return df


def legacy_key_parity(legacy: dict[str, pd.Series], new: pd.DataFrame) -> dict[str, int]:
    """Rows whose conformed key differs from the legacy key after the agreed translations."""
    tr = {
        "SalespersonKey": lambda v: UNKNOWN if pd.isna(v) or int(v) == 0 else int(v),
        "SalesTeamKey": _team_key,
        "ChannelKey": lambda v: UNKNOWN if pd.isna(v) or int(v) == 1 else int(v),
        "SegmentKey": lambda v: UNKNOWN if pd.isna(v) or int(v) == 5 else int(v),
        "CompanyKey": lambda v: UNKNOWN if pd.isna(v) else {2: 3}.get(int(v), int(v)),
    }
    result = {}
    for col, old in legacy.items():
        translated = old.map(tr[col])
        result[col] = int((translated.to_numpy() != new[col].to_numpy()).sum())
    return result


def correct_order_ids(df: pd.DataFrame, orders: dict[int, dict], id_col: str, name_col: str) -> tuple[list, int]:
    """Order names repeat across companies (S00004 exists in Majaal and in Tika). The legacy order facts are built by
    name and, rarely, carry one company's order id with the other company's order. When the id's company contradicts
    the row's legacy company and an order with the same name exists in that company, the row is that order.
    Returns (order id per row, number corrected)."""
    by_name = {(r.get("name"), _int_or_none(r.get("company_id_id"))): i for i, r in orders.items()}
    legacy_company = [{2: 3}.get(_int_or_none(v), _int_or_none(v)) for v in _col(df, "CompanyKey")]
    ids, fixed = [], 0
    for v, name, co in zip(_col(df, id_col), _col(df, name_col), legacy_company):
        oid = _int_or_none(v)
        rec = orders.get(oid)
        if rec is not None and co is not None and _int_or_none(rec.get("company_id_id")) != co and rec.get("name") == name:
            other = by_name.get((name, co))
            if other is not None:
                oid, fixed = other, fixed + 1
        ids.append(oid)
    return ids, fixed


def _order_ids(df: pd.DataFrame, orders: dict[int, dict], id_col: str):
    rows = [orders.get(_int_or_none(v)) or {} for v in _col(df, id_col)]
    return ([r.get("partner_id_id") for r in rows], [r.get("user_id_id") for r in rows],
            [r.get("team_id_id") for r in rows], [r.get("company_id_id") for r in rows])


_MISSING_TEXT = {"", "<NA>", "nan", "NaN", "None", "NaT"}


def _ident_text(v) -> str:
    """Target identity value as text; every spelling of "missing" (the legacy sheet writes pd.NA as '<NA>') is ''."""
    if v is None or (not isinstance(v, str) and pd.isna(v)):
        return ""
    text = str(v).strip()
    return "" if text in _MISSING_TEXT else text


def _team_key(v) -> str:
    text = _ident_text(v)
    return UNKNOWN_TEXT if text in ("", LEGACY_UNKNOWN_TEAM) else text


def target_sheet_rows(sheet: pd.DataFrame) -> pd.DataFrame:
    """The rows of sales_targets.xlsx that the legacy TargetsLoader keeps (Year and Month present, Month 1-12), in
    sheet order. The legacy enrichment only left-joins on unique keys, so Fact_Targets row i is this row i."""
    year = pd.to_numeric(sheet["Year"], errors="coerce")
    month = pd.to_numeric(sheet["Month"], errors="coerce")
    return sheet[year.notna() & month.notna() & month.between(1, 12)].reset_index(drop=True)


def check_target_alignment(fact: pd.DataFrame, sheet: pd.DataFrame) -> None:
    """Fact_Targets and the sheet rows must agree row by row on what the legacy code never rewrites."""
    if len(fact) != len(sheet):
        raise ValueError(f"Fact_Targets has {len(fact)} rows but sales_targets.xlsx has {len(sheet)} usable rows")
    for col in ("YearMonth", "Target_Revenue", "Target_Volume"):
        a = fact[col].map(_ident_text) if col == "YearMonth" else pd.to_numeric(fact[col], errors="coerce").round(6)
        b = sheet[col].map(_ident_text) if col == "YearMonth" else pd.to_numeric(sheet[col], errors="coerce").round(6)
        differ = ~((a.to_numpy() == b.to_numpy()) | (pd.isna(a).to_numpy() & pd.isna(b).to_numpy()))
        if differ.any():
            i = int(differ.argmax())
            raise ValueError(f"Fact_Targets row {i} does not line up with sales_targets.xlsx ({col}: {a.iloc[i]!r} vs {b.iloc[i]!r})")


def conform(build, maps: KeyMaps, targets_keys: pd.DataFrame, product_rebuild) -> Conformed:
    """``targets_keys``: sales_targets.xlsx rows with YearMonth, Salesperson, SalesTeamKey, Company, SalespersonKey,
    CompanyKey. ``product_rebuild(lines_with_legacy_product_cols) -> dict`` re-runs the legacy product/BCG builders."""
    s = build.sheets
    out = Conformed()
    orders = _index(build.sale_orders_raw, ["name", "partner_id_id", "user_id_id", "team_id_id", "company_id_id"])
    leads = _index(build.leads_raw, ["partner_id_id", "user_id_id", "team_id_id", "company_id_id"])

    # sales lines -------------------------------------------------------------------------------------------------
    lines = s["Fact_SalesLines"]
    _, users, teams, companies = _order_ids(lines, orders, "OdooOrderID")
    lines = apply_org_keys(lines, maps, out, "fact_sales_lines", partner_ids=list(_col(lines, "OdooPartnerID")), user_ids=users,
                           team_ids=teams, company_ids=companies)
    legacy_product_key = lines["ProductKey"].copy()
    product_keys, fell = maps.products(_col(lines, "OdooProductID"))
    out.fell("fact_sales_lines.ProductKey (Odoo product id)", fell)
    lines["ProductKey"] = product_keys
    lines["ProductMasterKey"] = maps.product_masters(product_keys, lines["CompanyKey"])
    lines["SalesOrderKey"] = [(_int_or_none(v) if _int_or_none(v) is not None else UNKNOWN) for v in _col(lines, "OdooOrderID")]
    lines = _date_keys(lines.drop(columns=["InvoiceKey"], errors="ignore"))
    out.tables["fact_sales_lines"] = lines

    # orders, documents ----------------------------------------------------------------------------------------------
    for sheet, table, name_col in (("Fact_Orders", "fact_sales_orders", "order_number"), ("Fact_Sales", "fact_sales_documents", "OrderNumber")):
        df = s[sheet].copy()
        order_ids, fixed = correct_order_ids(df, orders, "SalesDocumentID", name_col)
        out.notes[f"{table}.order_id_corrected_by_name_and_company"] = fixed
        df["_order_id"] = order_ids
        partners, users, teams, companies = _order_ids(df, orders, "_order_id")
        df = apply_org_keys(df, maps, out, table, partner_ids=partners, user_ids=users, team_ids=teams, company_ids=companies)
        df["SalesOrderKey"] = [(v if v is not None else UNKNOWN) for v in order_ids]
        df = df.drop(columns=["_order_id"])
        out.tables[table] = _date_keys(df.drop(columns=["InvoiceKey"], errors="ignore"))

    # deliveries -------------------------------------------------------------------------------------------------------
    # keys come from the sale order only, as in the legacy pipeline: a picking without one (receipts, internal moves)
    # keeps every org key Unknown
    d = s["Fact_Delivery"]
    p_o, u_o, t_o, c_o = _order_ids(d, orders, "SalesOrderID")
    d = apply_org_keys(d, maps, out, "fact_sales_deliveries", partner_ids=p_o, user_ids=u_o, team_ids=t_o, company_ids=c_o)
    out.tables["fact_sales_deliveries"] = _date_keys(d)

    # leads, opportunities ---------------------------------------------------------------------------------------------
    for sheet, table, id_col in (("Fact_Lead", "fact_sales_leads", "OdooLeadID"), ("Fact_Opportunity", "fact_sales_opportunities", "OpportunityID")):
        df = s[sheet]
        rec = [leads.get(_int_or_none(v)) or {} for v in _col(df, id_col)]
        if id_col == "OdooLeadID":  # an ETL-generated lead has no Odoo lead: fall back to its opportunity
            rec = [r or leads.get(_int_or_none(o)) or {} for r, o in zip(rec, _col(df, "OpportunityID"))]
        users = [u if u is not None and not pd.isna(u) else r.get("user_id_id") for u, r in zip(_col(df, "SalespersonID"), rec)]
        teams = [t if t is not None and not pd.isna(t) else r.get("team_id_id") for t, r in zip(_col(df, "SalesTeamID"), rec)]
        df = apply_org_keys(df, maps, out, table, partner_ids=[r.get("partner_id_id") for r in rec], user_ids=users, team_ids=teams,
                            company_ids=[r.get("company_id_id") for r in rec])
        out.tables[table] = _date_keys(df)

    # targets: the sheets' own key columns -------------------------------------------------------------------------------
    t = s["Fact_Targets"].copy().reset_index(drop=True)
    keys = target_sheet_rows(targets_keys)
    check_target_alignment(t, keys)
    missing = keys["SalespersonKey"].isna()
    if missing.any():
        raise ValueError(f"{int(missing.sum())} target row(s) have no SalespersonKey in sales_targets.xlsx: "
                         f"{keys.loc[missing, ['YearMonth', 'Salesperson']].head(5).to_dict('records')}")
    legacy = {c: t[c].copy() for c in ("SalesTeamKey", "ChannelKey", "SegmentKey", "CompanyKey")}
    t["SalespersonKey"] = keys["SalespersonKey"].astype("int64").to_numpy()
    t["CompanyKey"] = keys["CompanyKey"].map(lambda v: UNKNOWN if pd.isna(v) else int(v)).to_numpy()
    t["SalesTeamKey"] = t["SalesTeamKey"].map(_team_key)
    t["ChannelKey"] = t["ChannelKey"].map(lambda v: UNKNOWN if pd.isna(v) or int(v) == 1 else int(v))  # frozen: legacy codes == sheet codes
    t["SegmentKey"] = t["SegmentKey"].map(lambda v: UNKNOWN if pd.isna(v) or int(v) == 5 else int(v))
    out.parity["fact_sales_targets"] = legacy_key_parity(legacy, t)
    out.tables["fact_sales_targets"] = _date_keys(t)

    # product pages, BCG: rebuilt by the legacy builders from the conformed lines (legacy product columns restored) -----
    hybrid = lines.copy()
    hybrid["ProductKey"] = legacy_product_key.to_numpy()
    product = product_rebuild(hybrid)
    # legacy product keys of products with no PRODUCTS.xlsx row ("RAW_FROM_ODOO|<hash>", "ODOO|<id>") -> Odoo product id
    legacy_to_odoo = {}
    for k, pid in zip(hybrid["ProductKey"].to_numpy(), lines["ProductKey"].to_numpy()):
        if isinstance(k, str) and k not in maps.master_keys and k not in legacy_to_odoo and pid != UNKNOWN:
            legacy_to_odoo[k] = int(pid)
    company_by_name = {"MAJAAL": 1, "TIKA": 3}
    for name, table in (("Fact_ProductSalesDaily", "fact_sales_product_daily"), ("Dim_ProductDashboard", "dim_sales_product_dashboard"),
                        ("Dim_ProductDashboardGroup", "dim_sales_product_group"), ("ProductDashboard_Meta", "etl_sales_product_dashboard_meta"),
                        ("Fact_BCGMatrix", "fact_sales_bcg_matrix")):
        df = product[name].copy()
        if "Company" in df.columns:  # the product builders work per company display name (Majaal / Tika)
            df["CompanyKey"] = df["Company"].map(lambda c: company_by_name.get(str(c).strip().upper(), UNKNOWN) if isinstance(c, str) else UNKNOWN)
        elif "CompanyKey" in df.columns:
            df["CompanyKey"] = df["CompanyKey"].map(lambda v: UNKNOWN if pd.isna(v) else {2: 3}.get(int(v), int(v)))
        if "ProductKey" in df.columns:
            legacy_keys = df["ProductKey"]
            df = df.rename(columns={"ProductKey": "ProductMasterKey"})
            df["ProductMasterKey"] = legacy_keys.map(lambda v: v if isinstance(v, str) and v in maps.master_keys else UNKNOWN_TEXT).to_numpy()
            if name == "Fact_BCGMatrix":  # an uncatalogued product is identified by its Odoo id
                unresolved = [k for k in legacy_keys if not (isinstance(k, str) and k in maps.master_keys) and k not in legacy_to_odoo]
                out.fell("fact_sales_bcg_matrix.ProductKey (uncatalogued product without an Odoo id)", unresolved)
                df["ProductKey"] = legacy_keys.map(lambda v: UNKNOWN if isinstance(v, str) and v in maps.master_keys else legacy_to_odoo.get(v, UNKNOWN)).to_numpy()
        for c in ("SalesTeamKey",):
            if c in df.columns:
                df[c] = df[c].map(_team_key)
        if name == "Fact_ProductSalesDaily":
            grain = ["DateKey", "CompanyKey", "ProductMatchKey", "SalespersonKey", "SalesTeamKey", "ChannelKey", "SegmentKey", "IsIntercompany", "UoM"]
            df["row_key"] = [hashlib.sha1("|".join(map(str, r)).encode("utf-8")).hexdigest() for r in df[grain].itertuples(index=False)]
        out.tables[table] = _date_keys(df)

    # inventory, product cost --------------------------------------------------------------------------------------------
    inv = s["Fact_Inventory"].rename(columns={"ProductKey": "_legacy_product_key"}).copy()
    inv["CompanyKey"] = inv["CompanyKey"].map(lambda v: UNKNOWN if pd.isna(v) else {2: 3}.get(int(v), int(v)))
    pk, fell = maps.products(_col(inv, "OdooProductID"))
    out.fell("fact_sales_inventory_snapshot.ProductKey", fell)
    inv["ProductKey"] = pk
    inv["ProductMasterKey"] = maps.product_masters(pk, inv["CompanyKey"])
    out.tables["fact_sales_inventory_snapshot"] = _date_keys(inv.drop(columns=["_legacy_product_key"]))

    cost = s["Dim_ProductCost"].rename(columns={"ProductKey": "ProductMasterKey"}).copy()
    pk, _ = maps.products(_col(cost, "OdooProductID"))
    cost["ProductKey"] = pk
    cost["CompanyKey"] = cost["Company"].map(lambda c: company_by_name.get(str(c).strip().upper(), UNKNOWN) if isinstance(c, str) else UNKNOWN)
    cost["ProductMasterKey"] = maps.product_masters(pk, cost["CompanyKey"])
    out.tables["dim_sales_product_cost"] = cost

    # small sales dimensions ------------------------------------------------------------------------------------------------
    out.tables["dim_sales_crm_stage"] = s["Dim_CRMStage"].copy()
    out.tables["dim_sales_lost_reason"] = s["Dim_LostReason"].copy()
    so = build.sale_orders_raw
    so_customers, _ = maps.customers(_col(so, "partner_id_id"))
    so_companies, _ = maps.companies(_col(so, "company_id_id"))
    out.tables["dim_sales_order"] = pd.DataFrame({"SalesOrderKey": so["id"].astype("int64"), "order_number": so["name"].astype(str),
                                                  "CompanyKey": so_companies, "CustomerKey": so_customers})
    return out


def customer_growth_input(lines: pd.DataFrame, customer_names: dict[int, str]) -> pd.DataFrame:
    """The conformed sales lines in the shape CustomerDimensionBuilder expects, at commercial-partner grain."""
    df = lines.copy()
    df["customer_id"] = df["CustomerKey"].astype(str)
    df["customer"] = df["CustomerKey"].map(lambda k: customer_names.get(int(k), "Unknown"))
    df["Company"] = df.get("company_final")
    return df


GROWTH_COLUMNS = ("company", "salesperson", "SalesTeamKey", "DistributionChannel", "Branch", "First_Purchase_Date", "Last_Purchase_Date",
                  "LY_Value", "YTD_Value", "Full_2023_Value", "Full_2024_Value", "Full_2025_Value", "HasHistoryBeforeLYTD",
                  "HasHistoryPostLYTDLastYear", "IsLYTD", "IsYTD", "IsLYFullYear", "CustomerSegment", "CustomerClass_LY", "IsActiveYTD",
                  "CustomerStatus")


def growth_rows(legacy_dim: pd.DataFrame) -> pd.DataFrame:
    """CustomerDimensionBuilder output (CustomerID = str(CustomerKey)) -> dim_customer growth columns by CustomerKey."""
    df = legacy_dim.copy()
    df = df[df["CustomerID"].astype(str).str.fullmatch(r"-?\d+")]
    out = pd.DataFrame({"CustomerKey": df["CustomerID"].astype("int64").to_numpy()})
    for c in GROWTH_COLUMNS:
        out[c] = df[c].to_numpy() if c in df.columns else None
    for c in ("First_Purchase_Date", "Last_Purchase_Date"):
        out[c] = pd.to_datetime(out[c], errors="coerce").dt.date
    return out
