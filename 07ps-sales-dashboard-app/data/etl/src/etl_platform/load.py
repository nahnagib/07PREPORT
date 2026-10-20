"""Load patterns. All writes are transactional; table schemas are owned by migrations, never by pandas.

  upsert            INSERT ... ON DUPLICATE KEY UPDATE on the natural key (raw + core layers)
  upsert_changed /  the same, writing (and stamping updated_at_utc on) only new or changed rows; replace_changed also
  replace_changed   deletes rows that left the source. Both return a ChangeSet (shared lists -> incremental sales)
  snapshot_replace  DELETE the partition (e.g. snapshot_date) + INSERT, one transaction (snapshot facts)
  atomic_swap       load ``<t>__new`` (same DDL as ``<t>``), check it, then one RENAME TABLE (mart facts)
  insert_rows       plain INSERT (append-only tables)

Every function validates the DataFrame against the target table first (unknown columns, missing or NULL
key columns, duplicate keys) and raises ``LoadError`` with the offending names/values rather than letting
MySQL truncate or silently drop data.
"""

from __future__ import annotations

import datetime as _dt
import decimal
import hashlib
import json
import logging
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Sequence

import pandas as pd
from sqlalchemy import MetaData, Table, delete, text
from sqlalchemy.sql import sqltypes
from sqlalchemy.dialects import mysql as mysql_dialect
from sqlalchemy.dialects import sqlite as sqlite_dialect
from sqlalchemy.engine import Connection, Engine

logger = logging.getLogger(__name__)

NEW_SUFFIX = "__new"
OLD_SUFFIX = "__old"
MAX_IDENTIFIER = 64


class LoadError(ValueError):
    """The data does not fit the target table."""


# -- helpers --------------------------------------------------------------------------------------------
def reflect_table(conn: Connection, name: str) -> Table:
    md = MetaData()
    return Table(name, md, autoload_with=conn)


def _py(value: Any) -> Any:
    if value is None:
        return None
    if value is pd.NaT:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.to_pydatetime()
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            return value.item()
        except (ValueError, AttributeError):
            return value
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value


def records(df: pd.DataFrame, table: Table | None = None) -> list[dict[str, Any]]:
    """Rows as plain Python values. With ``table``, DATE/DATETIME columns are normalized from strings or
    Timestamps (e.g. values read back with pd.read_sql) so every dialect receives date/datetime objects."""
    cols = list(df.columns)
    converters: dict[str, Any] = {}
    if table is not None:
        for c in cols:
            if c not in table.columns:
                continue
            col_type = table.columns[c].type
            if isinstance(col_type, sqltypes.DateTime):
                converters[c] = _to_datetime
            elif isinstance(col_type, sqltypes.Date):
                converters[c] = _to_date
    out = []
    for row in df.itertuples(index=False, name=None):
        rec = {}
        for c, v in zip(cols, row):
            v = _py(v)
            rec[c] = converters[c](v) if c in converters and v is not None else v
        out.append(rec)
    return out


def _to_datetime(value: Any) -> Any:
    if isinstance(value, _dt.datetime):
        return value
    if isinstance(value, _dt.date):
        return _dt.datetime(value.year, value.month, value.day)
    return pd.Timestamp(value).to_pydatetime()


def _to_date(value: Any) -> Any:
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    return pd.Timestamp(value).date()


def _validate(table: Table, df: pd.DataFrame, key: Sequence[str]) -> None:
    table_cols = {c.name for c in table.columns}
    unknown = [c for c in df.columns if c not in table_cols]
    if unknown:
        raise LoadError(f"{table.name}: column(s) not in the table: {', '.join(map(str, unknown))}")
    missing_key = [k for k in key if k not in df.columns]
    if missing_key:
        raise LoadError(f"{table.name}: key column(s) missing from the data: {', '.join(missing_key)}")
    if key and len(df):
        null_key = df[list(key)].isna().any(axis=1)
        if null_key.any():
            raise LoadError(f"{table.name}: {int(null_key.sum())} row(s) with a NULL key in {', '.join(key)}")
        dup = df.duplicated(subset=list(key), keep=False)
        if dup.any():
            sample = df.loc[dup, list(key)].drop_duplicates().head(10).to_dict("records")
            raise LoadError(f"{table.name}: duplicate key value(s) in the data for {', '.join(key)}: {sample}")
    absent_required = [
        c.name for c in table.columns
        if not c.nullable and c.default is None and c.server_default is None and not _is_generated(c) and c.name not in df.columns
    ]
    if len(df) and absent_required:
        raise LoadError(f"{table.name}: NOT NULL column(s) missing from the data: {', '.join(absent_required)}")


