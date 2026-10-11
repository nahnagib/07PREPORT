"""Finance department jobs.

  finance_receivables  open receivable journal items (account.move.line) from Odoo -> daily snapshot
                       fact_finance_receivable_snapshot + dim_finance_invoice + bridge_finance_invoice_order.
                       Runs inside the nightly full_all (after core_dims, before sales) and on its own daily at
                       15:00 Africa/Tripoli (ETL_SCHEDULE_FINANCE_CRON, "Receivables Snapshot"). Depends on core_dims
                       (reused when it succeeded within ETL_CORE_DIMS_FRESH_MINUTES).

Odoo credentials: profile "debt" (ODOO_DEBT_LOGIN / ODOO_DEBT_API_KEY / ODOO_DEBT_KEY_EXPIRES, the dedicated
read-only bot user). Until those are set the job uses the default read-only ETL credentials and logs a WARNING on
every run; setting them switches the job over with no code change.

Load: one transaction -- upsert the aging buckets, the invoice dimension and the bridge, replace today's snapshot,
then run the checks on that transaction: orphan checks FAIL the run (everything rolls back), the bridge check
(an order missing from the sales facts) WARNS, and the sanity checks (0 rows, a missing due date, the net open amount
changing by more than 50% from the previous snapshot) apply from the second snapshot on. Rules: transform.py.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

from zoneinfo import ZoneInfo

import pandas as pd
from sqlalchemy import bindparam, text

from core.jobs import ensure_date_range
from core.keys import UNKNOWN
from core.resolve import KeyMaps, _int_or_none
from departments.finance import aging
from departments.finance import scope as rscope
from departments.finance import transform as tf
from etl_platform import quality as q
from etl_platform.load import replace_all, snapshot_replace, upsert
from etl_platform.notify import notify
from etl_platform.registry import REGISTRY, DatasetSpec, JobSpec, TaskSpec
from etl_platform.runner import RunContext, TaskResult
from etl_platform.sources.odoo import OdooConfigError, OdooCredentials, m2o_id, m2o_name

DEPARTMENT = "finance"
PROFILE = "debt"
MAX_OPEN_AMOUNT_CHANGE_PCT = 50.0
RECEIVABLE_DOMAIN = [("account_type", "=", "asset_receivable"), ("parent_state", "=", "posted"),
                     ("reconciled", "=", False), ("amount_residual", "!=", 0)]
LINE_FIELDS = ["id", "move_id", "move_name", "partner_id", "company_id", "company_currency_id", "currency_id", "date",
               "date_maturity", "amount_residual", "amount_residual_currency", "payment_id", "write_date"]
MOVE_FIELDS = ["id", "name", "move_type", "state", "invoice_date", "invoice_date_due", "invoice_user_id", "team_id", "invoice_origin",
               "invoice_payment_term_id", "partner_id", "commercial_partner_id", "company_id", "currency_id", "amount_total",
               "amount_total_signed", "payment_state", "journal_id", "write_date"]
PAYMENT_FIELDS = ["id", "move_id", "name", "payment_type", "partner_type", "state", "journal_id", "partner_id", "company_id", "currency_id",
                  "date", "amount", "ref", "is_reconciled", "is_matched", "create_uid", "create_date", "write_date"]
FACT = "fact_finance_receivable_snapshot"
KEY_DIMS = {
    "CustomerKey": ("dim_customer", "CustomerKey"), "CompanyKey": ("dim_company", "CompanyKey"),
    "SalespersonKey": ("dim_salesperson", "SalespersonKey"), "SalesTeamKey": ("dim_sales_team", "SalesTeamKey"),
    "CurrencyKey": ("dim_currency", "CurrencyKey"), "PaymentTermKey": ("dim_payment_term", "PaymentTermKey"),
    "AgingBucketKey": ("dim_finance_aging_bucket", "AgingBucketKey"), "move_id": ("dim_finance_invoice", "move_id"),
    "receivable_scope": ("dim_finance_receivable_scope", "receivable_scope"),
    "PaymentKey": ("dim_finance_payment", "PaymentKey"),
    "SnapshotDateKey": ("dim_date", "DateKey"), "DueDateKey": ("dim_date", "DateKey"), "InvoiceDateKey": ("dim_date", "DateKey"),
}


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


def snapshot_date(ctx: RunContext) -> _dt.date:
    """The run's as-of date: --date when given, else today in the business time zone (Africa/Tripoli)."""
    return ctx.as_of


