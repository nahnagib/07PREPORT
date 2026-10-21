"""The Odoo mirror of the incremental sales build: write_date reads, the rules for values that change without the record's
own write_date, deletions, display names, and the client that answers the unchanged repositories from it."""

from __future__ import annotations

import datetime as _dt

import pytest
from sqlalchemy import text

from departments.sales import mirror as mr
from etl_platform.watermark import WatermarkStore
from sales_pipeline.odoo.crm_repository import CrmRepository
from sales_pipeline.odoo.product_cost_repository import ProductCostRepository
from sales_pipeline.odoo.sale_order_repository import SaleOrderRepository

T0 = _dt.datetime(2026, 10, 21, 8, 0, 0)


def _w(minutes: int) -> str:
    return (T0 + _dt.timedelta(minutes=minutes)).strftime(mr.ODOO_DT)


class FakeOdoo:
    """In-memory Odoo: records per model, search / search_read with the domains the mirror uses, a read counter."""

    UID = 2

    def __init__(self) -> None:
        self.uid = self.UID
        self.db: dict[str, dict[int, dict]] = {}
        self.reads: dict[str, int] = {}
        self.calls: list[tuple] = []

    def authenticate(self) -> int:
        return self.uid

    def put(self, model: str, **rec) -> dict:
        self.db.setdefault(model, {})[rec["id"]] = rec
        return rec

    def fields_get(self, model, attributes=None):
        fields = {f for r in self.db.get(model, {}).values() for f in r} | {"id", "write_date", "display_name"}
        spec = mr.SPEC_BY_MODEL.get(model)
        if spec:
            fields |= set(spec.fields)
        m2o = {"partner_id": "res.partner", "user_id": "res.users", "product_id": "product.product", "order_id": "sale.order",
               "picking_id": "stock.picking", "product_tmpl_id": "product.template", "company_id": "res.company",
               "currency_id": "res.currency", "uom_id": "uom.uom", "product_uom": "uom.uom", "team_id": "crm.team"}
        out = {f: {"type": "many2one", "relation": m2o[f], "string": f, "store": True} if f in m2o else {"type": "char", "string": f, "store": True}
               for f in fields}
        for f in mr.COVERED_NON_STORED.get(model, set()):
            if f in out:
                out[f]["store"] = False
        return out

    def _match(self, rec, domain):
        for f, op, v in domain:
            got = rec.get(f)
            if isinstance(got, list) and len(got) == 2 and isinstance(got[1], str):
                got = got[0]
            if op == "=" and got != v or op == "in" and got not in v or op == ">" and not got > v:
                return False
            if op == ">=" and not (got or "") >= v:
                return False
            if op == "!=" and v is False and not got:
                return False
        return True

    def _select(self, model, domain):
        return [r for _, r in sorted(self.db.get(model, {}).items()) if self._match(r, domain)]

    def search(self, model, domain, context=None, order="id"):
        self.calls.append(("search", model, tuple(map(tuple, domain))))
        return [r["id"] for r in self._select(model, domain)]

    def search_read(self, model, domain, fields, offset=0, limit=500, order="id", context=None):
        self.calls.append(("search_read", model, tuple(map(tuple, domain))))
        rows = self._select(model, domain)
        rows = rows[offset:offset + limit] if limit else rows[offset:]
        self.reads[model] = self.reads.get(model, 0) + len(rows)
        return [{"id": r["id"], **{f: r.get(f, False) for f in fields}} for r in rows]  # Odoo always returns id


DDL = [
    "CREATE TABLE raw_odoo_mirror (model TEXT NOT NULL, company_ctx INTEGER NOT NULL DEFAULT 0, record_id INTEGER NOT NULL, "
    "parent_id INTEGER, write_date DATETIME, payload TEXT NOT NULL, mirrored_at_utc DATETIME NOT NULL, run_uid TEXT, "
    "PRIMARY KEY (model, company_ctx, record_id))",
    "CREATE TABLE raw_odoo_mirror_meta (model TEXT NOT NULL, company_ctx INTEGER NOT NULL DEFAULT 0, fields_json TEXT NOT NULL, "
    "fields_get_json TEXT NOT NULL, domain_json TEXT NOT NULL, refreshed_at_utc DATETIME NOT NULL, PRIMARY KEY (model, company_ctx))",
    "CREATE TABLE raw_odoo_names (model TEXT NOT NULL, record_id INTEGER NOT NULL, display_name TEXT, write_date DATETIME, "
    "mirrored_at_utc DATETIME NOT NULL, PRIMARY KEY (model, record_id))",
]


@pytest.fixture
def engine(platform_engine):
    with platform_engine.begin() as conn:
        for ddl in DDL:
            conn.execute(text(ddl))
    return platform_engine