def _is_generated(col: Any) -> bool:
    """A surrogate AUTO_INCREMENT primary key (meta tables only; warehouse keys are never generated)."""
    return bool(col.primary_key and col.autoincrement in (True, "auto") and len(col.table.primary_key.columns) == 1)


def _chunks(rows: list[dict[str, Any]], size: int) -> Iterable[list[dict[str, Any]]]:
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def _primary_key(table: Table) -> list[str]:
    return [c.name for c in table.primary_key.columns]


# -- upsert -------------------------------------------------------------------------------------------------
def upsert(
    conn: Connection, table_name: str, df: pd.DataFrame, *, key: Sequence[str] | None = None,
    update_columns: Sequence[str] | None = None, chunk_size: int = 1000,
) -> int:
    """Inserts new rows and updates existing ones, matched on ``key`` (default: the table's primary key,
    which must be the natural key). Columns not in ``df`` are left untouched on update. Returns rows sent."""
    table = reflect_table(conn, table_name)
    pk = _primary_key(table)
    key = list(key or pk)
    if not key:
        raise LoadError(f"{table_name}: no key given and the table has no primary key")
    if set(key) != set(pk):
        raise LoadError(f"{table_name}: upsert key {key} must equal the table's primary key {pk} (the natural key)")
    _validate(table, df, key)
    if df.empty:
        return 0
    cols = list(df.columns)
    updates = [c for c in (update_columns or cols) if c not in key]
    rows = records(df, table)
    dialect = conn.dialect.name
    for chunk in _chunks(rows, chunk_size):
        if dialect == "mysql":
            stmt = mysql_dialect.insert(table).values(chunk)
            stmt = stmt.on_duplicate_key_update({c: stmt.inserted[c] for c in updates}) if updates else stmt.prefix_with("IGNORE")
        elif dialect == "sqlite":
            stmt = sqlite_dialect.insert(table).values(chunk)
            stmt = stmt.on_conflict_do_update(index_elements=key, set_={c: stmt.excluded[c] for c in updates}) if updates else stmt.on_conflict_do_nothing(index_elements=key)
        else:
            raise LoadError(f"upsert is not implemented for dialect '{dialect}'")
        conn.execute(stmt)
    return len(rows)


# -- plain insert --------------------------------------------------------------------------------------------
def insert_rows(conn: Connection, table_name: str, df: pd.DataFrame, *, chunk_size: int = 1000) -> int:
    table = reflect_table(conn, table_name)
    _validate(table, df, _primary_key(table) if all(k in df.columns for k in _primary_key(table)) else [])
    if df.empty:
        return 0
    rows = records(df, table)
    for chunk in _chunks(rows, chunk_size):
        conn.execute(table.insert(), chunk)
    return len(rows)


# -- replace all -----------------------------------------------------------------------------------------------
def replace_all(conn: Connection, table_name: str, df: pd.DataFrame, *, chunk_size: int = 1000) -> tuple[int, int]:
    """DELETE every row + INSERT ``df`` on ``conn`` (one transaction when called inside ``engine.begin()``).
    For small tables that must mirror their source exactly: maps derived from Excel, raw copies of a sheet.
    Returns (rows deleted, rows inserted)."""
    table = reflect_table(conn, table_name)
    _validate(table, df, _primary_key(table))
    deleted = conn.execute(delete(table)).rowcount or 0
    rows = records(df, table)
    for chunk in _chunks(rows, chunk_size):
        conn.execute(table.insert(), chunk)
    return deleted, len(rows)


# -- change-detecting writes (Phase B: the shared lists tell the incremental sales step what changed) -------------
DEFAULT_STAMP = "updated_at_utc"
MAX_KEYS_IN_DETAILS = 5000


