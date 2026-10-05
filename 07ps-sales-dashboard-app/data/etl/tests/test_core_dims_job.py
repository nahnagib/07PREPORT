"""core_dims end to end: fake read-only Odoo + generated Excel inputs -> SQLite built from the REAL migration
0029 DDL. Covers the conformed keys, -1 fallbacks, data-quality checks, and key stability."""

from __future__ import annotations

import datetime as dt
from dataclasses import replace

import pandas as pd
import pytest
from sqlalchemy import text

from core_fixtures import ODOO_USERS, SALESPERSON, FakeOdooSource, write_inputs
from core.transforms.org import OrgFileError
from etl_platform.registry import REGISTRY, load_definitions
from etl_platform.runner import Runner
from sqlite_schema import apply_migration_sqlite

AS_OF = dt.date(2026, 10, 1)
DIMS = ["dim_company", "dim_currency", "dim_payment_term", "dim_customer", "map_partner_customer", "dim_customer_company",
        "dim_channel", "dim_segment", "dim_sales_team", "dim_salesperson", "map_odoo_user_salesperson", "dim_date", "dim_offday",
        "dim_product", "dim_product_master", "map_product_master", "map_odoo_team_sales_team"]


@pytest.fixture
def core(platform_engine, platform_config, tmp_path):
    apply_migration_sqlite(platform_engine, "0029_core_dimensions.sql")
    apply_migration_sqlite(platform_engine, "0030_core_team_map.sql")
    apply_migration_sqlite(platform_engine, "0032_core_odoo_labels.sql")
    load_definitions()
    inputs = write_inputs(tmp_path / "inputs")
    config = replace(platform_config, input_dir=inputs)
    fake = FakeOdooSource()

    def run(full=False, cfg=None):
        runner = Runner(REGISTRY, platform_engine, cfg or config)
        runner._sources["odoo:default"] = fake
        return runner.run("core_dims", as_of=AS_OF, full_refresh=full, trigger_source="test")

    return platform_engine, run, inputs, fake


def _df(engine, sql):
    with engine.connect() as conn:
        return pd.read_sql(text(sql), conn)


def _vals(engine, sql) -> list[list]:
    """Raw DB values (ints stay ints, NULL stays None), unlike pd.read_sql."""
    with engine.connect() as conn:
        return [list(r) for r in conn.execute(text(sql))]


def _snapshot(engine) -> dict[str, pd.DataFrame]:
    out = {}
    for t in DIMS:
        df = _df(engine, f"SELECT * FROM {t}").drop(columns=["updated_at_utc"])
        out[t] = df.sort_values(list(df.columns[:2])).reset_index(drop=True)
    return out