@pytest.fixture
def odoo():
    o = FakeOdoo()
    o.put("res.users", id=FakeOdoo.UID, company_ids=[1, 3], partner_id=[50, "Bot"], display_name="Bot", write_date=_w(-100))
    o.put("res.company", id=1, name="Majaal", currency_id=[102, "LYD"], write_date=_w(-100), display_name="Majaal")
    o.put("res.company", id=3, name="Tika", currency_id=[102, "LYD"], write_date=_w(-100), display_name="Tika")
    o.put("res.partner", id=100, display_name="ACME", write_date=_w(-100))
    o.put("res.partner", id=50, display_name="Bot", write_date=_w(-100))
    o.put("product.template", id=900, display_name="Grout", write_date=_w(-100))
    o.put("product.product", id=500, product_tmpl_id=[900, "Grout"], name="Grout", display_name="[GR] Grout", uom_id=[1, "Units"],
          standard_price=4.0, write_date=_w(-100))
    o.put("uom.uom", id=1, name="Units", factor=1.0, display_name="Units", write_date=_w(-100))
    o.put("sale.order", id=1, name="S00001", partner_id=[100, "ACME"], user_id=[2, "Bot"], company_id=[1, "Majaal"],
          currency_id=[102, "LYD"], currency_rate=1.0, state="sale", write_date=_w(-100))
    o.put("sale.order.line", id=11, order_id=[1, "S00001"], product_id=[500, "[GR] Grout"], product_uom=[1, "Units"], write_date=_w(-100))
    o.put("sale.order.line", id=12, order_id=[1, "S00001"], product_id=[500, "[GR] Grout"], product_uom=[1, "Units"], write_date=_w(-100))
    o.put("stock.quant", id=70, product_id=[500, "[GR] Grout"], quantity=5.0, value=20.0, write_date=_w(-100))
    o.put("crm.lead", id=30, type="opportunity", name="Big deal", partner_id=[100, "ACME"], activity_state=False, write_date=_w(-100))
    return o


def _sync(engine, odoo, minutes, *, full_check=False):
    s = mr.MirrorSync(odoo, engine, WatermarkStore(engine), run_uid="r", overlap_minutes=10, audit_days=2, page_size=2,
                      now=lambda: T0 + _dt.timedelta(minutes=minutes))
    return s.run(full_check=full_check)


def _payload(engine, model, rid, ctx=0):
    with engine.connect() as conn:
        rows = mr.MirrorStore(conn).payloads(model, ctx, [rid])
    return rows[0] if rows else None


def test_first_fill_reads_everything_then_a_quiet_cycle_reads_nothing(engine, odoo):
    first = _sync(engine, odoo, 0)
    assert "mirror:sale.order.line" in first.first_fill and first.changed["mirror:sale.order.line"] == 2
    assert first.changed["mirror:product.product@1"] == 1 and first.changed["mirror:product.product@3"] == 1  # one copy per company
    odoo.reads.clear()
    quiet = _sync(engine, odoo, 30)
    assert {m: n for m, n in odoo.reads.items() if n} == {}  # no record changed since the last read: 0 rows read
    assert not quiet.any_change


def test_a_changed_record_is_read_and_stored_unchanged_ones_are_not(engine, odoo):
    _sync(engine, odoo, 0)
    odoo.db["sale.order"][1].update(state="cancel", write_date=_w(20))
    odoo.reads.clear()
    res = _sync(engine, odoo, 30)
    assert odoo.reads["sale.order"] == 2  # the record, and its display name (order lines point to it)
    assert odoo.reads.get("sale.order.line", 0) == 0
    assert res.changed["mirror:sale.order"] == 1 and res.any_change
    assert _payload(engine, "sale.order", 1)["state"] == "cancel"


def test_a_line_removed_from_an_order_is_deleted_although_it_has_no_write_date(engine, odoo):
    _sync(engine, odoo, 0)
    del odoo.db["sale.order.line"][12]
    odoo.db["sale.order"][1]["write_date"] = _w(20)  # Odoo moves the ORDER's write_date only
    res = _sync(engine, odoo, 30)
    assert res.deleted["mirror:sale.order.line"] == 1
    assert _payload(engine, "sale.order.line", 12) is None and _payload(engine, "sale.order.line", 11) is not None


def test_a_deleted_order_is_removed_by_the_id_check_of_every_cycle(engine, odoo):
    _sync(engine, odoo, 0)
    del odoo.db["sale.order"][1]
    res = _sync(engine, odoo, 30)
    assert res.deleted["mirror:sale.order"] == 1 and _payload(engine, "sale.order", 1) is None


