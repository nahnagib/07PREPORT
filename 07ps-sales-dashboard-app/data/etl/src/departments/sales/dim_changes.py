"""Shared-list records that really changed since a point in time: the input of the incremental sales load (Phase B).

core_dims writes only new / changed rows and stamps only those with updated_at_utc (etl_platform.load.upsert_changed /
replace_changed), so "changed since T" is ``updated_at_utc > T``. Rows DELETED from a map (replace_changed) cannot be
found that way; their keys are in the core_dims task log (details.changed.<table>.deleted_keys), read here too.

``since`` is the start of the last successful sales load: everything stamped after it has not been applied yet. A
truncated deleted-key list (more than 5,000 deletions in one run) is reported as ``truncated`` so the caller can ask
for a full sales rebuild instead of guessing.
"""

from __future__ import annotations

import datetime as _dt
import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from departments.sales.affected import DimChanges

# table -> (key column, DimChanges field)
CHANGED_BY_STAMP = {
    "dim_customer": ("CustomerKey", "customers"),
    "map_partner_customer": ("partner_id", "partners"),
    "dim_product": ("ProductKey", "products"),
    "dim_product_master": ("ProductMasterKey", "product_masters"),
    "map_product_master": ("ProductKey", "mapped_products"),  # key (ProductKey = Odoo product id, CompanyKey)
    "map_odoo_user_salesperson": ("odoo_user_id", "odoo_users"),
    "map_odoo_team_sales_team": ("odoo_team_id", "odoo_teams"),
    "dim_salesperson": ("SalespersonKey", "salespeople"),
    "dim_sales_team": ("SalesTeamKey", "teams"),
    "dim_channel": ("ChannelKey", "channels"),
    "dim_segment": ("SegmentKey", "segments"),
    "dim_company": ("CompanyKey", "companies"),
}
CORE_TASKS = ("build_reference_dims", "build_org_dims", "build_customer_dims", "build_product_dims")


def _naive_utc(value: _dt.datetime) -> _dt.datetime:
    return value.astimezone(_dt.timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _key(value: Any) -> Any:
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def dim_changes_since(conn: Connection, since: _dt.datetime) -> tuple[DimChanges, dict[str, Any]]:
    """(changes, info). info: per table how many keys changed, and ``truncated`` tables whose deleted-key list was cut."""
    since = _naive_utc(since)
    out = DimChanges()
    info: dict[str, Any] = {"since_utc": since.isoformat(sep=" "), "tables": {}, "truncated": []}
    q = conn.dialect.identifier_preparer.quote
    for table, (col, attr) in CHANGED_BY_STAMP.items():
        rows = conn.execute(text(f"SELECT {q(col)} FROM {q(table)} WHERE updated_at_utc > :since"), {"since": since}).fetchall()
        keys = {_key(r[0]) for r in rows}
        getattr(out, attr).update(keys)
        info["tables"][table] = len(keys)
    logs = conn.execute(text(
        "SELECT details FROM etl_task_log WHERE status = 'success' AND finished_at_utc > :since AND task_name IN ("
        + ", ".join(f"'{t}'" for t in CORE_TASKS) + ")"), {"since": since}).fetchall()
    for (raw,) in logs:
        details = json.loads(raw) if isinstance(raw, str) else (raw or {})
        for table, summary in (details.get("changed") or {}).items():
            if table not in CHANGED_BY_STAMP or not summary.get("deleted"):
                continue
            col, attr = CHANGED_BY_STAMP[table]
            getattr(out, attr).update(_key(k[0]) for k in summary.get("deleted_keys", []))
            info["tables"][table] = info["tables"].get(table, 0) + int(summary["deleted"])
            if summary.get("deleted_keys_truncated"):
                info["truncated"].append(table)
    return out, info
