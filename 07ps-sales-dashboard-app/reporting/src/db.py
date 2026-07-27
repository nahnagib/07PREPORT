"""Database engine for the reporting pipeline.

Reuses the DB_* credentials already sitting in ../backend/.env (the same
MySQL instance the Node backend and the ETL connect to) instead of
introducing a second copy of the credentials. There is deliberately no
reporting/.env file.
"""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote_plus

from dotenv import dotenv_values
from sqlalchemy import Engine, create_engine

BACKEND_ENV_PATH = Path(__file__).resolve().parent.parent.parent / "backend" / ".env"

_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is not None:
        return _engine

    if not BACKEND_ENV_PATH.exists():
        raise RuntimeError(
            f"Expected DB credentials at {BACKEND_ENV_PATH}, but that file doesn't exist. "
            f"Copy backend/.env.example to backend/.env and fill in the DB_* values first "
            f"(this reporting pipeline reuses the backend's own DB config)."
        )

    env = dotenv_values(BACKEND_ENV_PATH)
    host = env.get("DB_HOST") or "localhost"
    port = env.get("DB_PORT") or "3306"
    user = env.get("DB_USER")
    password = env.get("DB_PASSWORD") or ""
    name = env.get("DB_NAME")
    socket = env.get("DB_SOCKET") or None

    if not user or not name:
        raise RuntimeError(
            f"backend/.env is missing DB_USER/DB_NAME. Cannot connect to the warehouse."
        )

    query = {}
    if socket:
        query["unix_socket"] = socket

    url = f"mysql+pymysql://{quote_plus(user)}:{quote_plus(password)}@{host}:{port}/{name}"
    _engine = create_engine(url, connect_args=query, pool_pre_ping=True)
    return _engine
