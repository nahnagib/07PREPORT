"""Phase B step 1: the sales tables built every 30 minutes from the Odoo mirror (docs/etl-phase-b-sales-incremental.md).

  sales_mirror          module of the 30-minute refresh: Odoo -> raw_odoo_mirror by write_date (seconds when nothing
                        changed); in the 02:00 full refresh with the id checks and the write_date audit (full_check).
  sales_build           its own job on the second queue (etl-long, lock "sales"): when the mirror, the shared lists, the
                        input files or the business date changed since the last build, the unchanged legacy transforms
                        run on the mirror (build_sheets(source=mirror)), the keys are conformed as in the full refresh,
                        and only the rows that differ are written -- to the shd_* copies (ETL_SALES_MODE=shadow) or to the
                        live tables (incremental). Nothing changed: it ends in seconds.
  sales_shadow_compare  after the 02:00 full refresh (shadow mode): live (built from Odoo's sale.report) vs shadow (built
                        from the mirror), every table row by row and fact_sales_lines totals per company x currency x
                        month x salesperson -> etl_shadow_compare / etl_shadow_diff, shown in the ETL Control Center.

The 02:00 full refresh keeps rebuilding the live tables from Odoo in every mode: it is the reference.
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
import hashlib
import json
import logging
import uuid
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
from sqlalchemy import inspect, text

from departments.sales import mirror as mr
from departments.sales.dim_changes import dim_changes_since
from etl_platform.config import sales_mode_from_env
from etl_platform.load import _content_hash, _key_of, reflect_table, replace_changed
from etl_platform.runner import RunContext, TaskResult
from sales_pipeline.odoo.client import rows_read_since, rows_read_totals

log = logging.getLogger(__name__)

SHADOW_PREFIX = "shd_"
MIRROR_CHANGED = "mirror:changed"   # etl_watermark: last time sales_mirror stored / deleted anything
BUILD_WATERMARK = "sales_build"     # etl_watermark: the MIRROR_CHANGED value the last successful build consumed
LINE_MEASURES = ["quantity", "Volume", "line_total", "Value", "untaxed_total", "qty_ordered", "qty_delivered", "InvoiceValue"]
# order id column per table (rows of orders changed in Odoo while the comparison ran are left out of the verdict)
ORDER_COLUMNS = {"fact_sales_lines": "OdooOrderID", "fact_sales_orders": "SalesDocumentID", "fact_sales_documents": "SalesDocumentID",
                 "fact_sales_deliveries": "SalesOrderID", "dim_sales_order": "SalesOrderKey"}
IGNORED_COLUMNS = {"_run_id"}
MAX_SAMPLE_KEYS = 20


def mode_disabled(*allowed: str):
    def reason() -> str | None:
        mode = sales_mode_from_env()
        return None if mode in allowed else f"ETL_SALES_MODE={mode}"
    return reason


def build_locks() -> tuple[str, ...]:
    """shadow: the build writes shd_* only, so it never waits for (or blocks) the 5x/day job writing the live tables;
    incremental: it writes the live tables, the same lock as the 02:00 rebuild of them."""
    return ("sales_shadow",) if sales_mode_from_env() == "shadow" else ("sales",)


def target_table(table: str, mode: str) -> str:
    return SHADOW_PREFIX + table if mode == "shadow" else table


# -- sales_mirror ----------------------------------------------------------------------------------------------------------
def mirror_sync(ctx: RunContext) -> TaskResult:
    before = rows_read_totals()
    client = ctx.odoo().client  # read-only (GuardedOdooClient); the mirror passes the legacy repositories' own contexts
    full_check = ctx.full_refresh or ctx.state.get("top_job") == "full_all"
    sync = mr.MirrorSync(client, ctx.engine, ctx.watermarks, run_uid=ctx.run_uid, overlap_minutes=ctx.config.mirror_overlap_minutes,
                         audit_days=ctx.config.mirror_audit_days, page_size=ctx.config.odoo_page_size)
    result = sync.run(full_check=full_check)
    with ctx.engine.begin() as conn:
        if result.any_change:
            wm = ctx.watermarks.get(MIRROR_CHANGED, conn=conn)
            ctx.watermarks.save(dataclasses.replace(wm, write_date=mr.utc_now()), run_uid=ctx.run_uid, conn=conn)
    read = rows_read_since(before)
    log.info("Odoo rows read per model (sales_mirror): %s", read or "none")
    for model, fields in result.non_stored_fields.items():
        log.warning("Mirror: %s fields %s are not stored in Odoo and no rule refreshes them: changes show in the shadow comparison",
                    model, fields)
    return TaskResult(rows_extracted=sum(read.values()), rows_loaded=sum(result.changed.values()) + sum(result.deleted.values()),
                      details={**result.summary(), "odoo_rows_read": read})


# -- sales_build -----------------------------------------------------------------------------------------------------------
def _inputs_signature(input_dir: Path) -> str:
    """Name, size and modification time of every input file the sales build reads (SalesTeam.xlsx, PRODUCTS.xlsx,
    sales_targets.xlsx, ...): a changed workbook rebuilds."""
    parts = []
    for f in sorted(Path(input_dir).glob("*")):
        if f.is_file() and not f.name.startswith("~$"):
            st = f.stat()
            parts.append(f"{f.name}|{st.st_size}|{int(st.st_mtime)}")
    return hashlib.sha1("\n".join(parts).encode("utf-8")).hexdigest()


def _last_build(conn) -> dict[str, Any] | None:
    row = conn.execute(text(
        "SELECT t.started_at_utc, t.details FROM etl_task_log t WHERE t.task_name = 'write_sales_from_mirror' AND t.status = 'success' "
        "ORDER BY t.started_at_utc DESC LIMIT 1")).first()
    if row is None:
        return None
    details = row[1] if isinstance(row[1], dict) else json.loads(row[1] or "{}")
    return {"started": row[0], **details}


def build_reason(ctx: RunContext, mode: str) -> str | None:
    """Why the sales tables must be rebuilt now, or None (nothing changed since the last build)."""
    today = _dt.datetime.now(ZoneInfo(ctx.config.business_timezone)).date().isoformat()
    with ctx.engine.connect() as conn:
        last = _last_build(conn)
        if ctx.full_refresh:
            return "full refresh requested"
        if last is None or last.get("mode") != mode:
            return f"first build in {mode} mode"
        if last.get("business_date") != today:
            return f"business date {today} (date-relative columns)"
        if last.get("inputs_signature") != _inputs_signature(ctx.config.input_dir):
            return "input workbook(s) changed"
        changed = ctx.watermarks.get(MIRROR_CHANGED, conn=conn).write_date
        if changed is not None and str(changed) != last.get("mirror_changed"):
            return f"Odoo records changed (mirror at {changed} UTC)"
        dims, _ = dim_changes_since(conn, pd.Timestamp(last["started"]).to_pydatetime())
        if not dims.empty:
            return "shared lists changed: " + ", ".join(f"{k}={len(v)}" for k, v in vars(dims).items() if v)
    return None


def build_sales_from_mirror(ctx: RunContext) -> TaskResult:
    from departments.sales.jobs import _pipeline

    mode = sales_mode_from_env()
    if mode == "legacy":
        ctx.state["skip_sales_build"] = "ETL_SALES_MODE=legacy"
        return TaskResult(details={"skipped": "ETL_SALES_MODE=legacy: the sales tables are built by the 5x/day job"})
    reason = build_reason(ctx, mode)
    if reason is None:
        ctx.state["skip_sales_build"] = "nothing changed since the last build"
        log.info("sales_build: nothing changed since the last build (mirror, shared lists, inputs, date): nothing to do")
        return TaskResult(details={"skipped": "nothing changed since the last build"})
    with ctx.engine.connect() as conn:
        mirror_changed = ctx.watermarks.get(MIRROR_CHANGED, conn=conn).write_date
    log.info("sales_build (%s): rebuilding because %s", mode, reason)
    with mr.MirrorSnapshot(ctx.engine) as snapshot:
        build = _pipeline(ctx).build_sheets(include_qa=False, source=snapshot)
    ctx.state.update(build=build, sales_mode=mode, build_reason=reason, mirror_changed=mirror_changed)
    return TaskResult(rows_extracted=0, details={"mode": mode, "reason": reason, "mirror_rows_used": build.odoo_extract_count,
                                                 "sheets": {k: len(v) for k, v in build.sheets.items()}})


def conform_sales_from_mirror(ctx: RunContext) -> TaskResult:
    from departments.sales.jobs import conform_sales

    if ctx.state.get("skip_sales_build"):
        return TaskResult(details={"skipped": ctx.state["skip_sales_build"]})
    # shadow: dim_customer (live) keeps the growth columns of the live build; incremental writes them like the full refresh
    ctx.state["write_customer_growth"] = ctx.state["sales_mode"] == "incremental"
    return conform_sales(ctx)


def write_sales_from_mirror(ctx: RunContext) -> TaskResult:
    from departments.sales.jobs import KEY_DIMS, MART_TABLES, cf
    from etl_platform import quality as q

    if ctx.state.get("skip_sales_build"):
        return TaskResult(details={"skipped": ctx.state["skip_sales_build"]})
    mode = ctx.state["sales_mode"]
    result = ctx.state["conformed"]
    insp = inspect(ctx.engine)
    changes: dict[str, Any] = {}
    written = 0
    with ctx.engine.begin() as conn:
        overrides = {}
        specs = []
        for table in MART_TABLES:
            target = target_table(table, mode)
            cols = [c["name"] for c in insp.get_columns(target)]
            df = result.tables[table]
            df = df[[c for c in df.columns if c in cols]].copy()
            cs = replace_changed(conn, target, df, stamp_column="_run_id", stamp_value=ctx.run_uid)
            changes[table] = {k: v for k, v in cs.summary().items() if k != "deleted_keys" or v}
            written += cs.written + len(cs.deleted)
            overrides[table] = target
            for col in df.columns:
                if col in KEY_DIMS:
                    dim, dim_col = KEY_DIMS[col]
                    specs.append(q.orphan(table, col, dim, dim_col, name=f"orphan:{table}.{col}"))
            specs.append(q.min_rows(table, 1, name=f"min_rows:{table}", severity="fail" if table == "fact_sales_lines" else "warn"))
        # the same checks as the full refresh, on the written tables, before the transaction commits
        q.raise_for_failures(ctx.quality.evaluate(specs, conn, task_name="write_sales_from_mirror", table_overrides=overrides))
    today = _dt.datetime.now(ZoneInfo(ctx.config.business_timezone)).date().isoformat()
    log.info("sales_build (%s): %s row(s) written or deleted: %s", mode, f"{written:,}",
             {t: (c.get("inserted", 0), c.get("updated", 0), c.get("deleted", 0)) for t, c in changes.items()})
    return TaskResult(rows_loaded=written, details={
        "mode": mode, "reason": ctx.state["build_reason"], "business_date": today, "inputs_signature": _inputs_signature(ctx.config.input_dir),
        "mirror_changed": None if ctx.state["mirror_changed"] is None else str(ctx.state["mirror_changed"]), "tables": changes,
        "targets": {t: target_table(t, mode) for t in MART_TABLES}})


# -- sales_shadow_compare --------------------------------------------------------------------------------------------------
def _table_frame(conn, table: str) -> pd.DataFrame:
    return pd.read_sql(text(f"SELECT * FROM `{table}`") if conn.dialect.name == "mysql" else text(f'SELECT * FROM "{table}"'), conn)


def _row_hashes(conn, table: str, key: list[str], compare: list[str]) -> dict[tuple, str]:
    q = conn.dialect.identifier_preparer.quote
    out = {}
    for row in conn.execute(text(f"SELECT {', '.join(q(c) for c in [*key, *compare])} FROM {q(table)}")):
        out[_key_of(row[:len(key)])] = _content_hash(row[len(key):])
    return out


def _last_run(conn, job: str) -> tuple[str | None, _dt.datetime | None]:
    row = conn.execute(text("SELECT run_uid, started_at_utc FROM etl_run_log WHERE job_name = :j AND status IN ('success', 'partial') "
                            "ORDER BY started_at_utc DESC LIMIT 1"), {"j": job}).first()
    return (row[0], row[1]) if row else (None, None)


def shadow_compare(ctx: RunContext) -> TaskResult:
    from departments.sales.jobs import MART_TABLES

    compare_uid = str(uuid.uuid4())
    started = mr.utc_now()
    as_of = _dt.datetime.now(ZoneInfo(ctx.config.business_timezone)).date()
    diffs: list[dict[str, Any]] = []
    summary: dict[str, Any] = {"tables": {}}
    totals = dict(rows_live=0, rows_shadow=0, rows_only_live=0, rows_only_shadow=0, rows_different=0)
    with ctx.engine.connect() as conn:
        live_uid, live_started = _last_run(conn, "sales_full")
        shadow_uid, _ = _last_run(conn, "sales_build")
        # orders changed in Odoo after the live read began: their rows are left out of the verdict (listed)
        excluded: set[int] = set()
        if live_started is not None:
            excluded = {int(r[0]) for r in conn.execute(text(
                "SELECT record_id FROM raw_odoo_mirror WHERE model = 'sale.order' AND write_date >= :t"), {"t": live_started})}
        for table in MART_TABLES:
            shadow = SHADOW_PREFIX + table
            t = reflect_table(conn, table)
            key = [c.name for c in t.primary_key.columns]
            cols = [c.name for c in t.columns if c.name not in key and c.name not in IGNORED_COLUMNS]
            live = _row_hashes(conn, table, key, cols)
            shd = _row_hashes(conn, shadow, key, cols)
            order_col = ORDER_COLUMNS.get(table)
            if excluded and order_col:
                drop = _keys_of_orders(conn, table, key, order_col, excluded) | _keys_of_orders(conn, shadow, key, order_col, excluded)
                live = {k: v for k, v in live.items() if k not in drop}
                shd = {k: v for k, v in shd.items() if k not in drop}
            only_live = [k for k in live if k not in shd]
            only_shd = [k for k in shd if k not in live]
            different = [k for k in live if k in shd and live[k] != shd[k]]
            stats = {"rows_live": len(live), "rows_shadow": len(shd), "rows_only_live": len(only_live),
                     "rows_only_shadow": len(only_shd), "rows_different": len(different)}
            for k, v in stats.items():
                totals[k] += v
                diffs.append({"table_name": table, "cell_key": "*", "measure": k, "live_value": None, "shadow_value": None,
                              "diff": v, "status": "DIFF" if k in ("rows_only_live", "rows_only_shadow", "rows_different") and v else "MATCH"})
            bad = only_live + only_shd + different
            summary["tables"][table] = {**stats, "sample_keys": [list(k) for k in bad[:MAX_SAMPLE_KEYS]],
                                        "different_columns": _different_columns(conn, table, shadow, key, cols, different[:200]) if different else {}}
        cells, cells_diff = _line_cells(conn, excluded, diffs)
    status = "match" if totals["rows_only_live"] + totals["rows_only_shadow"] + totals["rows_different"] + cells_diff == 0 else "diff"
    summary["excluded_orders"] = sorted(excluded)[:200]
    with ctx.engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO etl_shadow_compare (compare_uid, module, as_of_date, run_uid, live_run_uid, shadow_run_uid, started_at_utc, "
            "finished_at_utc, status, tables_compared, rows_live, rows_shadow, rows_only_live, rows_only_shadow, rows_different, "
            "cells_compared, cells_diff, excluded_orders, summary_json) VALUES (:u, 'sales', :d, :r, :lu, :su, :s, :f, :st, :tc, "
            ":rl, :rs, :ol, :os, :rd, :cc, :cd, :eo, :sj)"),
            {"u": compare_uid, "d": as_of, "r": ctx.run_uid, "lu": live_uid, "su": shadow_uid, "s": started, "f": mr.utc_now(),
             "st": status, "tc": len(MART_TABLES), "rl": totals["rows_live"], "rs": totals["rows_shadow"], "ol": totals["rows_only_live"],
             "os": totals["rows_only_shadow"], "rd": totals["rows_different"], "cc": cells, "cd": cells_diff, "eo": len(excluded),
             "sj": json.dumps(summary, default=str)})
        rows = [{"u": compare_uid, **{k: d[k] for k in ("table_name", "cell_key", "measure", "live_value", "shadow_value", "diff", "status")}}
                for d in diffs]
        for i in range(0, len(rows), 500):
            conn.execute(text("INSERT INTO etl_shadow_diff (compare_uid, table_name, cell_key, measure, live_value, shadow_value, diff, status) "
                              "VALUES (:u, :table_name, :cell_key, :measure, :live_value, :shadow_value, :diff, :status)"), rows[i:i + 500])
    log.info("Shadow comparison %s: %s -- rows only live %s, only shadow %s, different %s; line cells %s/%s differ; %s order(s) "
             "changed during the comparison left out", compare_uid, status.upper(), totals["rows_only_live"], totals["rows_only_shadow"],
             totals["rows_different"], cells_diff, cells, len(excluded))
    return TaskResult(rows_loaded=len(rows), details={"compare_uid": compare_uid, "status": status, **totals, "cells_compared": cells,
                                                      "cells_diff": cells_diff, "excluded_orders": len(excluded)})


def _keys_of_orders(conn, table: str, key: list[str], order_col: str, orders: set[int]) -> set[tuple]:
    q = conn.dialect.identifier_preparer.quote
    out: set[tuple] = set()
    ids = sorted(orders)
    for i in range(0, len(ids), 1000):
        chunk = ",".join(str(x) for x in ids[i:i + 1000])
        out |= {_key_of(r) for r in conn.execute(text(f"SELECT {', '.join(q(c) for c in key)} FROM {q(table)} WHERE {q(order_col)} IN ({chunk})"))}
    return out


def _different_columns(conn, table: str, shadow: str, key: list[str], cols: list[str], keys: list[tuple]) -> dict[str, int]:
    """For a sample of differing rows: how many differ in each column (where to look)."""
    if not keys:
        return {}
    live = _table_frame(conn, table).set_index(key)
    shd = _table_frame(conn, shadow).set_index(key)
    idx = [k[0] if len(k) == 1 else k for k in keys]
    idx = [k for k in idx if k in live.index and k in shd.index]
    counts: dict[str, int] = {}
    for c in cols:
        a = [json.dumps(_key_of([v]), default=str) for v in live.loc[idx, c]]
        b = [json.dumps(_key_of([v]), default=str) for v in shd.loc[idx, c]]
        n = sum(x != y for x, y in zip(a, b))
        if n:
            counts[c] = n
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


def _line_cells(conn, excluded: set[int], diffs: list[dict[str, Any]]) -> tuple[int, int]:
    """fact_sales_lines totals per company x order currency x month x salesperson, live vs shadow; DIFF cells stored."""
    currency = {int(r["id"]): (r.get("currency_id") or [None, ""])[1] for r in mr.MirrorStore(conn).payloads("sale.order")}

    def cut(table: str) -> pd.DataFrame:
        df = pd.read_sql(text(f"SELECT CompanyKey, OdooOrderID, DateKey, SalespersonKey, {', '.join('`' + m + '`' for m in LINE_MEASURES)} "
                              f"FROM `{table}`"), conn)
        if excluded:
            df = df[~df["OdooOrderID"].isin(excluded)]
        df["Currency"] = df["OdooOrderID"].map(lambda o: currency.get(int(o), "") if pd.notna(o) else "")
        df["Month"] = (pd.to_numeric(df["DateKey"]) // 100).astype("Int64").astype(str)
        df["rows"] = 1
        return df.groupby(["CompanyKey", "Currency", "Month", "SalespersonKey"])[["rows", *LINE_MEASURES]].sum()

    a, b = cut("fact_sales_lines"), cut(SHADOW_PREFIX + "fact_sales_lines")
    t = a.join(b, how="outer", lsuffix="_live", rsuffix="_shadow").fillna(0)
    n_diff = 0
    for idx, row in t.iterrows():
        cell = "|".join(str(v) for v in idx)
        bad = False
        for m in ["rows", *LINE_MEASURES]:
            lv, sv = float(row[f"{m}_live"]), float(row[f"{m}_shadow"])
            if abs(lv - sv) > 0.005:
                bad = True
                diffs.append({"table_name": "fact_sales_lines", "cell_key": cell[:255], "measure": m, "live_value": lv,
                              "shadow_value": sv, "diff": sv - lv, "status": "DIFF"})
        n_diff += bad
    return len(t), n_diff