@dataclass
class ChangeSet:
    """What a change-detecting write did to one table. Keys are tuples in the table's primary-key order."""

    table: str
    inserted: list[tuple] = field(default_factory=list)
    updated: list[tuple] = field(default_factory=list)
    deleted: list[tuple] = field(default_factory=list)
    unchanged: int = 0

    @property
    def written(self) -> int:
        return len(self.inserted) + len(self.updated)

    @property
    def changed_keys(self) -> list[tuple]:
        return [*self.inserted, *self.updated, *self.deleted]

    def summary(self) -> dict[str, Any]:
        """For etl_task_log.details. Deleted keys are listed (capped): a deleted row cannot be found later by its
        updated_at_utc, so the incremental sales step reads them from here."""
        out: dict[str, Any] = {"inserted": len(self.inserted), "updated": len(self.updated), "deleted": len(self.deleted),
                               "unchanged": self.unchanged}
        if self.deleted:
            out["deleted_keys"] = [list(k) for k in self.deleted[:MAX_KEYS_IN_DETAILS]]
            out["deleted_keys_truncated"] = len(self.deleted) > MAX_KEYS_IN_DETAILS
        return out


def _norm(value: Any) -> Any:
    """A comparable, JSON-able form of one cell, the same for a DataFrame value and the value read back from the DB."""
    value = _py(value)
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, decimal.Decimal):
        value = float(value)
    if isinstance(value, float):
        if value.is_integer():
            return int(value)
        return round(value, 9)
    if isinstance(value, _dt.datetime):
        return value.replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")
    if isinstance(value, _dt.date):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return value.hex()
    return value


def _content_hash(values: Sequence[Any]) -> str:
    return hashlib.sha1(json.dumps([_norm(v) for v in values], default=str, ensure_ascii=False).encode("utf-8")).hexdigest()


def _key_of(values: Sequence[Any]) -> tuple:
    return tuple(_norm(v) for v in values)


def _diff(conn: Connection, table: Table, df: pd.DataFrame, key: list[str], compare: list[str]) -> tuple[pd.Series, list[tuple], set[tuple], list[tuple]]:
    """(mask of df rows that are new or changed, their keys, keys of new rows, keys in the table but not in df)."""
    stored = {}
    sel = text(f"SELECT {', '.join(conn.dialect.identifier_preparer.quote(c) for c in [*key, *compare])} "
               f"FROM {conn.dialect.identifier_preparer.quote(table.name)}")
    typed = records(df[[*key, *compare]], table)
    for row in conn.execute(sel):
        stored[_key_of(row[:len(key)])] = _content_hash(row[len(key):])
    mask, keys, new = [], [], set()
    seen = set()
    for rec in typed:
        k = _key_of([rec[c] for c in key])
        seen.add(k)
        old = stored.get(k)
        changed = old is None or old != _content_hash([rec[c] for c in compare])
        mask.append(changed)
        if changed:
            keys.append(k)
            if old is None:
                new.add(k)
    missing = [k for k in stored if k not in seen]
    return pd.Series(mask, index=df.index), keys, new, missing


def upsert_changed(
    conn: Connection, table_name: str, df: pd.DataFrame, *, compare_columns: Sequence[str] | None = None,
    update_columns: Sequence[str] | None = None, stamp_column: str | None = DEFAULT_STAMP, now: _dt.datetime | None = None,
) -> ChangeSet:
    """``upsert`` that writes only the rows that are new or whose ``compare_columns`` differ from the stored row (default:
    every column of ``df`` except the key and the stamp). Only those rows get ``stamp_column`` = now, so the stamp means
    "this record really changed then". Rows absent from ``df`` are left alone (not deleted)."""
    table = reflect_table(conn, table_name)
    key = _primary_key(table)
    stamp = stamp_column if stamp_column and stamp_column in table.columns else None
    now = now or _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
    if stamp:
        df = df.assign(**{stamp: now})  # the stamp may be NOT NULL; it is never compared
    _validate(table, df, key)
    compare = [c for c in (compare_columns or [c for c in (update_columns or df.columns)]) if c not in key and c != stamp]
    out = ChangeSet(table_name)
    if df.empty:
        return out
    mask, keys, new, _ = _diff(conn, table, df, key, compare)
    out.unchanged = int((~mask).sum())
    out.inserted = [k for k in keys if k in new]
    out.updated = [k for k in keys if k not in new]
    if keys:
        changed = df.loc[mask].copy()
        cols = [*(update_columns or [c for c in changed.columns if c not in key]), *([stamp] if stamp else [])]
        upsert(conn, table_name, changed, update_columns=list(dict.fromkeys(cols)))
    return out


