"""NPS Score transform: raw NPS rows -> fact_process_nps_response + fact_process_nps_comment. Pure (no database).

Rules (docs/nps-etl.md; decisions of 2026-10-18):
* Rating vs comment vs blank: ``nps.classify`` (the developer's exact rule). One response = one rating row, i.e. one
  delivery's rating; free text on the same delivery (``delivery_code``) is a comment linked to that rating; blank rows
  are counted in the run details and dropped.
* Dates: the source stores UTC (``scheduled_date`` = Odoo's picking date - 2 h, checked on 146 of 146 rows); converted
  to the business time zone (Africa/Tripoli). RatingDateKey = the local date of ``create_date``; DeliveryDateKey = the
  local date of ``scheduled_date`` (-1 when there is none).
* Keys through ``KeyMaps`` only (Odoo ids, never names): customer = the commercial partner of ``partner_id``;
  salesperson = Odoo USER ``salesperson_id`` (sheet OdooUsers); team = ``team_id`` as transacted (sheet OdooTeams),
  no team -> the salesperson's team (D3); segment follows the team, channel the salesperson.
* Company: the source's ``company_id`` is NOT used (the developer's script fills it from the WhatsApp account). It is
  the company of the matched sale order (``order_id`` = sale.order name), else of the matched delivery
  (``delivery_code`` = picking name), else ``company_name`` MAJAAL / TIKA mapped to its Odoo company
  (COMPANY_BY_SOURCE_NAME), else -1 with a warning. Order and picking names repeat across companies, so a name with
  several candidates is narrowed by the customer, then by the company name; still not exactly one -> no match.
* SalesOrderKey: the matched order (Odoo sale.order id), -1 when there is none.
"""

from __future__ import annotations

import datetime as _dt
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo

import pandas as pd

from core.keys import UNKNOWN
from core.resolve import KeyMaps, _int_or_none
from departments.process import nps

# company_name in the source -> Odoo company id (decision of 2026-10-18, as the developer's weekly report counts them)
COMPANY_BY_SOURCE_NAME: dict[str, int] = {"MAJAAL": 1, "TIKA": 3}

RESPONSE_COLUMNS = ["response_id", "delivery_code", "order_ref", "rated_at_utc", "rated_at_local", "RatingDateKey", "DeliveryDateKey",
                    "CompanyKey", "company_source", "CustomerKey", "SalespersonKey", "SalesTeamKey", "SegmentKey", "ChannelKey",
                    "SalesOrderKey", "nps_level", "is_low_rating", "in_low_rating_table", "team_branch", "has_comment"]
COMMENT_COLUMNS = ["comment_id", "response_id", "delivery_code", "commented_at_utc", "commented_at_local", "CommentDateKey",
                   "CompanyKey", "CustomerKey", "SalespersonKey", "SalesTeamKey", "SegmentKey", "ChannelKey", "comment_text"]

Candidate = tuple[int, int, int]  # (SalesOrderKey or 0, CompanyKey, CustomerKey)


@dataclass
class Lookups:
    """Warehouse lookups by NAME of document (the only link the source has to an Odoo order / picking)."""
    orders: Mapping[str, Sequence[Candidate]]  # order_number -> (SalesOrderKey, CompanyKey, CustomerKey)
    deliveries: Mapping[str, Sequence[Candidate]]  # DeliveryReference -> (0, CompanyKey, CustomerKey)


@dataclass
class Built:
    responses: pd.DataFrame
    comments: pd.DataFrame
    fallbacks: dict[str, list[Any]] = field(default_factory=dict)
    stats: dict[str, Any] = field(default_factory=dict)


def date_key(d: _dt.date | None) -> int:
    return -1 if d is None else d.year * 10000 + d.month * 100 + d.day


def to_local(value: Any, tz: ZoneInfo) -> _dt.datetime | None:
    """A naive UTC source timestamp -> naive local time in ``tz``."""
    if value is None or pd.isna(value):  # NaT is a datetime too
        return None
    ts = pd.Timestamp(value).to_pydatetime()
    return ts.replace(tzinfo=_dt.timezone.utc).astimezone(tz).replace(tzinfo=None)


