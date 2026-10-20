"""Platform settings, read from the environment once per run.

Database connection settings are taken from ``config.settings.Settings`` (the same DB_* / DB_URL variables
the sales pipeline already uses) so there is exactly one place that builds the SQLAlchemy URL. Everything
else here is new and platform-specific. Secrets (DB password, Odoo API keys) are never stored on this object
except inside ``database_url``, which is excluded from ``repr``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from config.settings import Settings


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _csv_env(name: str, default: str = "") -> tuple[str, ...]:
    raw = os.getenv(name, default)
    return tuple(part.strip().lower() for part in raw.split(",") if part.strip())


def _text_csv_env(name: str, default: str = "") -> tuple[str, ...]:
    raw = os.getenv(name, default)
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _int_csv_env(name: str, default: str = "") -> tuple[int, ...]:
    values = []
    for part in os.getenv(name, default).split(","):
        part = part.strip()
        if part:
            values.append(int(part))
    return tuple(values)


@dataclass(frozen=True)
class PlatformConfig:
    database_url: str = field(repr=False)
    db_session_timezone: str = "+00:00"
    business_timezone: str = "Africa/Tripoli"
    input_dir: Path = Path(".")
    db_chunksize: int = 5000

    odoo_url: str = ""
    odoo_db: str = ""
    # Production guard (sources/odoo.py): refuse to run unless ODOO_DB == ODOO_PROD_DB and the host of
    # ODOO_URL is in ODOO_ALLOWED_HOSTS. ALLOW_NON_PROD=1 overrides both.
    odoo_prod_db: str = ""
    odoo_allowed_hosts: tuple[str, ...] = ()
    allow_non_prod: bool = False
    odoo_company_ids: tuple[int, ...] = ()
    # Optional names resolved against res.company at runtime, then unioned with ODOO_COMPANY_IDS.
    # Useful when access to a new company is granted before its numeric Odoo id is known locally.
    odoo_company_names: tuple[str, ...] = ()
    odoo_timeout_seconds: int = 60
    odoo_max_retries: int = 5
    odoo_connect_retry_window_seconds: float = 900.0
    odoo_page_size: int = 2000
    odoo_id_chunk_size: int = 500
    # Incremental extraction re-reads this many seconds before the stored write_date watermark: Odoo stamps
    # write_date at transaction start, so a long transaction can commit a write_date older than records
    # already extracted. Re-reading is harmless because raw tables are upserted by source id.
    incremental_overlap_seconds: int = 300
    key_expiry_warn_days: int = 14
    # Finance: Odoo partner ids whose receivables are inter-company balances although they are not one of our own
    # companies' partners (e.g. "مديونية شركة تيكا" 15907, "مديونية مجال" 15905). FINANCE_INTERCOMPANY_PARTNER_IDS.
    finance_intercompany_partner_ids: tuple[int, ...] = ()

    # Same MySQL named lock as the legacy pipeline (DatabaseExporter.PIPELINE_LOCK_NAME), so a legacy run and
    # a platform run can never write at the same time while both exist.
    lock_name: str = "sales_pipeline_full_load"
    lock_timeout_seconds: int = 30
    # A department job skips its core_dims dependency when core_dims succeeded this recently. 0 (the default since the
    # 30-minute refresh) = core_dims runs every time: it is incremental, so a cycle with no Odoo change costs seconds.
    core_dims_fresh_minutes: int = 0
    # The modules the 30-minute refresh job (refresh_30m) runs, in this order of preference; a module that is not
    # registered in this build (process_nps before the NPS branch is merged) is skipped with a log line.
    refresh_modules: tuple[str, ...] = ("core_dims", "finance_receivables", "process_nps")

    @classmethod
    def from_env(cls, env_file: str | Path | None = None) -> "PlatformConfig":
        settings = Settings.from_env(env_file)  # also loads the .env file
        return cls(
            database_url=settings.sqlalchemy_url,
            db_session_timezone=settings.db_session_timezone,
            business_timezone=settings.timezone,
            input_dir=settings.input_dir,
            db_chunksize=settings.db_chunksize,
            odoo_url=settings.odoo_url,
            odoo_db=settings.odoo_db,
            odoo_prod_db=os.getenv("ODOO_PROD_DB", "").strip(),
            odoo_allowed_hosts=_csv_env("ODOO_ALLOWED_HOSTS"),
            allow_non_prod=_bool_env("ALLOW_NON_PROD", False),
            odoo_company_ids=_int_csv_env("ODOO_COMPANY_IDS"),
            odoo_company_names=_text_csv_env("ODOO_COMPANY_NAMES"),
            odoo_timeout_seconds=settings.rpc_timeout_seconds,
            odoo_max_retries=int(os.getenv("ETL_ODOO_MAX_RETRIES", "5")),
            odoo_connect_retry_window_seconds=settings.odoo_connect_retry_window_seconds,
            odoo_page_size=int(os.getenv("ETL_ODOO_PAGE_SIZE", "2000")),
            odoo_id_chunk_size=int(os.getenv("ETL_ODOO_ID_CHUNK_SIZE", "500")),
            incremental_overlap_seconds=int(os.getenv("ETL_INCREMENTAL_OVERLAP_SECONDS", "300")),
            key_expiry_warn_days=int(os.getenv("ETL_KEY_EXPIRY_WARN_DAYS", "14")),
            finance_intercompany_partner_ids=_int_csv_env("FINANCE_INTERCOMPANY_PARTNER_IDS"),
            lock_name=os.getenv("ETL_LOCK_NAME", "sales_pipeline_full_load"),
            lock_timeout_seconds=int(os.getenv("ETL_LOCK_TIMEOUT_SECONDS", "30")),
            core_dims_fresh_minutes=int(os.getenv("ETL_CORE_DIMS_FRESH_MINUTES", "0")),
            refresh_modules=_csv_env("ETL_REFRESH_MODULES", "core_dims,finance_receivables,process_nps"),
        )
