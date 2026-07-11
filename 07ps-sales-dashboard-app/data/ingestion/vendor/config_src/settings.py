from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class Settings:
    odoo_url: str
    odoo_db: str
    odoo_user: str
    odoo_api_key: str
    input_dir: Path
    output_dir: Path
    output_file: str
    batch_size: int
    timezone: str
    assume_utc_for_naive: bool
    inventory_validation_file: str = "Inventory_Validation.xlsx"
    unmapped_products_file: str = "Unmapped_Products.xlsx"
    crm_inactive_days_threshold: int = 30
    crm_recent_activity_days: int = 14
    db_type: str = "mysql"
    db_host: str = "localhost"
    db_port: int = 3306
    db_name: str = "powerbi_sales"
    db_user: str = ""
    db_password: str = ""
    db_schema: str | None = None
    db_url: str = ""
    db_reload_mode: str = "drop_recreate"
    db_chunksize: int = 5000
    incremental_overlap_days: int = 7
    rpc_timeout_seconds: int = 60
    max_retries: int = 5
    include_uninvoiced_sales_lines: bool = False
    force_sales_full_refresh: bool = False

    @property
    def output_path(self) -> Path:
        return self.output_dir / self.output_file

    @property
    def inventory_validation_path(self) -> Path:
        return self.output_dir / self.inventory_validation_file

    @property
    def unmapped_products_path(self) -> Path:
        return self.output_dir / self.unmapped_products_file

    @property
    def targets_path(self) -> Path:
        return self.input_dir / "sales_targets.xlsx"

    @property
    def sales_team_path(self) -> Path:
        return self.input_dir / "SalesTeam.xlsx"

    @property
    def offdays_path(self) -> Path:
        return self.input_dir / "OffDays.xlsx"

    @property
    def products_path(self) -> Path:
        return self.input_dir / "PRODUCTS.xlsx"

    @property
    def blocked_customers_path(self) -> Path:
        return self.input_dir / "BlockedCustomers.xlsx"

    @classmethod
    def from_env(cls, env_file: str | Path | None = None) -> "Settings":
        load_dotenv(env_file)
        defaults_input = "Input"
        defaults_output = "Exports"
        return cls(
            odoo_url=os.getenv("ODOO_URL", "").rstrip("/"),
            odoo_db=os.getenv("ODOO_DB", ""),
            odoo_user=os.getenv("ODOO_USER", ""),
            odoo_api_key=os.getenv("ODOO_API_KEY", ""),
            input_dir=Path(os.getenv("INPUT_DIR", defaults_input)),
            output_dir=Path(os.getenv("OUTPUT_DIR", defaults_output)),
            output_file=os.getenv("OUTPUT_FILE", "SalesModel_OneOutput.xlsx"),
            inventory_validation_file=os.getenv("INVENTORY_VALIDATION_FILE", "Inventory_Validation.xlsx"),
            unmapped_products_file=os.getenv("UNMAPPED_PRODUCTS_FILE", "Unmapped_Products.xlsx"),
            batch_size=int(os.getenv("BATCH_SIZE", "500")),
            timezone=os.getenv("TIMEZONE", "Asia/Riyadh"),
            assume_utc_for_naive=_bool_env("ASSUME_UTC_FOR_NAIVE", False),
            crm_inactive_days_threshold=int(os.getenv("CRM_INACTIVE_DAYS_THRESHOLD", "30")),
            crm_recent_activity_days=int(os.getenv("CRM_RECENT_ACTIVITY_DAYS", "14")),
            db_type=os.getenv("DB_TYPE", "mysql").strip().lower(),
            db_host=os.getenv("DB_HOST", "localhost"),
            db_port=int(os.getenv("DB_PORT", "3306")),
            db_name=os.getenv("DB_NAME", "powerbi_sales"),
            db_user=os.getenv("DB_USER", ""),
            db_password=os.getenv("DB_PASSWORD", ""),
            db_schema=os.getenv("DB_SCHEMA", "") or None,
            db_url=os.getenv("DB_URL", ""),
            db_reload_mode=os.getenv("DB_RELOAD_MODE", "drop_recreate").strip().lower(),
            db_chunksize=int(os.getenv("DB_CHUNKSIZE", "5000")),
            incremental_overlap_days=max(7, int(os.getenv("INCREMENTAL_OVERLAP_DAYS", "7"))),
            rpc_timeout_seconds=int(os.getenv("ODOO_TIMEOUT_SECONDS", "60")),
            max_retries=int(os.getenv("ODOO_MAX_RETRIES", "5")),
            include_uninvoiced_sales_lines=_bool_env("INCLUDE_UNINVOICED_SALES_LINES", False),
            force_sales_full_refresh=_bool_env("FORCE_SALES_FULL_REFRESH", False),
        )

    @property
    def sqlalchemy_url(self) -> str:
        if self.db_url.strip():
            url = self.db_url.strip()
            if url.startswith("mysql") and "charset=" not in url:
                separator = "&" if "?" in url else "?"
                return f"{url}{separator}charset=utf8mb4"
            return url
        db_type = self.db_type.lower()
        user = quote_plus(self.db_user)
        password = quote_plus(self.db_password)
        host = self.db_host
        port = self.db_port
        name = self.db_name
        if db_type == "mysql":
            return f"mysql+pymysql://{user}:{password}@{host}:{port}/{name}?charset=utf8mb4"
        raise ValueError("DB_TYPE must be 'mysql'.")

    def validate(self, require_database: bool = False) -> None:
        missing = []
        for name, value in {
            "ODOO_URL": self.odoo_url,
            "ODOO_DB": self.odoo_db,
            "ODOO_USER": self.odoo_user,
            "ODOO_API_KEY": self.odoo_api_key,
        }.items():
            if not str(value).strip():
                missing.append(name)
        if missing:
            raise ValueError(
                "Missing required environment variables: "
                + ", ".join(missing)
                + ". Create a .env file from .env.example and set ODOO_API_KEY."
            )
        if require_database:
            if self.db_reload_mode not in {"drop_recreate", "truncate"}:
                raise ValueError("DB_RELOAD_MODE must be either 'drop_recreate' or 'truncate'.")
            if not self.db_url.strip():
                missing_db = []
                for name, value in {
                    "DB_TYPE": self.db_type,
                    "DB_HOST": self.db_host,
                    "DB_PORT": self.db_port,
                    "DB_NAME": self.db_name,
                    "DB_USER": self.db_user,
                    "DB_PASSWORD": self.db_password,
                }.items():
                    if not str(value).strip():
                        missing_db.append(name)
                if missing_db:
                    raise ValueError(
                        "Missing database settings for SQL output: "
                        + ", ".join(missing_db)
                        + ". Set DB_URL or the individual DB_* variables."
                    )