def test_core_dims_builds_conformed_dimensions(core):
    engine, run, _, fake = core
    run()
    assert _vals(engine, "SELECT CompanyKey, Company, currency, is_in_scope FROM dim_company ORDER BY CompanyKey") == [[-1, "Unknown", None, 0], [1, "Majaal", "LYD", 1], [2, "Namaa Al Bahr", "LYD", 0], [3, "Tika", "LYD", 1]]

    cust = _df(engine, "SELECT CustomerKey, customer, is_customer, SalespersonKey, IsBlocked FROM dim_customer ORDER BY CustomerKey")
    assert cust["CustomerKey"].tolist() == [-1, 100, 102, 103]  # commercial partners only; contact 101 is not a customer row
    acme = cust.set_index("CustomerKey").loc[100]
    assert (acme.SalespersonKey, acme.IsBlocked, acme.is_customer) == (49, 1, 1)  # user 10 -> Moftah (49); blocked via CustomerKey
    assert cust.set_index("CustomerKey").loc[102, "SalespersonKey"] == -1  # user 13 not in OdooUsers -> -1 + reported
    assert cust.set_index("CustomerKey").loc[103, "is_customer"] == 0

    pmap = dict(_df(engine, "SELECT partner_id, CustomerKey FROM map_partner_customer").values.tolist())
    assert pmap[101] == 100 and pmap[100] == 100 and pmap[-1] == -1

    assert _vals(engine, "SELECT CustomerKey, CompanyKey, credit_limit, PaymentTermKey FROM dim_customer_company ORDER BY 1, 2") == [[100, 1, 5000.0, 8], [100, 3, 0.0, 7], [102, 1, 0.0, -1], [102, 3, 0.0, -1]]

    terms = _vals(engine, "SELECT PaymentTermKey, max_days, is_instalment FROM dim_payment_term ORDER BY 1")
    assert terms == [[-1, None, 0], [7, 30, 0], [8, 60, 1]]

    sp = _vals(engine, "SELECT SalespersonKey, SalesTeamKey, ChannelKey, assigned_team_key FROM dim_salesperson ORDER BY 1")
    # Sara (60) has a blank Status: same rule as the legacy pipeline -> effective team/channel Unknown
    # 62 and 63 have no team: Inactive whatever the sheet Status says -> team and channel Unknown
    assert sp == [[-1, "-1", -1, None], [49, "TK-BEN-BC-03", 3, "TK-BEN-BC-03"], [60, "-1", -1, "MJ-EST-BB"],
                  [62, "-1", -1, None], [63, "-1", -1, None], [79, "MJ-EST-BB", -1, "MJ-EST-BB"]]
    status = dict(_vals(engine, "SELECT SalespersonKey, status FROM dim_salesperson WHERE SalespersonKey > 0"))
    assert status == {49: "Active", 60: None, 62: "Inactive", 63: "Inactive", 79: "Active"}
    warn = _vals(engine, "SELECT status, failing_rows FROM etl_dq_result WHERE check_name = 'warn:salesperson_active_status_without_team'")
    assert warn == [["warn", 1]]  # 63: the sheet says Active but has no team
    users = _vals(engine, "SELECT odoo_user_id, SalespersonKey FROM map_odoo_user_salesperson ORDER BY 1")
    assert users == [[10, 49], [11, 49], [12, 60]]  # one person, two Odoo users
    teams_map = _vals(engine, "SELECT odoo_team_id, SalesTeamKey, follows_salesperson FROM map_odoo_team_sales_team ORDER BY 1")
    assert teams_map == [[9, "MJ-EST-BB", 0], [27, "-1", 1]]  # EXPORT follows the salesperson; Website not listed

    pm = _vals(engine, "SELECT ProductKey, CompanyKey, ProductMasterKey, match_status FROM map_product_master ORDER BY 1, 2")
    cem_key = _df(engine, "SELECT ProductMasterKey FROM dim_product_master WHERE Company = 'Tika'").iloc[0, 0]
    assert cem_key.startswith("CEM|")  # blank key in the sheet -> generated, always suffixed
    assert pm == [[500, 1, "Majaal | GR-1 | 1", "MatchedByCompanyAndName"], [500, 3, "-1", "Unmatched"],
                  [501, 3, cem_key, "MatchedByCompanyAndName"], [502, 1, "-1", "Unmatched"], [502, 3, "-1", "Unmatched"]]

    dates = _df(engine, "SELECT MIN(Date) AS lo, MAX(Date) AS hi FROM dim_date WHERE DateKey > 0")
    assert (str(dates.lo[0]), str(dates.hi[0])) == ("2018-01-01", "2027-12-31")
    off = _vals(engine, "SELECT DateKey, CompanyKey, SalesTeamKey FROM dim_offday ORDER BY 1")
    assert off == [[20260118, 1, "MJ-EST-BB"], [20261224, -1, "-1"]]  # Egypt row filtered out (country)

    dq = _df(engine, "SELECT check_type, status FROM etl_dq_result")
    orphans = dq[dq["check_type"] == "orphan"]
    assert len(orphans) >= 20 and set(orphans["status"]) == {"pass"}  # every orphan check passed
    assert dq[dq["check_type"] != "orphan"].values.tolist() == [["custom_sql", "warn"]]  # the Active-without-team warning
    fallback = _df(engine, "SELECT unknown_key_fallbacks, fallback_detail FROM etl_task_log WHERE task_name = 'build_customer_dims'")
    assert fallback.iloc[0, 0] == 1 and '"13"' in fallback.iloc[0, 1]
    assert ("res.partner", "full") in fake.calls  # first run: full extract


def test_second_run_is_incremental_and_keys_are_identical(core):
    engine, run, _, fake = core
    run()
    first = _snapshot(engine)
    fake.calls.clear()
    run()  # incremental
    assert ("res.partner", "incremental") in fake.calls
    run(full=True)  # and a full rebuild
    second = _snapshot(engine)
    for table in DIMS:
        pd.testing.assert_frame_equal(first[table], second[table], check_dtype=False, obj=table)


def test_new_salesperson_sorting_first_shifts_nothing(core):
    engine, run, inputs, _ = core
    run()
    before = _df(engine, "SELECT SalespersonKey, salesperson FROM dim_salesperson").set_index("salesperson")["SalespersonKey"].to_dict()
    added = pd.concat([pd.DataFrame([{"Name": "Aaron Aardvark", "TeamKey": "MJ-EST-BB", "Status": "Active", "DistributionChannel": "Retail",
                                      "SalespersonKey": 85, "ChannelKey": 3}]), SALESPERSON], ignore_index=True)
    write_inputs(inputs, salesperson=added)
    run()
    after = _df(engine, "SELECT SalespersonKey, salesperson FROM dim_salesperson").set_index("salesperson")["SalespersonKey"].to_dict()
    assert after.pop("Aaron Aardvark") == 85
    assert after == before


def test_removed_user_mapping_disappears_but_salesperson_stays(core):
    engine, run, inputs, _ = core
    run()
    write_inputs(inputs, users=ODOO_USERS[ODOO_USERS["odoo_user_id"] != 12])
    run()
    assert 12 not in _df(engine, "SELECT odoo_user_id FROM map_odoo_user_salesperson")["odoo_user_id"].tolist()
    assert 60 in _df(engine, "SELECT SalespersonKey FROM dim_salesperson")["SalespersonKey"].tolist()


def test_inconsistent_org_file_fails_and_leaves_dimensions_untouched(core):
    engine, run, inputs, _ = core
    run()
    before = _snapshot(engine)["dim_salesperson"]
    bad = SALESPERSON.copy()
    bad.loc[0, "ChannelKey"] = 2  # Projects, but the row says Retail
    write_inputs(inputs, salesperson=bad)
    with pytest.raises(OrgFileError, match="ChannelKey 2 is 'Projects' but DistributionChannel says 'Retail'"):
        run()
    pd.testing.assert_frame_equal(before, _snapshot(engine)["dim_salesperson"], check_dtype=False)
    status = _df(engine, "SELECT status FROM etl_run_log ORDER BY run_id DESC LIMIT 1").iloc[0, 0]
    assert status == "failed"