def source_company(name: Any, company_keys: Iterable[int]) -> int:
    if name is None or (not isinstance(name, str) and pd.isna(name)):
        return UNKNOWN
    key = COMPANY_BY_SOURCE_NAME.get(str(name).strip().upper(), UNKNOWN)
    return key if key in set(company_keys) else UNKNOWN


def pick(candidates: Sequence[Candidate], customer_key: int, company_hint: int) -> Candidate | None:
    """The one candidate document for a name: unique as is, else narrowed by the customer, then by the company."""
    found = list(dict.fromkeys(candidates))
    if len(found) > 1 and customer_key != UNKNOWN:
        found = [c for c in found if c[2] == customer_key] or found
    if len(found) > 1 and company_hint != UNKNOWN:
        found = [c for c in found if c[1] == company_hint] or found
    return found[0] if len(found) == 1 else None


def _text(v: Any) -> str:
    return "" if v is None or (not isinstance(v, str) and pd.isna(v)) else str(v).strip()


def build(full: pd.DataFrame, low: pd.DataFrame, maps: KeyMaps, lookups: Lookups, timezone: str) -> Built:
    """``full`` / ``low``: the raw rows (raw_nps_rating / raw_nps_low_rating) that are not deleted."""
    nps.validate_levels()
    tz = ZoneInfo(timezone)
    rows = full.sort_values("id").to_dict("records")
    low_branch = {int(r["id"]): (_text(r.get("team_branch")) or None) for r in low.to_dict("records")}
    kinds = [nps.body_kind(r.get("body")) for r in rows]

    customers, cust_fell = maps.customers([r.get("partner_id") for r in rows])
    people, sp_fell = maps.salespeople([r.get("salesperson_id") for r in rows])
    teams, team_unlisted = maps.teams([r.get("team_id") for r in rows], people, person_fallback=True)
    segments, channels = maps.segments(teams), maps.channels(people)

    out_resp: list[dict[str, Any]] = []
    out_comm: list[dict[str, Any]] = []
    company_fell: list[int] = []
    order_unmatched: list[int] = []
    order_ambiguous: list[int] = []
    by_source = defaultdict(int)
    ratings_by_delivery: dict[str, list[tuple[_dt.datetime, int]]] = defaultdict(list)
    keys_of: dict[int, dict[str, Any]] = {}

    for i, r in enumerate(rows):
        rid = int(r["id"])
        hint = source_company(r.get("company_name"), maps.company_keys)
        order_ref, code = _text(r.get("order_id")), _text(r.get("delivery_code"))
        order = pick(lookups.orders.get(order_ref, ()), customers[i], hint) if order_ref else None
        if order_ref and order is None:
            (order_ambiguous if lookups.orders.get(order_ref) else order_unmatched).append(rid)
        if order is not None:
            company, src = order[1], "order"
        else:
            delivery = pick(lookups.deliveries.get(code, ()), customers[i], hint) if code else None
            if delivery is not None:
                company, src = delivery[1], "delivery"
            elif hint != UNKNOWN:
                company, src = hint, "company_name"
            else:
                company, src = UNKNOWN, "none"
                company_fell.append(rid)
        by_source[src] += 1
        keys_of[rid] = {"CompanyKey": int(company), "CustomerKey": int(customers[i]), "SalespersonKey": int(people[i]),
                        "SalesTeamKey": str(teams[i]), "SegmentKey": int(segments[i]), "ChannelKey": int(channels[i])}
        at_utc = None if r.get("create_date") is None or pd.isna(r["create_date"]) else pd.Timestamp(r["create_date"]).to_pydatetime()
        at_local = to_local(at_utc, tz)
        if kinds[i] == nps.KIND_RATING:
            level = nps.classify(r.get("body"))
            delivered = to_local(r.get("scheduled_date"), tz)
            if code and at_utc is not None:
                ratings_by_delivery[code].append((at_utc, rid))
            out_resp.append({"response_id": rid, "delivery_code": code or None, "order_ref": order_ref or None,
                             "rated_at_utc": at_utc, "rated_at_local": at_local,
                             "RatingDateKey": date_key(at_local.date() if at_local else None),
                             "DeliveryDateKey": date_key(delivered.date() if delivered else None),
                             **keys_of[rid], "company_source": src, "SalesOrderKey": int(order[0]) if order else UNKNOWN,
                             "nps_level": int(level), "is_low_rating": int(level == nps.LOW_RATING_LEVEL),
                             "in_low_rating_table": int(rid in low_branch), "team_branch": low_branch.get(rid), "has_comment": 0})
        elif kinds[i] == nps.KIND_COMMENT:
            out_comm.append({"comment_id": rid, "response_id": UNKNOWN, "delivery_code": code or None, "commented_at_utc": at_utc,
                             "commented_at_local": at_local, "CommentDateKey": date_key(at_local.date() if at_local else None),
                             **keys_of[rid], "comment_text": nps.comment_text(r.get("body"))})

    # a comment belongs to its delivery's rating: the latest one at or before it, else the first one after it
    for c in out_comm:
        found = sorted(ratings_by_delivery.get(c["delivery_code"] or "", []))
        if not found or c["commented_at_utc"] is None:
            continue
        before = [rid for at, rid in found if at <= c["commented_at_utc"]]
        c["response_id"] = before[-1] if before else found[0][1]
    commented = {c["response_id"] for c in out_comm if c["response_id"] != UNKNOWN}
    for resp in out_resp:
        resp["has_comment"] = int(resp["response_id"] in commented)

    responses = pd.DataFrame(out_resp, columns=RESPONSE_COLUMNS)
    comments = pd.DataFrame(out_comm, columns=COMMENT_COLUMNS)
    rated_ids = set(responses["response_id"])
    level_counts = responses["nps_level"].value_counts().to_dict() if len(responses) else {}
    multi = {code: len(v) for code, v in ratings_by_delivery.items() if len(v) > 1}
    stats = {
        "source_rows": len(rows), "ratings": len(out_resp), "comments": len(out_comm), "blank": kinds.count(nps.KIND_BLANK),
        "by_level": {lv.key: int(level_counts.get(lv.level, 0)) for lv in nps.LEVELS},
        "nps_style": nps.nps_style(level_counts.get(3, 0), level_counts.get(2, 0), level_counts.get(1, 0)),
        "company_source": dict(by_source), "comments_without_rating": sum(1 for c in out_comm if c["response_id"] == UNKNOWN),
        "low_rating_ids_not_in_full": sorted(set(low_branch) - {int(r["id"]) for r in rows})[:50],
        "low_ratings_not_in_low_table": sorted(int(x) for x in responses.loc[(responses["is_low_rating"] == 1) & (responses["in_low_rating_table"] == 0), "response_id"])[:50],
        "deliveries_rated_more_than_once": dict(list(multi.items())[:20]), "deliveries_rated_more_than_once_count": len(multi),
        "orders_not_found": len(order_unmatched), "orders_ambiguous": len(order_ambiguous),
    }
    fallbacks = {
        "fact_process_nps_response.CustomerKey": cust_fell,
        "fact_process_nps_response.SalespersonKey": sp_fell,
        "fact_process_nps_response.SalesTeamKey(unlisted Odoo team)": team_unlisted,
        "fact_process_nps_response.CompanyKey": [rid for rid in company_fell if rid in rated_ids],
        "fact_process_nps_response.SalesOrderKey(order name not found)": [rid for rid in order_unmatched if rid in rated_ids],
        "fact_process_nps_response.SalesOrderKey(order name ambiguous)": [rid for rid in order_ambiguous if rid in rated_ids],
    }
    return Built(responses, comments, {k: v for k, v in fallbacks.items() if v}, stats)
