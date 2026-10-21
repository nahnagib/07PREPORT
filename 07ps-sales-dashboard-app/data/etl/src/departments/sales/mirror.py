"""Odoo mirror for the incremental sales build (Phase B step 1, docs/etl-phase-b-sales-incremental.md).

The sales build reads 12 Odoo models through the legacy repositories (sale.order, stock.picking, stock.move, crm.*,
product.product per company, stock.quant, stock.location, res.company) plus sale.order.line / uom.uom for the
sale.report rebuild. This module keeps a copy of exactly those records in ``raw_odoo_mirror`` -- the search_read
record as Odoo returned it, with the union of the fields every reader asks for -- and answers the repositories from it
(``MirrorClient``), so the build runs the unchanged legacy code without touching Odoo.

Keeping it current (``sync``, every 30 minutes):
* per model: records with ``write_date >= previous read start - ETL_MIRROR_OVERLAP_MINUTES`` (the first run reads all);
  a stored record is rewritten only when its content changed;
* rules for values that change without the record's own write_date moving (Odoo computes them from other records):
  product.template changed -> its variants re-read (name / display_name); product cost changed -> its stock quants
  re-read (value); a lead's activities changed (or appeared / disappeared) -> the lead re-read (activity_* fields);
* many2one display names come from ``raw_odoo_names`` (current names of the referenced records, kept by write_date;
  res.users names follow their partner), never from the stored [id, name] pair: renaming a customer does not move the
  orders' write_date;
* id checks (deleted records; ids missing from the mirror are read): sale.order, stock.picking, crm.lead and stock.quant
  every cycle (ids only; Odoo deletes empty quants all the time), every model on a ``full_check`` (02:00); a changed
  order / picking re-checks its lines / moves (a removed line moves only the order's write_date), together with an audit of the write_date of every record
  changed in the last ETL_MIRROR_AUDIT_DAYS days and a re-read of every lead with activities (activity_state moves
  with the date).

Every Odoo read is counted per model (sales_pipeline.odoo.client rows_read_*): the run logs them.
"""

from __future__ import annotations

import dataclasses
import contextlib
import datetime as _dt
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

import pandas as pd
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from departments.sales import sale_report as sr
from sales_pipeline.inventory import RES_COMPANY_FIELDS, STOCK_LOCATION_FIELDS, STOCK_QUANT_FIELDS
from sales_pipeline.odoo.crm_repository import CRM_LEAD_FIELDS, CRM_LOST_REASON_FIELDS, CRM_STAGE_FIELDS
from sales_pipeline.odoo.product_cost_repository import PRODUCT_COST_FIELDS
from sales_pipeline.odoo.sale_order_line_repository import SALE_ORDER_LINE_FIELDS
from sales_pipeline.odoo.sale_order_repository import SALE_ORDER_FIELDS
from sales_pipeline.odoo.stock_move_repository import STOCK_MOVE_FIELDS
from sales_pipeline.odoo.stock_picking_repository import STOCK_PICKING_FIELDS

log = logging.getLogger(__name__)

ODOO_DT = "%Y-%m-%d %H:%M:%S"
FIELDS_GET_ATTRS = ["string", "type", "relation", "store"]
LEAD_TYPE_DOMAIN = (("type", "in", ["lead", "opportunity"]),)


def _u(*lists: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(["id", "write_date", *(f for lst in lists for f in lst)]))


@dataclass(frozen=True)
class MirrorSpec:
    model: str
    fields: tuple[str, ...]
    domain: tuple = ()                     # the domain of the full read (what the repositories read)
    context: Mapping[str, Any] = field(default_factory=dict)
    per_company: bool = False              # one copy per accessible company (company-dependent fields)
    id_check_every_cycle: bool = False
    domain_if_field: tuple[str, tuple] | None = None  # (field, domain): applied only when the field exists (crm.lead.type)


ARCHIVED = {"active_test": False}
SPECS: tuple[MirrorSpec, ...] = (
    MirrorSpec("sale.order", _u(SALE_ORDER_FIELDS, sr.ORDER_FIELDS), id_check_every_cycle=True),
    MirrorSpec("sale.order.line", _u(sr.LINE_FIELDS, SALE_ORDER_LINE_FIELDS)),
    MirrorSpec("stock.picking", _u(STOCK_PICKING_FIELDS), id_check_every_cycle=True),
    MirrorSpec("stock.move", _u(STOCK_MOVE_FIELDS)),
    MirrorSpec("crm.lead", _u(CRM_LEAD_FIELDS), context=ARCHIVED, domain_if_field=("type", LEAD_TYPE_DOMAIN),
               id_check_every_cycle=True),
    MirrorSpec("crm.stage", _u(CRM_STAGE_FIELDS)),
    MirrorSpec("crm.lost.reason", _u(CRM_LOST_REASON_FIELDS), context=ARCHIVED),
    MirrorSpec("product.product", _u(PRODUCT_COST_FIELDS, sr.PRODUCT_FIELDS), context=ARCHIVED, per_company=True),
    MirrorSpec("stock.quant", _u(STOCK_QUANT_FIELDS), id_check_every_cycle=True),
    MirrorSpec("stock.location", _u(STOCK_LOCATION_FIELDS), context=ARCHIVED),
    MirrorSpec("res.company", _u(RES_COMPANY_FIELDS, ["name", "currency_id"]), context=ARCHIVED),
    MirrorSpec("uom.uom", _u(["name", "factor"]), context=ARCHIVED),
)
SPEC_BY_MODEL = {s.model: s for s in SPECS}
# child model -> (parent model, link field): a child removed from its parent leaves no write_date of its own (the parent's
# moves), so when a parent changes its children's ids are re-checked; a deleted parent takes its children along
CHILDREN = {"sale.order.line": ("sale.order", "order_id"), "stock.move": ("stock.picking", "picking_id")}
USER_MODEL = "res.users"  # the ETL user's company_ids (ProductCostRepository._accessible_companies), one record
# display names that follow another model (a rename there does not move this model's write_date)
NAME_FOLLOWS = {"res.users": ("res.partner", "partner_id"), "product.product": ("product.template", "product_tmpl_id")}


