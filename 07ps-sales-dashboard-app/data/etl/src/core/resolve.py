"""Conformed-key resolution for department facts: Odoo ids -> core keys, the same way in every department.

Rules (docs/adding-a-department.md "Org rules"):
  CustomerKey     document partner -> its commercial partner (map_partner_customer)
  SalespersonKey  document user (sale order user_id, lead user_id, invoice_user_id) -> map_odoo_user_salesperson
  SalesTeamKey    AS TRANSACTED: the document's Odoo team (crm.team id) -> map_odoo_team_sales_team.
                  No Odoo team on the document, or an OdooTeams row that says SALESPERSON -> the salesperson's
                  effective team (dim_salesperson.SalesTeamKey). An Odoo team not listed in OdooTeams -> '-1'.
  SegmentKey      follows the TEAM (dim_sales_team.SegmentKey)
  ChannelKey      follows the SALESPERSON (dim_salesperson.ChannelKey)
  CompanyKey      the document's company id (unknown -> -1)
  ProductKey      Odoo product.product id; ProductMasterKey through map_product_master (ProductKey, CompanyKey)
Every function returns the keys plus the source ids that fell back to -1, for RunContext.record_fallback.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import pandas as pd
from sqlalchemy import text

from core.keys import UNKNOWN, UNKNOWN_TEXT


def _int_or_none(v: Any) -> int | None:
    if v is None or v is False:
        return None
    if isinstance(v, (list, tuple)):
        return int(v[0]) if v else None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


@dataclass
class KeyMaps:
    partner_customer: dict[int, int] = field(default_factory=dict)
    user_salesperson: dict[int, int] = field(default_factory=dict)
    team_map: dict[int, tuple[str, bool]] = field(default_factory=dict)
    salesperson_team: dict[int, str] = field(default_factory=dict)
    salesperson_channel: dict[int, int] = field(default_factory=dict)
    team_segment: dict[str, int] = field(default_factory=dict)
    company_keys: set[int] = field(default_factory=set)
    product_keys: set[int] = field(default_factory=set)
    product_master: dict[tuple[int, int], str] = field(default_factory=dict)
    master_keys: set[str] = field(default_factory=set)

    @classmethod
    def load(cls, conn) -> "KeyMaps":
        def rows(sql):
            return conn.execute(text(sql)).fetchall()

        return cls(
            partner_customer={int(p): int(c) for p, c in rows("SELECT partner_id, CustomerKey FROM map_partner_customer")},
            user_salesperson={int(u): int(s) for u, s in rows("SELECT odoo_user_id, SalespersonKey FROM map_odoo_user_salesperson")},
            team_map={int(t): (str(k), bool(f)) for t, k, f in rows("SELECT odoo_team_id, SalesTeamKey, follows_salesperson FROM map_odoo_team_sales_team")},
            salesperson_team={int(s): str(t) for s, t in rows("SELECT SalespersonKey, SalesTeamKey FROM dim_salesperson")},
            salesperson_channel={int(s): int(c) for s, c in rows("SELECT SalespersonKey, ChannelKey FROM dim_salesperson")},
            team_segment={str(t): int(s) for t, s in rows("SELECT SalesTeamKey, SegmentKey FROM dim_sales_team")},
            company_keys={int(c) for (c,) in rows("SELECT CompanyKey FROM dim_company")},
            product_keys={int(p) for (p,) in rows("SELECT ProductKey FROM dim_product")},
            product_master={(int(p), int(c)): str(m) for p, c, m in rows("SELECT ProductKey, CompanyKey, ProductMasterKey FROM map_product_master")},
            master_keys={str(m) for (m,) in rows("SELECT ProductMasterKey FROM dim_product_master")},
        )

    # -- resolvers (all vectorised over Python lists; inputs may be ids, floats, NaN, None or Odoo [id, name]) ----
    def customers(self, partner_ids: Iterable[Any]) -> tuple[list[int], list[int]]:
        keys, fell = [], []
        for v in partner_ids:
            pid = _int_or_none(v)
            k = self.partner_customer.get(pid, UNKNOWN) if pid is not None else UNKNOWN
            if pid is not None and k == UNKNOWN:
                fell.append(pid)
            keys.append(k)
        return keys, fell

    def salespeople(self, user_ids: Iterable[Any]) -> tuple[list[int], list[int]]:
        keys, fell = [], []
        for v in user_ids:
            uid = _int_or_none(v)
            k = self.user_salesperson.get(uid, UNKNOWN) if uid is not None else UNKNOWN
            if uid is not None and k == UNKNOWN:
                fell.append(uid)
            keys.append(k)
        return keys, fell

    def teams(self, odoo_team_ids: Iterable[Any], salesperson_keys: Sequence[int], *,
              person_fallback: bool = True) -> tuple[list[str], list[int]]:
        """Team as transacted (see module doc). Returns (SalesTeamKey per row, Odoo team ids not in OdooTeams).

        ``person_fallback``: what a document with no Odoo team (or a SALESPERSON team) gets -- the salesperson's
        effective team (True) or '-1' Unknown (False). Set per fact to what the legacy pipeline did for that fact."""
        keys, unlisted = [], []
        for v, sp in zip(odoo_team_ids, salesperson_keys):
            tid = _int_or_none(v)
            person_team = self.salesperson_team.get(int(sp), UNKNOWN_TEXT) if person_fallback else UNKNOWN_TEXT
            if tid is None:
                keys.append(person_team)
                continue
            mapped = self.team_map.get(tid)
            if mapped is None:
                unlisted.append(tid)
                keys.append(UNKNOWN_TEXT)
            elif mapped[1]:
                keys.append(person_team)
            else:
                keys.append(mapped[0])
        return keys, unlisted

    def segments(self, team_keys: Iterable[str]) -> list[int]:
        return [self.team_segment.get(str(t), UNKNOWN) for t in team_keys]

    def channels(self, salesperson_keys: Iterable[int]) -> list[int]:
        return [self.salesperson_channel.get(int(s), UNKNOWN) for s in salesperson_keys]

    def companies(self, company_ids: Iterable[Any]) -> tuple[list[int], list[Any]]:
        keys, fell = [], []
        for v in company_ids:
            cid = _int_or_none(v)
            if cid is not None and cid in self.company_keys:
                keys.append(cid)
            else:
                keys.append(UNKNOWN)
                if cid is not None:
                    fell.append(cid)
        return keys, fell

    def products(self, product_ids: Iterable[Any]) -> tuple[list[int], list[int]]:
        keys, fell = [], []
        for v in product_ids:
            pid = _int_or_none(v)
            if pid is not None and pid in self.product_keys:
                keys.append(pid)
            else:
                keys.append(UNKNOWN)
                if pid is not None:
                    fell.append(pid)
        return keys, fell

    def product_masters(self, product_keys: Sequence[int], company_keys: Sequence[int]) -> list[str]:
        return [self.product_master.get((int(p), int(c)), UNKNOWN_TEXT) for p, c in zip(product_keys, company_keys)]