def finance_source(ctx: RunContext):
    """The debt bot user's profile when configured; otherwise the default read-only ETL credentials + a warning."""
    try:
        OdooCredentials.from_env(PROFILE)
    except OdooConfigError:
        notify("WARNING", "finance_receivables runs with the default read-only ETL Odoo credentials: the dedicated bot user "
                          "(ODOO_DEBT_LOGIN / ODOO_DEBT_API_KEY) is not configured yet (docs/receivables-etl.md)",
               job=ctx.job.name)
        ctx.state["odoo_profile"] = "default"
        return ctx.odoo("default")
    ctx.state["odoo_profile"] = PROFILE
    return ctx.odoo(PROFILE)


def _frame(records: list[dict[str, Any]], spec: dict[str, str], ctx: RunContext, extracted_at: _dt.datetime) -> pd.DataFrame:
    """spec: raw column -> 'field' | 'field:m2o_id' | 'field:m2o_name'."""
    rows = []
    for r in records:
        row = {}
        for col, src in spec.items():
            name, _, kind = src.partition(":")
            v = r.get(name)
            row[col] = m2o_id(v) if kind == "m2o_id" else m2o_name(v) if kind == "m2o_name" else (None if v is False else v)
        row["_extracted_at"], row["_run_id"] = extracted_at, ctx.run_uid
        rows.append(row)
    return pd.DataFrame(rows, columns=[*spec, "_extracted_at", "_run_id"])


LINE_COLUMNS = {"id": "id", "move_id": "move_id:m2o_id", "move_name": "move_name", "partner_id": "partner_id:m2o_id",
                "company_id": "company_id:m2o_id", "company_currency_id": "company_currency_id:m2o_id", "currency_id": "currency_id:m2o_id",
                "date": "date", "date_maturity": "date_maturity", "amount_residual": "amount_residual",
                "amount_residual_currency": "amount_residual_currency", "payment_id": "payment_id:m2o_id"}
MOVE_COLUMNS = {"id": "id", "name": "name", "move_type": "move_type", "state": "state", "invoice_date": "invoice_date",
                "invoice_date_due": "invoice_date_due", "invoice_user_id": "invoice_user_id:m2o_id", "team_id": "team_id:m2o_id",
                "invoice_origin": "invoice_origin", "invoice_payment_term_id": "invoice_payment_term_id:m2o_id",
                "partner_id": "partner_id:m2o_id", "commercial_partner_id": "commercial_partner_id:m2o_id",
                "company_id": "company_id:m2o_id", "currency_id": "currency_id:m2o_id", "amount_total": "amount_total",
                "amount_total_signed": "amount_total_signed", "payment_state": "payment_state", "journal_id": "journal_id:m2o_id"}
PAYMENT_COLUMNS = {"id": "id", "move_id": "move_id:m2o_id", "name": "name", "payment_type": "payment_type", "partner_type": "partner_type",
                   "state": "state", "journal_id": "journal_id:m2o_id", "partner_id": "partner_id:m2o_id", "company_id": "company_id:m2o_id",
                   "currency_id": "currency_id:m2o_id", "date": "date", "amount": "amount", "ref": "ref", "is_reconciled": "is_reconciled",
                   "is_matched": "is_matched", "create_uid": "create_uid:m2o_id", "create_date": "create_date"}