def replace_changed(
    conn: Connection, table_name: str, df: pd.DataFrame, *, stamp_column: str | None = DEFAULT_STAMP,
    now: _dt.datetime | None = None,
) -> ChangeSet:
    """Same final content as ``replace_all`` (the table mirrors ``df``), but written as a diff: rows no longer in ``df``
    are deleted (their keys are reported), new / changed rows are upserted and stamped, unchanged rows keep their stamp."""
    table = reflect_table(conn, table_name)
    key = _primary_key(table)
    stamp = stamp_column if stamp_column and stamp_column in table.columns else None
    now = now or _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
    if stamp:
        df = df.assign(**{stamp: now})
    _validate(table, df, key)
    compare = [c for c in df.columns if c not in key and c != stamp]
    out = ChangeSet(table_name)
    if df.empty:
        mask, keys, new = pd.Series([], dtype=bool), [], set()
        missing = [_key_of(r) for r in conn.execute(text(
            f"SELECT {', '.join(conn.dialect.identifier_preparer.quote(c) for c in key)} FROM {conn.dialect.identifier_preparer.quote(table_name)}"))]
    else:
        mask, keys, new, missing = _diff(conn, table, df, key, compare)
    for chunk in _chunks(missing, 500):
        cond = None
        for k in chunk:
            one = None
            for col, v in zip(key, k):
                part = table.c[col] == v
                one = part if one is None else (one & part)
            cond = one if cond is None else (cond | one)
        conn.execute(delete(table).where(cond))
    out.deleted = list(missing)
    out.unchanged = int((~mask).sum()) if len(mask) else 0
    out.inserted = [k for k in keys if k in new]
    out.updated = [k for k in keys if k not in new]
    if keys:
        changed = df.loc[mask].copy()
        upsert(conn, table_name, changed)
    return out


# -- snapshot replace ------------------------------------------------------------------------------------------
def snapshot_replace(conn: Connection, table_name: str, df: pd.DataFrame, partition: Mapping[str, Any], *, chunk_size: int = 1000) -> tuple[int, int]:
    """Replaces exactly one partition (e.g. ``{"snapshot_date": date}``): DELETE + INSERT on ``conn``.
    Call it inside a transaction (``engine.begin()``) so a failed check afterwards rolls both back.
    Returns (rows deleted, rows inserted)."""
    if not partition:
        raise LoadError("snapshot_replace needs at least one partition column")
    table = reflect_table(conn, table_name)
    for col, value in partition.items():
        if col not in table.columns:
            raise LoadError(f"{table_name}: partition column '{col}' not in the table")
        if col in df.columns and len(df):
            values = {(_py(v).date() if isinstance(_py(v), _dt.datetime) else _py(v)) for v in df[col].unique()}
            expected = value.date() if isinstance(value, _dt.datetime) else value
            if values != {expected}:
                raise LoadError(f"{table_name}: data contains {col} values {sorted(map(str, values))[:5]} outside partition {expected}")
    if len(df):
        df = df.copy()
        for col, value in partition.items():
            df[col] = value
    _validate(table, df, _primary_key(table))
    cond = [table.c[col] == value for col, value in partition.items()]
    deleted = conn.execute(delete(table).where(*cond)).rowcount or 0
    inserted = 0
    if len(df):
        rows = records(df, table)
        for chunk in _chunks(rows, chunk_size):
            conn.execute(table.insert(), chunk)
        inserted = len(rows)
    return deleted, inserted


# -- atomic swap --------------------------------------------------------------------------------------------
def _staging_names(table_name: str) -> tuple[str, str]:
    new, old = f"{table_name}{NEW_SUFFIX}", f"{table_name}{OLD_SUFFIX}"
    if len(old) > MAX_IDENTIFIER:
        raise LoadError(f"Table name '{table_name}' is too long for swap staging names (max {MAX_IDENTIFIER - len(OLD_SUFFIX)} chars)")
    return new, old


