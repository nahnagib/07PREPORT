"""Engine creation and the server-side run lock."""

from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

# Upper bound on how long the lock holder's connection may sit idle: if the process is killed hard, MySQL
# reaps the connection (and releases the lock) after this, instead of after the OS keepalive (hours).
LOCK_SESSION_MAX_SECONDS = 2 * 60 * 60


class RunLockError(RuntimeError):
    """Another run holds the ETL lock."""


# SQLite (tests, local experiments) has no named locks; one process-wide lock per name stands in for GET_LOCK so
# the "second trigger is refused after the lock wait" behaviour is the same and can be tested.
_LOCAL_LOCKS: dict[str, threading.Lock] = {}
_LOCAL_LOCKS_GUARD = threading.Lock()


def _busy(name: str, timeout_seconds: int) -> RunLockError:
    return RunLockError(
        f"Could not acquire the ETL lock '{name}' within {timeout_seconds}s: another ETL run is writing "
        "to this database, so this trigger was skipped. Wait for it to finish (ETL Control Center) and try again."
    )


def create_platform_engine(database_url: str, session_timezone: str = "+00:00") -> Engine:
    connect_args = {}
    if database_url.startswith("mysql"):
        # Same as DatabaseExporter: CURRENT_TIMESTAMP / TIMESTAMP conversion must not depend on the server's
        # SYSTEM zone.
        connect_args["init_command"] = f"SET time_zone = '{session_timezone}'"
    return create_engine(database_url, pool_pre_ping=True, future=True, connect_args=connect_args)


@contextmanager
def run_lock(engine: Engine, name: str, timeout_seconds: int) -> Iterator[None]:
    """MySQL named lock held for a whole run (see DatabaseExporter._exclusive_run_lock for why a server-side
    lock rather than an in-process one). Other databases (SQLite in tests) get an in-process lock of the same name."""
    if engine.dialect.name != "mysql":
        with _LOCAL_LOCKS_GUARD:
            lock = _LOCAL_LOCKS.setdefault(name, threading.Lock())
        if not lock.acquire(timeout=timeout_seconds):
            raise _busy(name, timeout_seconds)
        try:
            yield
        finally:
            lock.release()
        return
    conn = engine.connect()
    try:
        conn.execute(text("SET SESSION wait_timeout = :t"), {"t": LOCK_SESSION_MAX_SECONDS})
        acquired = conn.execute(text("SELECT GET_LOCK(:name, :timeout)"), {"name": name, "timeout": timeout_seconds}).scalar_one()
        if acquired != 1:
            raise _busy(name, timeout_seconds)
        logger.info("Acquired ETL lock '%s'", name)
        try:
            yield
        finally:
            conn.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": name})
            logger.info("Released ETL lock '%s'", name)
    finally:
        conn.close()
