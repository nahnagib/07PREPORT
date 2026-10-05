"""<Dept>: raw Odoo frames -> conformed dimension + fact rows. Pure (no I/O), so every rule is unit-tested.

Write the department's rules here, one per bullet, the way departments/finance/transform.py does:
  * grain: ... ;
  * keys: customer / company / salesperson / team / product through core.resolve.KeyMaps (never by name);
  * labels: NONE -- keep Odoo's technical values; labels come from dim_odoo_selection_label (core.labels).
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Iterable

import pandas as pd

from core.keys import UNKNOWN
from core.resolve import KeyMaps


@dataclass
class DeptBuild:
    fact: pd.DataFrame
    dimension: pd.DataFrame
    fallbacks: dict[str, list[Any]] = field(default_factory=dict)
    stats: dict[str, Any] = field(default_factory=dict)

    def fell(self, key: str, ids: Iterable[Any]) -> None:
        ids = [i for i in ids if i is not None]
        if ids:
            self.fallbacks.setdefault(key, []).extend(ids)


def date_key(d: _dt.date | None) -> int:
    return UNKNOWN if d is None else d.year * 10000 + d.month * 100 + d.day


def build(records: pd.DataFrame, maps: KeyMaps, as_of: _dt.date) -> DeptBuild:
    out = DeptBuild(pd.DataFrame(), pd.DataFrame())
    customers, fell = maps.customers(list(records["partner_id"]))
    out.fell("fact_<dept>_<topic>.CustomerKey (partner id)", fell)
    companies, fell = maps.companies(list(records["company_id"]))
    out.fell("fact_<dept>_<topic>.CompanyKey (company id)", fell)
    people, fell = maps.salespeople(list(records["user_id"]))
    out.fell("fact_<dept>_<topic>.SalespersonKey (Odoo user not in OdooUsers)", fell)
    teams, fell = maps.teams(list(records["team_id"]), people, person_fallback=True)  # decide per fact (docs)
    out.fell("fact_<dept>_<topic>.SalesTeamKey (Odoo team id not in OdooTeams)", fell)
    out.fact = pd.DataFrame({
        "SnapshotDateKey": date_key(as_of),
        "record_id": records["id"].astype("int64").to_numpy(),
        "CustomerKey": customers, "CompanyKey": companies, "SalespersonKey": people, "SalesTeamKey": teams,
        "state": records["state"].to_numpy(),  # technical value; label via dim_odoo_selection_label
        "amount": pd.to_numeric(records["amount"]).fillna(0.0).to_numpy(),
    })
    out.stats = {"rows": len(out.fact), "amount": round(float(out.fact["amount"].sum()), 2)}
    return out