def atomic_swap(
    engine: Engine, table_name: str, df: pd.DataFrame, *, chunk_size: int = 2000,
    before_swap: Callable[[Connection, str], None] | None = None,
) -> int:
    """Rebuilds ``table_name`` without readers ever seeing a partial table.

    1. ``<t>__new`` is created with the exact DDL of ``<t>`` (MySQL ``CREATE TABLE ... LIKE``: same keys,
       indexes, charset) and loaded.
    2. ``before_swap(conn, "<t>__new")`` runs checks against the staged table; raising aborts the swap and
       leaves ``<t>`` untouched.
    3. One ``RENAME TABLE t TO t__old, t__new TO t`` (atomic in MySQL), then ``t__old`` is dropped.
    """
    new, old = _staging_names(table_name)
    dialect = engine.dialect.name
    with engine.connect() as conn:
        q = conn.dialect.identifier_preparer.quote
        target = reflect_table(conn, table_name)
        _validate(target, df, _primary_key(target))
        conn.execute(text(f"DROP TABLE IF EXISTS {q(new)}"))
        conn.execute(text(f"DROP TABLE IF EXISTS {q(old)}"))
        if dialect == "mysql":
            conn.execute(text(f"CREATE TABLE {q(new)} LIKE {q(table_name)}"))
        else:
            copy_md = MetaData()
            target.to_metadata(copy_md, name=new).create(conn)
        conn.commit()
    try:
        with engine.begin() as conn:
            staged = reflect_table(conn, new)
            rows = records(df, staged)
            for chunk in _chunks(rows, chunk_size):
                conn.execute(staged.insert(), chunk)
        if before_swap is not None:
            with engine.connect() as conn:
                before_swap(conn, new)
        with engine.begin() as conn:
            q = conn.dialect.identifier_preparer.quote
            if dialect == "mysql":
                conn.execute(text(f"RENAME TABLE {q(table_name)} TO {q(old)}, {q(new)} TO {q(table_name)}"))
            else:  # SQLite DDL is transactional, so this pair is atomic too
                conn.execute(text(f"ALTER TABLE {q(table_name)} RENAME TO {q(old)}"))
                conn.execute(text(f"ALTER TABLE {q(new)} RENAME TO {q(table_name)}"))
            conn.execute(text(f"DROP TABLE {q(old)}"))
    except Exception:
        with engine.begin() as conn:
            conn.execute(text(f"DROP TABLE IF EXISTS {conn.dialect.identifier_preparer.quote(new)}"))
        raise
    logger.info("Swapped %s: %s row(s)", table_name, f"{len(df):,}")
    return len(df)


def atomic_swap_many(
    engine: Engine, frames: Mapping[str, pd.DataFrame], *, chunk_size: int = 2000,
    before_swap: Callable[[Connection, Mapping[str, str]], None] | None = None,
) -> dict[str, int]:
    """atomic_swap for several tables at once: every ``<t>__new`` is created and loaded, ``before_swap(conn,
    {table: staged_table})`` checks them together, then ONE ``RENAME TABLE`` swaps all of them (MySQL renames the
    whole list atomically). Any failure leaves every live table untouched and removes the staged tables."""
    dialect = engine.dialect.name
    names = {t: _staging_names(t) for t in frames}
    try:
        for table, df in frames.items():
            new, old = names[table]
            with engine.connect() as conn:
                q = conn.dialect.identifier_preparer.quote
                target = reflect_table(conn, table)
                _validate(target, df, _primary_key(target))
                conn.execute(text(f"DROP TABLE IF EXISTS {q(new)}"))
                conn.execute(text(f"DROP TABLE IF EXISTS {q(old)}"))
                if dialect == "mysql":
                    conn.execute(text(f"CREATE TABLE {q(new)} LIKE {q(table)}"))
                else:
                    target.to_metadata(MetaData(), name=new).create(conn)
                conn.commit()
            with engine.begin() as conn:
                staged = reflect_table(conn, new)
                for chunk in _chunks(records(df, staged), chunk_size):
                    conn.execute(staged.insert(), chunk)
        if before_swap is not None:
            with engine.connect() as conn:
                before_swap(conn, {t: n for t, (n, _) in names.items()})
        with engine.begin() as conn:
            q = conn.dialect.identifier_preparer.quote
            if dialect == "mysql":
                pairs = []
                for table, (new, old) in names.items():
                    pairs += [f"{q(table)} TO {q(old)}", f"{q(new)} TO {q(table)}"]
                conn.execute(text("RENAME TABLE " + ", ".join(pairs)))
            else:
                for table, (new, old) in names.items():
                    conn.execute(text(f"ALTER TABLE {q(table)} RENAME TO {q(old)}"))
                    conn.execute(text(f"ALTER TABLE {q(new)} RENAME TO {q(table)}"))
            for table, (_, old) in names.items():
                conn.execute(text(f"DROP TABLE {q(old)}"))
    except Exception:
        with engine.begin() as conn:
            q = conn.dialect.identifier_preparer.quote
            for new, _ in names.values():
                conn.execute(text(f"DROP TABLE IF EXISTS {q(new)}"))
        raise
    logger.info("Swapped %s table(s) in one rename: %s", len(frames), ", ".join(f"{t}={len(df):,}" for t, df in frames.items()))
    return {t: len(df) for t, df in frames.items()}