# -- tasks -------------------------------------------------------------------------------------------------------------
def extract_receivables(ctx: RunContext) -> TaskResult:
    src = finance_source(ctx)
    companies = list(ctx.odoo_company_ids(ctx.state.get("odoo_profile", PROFILE)))
    company_dom = [("company_id", "in", companies)] if companies else []
    line_fields, skipped_l = src.available_fields("account.move.line", LINE_FIELDS)
    lines = src.search_read_all("account.move.line", [*RECEIVABLE_DOMAIN, *company_dom], line_fields)
    recount = recount_lines(src, [*RECEIVABLE_DOMAIN, *company_dom], {int(r["id"]) for r in lines})
    move_ids = sorted({m2o_id(r["move_id"]) for r in lines if m2o_id(r.get("move_id")) is not None})
    move_fields, skipped_m = src.available_fields("account.move", MOVE_FIELDS)
    moves = src.read_by_ids("account.move", move_ids, move_fields)
    invoice_moves = [m["id"] for m in moves if m.get("move_type") in ("out_invoice", "out_refund", "out_receipt")]
    orders: list[dict[str, Any]] = []
    for i in range(0, len(invoice_moves), src.id_chunk_size):
        chunk = invoice_moves[i:i + src.id_chunk_size]
        orders += src.search_read_all("sale.order", [("invoice_ids", "in", chunk)], ["id", "name", "company_id", "delivery_status", "invoice_ids"])
    wanted = set(invoice_moves)
    so_inv = [{"sale_order_id": o["id"], "move_id": mid, "order_name": o["name"], "company_id": m2o_id(o["company_id"]),
               "delivery_status": o.get("delivery_status") or None} for o in {o["id"]: o for o in orders}.values()
              for mid in (o.get("invoice_ids") or []) if mid in wanted]
    bridged = {r["move_id"] for r in so_inv}
    names = sorted({n for m in moves if m.get("move_type") == "out_invoice" and m["id"] not in bridged for n in tf.origin_names(m.get("invoice_origin"))})
    origin_orders: list[dict[str, Any]] = []
    for i in range(0, len(names), src.id_chunk_size):
        origin_orders += src.search_read_all("sale.order", [("name", "in", names[i:i + src.id_chunk_size]), *company_dom],
                                             ["id", "name", "company_id", "delivery_status"])
    own = src.search_read_all("res.company", [("id", "in", companies)] if companies else [], ["id", "partner_id"])
    payment_ids = sorted({m2o_id(r["payment_id"]) for r in lines if m2o_id(r.get("payment_id")) is not None})
    payment_fields, skipped_p = src.available_fields("account.payment", PAYMENT_FIELDS)
    payments = src.read_by_ids("account.payment", payment_ids, payment_fields)
    journal_ids = sorted({m2o_id(r.get("journal_id")) for r in [*payments, *moves] if m2o_id(r.get("journal_id")) is not None})
    journals = _journals(src, journal_ids)
    extracted_at = _now()
    lines_df = _frame(lines, LINE_COLUMNS, ctx, extracted_at)
    lines_df["_source_write_date"] = [pd.to_datetime(r.get("write_date")) if r.get("write_date") else None for r in lines]
    lines_df["_deleted_at"] = None
    moves_df = _frame(moves, MOVE_COLUMNS, ctx, extracted_at)
    moves_df["_source_write_date"] = [pd.to_datetime(r.get("write_date")) if r.get("write_date") else None for r in moves]
    moves_df["_deleted_at"] = None
    so_df = pd.DataFrame(so_inv, columns=["sale_order_id", "move_id", "order_name", "company_id", "delivery_status"])
    so_df["_extracted_at"], so_df["_run_id"] = extracted_at, ctx.run_uid
    pay_df = _frame(payments, PAYMENT_COLUMNS, ctx, extracted_at)
    pay_df["_source_write_date"] = [pd.to_datetime(r.get("write_date")) if r.get("write_date") else None for r in payments]
    pay_df["_deleted_at"] = None
    for col in ("is_reconciled", "is_matched"):
        pay_df[col] = pay_df[col].map(lambda v: None if v is None else int(bool(v)))
    jn_df = journals.assign(_extracted_at=extracted_at, _run_id=ctx.run_uid)
    with ctx.engine.begin() as conn:
        replace_all(conn, "raw_odoo_account_move_line", lines_df)
        replace_all(conn, "raw_odoo_account_move", moves_df)
        replace_all(conn, "raw_odoo_sale_order_invoice", so_df)
        replace_all(conn, "raw_odoo_account_payment", pay_df)
        replace_all(conn, "raw_odoo_account_journal", jn_df)
    ctx.state.update(lines=lines_df, moves=moves_df, so_inv=so_df, payments=pay_df, journals=jn_df,
                     origin_orders=pd.DataFrame([{"name": o["name"], "company_id": m2o_id(o["company_id"]), "delivery_status": o.get("delivery_status")}
                                                 for o in origin_orders], columns=["name", "company_id", "delivery_status"]),
                     own_company_partners=sorted({m2o_id(c["partner_id"]) for c in own if m2o_id(c.get("partner_id")) is not None}))
    details = {"odoo_profile": ctx.state["odoo_profile"], "api_mode": src.mode, "server_version": src.server_version,
               "lines": len(lines), "moves": len(moves), "payments": len(payments), "journals": len(journals),
               "invoice_order_links": len(so_inv), "orders_by_origin_name": len(origin_orders), "recount": recount,
               "skipped_fields": {"account.move.line": skipped_l, "account.move": skipped_m, "account.payment": skipped_p}}
    ctx.logger.info("Receivables extracted: %s", details)
    return TaskResult(rows_extracted=len(lines) + len(moves) + len(so_inv), rows_loaded=len(lines_df) + len(moves_df) + len(so_df), details=details)


