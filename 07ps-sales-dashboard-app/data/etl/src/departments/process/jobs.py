"""Process department jobs.

  process_nps   NPS Score: the NPS developer's MySQL database (through an SSH tunnel; etl_platform/sources/mysql_ssh.py,
                credential profile NPS) -> raw_nps_* -> fact_process_nps_response / fact_process_nps_comment -> the
                v_process_nps_* views (migration 0046) the NPS Score page reads. Depends on core_dims (reused when it
                succeeded within ETL_CORE_DIMS_FRESH_MINUTES). Runs inside the nightly full_all (an optional step: its
                failure leaves the run 'partial' and never touches sales or finance) and on its own every 3 hours
                (ETL_SCHEDULE_PROCESS_NPS_CRON). NPS_ENABLED=false switches it off in an environment without the source
                (full_all records it as skipped; run alone, it fails saying so).

Load (docs/nps-etl.md):
1. extract_nps: both source tables are read COMPLETELY every run (the developer's script reloads them as a whole, so
   updated_at is no watermark; decision D7), paged by id, through a read-only session. One transaction: raw upsert by
   id, ids that left the source get _deleted_at (cleared if they come back), sync_state copied. An empty source while
   the warehouse holds rows fails the run instead of marking everything deleted.
2. load_nps: transform (departments/process/transform.py, rules in nps.py) of the raw rows that are not deleted, then
   one transaction: level dimension upsert, both facts replaced, quality checks on that transaction -- orphans, a
   duplicate response id or a level outside 1..3 FAIL (everything rolls back); stale source, key fallback rates,
   low-rating table disagreements and deliveries rated more than once WARN.
"""

from __future__ import annotations

import datetime as _dt
import os
from typing import Any

import pandas as pd
from sqlalchemy import bindparam, text

from core.jobs import ensure_date_range
from core.resolve import KeyMaps
from departments.process import nps
from departments.process import transform as tf
from departments.process import whatsapp as wa
from etl_platform import quality as q
from etl_platform.load import replace_all, upsert
from etl_platform.notify import notify
from etl_platform.registry import REGISTRY, DatasetSpec, JobSpec, TaskSpec
from etl_platform.runner import RunContext, TaskResult
from etl_platform.sources.mysql_ssh import MySqlSshSettings, open_source

DEPARTMENT = "process"
PROFILE = "NPS"
SOURCE_FULL, SOURCE_LOW = "nps_rating_full_data", "low_rating_data"
RAW_FULL, RAW_LOW, RAW_SYNC = "raw_nps_rating", "raw_nps_low_rating", "raw_nps_sync_state"
FACT, COMMENTS, LEVELS = "fact_process_nps_response", "fact_process_nps_comment", "dim_process_nps_level"
# WhatsApp message reach (step 2, section 4; departments/process/whatsapp.py), behind NPS_REACH_ENABLED
RAW_MSG, MSG_FACT, FAILURE_GROUPS = "raw_nps_whatsapp_message", "fact_process_nps_message", "dim_process_nps_failure_group"
COMMON = ["id", "create_date", "company_id", "company_name", "created_id", "created_name", "mobile_number", "delivery_code",
          "body", "failure_type", "failure_reason", "order_id", "scheduled_date", "partner_id", "partner_name", "salesperson_id",
          "salesperson_name", "team_id", "team_name"]
FULL_COLUMNS = [*COMMON, "updated_at"]
LOW_COLUMNS = [*COMMON, "team_branch", "recipient_email", "email_notification", "notification_date", "updated_at"]
ID_COLUMNS = ("company_id", "created_id", "partner_id", "salesperson_id", "team_id")  # FLOAT in the source
# warnings
STALE_DAYS = 3  # no new rating for this many days -> the source probably stopped syncing
MAX_FALLBACK_PCT = {"CustomerKey": 10.0, "SalespersonKey": 10.0, "SalesTeamKey": 10.0}  # company / order: every row warns
KEY_DIMS = {
    "CompanyKey": ("dim_company", "CompanyKey"), "CustomerKey": ("dim_customer", "CustomerKey"),
    "SalespersonKey": ("dim_salesperson", "SalespersonKey"), "SalesTeamKey": ("dim_sales_team", "SalesTeamKey"),
    "SegmentKey": ("dim_segment", "SegmentKey"), "ChannelKey": ("dim_channel", "ChannelKey"),
}


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