def test_template_rename_rereads_its_variants_and_cost_change_rereads_quants(engine, odoo):
    _sync(engine, odoo, 0)
    odoo.db["product.template"][900].update(display_name="Grout Pro", write_date=_w(20))
    odoo.db["product.product"][500].update(name="Grout Pro", display_name="[GR] Grout Pro")  # variant write_date NOT moved
    odoo.db["stock.quant"][70]["value"] = 25.0  # recomputed from the cost, quant write_date NOT moved
    res = _sync(engine, odoo, 30)
    assert _payload(engine, "product.product", 500, ctx=1)["name"] == "Grout Pro"
    assert _payload(engine, "stock.quant", 70)["value"] == 25.0
    assert res.rule_rereads["product.template -> product.product"] == 1 and res.rule_rereads["product.product -> stock.quant"] == 1


def test_lead_activities_reread_the_lead(engine, odoo):
    _sync(engine, odoo, 0)
    odoo.put("mail.activity", id=1, res_model="crm.lead", res_id=30, write_date=_w(20))
    odoo.db["crm.lead"][30].update(activity_state="today", activity_ids=[1])  # lead write_date NOT moved
    _sync(engine, odoo, 30)
    assert _payload(engine, "crm.lead", 30)["activity_state"] == "today"
    del odoo.db["mail.activity"][1]  # done: the activity is deleted, nothing has a new write_date
    odoo.db["crm.lead"][30].update(activity_state=False, activity_ids=[])
    _sync(engine, odoo, 60)
    assert _payload(engine, "crm.lead", 30)["activity_state"] is False


def test_display_names_follow_renames_and_users_follow_their_partner(engine, odoo):
    _sync(engine, odoo, 0)
    odoo.db["res.partner"][100].update(display_name="ACME Libya", write_date=_w(20))  # the order's write_date does not move
    odoo.db["res.partner"][50].update(display_name="Sales Bot", write_date=_w(20))
    odoo.db["res.users"][FakeOdoo.UID]["display_name"] = "Sales Bot"  # user name = its partner's; user write_date not moved
    _sync(engine, odoo, 30)
    with mr.MirrorSnapshot(engine) as snap:
        order = snap.records("sale.order")[0]
    assert order["partner_id"] == [100, "ACME Libya"] and order["user_id"] == [2, "Sales Bot"]


def test_full_check_audit_catches_a_missed_update(engine, odoo):
    _sync(engine, odoo, 0)
    # a long transaction: write_date older than the last read start minus the overlap, committed after that read
    odoo.db["sale.order"][1].update(state="done", write_date=_w(-60))
    assert _sync(engine, odoo, 30).changed["mirror:sale.order"] == 0
    res = _sync(engine, odoo, 60, full_check=True)
    assert res.changed["mirror:sale.order"] == 1 and res.rule_rereads["audit:sale.order"] == 1


def test_the_client_answers_the_unchanged_repositories(engine, odoo):
    _sync(engine, odoo, 0)
    with mr.MirrorSnapshot(engine) as snap:
        client = snap.client()
        orders = SaleOrderRepository(client, 1).fetch_orders()
        assert orders["id"].tolist() == [1] and orders["partner_id"].tolist() == ["ACME"]
        costs = ProductCostRepository(client, 1).fetch_product_costs()  # per company, through res.users / res.company
        assert sorted(costs["cost_company"]) == ["Majaal", "Tika"]
        leads = CrmRepository(client, 1).fetch_leads()  # the lead type domain is the one the mirror holds
        assert leads["id"].tolist() == [30]
        with pytest.raises(mr.MirrorError, match="not mirrored"):
            client.search_read("account.move", [], ["id"])
        with pytest.raises(mr.MirrorError, match="order"):
            client.search_read("sale.order", [], ["id"], order="write_date desc")


def test_rows_read_are_counted_per_model():
    from sales_pipeline.odoo import client as oc

    before = oc.rows_read_totals()
    oc._count_rows("sale.order", [{}, {}])
    oc._count_rows("stock.quant", [{}])
    assert oc.rows_read_since(before) == {"sale.order": 2, "stock.quant": 1}


def test_a_line_of_an_order_created_after_the_order_read_brings_its_order(engine, odoo):
    _sync(engine, odoo, 0)
    real = odoo.search_read

    def racing(model, domain, fields, **kw):
        # the order and its line are created after this sync read (and id-checked) the orders, before it reads the lines
        if model == "sale.order.line" and 2 not in odoo.db["sale.order"]:
            odoo.put("sale.order", id=2, name="S00002", partner_id=[100, "ACME"], company_id=[1, "Majaal"], currency_id=[102, "LYD"],
                     currency_rate=1.0, state="draft", write_date=_w(25))
            odoo.put("sale.order.line", id=21, order_id=[2, "S00002"], product_id=[500, "[GR] Grout"], product_uom=[1, "Units"],
                     write_date=_w(25))
        return real(model, domain, fields, **kw)

    odoo.search_read = racing
    res = _sync(engine, odoo, 30)
    assert _payload(engine, "sale.order.line", 21) is not None
    assert _payload(engine, "sale.order", 2)["name"] == "S00002"  # never lines of an order the mirror does not have
    assert res.rule_rereads["sale.order.line -> missing sale.order"] == 1