def recount_lines(src, domain: list, read_ids: set[int]) -> dict[str, Any]:
    """End-of-extraction recount: the open receivable line ids Odoo has NOW vs the ones the paged read returned.
    A line posted or closed while the pages were read (e.g. an invoice posted mid-run) shows up here and is reported;
    it is not added -- the snapshot stays one consistent read, the next run includes it."""
    now = set(src.search_ids("account.move.line", domain, include_archived=False))
    new, gone = sorted(now - read_ids), sorted(read_ids - now)
    if new or gone:
        notify("WARNING", f"Receivables changed in Odoo during the extraction: {len(new)} open line(s) appeared "
                          f"(e.g. {new[:10]}), {len(gone)} closed (e.g. {gone[:10]}); the next snapshot includes them")
    return {"odoo_ids_after": len(now), "read": len(read_ids), "appeared_during_read": new[:50], "closed_during_read": gone[:50],
            "appeared_count": len(new), "closed_count": len(gone)}


def _journals(src, journal_ids: list[int]) -> pd.DataFrame:
    """Journal names as Odoo shows them, in English and (when active) Arabic -- never written in code."""
    from core.labels import ENGLISH, arabic_language

    arabic = arabic_language(src.active_languages())
    rows: dict[int, dict[str, Any]] = {}
    for lang, col in ((ENGLISH, "name_en"), (arabic, "name_ar")):
        if not lang or not journal_ids:
            continue
        ctx = {**src.context, "lang": lang}
        for i in range(0, len(journal_ids), src.id_chunk_size):
            chunk = journal_ids[i:i + src.id_chunk_size]
            for r in src.client.execute_kw("account.journal", "read", [chunk, ["id", "name", "code", "type", "company_id"]], {"context": ctx}):
                row = rows.setdefault(r["id"], {"id": r["id"], "code": r.get("code"), "type": r.get("type"), "company_id": m2o_id(r.get("company_id"))})
                row[col] = r.get("name")
    return pd.DataFrame(list(rows.values()), columns=["id", "name_en", "name_ar", "code", "type", "company_id"])