def disabled_reason() -> str | None:
    value = os.getenv("NPS_ENABLED", "").strip().lower()
    return None if value in ("1", "true", "yes", "on") else "NPS_ENABLED is not true (the NPS source is not configured here)"


def source_settings() -> MySqlSshSettings:
    """The NPS credential profile; fails fast naming every missing NPS_* variable (never a value)."""
    return MySqlSshSettings.from_env(PROFILE)


# -- extract -----------------------------------------------------------------------------------------------------------
def whole_ids(frame: pd.DataFrame, table: str) -> pd.DataFrame:
    """The source keeps Odoo ids as FLOAT: whole numbers -> BIGINT; anything else fails (it would not be an Odoo id)."""
    out = frame.copy()
    for col in ID_COLUMNS:
        if col not in out.columns:
            continue
        values = pd.to_numeric(out[col], errors="coerce")
        broken = out.loc[values.notna() & (values != values.round()), "id"].tolist()
        if broken:
            raise ValueError(f"{table}.{col} holds values that are not whole numbers (not Odoo ids), source ids {broken[:20]}")
        out[col] = values.round().astype("Int64").astype(object).where(values.notna(), None)
    return out


def raw_frame(records: list[dict[str, Any]], columns: list[str], table: str, ctx: RunContext, extracted_at: _dt.datetime) -> pd.DataFrame:
    df = pd.DataFrame(records, columns=columns)
    df = whole_ids(df, table)
    df["_source_write_date"] = df.pop("updated_at")
    df["_extracted_at"], df["_run_id"], df["_deleted_at"] = extracted_at, ctx.run_uid, None
    return df.astype(object).where(df.notna(), None)


def mark_deleted(conn, table: str, present_ids: set[int], now: _dt.datetime) -> tuple[int, int]:
    """Stamps _deleted_at on the ids that are no longer in the source; clears it on ids that came back.
    Returns (newly deleted, restored)."""
    rows = conn.execute(text(f"SELECT id, _deleted_at FROM {table}")).fetchall()
    gone = [int(i) for i, d in rows if int(i) not in present_ids and d is None]
    back = [int(i) for i, d in rows if int(i) in present_ids and d is not None]
    for ids, value in ((gone, now), (back, None)):
        for i in range(0, len(ids), 500):
            conn.execute(text(f"UPDATE {table} SET _deleted_at = :v WHERE id IN :ids").bindparams(bindparam("ids", expanding=True)),
                         {"v": value, "ids": ids[i:i + 500]})
    return len(gone), len(back)


def wa_raw_frame(records: list[dict[str, Any]], ctx: RunContext, extracted_at: _dt.datetime) -> pd.DataFrame:
    df = pd.DataFrame(records, columns=wa.SOURCE_COLUMNS)
    df["_source_write_date"] = df.pop("updated_at")
    df["_extracted_at"], df["_run_id"], df["_deleted_at"] = extracted_at, ctx.run_uid, None
    return df.astype(object).where(df.notna(), None)