class MirrorError(RuntimeError):
    """The mirror cannot answer a request the way Odoo would (unsupported domain / order / model)."""


# -- helpers -------------------------------------------------------------------------------------------------------------
def utc_now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None, microsecond=0)


def _dt_str(value: _dt.datetime) -> str:
    return value.strftime(ODOO_DT)


def _parse_dt(value: Any) -> _dt.datetime | None:
    if not value:
        return None
    try:
        return _dt.datetime.strptime(str(value)[:19], ODOO_DT)
    except ValueError:
        return None


def _payload(record: Mapping[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(payload: str) -> str:
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _chunks(values: Sequence[Any], size: int) -> Iterable[list[Any]]:
    values = list(values)
    for i in range(0, len(values), size):
        yield values[i:i + size]


def dataset_name(model: str, ctx: int = 0, kind: str = "mirror") -> str:
    return f"{kind}:{model}" + (f"@{ctx}" if ctx else "")


# -- store -----------------------------------------------------------------------------------------------------------------
class MirrorStore:
    """raw_odoo_mirror / _meta / raw_odoo_names on one connection."""

    def __init__(self, conn: Connection) -> None:
        self.conn = conn

    def meta(self, model: str, ctx: int = 0) -> dict[str, Any] | None:
        row = self.conn.execute(text("SELECT fields_json, fields_get_json, domain_json FROM raw_odoo_mirror_meta "
                                     "WHERE model = :m AND company_ctx = :c"), {"m": model, "c": ctx}).first()
        if row is None:
            return None
        return {"fields": json.loads(row[0]), "fields_get": json.loads(row[1]), "domain": json.loads(row[2])}

    def save_meta(self, model: str, ctx: int, fields: Sequence[str], fields_get: Mapping[str, Any], domain: Sequence[Any]) -> None:
        params = {"m": model, "c": ctx, "f": json.dumps(list(fields)), "g": json.dumps(fields_get, ensure_ascii=False, sort_keys=True),
                  "d": json.dumps([list(t) if isinstance(t, (list, tuple)) else t for t in domain]), "t": utc_now()}
        if not self.conn.execute(text("UPDATE raw_odoo_mirror_meta SET fields_json = :f, fields_get_json = :g, domain_json = :d, "
                                      "refreshed_at_utc = :t WHERE model = :m AND company_ctx = :c"), params).rowcount:
            self.conn.execute(text("INSERT INTO raw_odoo_mirror_meta (model, company_ctx, fields_json, fields_get_json, domain_json, "
                                   "refreshed_at_utc) VALUES (:m, :c, :f, :g, :d, :t)"), params)

    def stored_hashes(self, model: str, ctx: int, ids: Sequence[int] | None = None) -> dict[int, str]:
        out: dict[int, str] = {}
        if ids is None:
            rows = self.conn.execute(text("SELECT record_id, payload FROM raw_odoo_mirror WHERE model = :m AND company_ctx = :c"),
                                     {"m": model, "c": ctx})
            return {int(r[0]): _hash(r[1]) for r in rows}
        for chunk in _chunks(sorted(set(ids)), 1000):
            rows = self.conn.execute(text(f"SELECT record_id, payload FROM raw_odoo_mirror WHERE model = :m AND company_ctx = :c "
                                          f"AND record_id IN ({','.join(str(int(i)) for i in chunk)})"), {"m": model, "c": ctx})
            out.update({int(r[0]): _hash(r[1]) for r in rows})
        return out

    def ids(self, model: str, ctx: int = 0) -> set[int]:
        return {int(r[0]) for r in self.conn.execute(
            text("SELECT record_id FROM raw_odoo_mirror WHERE model = :m AND company_ctx = :c"), {"m": model, "c": ctx})}

    def write_dates(self, model: str, ctx: int, ids: Sequence[int]) -> dict[int, _dt.datetime | None]:
        out: dict[int, _dt.datetime | None] = {}
        for chunk in _chunks(sorted(set(ids)), 1000):
            rows = self.conn.execute(text(f"SELECT record_id, write_date FROM raw_odoo_mirror WHERE model = :m AND company_ctx = :c "
                                          f"AND record_id IN ({','.join(str(int(i)) for i in chunk)})"), {"m": model, "c": ctx})
            out.update({int(r[0]): r[1] for r in rows})
        return out

    def upsert(self, model: str, ctx: int, records: Sequence[Mapping[str, Any]], run_uid: str | None) -> list[int]:
        """Stores the records whose content changed; returns their ids (new or changed)."""
        if not records:
            return []
        by_id = {int(r["id"]): r for r in records}  # a record read twice keeps the last read
        old = self.stored_hashes(model, ctx, list(by_id))
        now = utc_now()
        rows, changed = [], []
        for rid, rec in by_id.items():
            payload = _payload(rec)
            if old.get(rid) == _hash(payload):
                continue
            changed.append(rid)
            parent = _m2o_id(rec.get(CHILDREN[model][1])) if model in CHILDREN else None
            rows.append({"m": model, "c": ctx, "i": rid, "pa": parent, "w": _parse_dt(rec.get("write_date")), "p": payload, "t": now, "r": run_uid})
        cols = "(model, company_ctx, record_id, parent_id, write_date, payload, mirrored_at_utc, run_uid) VALUES (:m, :c, :i, :pa, :w, :p, :t, :r)"
        for chunk in _chunks(rows, 500):
            self.conn.execute(text(f"INSERT INTO raw_odoo_mirror {cols} ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id), "
                                   "write_date = VALUES(write_date), payload = VALUES(payload), mirrored_at_utc = VALUES(mirrored_at_utc), "
                                   "run_uid = VALUES(run_uid)")
                              if self.conn.dialect.name == "mysql" else
                              text(f"INSERT INTO raw_odoo_mirror {cols} ON CONFLICT (model, company_ctx, record_id) DO UPDATE SET "
                                   "parent_id = excluded.parent_id, write_date = excluded.write_date, payload = excluded.payload, "
                                   "mirrored_at_utc = excluded.mirrored_at_utc, run_uid = excluded.run_uid"), chunk)
        return changed

    def child_ids(self, model: str, parents: Sequence[int]) -> dict[int, int]:
        """child id -> parent id for the mirrored children of ``parents``."""
        out: dict[int, int] = {}
        for chunk in _chunks(sorted({int(p) for p in parents}), 1000):
            out.update({int(r[0]): int(r[1]) for r in self.conn.execute(text(
                f"SELECT record_id, parent_id FROM raw_odoo_mirror WHERE model = :m AND parent_id IN ({','.join(str(i) for i in chunk)})"),
                {"m": model})})
        return out

    def delete(self, model: str, ctx: int, ids: Iterable[int]) -> list[int]:
        ids = sorted({int(i) for i in ids})
        for chunk in _chunks(ids, 1000):
            self.conn.execute(text(f"DELETE FROM raw_odoo_mirror WHERE model = :m AND company_ctx = :c "
                                   f"AND record_id IN ({','.join(str(i) for i in chunk)})"), {"m": model, "c": ctx})
        return ids

    def payloads(self, model: str, ctx: int = 0, ids: Sequence[int] | None = None) -> list[dict[str, Any]]:
        if ids is None:
            rows = self.conn.execute(text("SELECT payload FROM raw_odoo_mirror WHERE model = :m AND company_ctx = :c ORDER BY record_id"),
                                     {"m": model, "c": ctx})
            return [json.loads(r[0]) for r in rows]
        out = []
        for chunk in _chunks(sorted(set(ids)), 1000):
            out += [json.loads(r[0]) for r in self.conn.execute(text(
                f"SELECT payload FROM raw_odoo_mirror WHERE model = :m AND company_ctx = :c AND record_id IN ({','.join(str(int(i)) for i in chunk)}) "
                f"ORDER BY record_id"), {"m": model, "c": ctx})]
        return out

    def contexts(self, model: str) -> list[int]:
        return sorted(int(r[0]) for r in self.conn.execute(text("SELECT company_ctx FROM raw_odoo_mirror_meta WHERE model = :m"), {"m": model}))

    def upsert_names(self, model: str, records: Sequence[Mapping[str, Any]]) -> list[int]:
        if not records:
            return []
        by_id = {int(r["id"]): r for r in records}
        old: dict[int, Any] = {}
        for chunk in _chunks(sorted(by_id), 1000):
            old.update({int(r[0]): r[1] for r in self.conn.execute(text(
                f"SELECT record_id, display_name FROM raw_odoo_names WHERE model = :m AND record_id IN ({','.join(str(i) for i in chunk)})"),
                {"m": model})})
        now = utc_now()
        rows = [{"m": model, "i": rid, "n": _display(r), "w": _parse_dt(r.get("write_date")), "t": now}
                for rid, r in by_id.items() if rid not in old or old[rid] != _display(r)]
        sql = ("INSERT INTO raw_odoo_names (model, record_id, display_name, write_date, mirrored_at_utc) VALUES (:m, :i, :n, :w, :t) "
               + ("ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), write_date = VALUES(write_date), "
                  "mirrored_at_utc = VALUES(mirrored_at_utc)" if self.conn.dialect.name == "mysql" else
                  "ON CONFLICT (model, record_id) DO UPDATE SET display_name = excluded.display_name, write_date = excluded.write_date, "
                  "mirrored_at_utc = excluded.mirrored_at_utc"))
        for chunk in _chunks(rows, 1000):
            self.conn.execute(text(sql), chunk)
        return [r["i"] for r in rows]

    def names(self, model: str) -> dict[int, str]:
        return {int(r[0]): r[1] for r in self.conn.execute(text("SELECT record_id, display_name FROM raw_odoo_names WHERE model = :m"),
                                                           {"m": model}) if r[1] is not None}


def _m2o_id(value: Any) -> int | None:
    if isinstance(value, (list, tuple)) and value:
        return int(value[0])
    return None


def _display(record: Mapping[str, Any]) -> str | None:
    value = record.get("display_name")
    return None if value in (False, None) else str(value)


# -- sync (Odoo -> mirror) -----------------------------------------------------------------------------------------------
@dataclass
class SyncResult:
    changed: dict[str, int] = field(default_factory=dict)      # dataset -> records stored (new or changed)
    deleted: dict[str, int] = field(default_factory=dict)
    names_changed: dict[str, int] = field(default_factory=dict)
    rule_rereads: dict[str, int] = field(default_factory=dict)  # rule -> records re-read
    names_unavailable: dict[str, str] = field(default_factory=dict)
    non_stored_fields: dict[str, list[str]] = field(default_factory=dict)  # model -> mirrored fields Odoo does not store
    first_fill: list[str] = field(default_factory=list)
    full_check: bool = False

    @property
    def any_change(self) -> bool:
        return bool(sum(self.changed.values()) + sum(self.deleted.values()) + sum(self.names_changed.values()))

    def summary(self) -> dict[str, Any]:
        return {"changed": {k: v for k, v in self.changed.items() if v}, "deleted": {k: v for k, v in self.deleted.items() if v},
                "names_changed": {k: v for k, v in self.names_changed.items() if v},
                "rule_rereads": {k: v for k, v in self.rule_rereads.items() if v}, "names_unavailable": self.names_unavailable,
                "non_stored_fields": self.non_stored_fields, "first_fill": self.first_fill, "full_check": self.full_check,
                "any_change": self.any_change}


# non-stored fields that a rule below keeps current; any other non-stored field is reported (summary.non_stored_fields)
COVERED_NON_STORED = {
    # template rule (name / display_name / uom_id / company_id are the template's); standard_price moves the product write_date
    "product.product": {"display_name", "name", "standard_price", "uom_id", "company_id"},
    "stock.picking": {"picking_type_code"},                           # the operation type's code: fixed per type
    "stock.quant": {"value", "inventory_value"},                      # product cost rule
    "crm.lead": {"activity_date_deadline", "activity_summary", "activity_state", "activity_type_id", "activity_user_id"},
}


class MirrorSync:
    """One sync of every spec. ``client``: a read-only Odoo client (search_read / search / fields_get). Each model (with
    its watermark), the rules and the names commit on their own: a failure keeps what was already mirrored (a first
    fill reads every record once; it must not start over)."""

    def __init__(self, client: Any, engine: Engine, watermarks: Any, *, run_uid: str | None, overlap_minutes: int,
                 audit_days: int, page_size: int = 2000, now: Callable[[], _dt.datetime] = utc_now) -> None:
        self.client, self.engine, self.wm = client, engine, watermarks
        self.conn: Connection | None = None
        self.store: MirrorStore | None = None
        self.run_uid, self.overlap = run_uid, _dt.timedelta(minutes=overlap_minutes)
        self.audit = _dt.timedelta(days=audit_days)
        self.page = page_size
        self.now = now
        self.result = SyncResult()
        self._meta: dict[tuple[str, int], dict[str, Any]] = {}
        self._deleted: dict[str, set[int]] = {}

    # -- Odoo reads ----------------------------------------------------------------------------------------------------
    def _read(self, model: str, domain: list, fields: Sequence[str], context: Mapping[str, Any]) -> list[dict[str, Any]]:
        """Every matching record, keyset-paged by id (records changing while we page keep their id)."""
        out, last = [], 0
        while True:
            page = self.client.search_read(model, [*domain, ["id", ">", last]], list(fields), offset=0, limit=self.page, order="id",
                                           context=dict(context) or None)
            out.extend(page)
            if len(page) < self.page:
                return out
            last = int(page[-1]["id"])

    def _read_ids(self, model: str, ids: Iterable[int], fields: Sequence[str], context: Mapping[str, Any]) -> list[dict[str, Any]]:
        out = []
        for chunk in _chunks(sorted({int(i) for i in ids}), 500):
            out += self.client.search_read(model, [["id", "in", chunk]], list(fields), offset=0, limit=len(chunk), order="id",
                                           context=dict(context) or None)
        return out

    # -- specs -----------------------------------------------------------------------------------------------------------
    def contexts(self, spec: MirrorSpec) -> list[tuple[int, dict[str, Any]]]:
        if not spec.per_company:
            return [(0, dict(spec.context))]
        return [(cid, {**spec.context, "allowed_company_ids": [cid], "force_company": cid}) for cid in self.companies]

    def _spec_meta(self, spec: MirrorSpec, ctx: int, context: Mapping[str, Any], refresh: bool) -> dict[str, Any]:
        key = (spec.model, ctx)
        if key in self._meta:
            return self._meta[key]
        meta = None if refresh else self.store.meta(spec.model, ctx)
        if meta is None:
            fg = self.client.fields_get(spec.model, attributes=FIELDS_GET_ATTRS)
            fields = [f for f in spec.fields if f in fg]
            domain = list(spec.domain)
            if spec.domain_if_field and spec.domain_if_field[0] in fg:
                domain += [list(t) for t in spec.domain_if_field[1]]
            self.store.save_meta(spec.model, ctx, fields, fg, domain)
            meta = {"fields": fields, "fields_get": fg, "domain": domain}
        non_stored = sorted(f for f in meta["fields"] if meta["fields_get"].get(f, {}).get("store") is False
                            and f not in COVERED_NON_STORED.get(spec.model, set()))
        if non_stored:
            self.result.non_stored_fields[spec.model] = non_stored
        self._meta[key] = meta
        return meta

    @contextlib.contextmanager
    def _tx(self):
        with self.engine.begin() as conn:
            self.conn, self.store = conn, MirrorStore(conn)
            try:
                yield
            finally:
                self.conn, self.store = None, None

    def run(self, *, full_check: bool = False) -> SyncResult:
        self.result.full_check = full_check
        with self._tx():
            self.companies = self._user_companies(refresh=full_check)
        changed_ids: dict[str, set[int]] = {}
        for spec in SPECS:
            for ctx, context in self.contexts(spec):
                t0 = time.perf_counter()
                with self._tx():
                    ids = self._sync_spec(spec, ctx, context, full_check=full_check)
                ds = dataset_name(spec.model, ctx)
                log.info("Mirror %s: %s stored, %s deleted (%.1fs)", ds, f"{self.result.changed.get(ds, 0):,}",
                         f"{self.result.deleted.get(ds, 0):,}", time.perf_counter() - t0)
                changed_ids.setdefault(spec.model, set()).update(ids)
        with self._tx():
            self._rules(changed_ids, full_check=full_check)
        with self._tx():
            self._names()
        return self.result

    def _user_companies(self, *, refresh: bool) -> list[int]:
        """The ETL user's companies (what ProductCostRepository reads product costs for), mirrored as one res.users row."""
        uid = self.client.uid or self.client.authenticate()
        stored = self.store.payloads(USER_MODEL, 0, [uid])
        if refresh or not stored:
            rec = self.client.search_read(USER_MODEL, [["id", "=", uid]], ["id", "company_ids"], limit=1)
            self.store.upsert(USER_MODEL, 0, rec, self.run_uid)
            stored = rec
        return sorted(int(c) for c in (stored[0]["company_ids"] if stored else []))

    def _sync_spec(self, spec: MirrorSpec, ctx: int, context: dict[str, Any], *, full_check: bool) -> set[int]:
        ds = dataset_name(spec.model, ctx)
        meta = self._spec_meta(spec, ctx, context, refresh=full_check)
        fields, domain = meta["fields"], meta["domain"]
        wm = self.wm.get(ds, conn=self.conn)
        started = self.now()
        if wm.write_date is None:
            records = self._read(spec.model, domain, fields, context)
            self.result.first_fill.append(ds)
        else:
            since = _dt_str(wm.write_date - self.overlap)
            records = self._read(spec.model, [*domain, ["write_date", ">=", since]], fields, context)
        changed = set(self.store.upsert(spec.model, ctx, records, self.run_uid))
        deleted: list[int] = []
        if wm.write_date is not None and (full_check or spec.id_check_every_cycle):
            odoo_ids = set(self.client.search(spec.model, domain, context=dict(context) or None))
            mine = self.store.ids(spec.model, ctx)
            deleted = self.store.delete(spec.model, ctx, mine - odoo_ids)
            missing = odoo_ids - mine
            if missing:  # created and never seen (a missed transaction): read them now
                changed |= set(self.store.upsert(spec.model, ctx, self._read_ids(spec.model, missing, fields, context), self.run_uid))
            if full_check:
                changed |= self._audit(spec, ctx, context, fields, domain, started)
        self.result.changed[ds] = len(changed)
        self.result.deleted[ds] = len(deleted)
        self._deleted.setdefault(spec.model, set()).update(deleted)
        self.wm.save(dataclasses.replace(wm, write_date=started), run_uid=self.run_uid, conn=self.conn, full_refresh=ds in self.result.first_fill,
                     reconciled=full_check or spec.id_check_every_cycle)
        return changed | set(deleted)

    def _audit(self, spec: MirrorSpec, ctx: int, context: dict[str, Any], fields: Sequence[str], domain: list,
               started: _dt.datetime) -> set[int]:
        """write_date of every record changed in the last ETL_MIRROR_AUDIT_DAYS days vs the mirror: a different one is re-read."""
        recent = self._read(spec.model, [*domain, ["write_date", ">=", _dt_str(started - self.audit)]], ["id", "write_date"], context)
        stored = self.store.write_dates(spec.model, ctx, [r["id"] for r in recent])
        stale = [int(r["id"]) for r in recent if stored.get(int(r["id"])) != _parse_dt(r.get("write_date"))]
        if not stale:
            return set()
        self.result.rule_rereads[f"audit:{spec.model}"] = len(stale)
        return set(self.store.upsert(spec.model, ctx, self._read_ids(spec.model, stale, fields, context), self.run_uid))

    # -- rules: values that change without the record's own write_date moving --------------------------------------------
    def _rule_since(self, name: str) -> tuple[Any, _dt.datetime | None, _dt.datetime]:
        wm = self.wm.get(dataset_name(name, kind="rule"), conn=self.conn)
        return wm, (wm.write_date - self.overlap) if wm.write_date else None, self.now()

    def _rule_done(self, wm: Any, started: _dt.datetime) -> None:
        self.wm.save(dataclasses.replace(wm, write_date=started), run_uid=self.run_uid, conn=self.conn)

    def _reread(self, model: str, ids: set[int], rule: str) -> set[int]:
        if not ids:
            return set()
        spec = SPEC_BY_MODEL[model]
        changed: set[int] = set()
        for ctx, context in self.contexts(spec):
            meta = self._spec_meta(spec, ctx, context, refresh=False)
            changed |= set(self.store.upsert(model, ctx, self._read_ids(model, ids, meta["fields"], context), self.run_uid))
        self.result.rule_rereads[rule] = self.result.rule_rereads.get(rule, 0) + len(ids)
        if changed:
            ds = dataset_name(model)
            self.result.changed[ds] = self.result.changed.get(ds, 0) + len(changed)
        return changed

    def _rules(self, changed_ids: dict[str, set[int]], *, full_check: bool) -> None:
        # parent changed -> its children's ids re-checked (a removed line / move); parent deleted -> its children deleted
        for child, (parent, link) in CHILDREN.items():
            parents = changed_ids.get(parent, set())
            if not parents:
                continue
            gone = self._deleted.get(parent, set())
            mirrored = self.store.child_ids(child, parents)
            odoo: set[int] = set()
            live = sorted(parents - gone)
            for chunk in _chunks(live, 1000):
                odoo |= set(self.client.search(child, [[link, "in", chunk]]))
            removed = self.store.delete(child, 0, set(mirrored) - odoo)
            if removed:
                ds = dataset_name(child)
                self.result.deleted[ds] = self.result.deleted.get(ds, 0) + len(removed)
                changed_ids.setdefault(child, set()).update(removed)
            unseen = odoo - set(mirrored) - changed_ids.get(child, set())
            if unseen:  # a child of a changed parent that the write_date read did not bring (missed transaction)
                changed_ids.setdefault(child, set()).update(self._reread(child, unseen, f"{parent} -> {child}"))
        # product.template -> its variants (name / display_name come from the template)
        wm, since, started = self._rule_since("product.template")
        if since is not None:
            tmpl = self.client.search("product.template", [["write_date", ">=", _dt_str(since)]], context=dict(ARCHIVED))
            if tmpl:
                variants = set(self.client.search("product.product", [["product_tmpl_id", "in", tmpl]], context=dict(ARCHIVED)))
                changed_ids["product.product"] = changed_ids.get("product.product", set()) | self._reread(
                    "product.product", variants, "product.template -> product.product")
        self._rule_done(wm, started)
        # product changed (cost) -> its quants (value = quantity x cost)
        products = changed_ids.get("product.product", set())
        if products:
            quants = set()
            for chunk in _chunks(sorted(products), 1000):
                quants |= set(self.client.search("stock.quant", [["product_id", "in", chunk]]))
            self._reread("stock.quant", quants, "product.product -> stock.quant")
        # activities -> leads (activity_* fields are computed from mail.activity)
        lead_spec = SPEC_BY_MODEL["crm.lead"]
        lead_domain = self._spec_meta(lead_spec, 0, lead_spec.context, refresh=False)["domain"]
        wm, since, started = self._rule_since("mail.activity")
        leads: set[int] = set()
        if since is not None:
            acts = self.client.search_read("mail.activity", [["res_model", "=", "crm.lead"], ["write_date", ">=", _dt_str(since)]],
                                           ["res_id"], limit=0)
            leads |= {int(a["res_id"]) for a in acts if a.get("res_id")}
            with_acts = set(self.client.search("crm.lead", [*lead_domain, ["activity_ids", "!=", False]], context=dict(ARCHIVED)))
            mirrored_with = {int(p["id"]) for p in self.store.payloads("crm.lead") if p.get("activity_state")}
            leads |= with_acts ^ mirrored_with  # an activity done (deleted) leaves no trace but this
            if full_check:  # activity_state (overdue / today / planned) moves with the date
                leads |= with_acts
        self._reread("crm.lead", leads & self.store.ids("crm.lead"), "mail.activity -> crm.lead")
        self._rule_done(wm, started)

    # -- display names -----------------------------------------------------------------------------------------------------
    def relation_models(self) -> list[str]:
        rel = set()
        for (model, _), meta in self._meta.items():
            for f in meta["fields"]:
                info = meta["fields_get"].get(f, {})
                if info.get("type") == "many2one" and info.get("relation"):
                    rel.add(info["relation"])
        return sorted(rel)

    def _names(self) -> None:
        followed_changes: dict[str, list[int]] = {}
        for model in self.relation_models():
            ds = dataset_name(model, kind="names")
            wm = self.wm.get(ds, conn=self.conn)
            started = self.now()
            domain = [] if wm.write_date is None else [["write_date", ">=", _dt_str(wm.write_date - self.overlap)]]
            try:
                recs = self._read(model, domain, ["id", "display_name", "write_date"], ARCHIVED)
            except Exception as exc:  # noqa: BLE001 - names of this model keep the stored pair; reported
                self.result.names_unavailable[model] = f"{type(exc).__name__}: {exc}"[:300]
                log.warning("Mirror: display names of %s unavailable, the stored names are used: %s", model, exc)
                continue
            changed = self.store.upsert_names(model, recs)
            self.result.names_changed[model] = len(changed)
            followed_changes[model] = changed
            self.wm.save(dataclasses.replace(wm, write_date=started), run_uid=self.run_uid, conn=self.conn, full_refresh=domain == [])
        # names that follow another record: res.users <- res.partner, product.product <- product.template
        for model, (source, link) in NAME_FOLLOWS.items():
            if model not in self.result.names_changed:
                continue
            src_changed = followed_changes.get(source) if source in followed_changes else self._changed_source_ids(source)
            if not src_changed:
                continue
            ids: set[int] = set()
            for chunk in _chunks(sorted(src_changed), 1000):
                ids |= set(self.client.search(model, [[link, "in", chunk]], context=dict(ARCHIVED)))
            if ids:
                changed = self.store.upsert_names(model, self._read_ids(model, ids, ["id", "display_name", "write_date"], ARCHIVED))
                self.result.names_changed[model] += len(changed)

    def _changed_source_ids(self, source: str) -> list[int]:
        """Ids of ``source`` records changed since its own rule watermark (source not itself a many2one target)."""
        wm, since, started = self._rule_since(f"names-follow:{source}")
        ids = [] if since is None else self.client.search(source, [["write_date", ">=", _dt_str(since)]], context=dict(ARCHIVED))
        self._rule_done(wm, started)
        return ids


# -- the build side: a client that answers the repositories from the mirror ------------------------------------------------
def _matches(record: Mapping[str, Any], domain: Sequence[Any]) -> bool:
    for term in domain:
        if term == "&":
            continue
        if isinstance(term, str):
            raise MirrorError(f"domain operator {term!r} is not supported by the mirror")
        fname, op, value = term
        got = record.get(fname)
        if isinstance(got, list) and got and isinstance(got[0], int) and len(got) == 2 and isinstance(got[1], str):
            got = got[0]  # many2one [id, name]
        if op == "=":
            ok = got == value
        elif op == "!=":
            ok = got != value
        elif op == "in":
            ok = got in list(value)
        elif op == "not in":
            ok = got not in list(value)
        elif op == ">":
            ok = got is not None and got is not False and got > value
        else:
            raise MirrorError(f"domain operator {op!r} is not supported by the mirror")
        if not ok:
            return False
    return True


class MirrorSnapshot:
    """A consistent read of the whole mirror (one REPEATABLE READ transaction), loaded per model on first use."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self._conn: Connection | None = None
        self._records: dict[tuple[str, int], list[dict[str, Any]]] = {}
        self._names: dict[str, dict[int, str]] = {}
        self._meta: dict[tuple[str, int], dict[str, Any]] = {}

    def __enter__(self) -> "MirrorSnapshot":
        self._conn = self.engine.connect()
        if self._conn.dialect.name == "mysql":
            self._conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            self._conn.execute(text("START TRANSACTION WITH CONSISTENT SNAPSHOT"))
        self.store = MirrorStore(self._conn)
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._conn is not None:
            self._conn.rollback()
            self._conn.close()
            self._conn = None

    @property
    def uid(self) -> int:
        rec = self.store.conn.execute(text("SELECT record_id FROM raw_odoo_mirror WHERE model = :m"), {"m": USER_MODEL}).first()
        if rec is None:
            raise MirrorError("the mirror holds no ETL user (run sales_mirror first)")
        return int(rec[0])

    def meta(self, model: str, ctx: int = 0) -> dict[str, Any]:
        if (model, ctx) not in self._meta:
            meta = self.store.meta(model, ctx)
            if meta is None:
                raise MirrorError(f"the mirror holds no {model} (company context {ctx}): run sales_mirror first")
            self._meta[(model, ctx)] = meta
        return self._meta[(model, ctx)]

    def names(self, model: str) -> dict[int, str]:
        if model not in self._names:
            self._names[model] = self.store.names(model)
        return self._names[model]

    def records(self, model: str, ctx: int = 0) -> list[dict[str, Any]]:
        """The model's records, many2one display names refreshed from raw_odoo_names."""
        key = (model, ctx)
        if key not in self._records:
            recs = self.store.payloads(model, ctx)
            if model != USER_MODEL:
                fg = self.meta(model, ctx)["fields_get"]
                m2o = {f: info["relation"] for f, info in fg.items() if info.get("type") == "many2one" and info.get("relation")}
                for f, rel in m2o.items():
                    names = self.names(rel)
                    if not names:
                        continue
                    for r in recs:
                        v = r.get(f)
                        if isinstance(v, list) and len(v) == 2 and v[0] in names:
                            r[f] = [v[0], names[v[0]]]
            self._records[key] = recs
        return self._records[key]

    def release(self, model: str, ctx: int = 0) -> None:
        self._records.pop((model, ctx), None)

    def client(self) -> "MirrorClient":
        return MirrorClient(self)

    def sale_report(self, *, timezone: str, assume_utc_for_naive: bool) -> pd.DataFrame:
        return sale_report_from_mirror(self, timezone=timezone, assume_utc_for_naive=assume_utc_for_naive)

    def frame(self, model: str, fields: Sequence[str], m2o: Sequence[str], ctx: int = 0) -> pd.DataFrame:
        return sr.flatten_records(self.records(model, ctx), list(fields), list(m2o))


class MirrorClient:
    """Stands in for sales_pipeline.odoo.client.OdooClient in the repositories (fields_get / search_count /
    search_read / execute_kw for those), answering from a MirrorSnapshot."""

    def __init__(self, snapshot: MirrorSnapshot) -> None:
        self.snapshot = snapshot
        self.uid = snapshot.uid

    def authenticate(self) -> int:
        return self.uid

    @staticmethod
    def _ctx(model: str, context: Mapping[str, Any] | None) -> int:
        spec = SPEC_BY_MODEL.get(model)
        if spec is None or not spec.per_company:
            return 0
        allowed = (context or {}).get("allowed_company_ids") or []
        if not allowed:
            raise MirrorError(f"{model} is mirrored per company: the read needs allowed_company_ids")
        return int(allowed[0])

    def fields_get(self, model: str, attributes: list[str] | None = None) -> dict[str, Any]:
        ctx = self.snapshot.store.contexts(model)
        fg = self.snapshot.meta(model, ctx[0] if ctx else 0)["fields_get"]
        if not attributes:
            return fg
        return {f: {a: v for a, v in info.items() if a in attributes} for f, info in fg.items()}

    def _select(self, model: str, domain: Sequence[Any], context: Mapping[str, Any] | None) -> list[dict[str, Any]]:
        if model not in SPEC_BY_MODEL and model != USER_MODEL:
            raise MirrorError(f"{model} is not mirrored")
        ctx = self._ctx(model, context)
        recs = self.snapshot.records(model, ctx)
        if model in SPEC_BY_MODEL:
            stored = [tuple(t) for t in self.snapshot.meta(model, ctx)["domain"]]
            wanted = [tuple(t) if isinstance(t, (list, tuple)) else t for t in domain]
            if stored and wanted[:len(stored)] == stored:  # the mirror holds exactly the full-read domain
                wanted = wanted[len(stored):]
            elif stored:
                raise MirrorError(f"{model}: the mirror holds domain {stored}, the read asked {wanted}")
            domain = wanted
        return [r for r in recs if _matches(r, domain)] if domain else recs

    def search_count(self, model: str, domain: list[Any], context: dict[str, Any] | None = None) -> int:
        return len(self._select(model, domain, context))

    def search_read(self, model: str, domain: list[Any], fields: list[str], offset: int = 0, limit: int = 500, order: str = "id",
                    context: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        if order not in ("id", "id asc", "id ASC", None, ""):
            raise MirrorError(f"order {order!r} is not supported by the mirror (records are in id order)")
        rows = self._select(model, domain, context)
        rows = rows[offset:] if not limit else rows[offset:offset + limit]
        missing = [f for f in fields if rows and f not in rows[0]]
        if missing:
            raise MirrorError(f"{model}: field(s) {missing} are not mirrored")
        return [{f: r.get(f) for f in fields} if fields else dict(r) for r in rows]

    def execute_kw(self, model: str, method: str, args: list[Any] | None = None, kwargs: dict[str, Any] | None = None) -> Any:
        args, kwargs = args or [], kwargs or {}
        if method == "fields_get":
            return self.fields_get(model, kwargs.get("attributes"))
        if method == "search_count":
            return self.search_count(model, args[0], kwargs.get("context"))
        if method == "search_read":
            return self.search_read(model, args[0], kwargs.get("fields", []), kwargs.get("offset", 0), kwargs.get("limit", 500),
                                    kwargs.get("order", "id"), kwargs.get("context"))
        raise MirrorError(f"{model}.{method} is not supported by the mirror")


def sale_report_from_mirror(snapshot: MirrorSnapshot, *, timezone: str, assume_utc_for_naive: bool) -> pd.DataFrame:
    """sale.report rebuilt from the mirrored orders / lines (departments.sales.sale_report, the gate-verified rules),
    after the currency guard."""
    orders = snapshot.frame("sale.order", sr.ORDER_FIELDS, sr.ORDER_M2O)
    lines = snapshot.frame("sale.order.line", sr.LINE_FIELDS, sr.LINE_M2O)
    ctxs = snapshot.store.contexts("product.product")
    products = snapshot.frame("product.product", sr.PRODUCT_FIELDS, sr.PRODUCT_M2O, ctx=ctxs[0] if ctxs else 0)
    uoms = pd.DataFrame([{"id": r["id"], "factor": r.get("factor")} for r in snapshot.records("uom.uom")])
    companies = snapshot.frame("res.company", ("id", "name", "currency_id"), ("currency_id",))
    sr.check_currencies(companies, orders)
    snapshot.release("sale.order.line")
    rebuilt = sr.rebuild_sale_report(orders, lines, products, uoms, timezone=timezone, assume_utc_for_naive=assume_utc_for_naive)
    return rebuilt[[*sr.REPORT_COLUMNS, "Discount"]]  # the frame SalesReportRepository.fetch_sale_report returns