def _inputs(conn, own_partners: list[int], intercompany_partners: tuple[int, ...] = ()) -> tf.FinanceInputs:
    """``intercompany_partners``: FINANCE_INTERCOMPANY_PARTNER_IDS (Odoo partner ids), resolved to their commercial
    partner (CustomerKey) like every receivable line's partner."""
    rows = lambda sql: conn.execute(text(sql)).fetchall()  # noqa: E731
    partner_customer = {int(p): int(c) for p, c in rows("SELECT partner_id, CustomerKey FROM map_partner_customer")}
    return tf.FinanceInputs(
        currency_keys={int(k) for (k,) in rows("SELECT CurrencyKey FROM dim_currency")},
        payment_term_keys={int(k) for (k,) in rows("SELECT PaymentTermKey FROM dim_payment_term")},
        customer_salesperson={int(c): int(s) for c, s in rows("SELECT CustomerKey, SalespersonKey FROM dim_customer")},
        customer_company_term={(int(c), int(co)): int(t) for c, co, t in rows("SELECT CustomerKey, CompanyKey, PaymentTermKey FROM dim_customer_company")},
        own_company_customers={partner_customer.get(int(p), int(p)) for p in own_partners},
        configured_intercompany_customers={partner_customer.get(int(p), int(p)) for p in intercompany_partners},
    )


def _checks(first_snapshot: bool, snap: int) -> list[q.CheckSpec]:
    where = f"SnapshotDateKey = {int(snap)}"
    specs = [q.orphan(FACT, col, dim, dim_col, where=where, name=f"orphan:{FACT}.{col}") for col, (dim, dim_col) in KEY_DIMS.items()]
    specs += [q.orphan("dim_finance_invoice", col, *KEY_DIMS[col], name=f"orphan:dim_finance_invoice.{col}")
              for col in ("CustomerKey", "CompanyKey", "SalespersonKey", "SalesTeamKey", "CurrencyKey", "PaymentTermKey")]
    specs.append(q.orphan("bridge_finance_invoice_order", "move_id", "dim_finance_invoice", "move_id", name="orphan:bridge_finance_invoice_order.move_id"))
    # the full Odoo sale order list (dim_sales_order: every sale.order read by sales_full, no filter) -- a warning
    specs.append(q.orphan("bridge_finance_invoice_order", "SalesOrderKey", "dim_sales_order", "SalesOrderKey", severity="warn",
                          name="warn:bridge_finance_invoice_order.order_not_in_sale_order_list"))
    if not first_snapshot:  # sanity checks apply from the second snapshot on
        specs.append(q.min_rows(FACT, 1, where=where, name="sanity:receivable_rows"))
        specs.append(q.not_null(FACT, ["due_date"], where=where, name="sanity:receivable_due_date"))
        specs.append(q.custom_sql("sanity:receivable_due_date_unknown",
                                  f"SELECT line_id FROM {FACT} WHERE {where} AND (DueDateKey = -1 OR AgingBucketKey = -1)"))
        specs.append(q.metric_change(
            "sanity:receivable_open_amount_change",
            f"SELECT SUM(residual_company_ccy) FROM {FACT} WHERE {where}",
            MAX_OPEN_AMOUNT_CHANGE_PCT, table=FACT,
            previous_sql=f"SELECT SUM(residual_company_ccy) FROM {FACT} WHERE SnapshotDateKey = "
                         f"(SELECT MAX(SnapshotDateKey) FROM {FACT} WHERE SnapshotDateKey < {int(snap)})"))
    return specs