def extract_nps(ctx: RunContext) -> TaskResult:
    settings = source_settings()
    with open_source(settings) as src:
        full = src.read_table_incremental(SOURCE_FULL, FULL_COLUMNS)
        low = src.read_table_incremental(SOURCE_LOW, LOW_COLUMNS)
        sync = src.read_query("SELECT source, last_successful_sync FROM sync_state")
        reach = wa.ReachConfig.from_env()
        messages, reach_status = None, "disabled (NPS_REACH_ENABLED is not true)"
        if reach.enabled:
            exists = src.read_query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() "
                                    "AND TABLE_NAME = :t", {"t": wa.SOURCE_TABLE})
            if int(exists[0]["n"] if exists else 0):
                messages, reach_status = src.read_table_incremental(wa.SOURCE_TABLE, wa.SOURCE_COLUMNS), "loaded"
            else:
                reach_status = f"skipped: {wa.SOURCE_TABLE} does not exist in the source yet"
                ctx.logger.info("NPS reach %s; the ratings are not affected", reach_status)
    extracted_at = _now()
    full_df = raw_frame(full, FULL_COLUMNS, SOURCE_FULL, ctx, extracted_at)
    low_df = raw_frame(low, LOW_COLUMNS, SOURCE_LOW, ctx, extracted_at)
    sync_df = pd.DataFrame(sync, columns=["source", "last_successful_sync"]).assign(_extracted_at=extracted_at, _run_id=ctx.run_uid)
    with ctx.engine.begin() as conn:
        held = int(conn.execute(text(f"SELECT COUNT(*) FROM {RAW_FULL} WHERE _deleted_at IS NULL")).scalar() or 0)
        if not len(full_df) and held:
            raise RuntimeError(f"The NPS source returned 0 rows from {SOURCE_FULL} while the warehouse holds {held}: not marking "
                               "them deleted (the source may be reloading). The next run tries again.")
        upsert(conn, RAW_FULL, full_df)
        upsert(conn, RAW_LOW, low_df)
        deleted_full = mark_deleted(conn, RAW_FULL, {int(i) for i in full_df["id"]}, extracted_at)
        deleted_low = mark_deleted(conn, RAW_LOW, {int(i) for i in low_df["id"]}, extracted_at)
        replace_all(conn, RAW_SYNC, sync_df)
        deleted_msg = None
        if messages is not None:
            msg_df = wa_raw_frame(messages, ctx, extracted_at)
            held_msg = int(conn.execute(text(f"SELECT COUNT(*) FROM {RAW_MSG} WHERE _deleted_at IS NULL")).scalar() or 0)
            upsert(conn, RAW_MSG, msg_df)
            if len(msg_df) or not held_msg:  # an empty source table never marks every message deleted
                deleted_msg = mark_deleted(conn, RAW_MSG, {int(i) for i in msg_df["id"]}, extracted_at)
            else:
                notify("WARNING", f"{wa.SOURCE_TABLE} returned 0 rows while the warehouse holds {held_msg}: none marked deleted", job=ctx.job.name)
    ctx.state["reach_status"] = reach_status
    details = {"source_db": settings.db_name, "ssh": settings.ssh_enabled, "ssh_auth": settings.auth_method if settings.ssh_enabled else None,
               "rows": {SOURCE_FULL: len(full_df), SOURCE_LOW: len(low_df), "sync_state": len(sync_df)},
               "deleted_restored": {RAW_FULL: deleted_full, RAW_LOW: deleted_low},
               "sync_state": {str(r["source"]): str(r["last_successful_sync"]) for r in sync},
               "reach": {"status": reach_status, "messages": None if messages is None else len(messages), "deleted_restored": deleted_msg}}
    ctx.logger.info("NPS extracted: %s", details)
    return TaskResult(rows_extracted=len(full_df) + len(low_df), rows_loaded=len(full_df) + len(low_df), details=details)


# -- load --------------------------------------------------------------------------------------------------------------
def lookups(conn, order_names: set[str], delivery_codes: set[str]) -> tf.Lookups:
    """Candidate sale orders / pickings by name (names repeat across companies; transform.pick narrows them)."""
    orders: dict[str, list[tf.Candidate]] = {}
    deliveries: dict[str, list[tf.Candidate]] = {}
    names = sorted(order_names)
    for i in range(0, len(names), 500):
        for k, n, co, cu in conn.execute(text("SELECT SalesOrderKey, order_number, CompanyKey, CustomerKey FROM dim_sales_order "
                                              "WHERE order_number IN :n").bindparams(bindparam("n", expanding=True)), {"n": names[i:i + 500]}):
            orders.setdefault(str(n), []).append((int(k), int(co), int(cu)))
    codes = sorted(delivery_codes)
    for i in range(0, len(codes), 500):
        for ref, co, cu in conn.execute(text("SELECT DISTINCT DeliveryReference, CompanyKey, CustomerKey FROM fact_sales_deliveries "
                                             "WHERE DeliveryReference IN :c").bindparams(bindparam("c", expanding=True)), {"c": codes[i:i + 500]}):
            deliveries.setdefault(str(ref), []).append((0, int(co), int(cu if cu is not None else -1)))
    return tf.Lookups(orders, deliveries)


