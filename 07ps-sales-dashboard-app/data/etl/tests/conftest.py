"""Shared fixtures for the etl_platform tests (test_platform_*.py). Existing tests define their own."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from sqlalchemy import create_engine

from etl_platform.config import PlatformConfig
from etl_platform.meta import create_meta_tables


# Credential profiles a test must never pick up from a developer's data/etl/.env. api/api_config.py calls load_dotenv() at
# import, so once tests/test_etl_api.py ran, ODOO_DEBT_* sent finance_receivables to the REAL Odoo (profile "debt")
# instead of the fake one, and the pipeline tests read live data for minutes. Tests that need a profile set it themselves.
_PROFILE_PREFIXES = ("ODOO_DEBT_", "NPS_")


@pytest.fixture(autouse=True)
def _no_local_credential_profiles(monkeypatch):
    for name in [k for k in os.environ if k.startswith(_PROFILE_PREFIXES)]:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def platform_engine(tmp_path: Path):
    """File-backed SQLite with the meta tables (file-backed: several connections must see the same data)."""
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'platform.db'}", future=True)
    create_meta_tables(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def platform_config(tmp_path: Path) -> PlatformConfig:
    inputs = tmp_path / "Input"
    inputs.mkdir()
    return PlatformConfig(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'platform.db'}",
        input_dir=inputs,
        odoo_url="https://majaal.odoo.com",
        odoo_db="odoo-ps-majaal-main-3380005",
        odoo_prod_db="odoo-ps-majaal-main-3380005",
        odoo_allowed_hosts=("majaal.odoo.com", "odoo-ps-majaal-main-3380005.dev.odoo.com"),
        odoo_company_ids=(1, 3),
        core_dims_fresh_minutes=180,
    )
