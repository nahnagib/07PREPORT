"""The real refresh_30m definition and its configuration defaults (docs/etl-refresh-schedule.md)."""

from etl_platform.config import PlatformConfig
from etl_platform.registry import REGISTRY, load_definitions


def test_refresh_job_is_isolated_configurable_and_runs_only_the_sales_mirror():
    load_definitions()
    job = REGISTRY.get_job("refresh_30m")
    assert job.isolated and job.configurable_modules and not job.tasks
    assert job.depends_on_jobs == ("core_dims", "sales_mirror", "finance_receivables", "process_nps")  # shared lists first
    # Phase B: the refresh only brings the Odoo mirror up to date (seconds); the sales tables are built by sales_build on
    # the second queue, so no sales build ever runs inside the refresh
    assert [name for name in job.depends_on_jobs if name.startswith("sales")] == ["sales_mirror"]
    REGISTRY.validate()


def test_defaults_run_core_dims_every_cycle_and_list_the_modules(monkeypatch, tmp_path):
    for name in ("ETL_CORE_DIMS_FRESH_MINUTES", "ETL_REFRESH_MODULES", "ETL_ODOO_MAX_RETRIES"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DB_URL", f"sqlite+pysqlite:///{tmp_path / 'x.db'}")
    config = PlatformConfig.from_env(tmp_path / "missing.env")
    assert config.core_dims_fresh_minutes == 0
    assert config.refresh_modules == ("core_dims", "sales_mirror", "finance_receivables", "process_nps")
    assert config.odoo_max_retries == 5
    monkeypatch.setenv("ETL_REFRESH_MODULES", " core_dims , process_nps ")
    assert PlatformConfig.from_env(tmp_path / "missing.env").refresh_modules == ("core_dims", "process_nps")