def _checks(stale_before: _dt.datetime) -> list[q.CheckSpec]:
    specs = [q.orphan(FACT, col, dim, dim_col, name=f"orphan:{FACT}.{col}") for col, (dim, dim_col) in KEY_DIMS.items()]
    specs += [q.orphan(COMMENTS, col, dim, dim_col, name=f"orphan:{COMMENTS}.{col}") for col, (dim, dim_col) in KEY_DIMS.items()]
    specs += [
        q.orphan(FACT, "nps_level", LEVELS, "nps_level", name=f"orphan:{FACT}.nps_level"),
        q.orphan(FACT, "RatingDateKey", "dim_date", "DateKey", name=f"orphan:{FACT}.RatingDateKey"),
        q.orphan(FACT, "DeliveryDateKey", "dim_date", "DateKey", name=f"orphan:{FACT}.DeliveryDateKey"),
        q.orphan(COMMENTS, "CommentDateKey", "dim_date", "DateKey", name=f"orphan:{COMMENTS}.CommentDateKey"),
        q.orphan(FACT, "SalesOrderKey", "dim_sales_order", "SalesOrderKey", where="f.SalesOrderKey <> -1", name=f"orphan:{FACT}.SalesOrderKey"),
        q.orphan(COMMENTS, "response_id", FACT, "response_id", where="f.response_id <> -1", name=f"orphan:{COMMENTS}.response_id"),
        q.unique(FACT, ["response_id"], name=f"fail:{FACT}.duplicate_response_id"),
        q.custom_sql(f"fail:{FACT}.level_outside_1_3", f"SELECT response_id, nps_level FROM {FACT} WHERE nps_level NOT IN (1, 2, 3)", table=FACT),
        # warnings
        q.custom_sql("warn:nps_source_stale",
                     f"SELECT MAX(rated_at_utc) FROM {FACT} HAVING MAX(rated_at_utc) IS NULL OR MAX(rated_at_utc) < :cutoff",
                     table=FACT, severity="warn", params={"cutoff": stale_before}),
        # the developer's own bookkeeping: an old sync, or no sync_state row at all (nothing says when it last synced)
        q.custom_sql("warn:nps_sync_state_stale",
                     f"SELECT source, last_successful_sync FROM {RAW_SYNC} WHERE last_successful_sync IS NULL OR last_successful_sync < :cutoff "
                     f"UNION ALL SELECT '(sync_state is empty)', NULL WHERE NOT EXISTS (SELECT 1 FROM {RAW_SYNC})",
                     table=RAW_SYNC, severity="warn", params={"cutoff": stale_before}),
        q.custom_sql("warn:nps_low_rating_ids_not_in_full",
                     f"SELECT l.id FROM {RAW_LOW} l LEFT JOIN {RAW_FULL} r ON r.id = l.id AND r._deleted_at IS NULL "
                     "WHERE l._deleted_at IS NULL AND r.id IS NULL", table=RAW_LOW, severity="warn"),
        q.custom_sql("warn:nps_below_rating_not_in_low_rating_table",
                     f"SELECT response_id FROM {FACT} WHERE is_low_rating = 1 AND in_low_rating_table = 0", table=FACT, severity="warn"),
        q.custom_sql("warn:nps_delivery_rated_more_than_once",
                     f"SELECT delivery_code, COUNT(*) FROM {FACT} WHERE delivery_code IS NOT NULL GROUP BY delivery_code HAVING COUNT(*) > 1",
                     table=FACT, severity="warn"),
        # every response whose company could not be found (order, delivery and company name all failed)
        q.custom_sql("warn:nps_company_unmatched", f"SELECT response_id, delivery_code FROM {FACT} WHERE CompanyKey = -1",
                     table=FACT, severity="warn"),
        # a response naming an order that is not in dim_sales_order (or is ambiguous across companies)
        q.custom_sql("warn:nps_order_unmatched",
                     f"SELECT response_id, order_ref FROM {FACT} WHERE order_ref IS NOT NULL AND SalesOrderKey = -1",
                     table=FACT, severity="warn"),
        # source rows that are not one of the 3 answers (comments and blanks: listed, never counted)
        q.custom_sql("warn:nps_rows_not_a_rating",
                     f"SELECT r.id FROM {RAW_FULL} r LEFT JOIN {FACT} f ON f.response_id = r.id "
                     "WHERE r._deleted_at IS NULL AND f.response_id IS NULL",
                     table=RAW_FULL, severity="warn"),
    ]
    for col, pct in MAX_FALLBACK_PCT.items():
        unknown = "'-1'" if col == "SalesTeamKey" else "-1"
        specs.append(q.custom_sql(
            f"warn:{FACT}.{col}_unknown_over_{pct:g}pct",
            f"SELECT SUM(CASE WHEN {col} = {unknown} THEN 1 ELSE 0 END), COUNT(*) FROM {FACT} "
            f"HAVING COUNT(*) > 0 AND 100.0 * SUM(CASE WHEN {col} = {unknown} THEN 1 ELSE 0 END) / COUNT(*) > {pct}",
            table=FACT, severity="warn"))
    return specs


