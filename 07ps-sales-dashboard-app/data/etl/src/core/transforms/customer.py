"""Customer = Odoo COMMERCIAL partner (the company a contact/address belongs to; receivables are posted on it).

  dim_customer          one row per commercial partner (every one, with is_customer = customer_rank > 0, so a
                        late-arriving invoice or order never finds its customer missing)
  map_partner_customer  every partner id -> its commercial partner (contacts/addresses roll up)
  dim_customer_company  (customer, company) -> credit limit and default payment term (company-dependent in Odoo 17)

The Customer Growth columns of dim_customer are NOT built here: the sales job computes them per commercial
partner from its facts and upserts only those columns.
"""

from __future__ import annotations

from typing import Iterable, Mapping

import pandas as pd

from core.keys import UNKNOWN
from sales_pipeline.legacy_transform import CustomerDimensionBuilder

CORE_CUSTOMER_COLUMNS = (
    "CustomerKey", "customer", "CustomerID", "is_company", "is_customer", "SalespersonKey", "odoo_salesperson_user_id",
    "ref", "active", "is_deleted", "IsBlocked", "BlockedDate", "UnblockedDate", "BlockedReason", "Notes",
)


def _commercial_id(row_id, commercial) -> int:
    return int(commercial) if commercial is not None and not pd.isna(commercial) else int(row_id)


def build_partner_map(raw_partner: pd.DataFrame) -> pd.DataFrame:
    commercial = [_commercial_id(i, c) for i, c in zip(raw_partner["id"], raw_partner["commercial_partner_id"])]
    return pd.DataFrame({
        "partner_id": raw_partner["id"].astype("int64"),
        "CustomerKey": pd.Series(commercial, dtype="int64"),
        "is_commercial": [int(int(i) == c) for i, c in zip(raw_partner["id"], commercial)],
    }).reset_index(drop=True)


def build_customers(raw_partner: pd.DataFrame, user_to_salesperson: Mapping[int, int],
                    blocked: pd.DataFrame | None = None) -> tuple[pd.DataFrame, list[int]]:
    """Returns (dim_customer core columns, the customers whose salesperson-of-record Odoo user is not in
    sheet OdooUsers -- one entry per such customer, as the user id, for the fallback report)."""
    commercial_ids = {_commercial_id(i, c) for i, c in zip(raw_partner["id"], raw_partner["commercial_partner_id"])}
    rows = raw_partner[raw_partner["id"].isin(commercial_ids)].copy()
    names = rows["name"].where(rows["name"].notna() & (rows["name"].astype(str).str.strip() != ""), rows["display_name"])
    names = names.fillna("(no name)").astype(str).str.strip()
    # a plain list: in a pandas Series, None becomes NaN and ids become floats
    user_ids = [None if v is None or pd.isna(v) else int(v) for v in rows["user_id"]]
    sp = [user_to_salesperson.get(u, UNKNOWN) if u is not None else UNKNOWN for u in user_ids]
    unmapped_users = [u for u, k in zip(user_ids, sp) if u is not None and k == UNKNOWN]
    out = pd.DataFrame({
        "CustomerKey": rows["id"].astype("int64").to_numpy(),
        "customer": names.to_numpy(),
        "CustomerID": names.map(CustomerDimensionBuilder._make_synthetic_customer_id).to_numpy(),
        "is_company": rows["is_company"].fillna(False).astype(int).to_numpy(),
        "is_customer": (rows["customer_rank"].fillna(0) > 0).astype(int).to_numpy(),
        "SalespersonKey": sp,
        "odoo_salesperson_user_id": pd.array(user_ids, dtype="Int64"),
        "ref": rows["ref"].to_numpy(),
        "active": rows["active"].fillna(True).astype(int).to_numpy(),
        "is_deleted": rows["_deleted_at"].notna().astype(int).to_numpy() if "_deleted_at" in rows else 0,
    })
    out = apply_blocked(out, blocked)
    return out.reset_index(drop=True), unmapped_users


def apply_blocked(customers: pd.DataFrame, blocked: pd.DataFrame | None) -> pd.DataFrame:
    """BlockedCustomers.xlsx rows with a CustomerKey; the latest BlockedDate wins per customer."""
    out = customers.copy()
    for col, default in (("IsBlocked", 0), ("BlockedDate", None), ("UnblockedDate", None), ("BlockedReason", None), ("Notes", None)):
        out[col] = default
    if blocked is None or blocked.empty:
        return out
    b = blocked[blocked["CustomerKey"].notna()].copy()
    b["CustomerKey"] = b["CustomerKey"].astype("int64")
    b = b.sort_values(["CustomerKey", "BlockedDate"], na_position="first").drop_duplicates("CustomerKey", keep="last").set_index("CustomerKey")
    hit = out["CustomerKey"].isin(b.index)
    keys = out.loc[hit, "CustomerKey"]
    out.loc[hit, "IsBlocked"] = keys.map(b["IsBlocked"]).fillna(False).astype(int).to_numpy()
    for col in ("BlockedDate", "UnblockedDate", "BlockedReason", "Notes"):
        out.loc[hit, col] = keys.map(b[col]).to_numpy()
    return out


def blocked_without_customer(blocked: pd.DataFrame | None, customer_keys: Iterable[int]) -> pd.DataFrame:
    """Blocked-list rows that do not resolve to a customer (no CustomerKey, or an id that is not a customer)."""
    if blocked is None or blocked.empty:
        return pd.DataFrame(columns=["_excel_row", "CustomerName", "CustomerKey"])
    known = set(customer_keys)
    bad = blocked["CustomerKey"].isna() | ~blocked["CustomerKey"].map(lambda v: not pd.isna(v) and int(v) in known)
    return blocked.loc[bad, ["_excel_row", "CustomerName", "CustomerKey"]]


def build_customer_company(raw_partner_company: pd.DataFrame, partner_map: pd.DataFrame,
                           payment_term_keys: Iterable[int]) -> pd.DataFrame:
    known_terms = set(payment_term_keys)
    commercial = dict(zip(partner_map["partner_id"], partner_map["CustomerKey"]))
    rows = raw_partner_company[raw_partner_company["partner_id"].map(lambda p: commercial.get(p) == p)]
    return pd.DataFrame({
        "CustomerKey": rows["partner_id"].astype("int64").to_numpy(),
        "CompanyKey": rows["company_id"].astype("int64").to_numpy(),
        "credit_limit": rows["credit_limit"].to_numpy(),
        "PaymentTermKey": rows["property_payment_term_id"].map(
            lambda v: int(v) if not pd.isna(v) and int(v) in known_terms else UNKNOWN).to_numpy(),
    }).reset_index(drop=True)
