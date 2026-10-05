"""Generic Odoo -> raw_odoo_* extraction, used by core and every department.

A ``RawOdooSpec`` lists the Odoo fields and the raw columns they land in. ``extract_odoo_raw``:
  * full extract on the first run, with --full, or for non-incremental specs;
  * otherwise incremental on write_date (watermark - overlap), paged by (write_date, id);
  * upserts by id and saves the new watermark in the SAME transaction (a failed load never moves it);
  * once a day (or on --full) reconciles ids: rows whose record no longer exists in Odoo get _deleted_at,
    rows that reappear get it cleared. Raw rows are never deleted.
Missing Odoo fields are skipped with a warning (their columns stay NULL), never a failure.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

import pandas as pd
from sqlalchemy import text

from etl_platform.load import upsert
from etl_platform.runner import RunContext, TaskResult
from etl_platform.sources.odoo import m2o_id, m2o_name
from etl_platform.watermark import Watermark, advance, incremental_since, parse_odoo_datetime

RECONCILE_EVERY = _dt.timedelta(hours=20)
META_COLUMNS = ("_extracted_at", "_run_id", "_source_write_date", "_deleted_at")


@dataclass(frozen=True)
class RawField:
    column: str
    odoo: str
    kind: str = "plain"  # plain | m2o_id | m2o_name | bool | float | int | datetime


@dataclass(frozen=True)
class RawOdooSpec:
    dataset: str
    model: str
    table: str
    fields: tuple[RawField, ...]
    domain: tuple[Any, ...] = ()
    incremental: bool = True
    include_archived: bool = True
    profile: str = "default"

    @property
    def odoo_fields(self) -> list[str]:
        return list(dict.fromkeys(["id", "write_date", *(f.odoo for f in self.fields)]))


def _convert(value: Any, kind: str) -> Any:
    if kind == "m2o_id":
        return m2o_id(value)
    if kind == "m2o_name":
        return m2o_name(value)
    if value is False or value is None:
        return False if kind == "bool" else None
    if kind == "bool":
        return bool(value)
    if kind == "float":
        return float(value)
    if kind == "int":
        return int(value)
    if kind == "datetime":
        return parse_odoo_datetime(value)
    return value


def records_to_frame(records: Sequence[dict[str, Any]], spec: RawOdooSpec, *, run_uid: str, extracted_at: _dt.datetime,
                     available: Iterable[str] | None = None) -> pd.DataFrame:
    """Pure: Odoo records -> raw table rows (columns in spec order + meta columns)."""
    present = set(available) if available is not None else None
    rows = []
    for rec in records:
        row = {"id": int(rec["id"])}
        for f in spec.fields:
            if f.column == "id":
                continue
            row[f.column] = _convert(rec.get(f.odoo), f.kind) if present is None or f.odoo in present else None
        row["_extracted_at"] = extracted_at
        row["_run_id"] = run_uid
        row["_source_write_date"] = parse_odoo_datetime(rec.get("write_date"))
        row["_deleted_at"] = None
        rows.append(row)
    columns = ["id", *[f.column for f in spec.fields if f.column != "id"], *META_COLUMNS]
    return pd.DataFrame(rows, columns=columns)


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


def extract_odoo_raw(ctx: RunContext, spec: RawOdooSpec) -> TaskResult:
    source = ctx.odoo(spec.profile)
    fields, skipped = source.available_fields(spec.model, spec.odoo_fields)
    before = ctx.watermarks.get(spec.dataset)
    full = ctx.full_refresh or not spec.incremental or before.is_empty
    if spec.incremental:
        since = None if full else incremental_since(before, ctx.config.incremental_overlap_seconds)
        records = source.search_read_incremental(spec.model, spec.domain, fields, since=since, include_archived=spec.include_archived)
    else:
        records = source.search_read_all(spec.model, spec.domain, fields, include_archived=spec.include_archived)
    df = records_to_frame(records, spec, run_uid=ctx.run_uid, extracted_at=_now(), available=fields)
    after = advance(Watermark(spec.dataset, last_full_refresh=before.last_full_refresh, last_reconciled=before.last_reconciled) if full else before, records)
    with ctx.engine.begin() as conn:
        loaded = upsert(conn, spec.table, df)
        ctx.watermarks.save(after, run_uid=ctx.run_uid, conn=conn, full_refresh=full)
    ctx.record_watermark(spec.dataset, before, after)

    details: dict[str, Any] = {"mode": "full" if full else "incremental", "skipped_fields": skipped}
    due = full or before.last_reconciled is None or _now() - before.last_reconciled >= RECONCILE_EVERY
    if due:
        details["reconciliation"] = reconcile_ids(ctx, spec, source)
    ctx.logger.info("%s: %s record(s) %s; %s", spec.dataset, f"{len(records):,}", details["mode"], details.get("reconciliation", "no reconciliation due"))
    return TaskResult(rows_extracted=len(records), rows_loaded=loaded, details=details)


def reconcile_ids(ctx: RunContext, spec: RawOdooSpec, source) -> dict[str, int]:
    """Marks raw rows whose Odoo record is gone (_deleted_at) and clears the mark on rows that reappear."""
    live = set(source.search_ids(spec.model, spec.domain, include_archived=True))
    q = ctx.engine.dialect.identifier_preparer.quote
    now = _now()
    with ctx.engine.begin() as conn:
        rows = conn.execute(text(f"SELECT id, _deleted_at FROM {q(spec.table)}")).fetchall()
        gone = [r[0] for r in rows if r[0] not in live and r[1] is None]
        back = [r[0] for r in rows if r[0] in live and r[1] is not None]
        for chunk_start in range(0, len(gone), 500):
            chunk = gone[chunk_start:chunk_start + 500]
            conn.execute(text(f"UPDATE {q(spec.table)} SET _deleted_at = :now WHERE id IN ({','.join(str(int(i)) for i in chunk)})"), {"now": now})
        for chunk_start in range(0, len(back), 500):
            chunk = back[chunk_start:chunk_start + 500]
            conn.execute(text(f"UPDATE {q(spec.table)} SET _deleted_at = NULL WHERE id IN ({','.join(str(int(i)) for i in chunk)})"))
        wm = ctx.watermarks.get(spec.dataset, conn=conn)
        ctx.watermarks.save(wm, run_uid=ctx.run_uid, conn=conn, reconciled=True)
    if gone:
        ctx.logger.warning("%s: %s record(s) no longer exist in Odoo (marked _deleted_at), e.g. %s", spec.dataset, len(gone), gone[:10])
    return {"odoo_ids": len(live), "marked_deleted": len(gone), "reappeared": len(back)}