def load_messages(conn, ctx: RunContext, now: _dt.datetime) -> dict[str, Any]:
    """fact_process_nps_message from the raw messages, in the load transaction (only when the source table was read)."""
    raw = pd.read_sql(text(f"SELECT * FROM {RAW_MSG} WHERE _deleted_at IS NULL"), conn)
    raw["create_date"] = pd.to_datetime(raw["create_date"])
    company_keys = {int(k) for (k,) in conn.execute(text("SELECT CompanyKey FROM dim_company"))}
    fact = wa.build_messages(raw, wa.ReachConfig.from_env(), ctx.config.business_timezone,
                             lambda name: tf.source_company(name, company_keys))
    keys = [int(v) for v in fact["MessageDateKey"].unique() if int(v) > 0]
    if keys:
        ensure_date_range(conn, _dt.date(min(keys) // 10000, min(keys) // 100 % 100, min(keys) % 100),
                          _dt.date(max(keys) // 10000, max(keys) // 100 % 100, max(keys) % 100))
    upsert(conn, FAILURE_GROUPS, wa.group_frame().assign(updated_at_utc=now))
    replace_all(conn, MSG_FACT, _stamped(fact, ctx, now))
    scope = fact[fact["in_reach_scope"] == 1]
    return {"messages": len(fact), "in_scope": len(scope), "by_box": scope["box"].value_counts().to_dict(),
            "states": fact["state"].value_counts().to_dict(), "error_groups": scope.loc[scope["box"] == "error", "failure_group"].value_counts().to_dict()}


def _message_checks() -> list[q.CheckSpec]:
    return [
        q.orphan(MSG_FACT, "CompanyKey", "dim_company", "CompanyKey", name=f"orphan:{MSG_FACT}.CompanyKey"),
        q.orphan(MSG_FACT, "MessageDateKey", "dim_date", "DateKey", name=f"orphan:{MSG_FACT}.MessageDateKey"),
        q.orphan(MSG_FACT, "failure_group", FAILURE_GROUPS, "failure_group", name=f"orphan:{MSG_FACT}.failure_group"),
        # a state that is none of delivered / read / sent / error: listed with its count, to be placed by the business
        q.custom_sql("warn:nps_message_other_state", f"SELECT state, COUNT(*) FROM {MSG_FACT} WHERE box = 'other' GROUP BY state",
                     table=MSG_FACT, severity="warn"),
        q.custom_sql("warn:nps_message_company_unmatched", f"SELECT message_id FROM {MSG_FACT} WHERE CompanyKey = -1",
                     table=MSG_FACT, severity="warn"),
    ]


def _stamped(df: pd.DataFrame, ctx: RunContext, now: _dt.datetime) -> pd.DataFrame:
    out = df.assign(loaded_at_utc=now, _run_id=ctx.run_uid)
    return out.astype(object).where(out.notna(), None)


def load_nps(ctx: RunContext) -> TaskResult:
    nps.validate_levels()
    with ctx.engine.connect() as conn:
        full = pd.read_sql(text(f"SELECT * FROM {RAW_FULL} WHERE _deleted_at IS NULL"), conn)
        low = pd.read_sql(text(f"SELECT id, team_branch FROM {RAW_LOW} WHERE _deleted_at IS NULL"), conn)
        maps = KeyMaps.load(conn)
        found = lookups(conn, {str(v).strip() for v in full["order_id"].dropna() if str(v).strip()},
                        {str(v).strip() for v in full["delivery_code"].dropna() if str(v).strip()})
    for col in ("create_date", "scheduled_date"):
        full[col] = pd.to_datetime(full[col])
    built = tf.build(full, low, maps, found, ctx.config.business_timezone)
    for key, ids in built.fallbacks.items():
        ctx.record_fallback(key, ids)
    if built.stats["low_rating_ids_not_in_full"]:
        notify("WARNING", f"NPS low_rating_data ids missing from nps_rating_full_data: {built.stats['low_rating_ids_not_in_full'][:10]}", job=ctx.job.name)
    now = _now()
    responses, comments = _stamped(built.responses, ctx, now), _stamped(built.comments, ctx, now)
    keys = [int(v) for c, df in (("RatingDateKey", responses), ("DeliveryDateKey", responses), ("CommentDateKey", comments))
            for v in df[c].unique() if int(v) > 0]
    with ctx.engine.begin() as conn:
        if keys:
            lo, hi = min(keys), max(keys)
            ensure_date_range(conn, _dt.date(lo // 10000, lo // 100 % 100, lo % 100), _dt.date(hi // 10000, hi // 100 % 100, hi % 100))
        upsert(conn, LEVELS, nps.level_frame().assign(updated_at_utc=now))
        replace_all(conn, FACT, responses)
        replace_all(conn, COMMENTS, comments)
        reach_stats = load_messages(conn, ctx, now) if ctx.state.get("reach_status") == "loaded" else None
        checks = _checks(now - _dt.timedelta(days=STALE_DAYS)) + (_message_checks() if reach_stats is not None else [])
        results = ctx.quality.evaluate(checks, conn, task_name="load_nps")
        q.raise_for_failures(results)  # rolls back the whole mart load
    details = {**built.stats, "responses_loaded": len(responses), "comments_loaded": len(comments),
               "reach": reach_stats or ctx.state.get("reach_status")}
    ctx.logger.info("NPS loaded: %s response(s) %s, NPS-style %s; %s comment(s); %s blank; company from %s",
                    len(responses), details["by_level"], details["nps_style"], len(comments), details["blank"], details["company_source"])
    return TaskResult(rows_loaded=len(responses) + len(comments), details=details)


# -- registration ----------------------------------------------------------------------------------------------------------
for table, model in ((RAW_FULL, SOURCE_FULL), (RAW_LOW, SOURCE_LOW)):
    REGISTRY.dataset(DatasetSpec(table, DEPARTMENT, "raw", "mysql", table, "upsert", ("id",), model=model))
REGISTRY.dataset(DatasetSpec(RAW_SYNC, DEPARTMENT, "raw", "mysql", RAW_SYNC, "replace", ("source",), model="sync_state"))
REGISTRY.dataset(DatasetSpec(LEVELS, DEPARTMENT, "mart", "sql", LEVELS, "upsert", ("nps_level",)))
for table, key in ((FACT, ("response_id",)), (COMMENTS, ("comment_id",))):
    REGISTRY.dataset(DatasetSpec(table, DEPARTMENT, "mart", "sql", table, "replace", key))
REGISTRY.dataset(DatasetSpec(RAW_MSG, DEPARTMENT, "raw", "mysql", RAW_MSG, "upsert", ("id",), model=wa.SOURCE_TABLE,
                             description="WhatsApp feedback messages; only with NPS_REACH_ENABLED and once the source table exists"))
REGISTRY.dataset(DatasetSpec(FAILURE_GROUPS, DEPARTMENT, "mart", "sql", FAILURE_GROUPS, "upsert", ("failure_group",)))
REGISTRY.dataset(DatasetSpec(MSG_FACT, DEPARTMENT, "mart", "sql", MSG_FACT, "replace", ("message_id",)))
REGISTRY.task(TaskSpec("extract_nps", extract_nps, datasets=(RAW_FULL, RAW_LOW, RAW_SYNC, RAW_MSG)))
REGISTRY.task(TaskSpec("load_nps", load_nps, depends_on=("extract_nps",), datasets=(LEVELS, FACT, COMMENTS, FAILURE_GROUPS, MSG_FACT)))
REGISTRY.job(JobSpec("process_nps", DEPARTMENT, tasks=("extract_nps", "load_nps"), depends_on_jobs=("core_dims",), mode="full",
                     disabled_reason=disabled_reason,
                     description="NPS Score: the NPS developer's MySQL (SSH tunnel) -> raw_nps_* -> NPS facts; nightly inside "
                                 "full_all after sales, every 3 h alone."))
