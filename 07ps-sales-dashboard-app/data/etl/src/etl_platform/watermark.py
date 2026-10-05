"""Incremental extraction state per dataset (``etl_watermark``).

A watermark is the (write_date, id) of the last source record loaded. The next extraction reads records with
``write_date >= watermark - overlap`` (sources/odoo.py pages them in id order), so records sharing the
watermark's second are never skipped -- Odoo returns write_date truncated to the second -- and a write_date
stamped by a long transaction that committed late is re-read. Raw tables are upserted by source id, so
re-reading is harmless.

The watermark is advanced in the same transaction that upserts the raw rows (``save(conn=...)``): a failed
load never moves it.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from sqlalchemy import select
from sqlalchemy.engine import Connection, Engine

from etl_platform.meta import etl_watermark

ODOO_DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S"


@dataclass(frozen=True)
class Watermark:
    dataset: str
    write_date: _dt.datetime | None = None  # naive UTC, as Odoo stores it
    last_id: int | None = None
    last_full_refresh: _dt.datetime | None = None
    last_reconciled: _dt.datetime | None = None

    @property
    def is_empty(self) -> bool:
        return self.write_date is None

    def as_dict(self) -> dict[str, Any]:
        return {
            "write_date": self.write_date.strftime(ODOO_DATETIME_FORMAT) if self.write_date else None,
            "last_id": self.last_id,
        }


def parse_odoo_datetime(value: Any) -> _dt.datetime | None:
    if value in (None, False, ""):
        return None
    if isinstance(value, _dt.datetime):
        return value.replace(tzinfo=None) if value.tzinfo is None else value.astimezone(_dt.timezone.utc).replace(tzinfo=None)
    text = str(value).strip()
    for fmt in (ODOO_DATETIME_FORMAT, "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return _dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise ValueError(f"Unrecognised Odoo datetime: {value!r}")


def incremental_since(wm: Watermark, overlap_seconds: int) -> _dt.datetime | None:
    """The lower bound to extract from, or None for a full extraction."""
    if wm.is_empty:
        return None
    return wm.write_date - _dt.timedelta(seconds=max(0, overlap_seconds))


def advance(wm: Watermark, rows: Iterable[Mapping[str, Any]], field: str = "write_date") -> Watermark:
    """The watermark after loading ``rows``: the maximum (write_date, id) seen, never moving backwards."""
    best: tuple[_dt.datetime, int] | None = (wm.write_date, wm.last_id or 0) if wm.write_date else None
    for row in rows:
        wd = parse_odoo_datetime(row.get(field))
        if wd is None:
            continue
        rid = int(row.get("id") or 0)
        if best is None or (wd, rid) > best:
            best = (wd, rid)
    if best is None:
        return wm
    return Watermark(wm.dataset, best[0], best[1], wm.last_full_refresh, wm.last_reconciled)


class WatermarkStore:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def get(self, dataset: str, conn: Connection | None = None) -> Watermark:
        def _read(c: Connection) -> Watermark:
            row = c.execute(select(etl_watermark).where(etl_watermark.c.dataset == dataset)).mappings().first()
            if row is None:
                return Watermark(dataset)
            return Watermark(dataset, row["last_write_date_utc"], row["last_id"], row["last_full_refresh_utc"], row["last_reconciled_utc"])

        if conn is not None:
            return _read(conn)
        with self.engine.connect() as c:
            return _read(c)

    def save(self, wm: Watermark, *, run_uid: str | None, conn: Connection, full_refresh: bool = False, reconciled: bool = False) -> Watermark:
        """Writes ``wm`` on ``conn`` (the caller's load transaction)."""
        now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
        values = {
            "last_write_date_utc": wm.write_date,
            "last_id": wm.last_id,
            "updated_at_utc": now,
            "updated_by_run_uid": run_uid,
            "last_full_refresh_utc": now if full_refresh else wm.last_full_refresh,
            "last_reconciled_utc": now if reconciled else wm.last_reconciled,
        }
        updated = conn.execute(etl_watermark.update().where(etl_watermark.c.dataset == wm.dataset).values(**values)).rowcount
        if not updated:
            conn.execute(etl_watermark.insert().values(dataset=wm.dataset, **values))
        return Watermark(wm.dataset, wm.write_date, wm.last_id, values["last_full_refresh_utc"], values["last_reconciled_utc"])

    def reset(self, dataset: str, *, conn: Connection) -> None:
        """Forgets the watermark so the next run extracts everything (``--full``)."""
        conn.execute(etl_watermark.delete().where(etl_watermark.c.dataset == dataset))