def load_receivables(ctx: RunContext) -> TaskResult:
    aging.validate_buckets()
    rscope.validate_scopes()
    snap_date = snapshot_date(ctx)
    snap = tf.date_key(snap_date)
    today = _dt.datetime.now(ZoneInfo(ctx.config.business_timezone)).date()
    if snap_date != today:  # Odoo is read as it is NOW: a past --date only relabels today's open items
        notify("WARNING", f"finance_receivables snapshot {snap_date} is not today ({today}): it holds Odoo's CURRENT open items "
                          "aged as of that date, not a historical reconstruction (docs/receivables-etl.md, backfill)", job=ctx.job.name)
    with ctx.engine.connect() as conn:
        maps = KeyMaps.load(conn)
        intercompany_ids = tuple(ctx.config.finance_intercompany_partner_ids)
        inputs = _inputs(conn, ctx.state["own_company_partners"], intercompany_ids)
        named = dict(conn.execute(text("SELECT CustomerKey, customer FROM dim_customer WHERE CustomerKey IN :ids").bindparams(
            bindparam("ids", expanding=True)), {"ids": list(inputs.configured_intercompany_customers) or [-999]}).fetchall())
        previous = conn.execute(text(f"SELECT MAX(SnapshotDateKey) FROM {FACT} WHERE SnapshotDateKey <> :s"), {"s": snap}).scalar()
    built = tf.build(ctx.state["lines"], ctx.state["moves"], ctx.state["so_inv"], ctx.state["origin_orders"], ctx.state["payments"],
                     ctx.state["journals"], maps, inputs, snap_date)
    for key, ids in built.fallbacks.items():
        ctx.record_fallback(key, ids)
    fact = built.fact.copy()
    fact["_run_id"], fact["loaded_at_utc"] = ctx.run_uid, _now()
    fact["days_past_due"] = fact["days_past_due"].fillna(0).astype("int64")
    now = _now()
    keys = [int(v) for c in ("SnapshotDateKey", "DueDateKey", "InvoiceDateKey") for v in fact[c].unique() if int(v) > 0]
    first_snapshot = previous is None
    with ctx.engine.begin() as conn:
        if keys:
            lo, hi = min(keys), max(keys)
            ensure_date_range(conn, _dt.date(lo // 10000, lo // 100 % 100, lo % 100), _dt.date(hi // 10000, hi // 100 % 100, hi % 100))
        # the documents' own teams that have no Excel org team (ODOO-TEAM-<id>, e.g. EXPORT): members before the facts
        own = {str(k) for k in [*fact["SalesTeamKey"], *(built.invoices["SalesTeamKey"] if len(built.invoices) else [])]
               if str(k).startswith(tf.OWN_TEAM_PREFIX)}
        if own:
            odoo_teams = {int(r[0]): (r[1], None if r[2] is None else int(r[2]))
                          for r in conn.execute(text("SELECT id, name, company_id FROM raw_odoo_crm_team"))}
            company_keys = {int(r[0]) for r in conn.execute(text("SELECT CompanyKey FROM dim_company"))}
            upsert(conn, "dim_sales_team", tf.own_team_members(own, odoo_teams, company_keys).assign(updated_at_utc=now))
        upsert(conn, "dim_finance_aging_bucket", aging.bucket_frame().assign(updated_at_utc=now))
        upsert(conn, "dim_finance_receivable_scope", rscope.scope_frame().assign(updated_at_utc=now))
        if len(built.invoices):
            upsert(conn, "dim_finance_invoice", built.invoices.assign(updated_at_utc=now))
        if len(built.payments):
            upsert(conn, "dim_finance_payment", built.payments.assign(updated_at_utc=now))
        if len(built.bridge):
            upsert(conn, "bridge_finance_invoice_order", built.bridge.assign(updated_at_utc=now))
        deleted, inserted = snapshot_replace(conn, FACT, fact.drop(columns=["SnapshotDateKey"]), {"SnapshotDateKey": snap})
        results = ctx.quality.evaluate(_checks(first_snapshot, snap), conn, task_name="load_receivables")
        q.raise_for_failures(results)  # rolls back the whole load
        # information only: bridged orders the sales orders fact does not carry (legacy "real sales order" rule)
        not_in_orders_fact = conn.execute(text(
            "SELECT COUNT(DISTINCT b.SalesOrderKey) FROM bridge_finance_invoice_order b "
            "LEFT JOIN fact_sales_orders o ON o.SalesOrderKey = b.SalesOrderKey WHERE o.SalesOrderKey IS NULL")).scalar()
    details = {**built.stats, "bridged_orders_not_in_fact_sales_orders": int(not_in_orders_fact or 0), "replaced_rows_of_same_day": deleted, "first_snapshot": first_snapshot, "snapshot_is_today": snap_date == today,
               "previous_snapshot": previous, "odoo_profile": ctx.state.get("odoo_profile"),
               "intercompany_partner_ids_configured": list(intercompany_ids),
               "intercompany_partners_configured": {str(k): named.get(k) for k in sorted(inputs.configured_intercompany_customers)}}
    ctx.logger.info("Receivable snapshot %s: %s row(s); net open %s; overdue %s; by move type %s; payment lines %s", snap_date, inserted,
                    f"{details['open_amount_net']:,.2f}", f"{details['overdue_amount']:,.2f}", details["rows_by_move_type"],
                    details["payment_lines_by_type"])
    # ids only in the log line (names, often Arabic, are in the run details: a non-UTF-8 console cannot print them)
    ctx.logger.info("Receivable scopes: %s; Debt page default (customer debt, no inter-company) %s; configured inter-company partner ids %s",
                    details["by_scope"], f"{details['open_amount_net_default_view']:,.2f}", details["intercompany_partner_ids_configured"])
    return TaskResult(rows_loaded=inserted, details=details)


# -- registration ----------------------------------------------------------------------------------------------------------
for table, key, model in (("raw_odoo_account_move_line", ("id",), "account.move.line"), ("raw_odoo_account_move", ("id",), "account.move"),
                          ("raw_odoo_account_payment", ("id",), "account.payment"), ("raw_odoo_account_journal", ("id",), "account.journal"),
                          ("raw_odoo_sale_order_invoice", ("sale_order_id", "move_id"), "sale.order")):
    REGISTRY.dataset(DatasetSpec(table, DEPARTMENT, "raw", "odoo", table, "replace", key, model=model))
for table, key, load in (("dim_finance_aging_bucket", ("AgingBucketKey",), "upsert"), ("dim_finance_receivable_scope", ("receivable_scope",), "upsert"), ("dim_finance_invoice", ("move_id",), "upsert"),
                         ("dim_finance_payment", ("PaymentKey",), "upsert"),
                         ("bridge_finance_invoice_order", ("move_id", "SalesOrderKey"), "upsert"),
                         (FACT, ("SnapshotDateKey", "line_id"), "snapshot_replace")):
    REGISTRY.dataset(DatasetSpec(table, DEPARTMENT, "mart", "sql", table, load, key))
REGISTRY.task(TaskSpec("extract_receivables", extract_receivables))
REGISTRY.task(TaskSpec("load_receivables", load_receivables, depends_on=("extract_receivables",)))
# the collections tasks (departments/finance/collections.py, registered there) run after the snapshot is committed
REGISTRY.job(JobSpec("finance_receivables", DEPARTMENT,
                     tasks=("extract_receivables", "load_receivables", "extract_collections", "load_collections"),
                     depends_on_jobs=("core_dims",), mode="snapshot",
                     description="Receivable snapshot of today + collections (customer payments) since the last run "
                                 "(Receivables and Collections); nightly inside full_all, daily 15:00 alone."))

# registers the collections tasks of the job above (only "jobs" modules are auto-imported; collections.py imports this module)
from departments.finance import collections as _collections  # noqa: E402,F401
