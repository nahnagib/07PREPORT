"""Odoo source: read-only allowlist, production guard, credentials/expiry, field safety, paging, chunking.
All Odoo traffic is faked; no network, no real keys."""

from __future__ import annotations

import datetime as dt
import logging

import pytest

from etl_platform.sources import odoo as odoo_mod
from etl_platform.sources.odoo import (
    GuardedOdooClient,
    OdooAuthError,
    OdooConfigError,
    OdooCredentials,
    OdooGuardError,
    OdooSource,
    OdooWriteBlockedError,
    check_production_target,
    key_expiry_message,
)

PROD_DB = "odoo-ps-majaal-main-3380005"
HOSTS = ("majaal.odoo.com", "odoo-ps-majaal-main-3380005.dev.odoo.com")


class FakeModels:
    """Stands in for the /xmlrpc/2/object proxy; serves search_read from an in-memory list."""

    def __init__(self, records=None, fields=None):
        self.records = records or []
        self.fields = fields or {}
        self.calls: list[tuple[str, str, list, dict]] = []

    def execute_kw(self, db, uid, key, model, method, args, kwargs):
        self.calls.append((model, method, args, kwargs))
        if method == "fields_get":
            return self.fields
        if method == "search_read":
            domain = args[0]
            rows = [r for r in self.records if _match(r, domain)]
            order = kwargs.get("order", "id")
            if order.startswith("write_date"):
                rows.sort(key=lambda r: (r["write_date"], r["id"]))
            else:
                rows.sort(key=lambda r: r["id"])
            off, lim = kwargs.get("offset", 0), kwargs.get("limit")
            return [{k: r[k] for k in kwargs["fields"] if k in r} for r in rows[off:off + lim]]
        if method == "search_count":
            return len(self.records)
        if method == "search":
            return [r["id"] for r in self.records]
        raise AssertionError(f"unexpected {method}")


def _match(rec, domain):
    """Tiny evaluator for the domains the source builds (AND of terms, plus the keyset OR block)."""
    def term(t):
        f, op, v = t
        x = rec.get(f)
        if op == "in":
            return x in v
        return {">=": lambda: x >= v, ">": lambda: x > v, "=": lambda: x == v}[op]()

    i, ok = 0, True
    while i < len(domain):
        if domain[i] == "|":  # keyset block: '|', A, '&', B, C
            a, b, c = domain[i + 1], domain[i + 3], domain[i + 4]
            ok = ok and (term(a) or (term(b) and term(c)))
            i += 5
        else:
            ok = ok and term(domain[i])
            i += 1
    return ok


class FakeCommon:
    def __init__(self, uid=1):
        self.uid = uid

    def version(self):
        return {"server_version": "17.0+e"}

    def authenticate(self, *a):
        return self.uid


def _client(models=None, uid=1) -> GuardedOdooClient:
    c = GuardedOdooClient(url="https://majaal.odoo.com", db=PROD_DB, username="bot@example.com", api_key="test-not-a-key",
                          max_retries=1, connect_retry_window_seconds=0)
    c._models = models or FakeModels()
    c._common = FakeCommon(uid)
    c.uid = 1
    return c


def _source(models=None, **kw) -> OdooSource:
    return OdooSource(_client(models), company_ids=(1, 3), **kw)


# -- read-only -----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["create", "write", "unlink", "action_post", "copy", "message_post", "button_confirm"])
def test_any_non_read_method_is_blocked_before_reaching_odoo(method):
    models = FakeModels()
    client = _client(models)
    with pytest.raises(OdooWriteBlockedError, match="read-only"):
        client.execute_kw("account.move", method, [[1]], {})
    assert models.calls == []


@pytest.mark.parametrize("method", sorted(odoo_mod.READ_ONLY_METHODS - {"read", "read_group"}))
def test_read_methods_pass(method):
    models = FakeModels(fields={"id": {}})
    _client(models).execute_kw("res.partner", method, [[]], {"fields": ["id"], "offset": 0, "limit": 10})
    assert models.calls[0][1] == method


# -- production guard --------------------------------------------------------------------------------------------
def test_guard_accepts_prod_db_on_either_allowed_host():
    for host in HOSTS:
        check_production_target(f"https://{host}", PROD_DB, prod_db=PROD_DB, allowed_hosts=HOSTS, allow_non_prod=False)


@pytest.mark.parametrize("url, db, match", [
    ("https://majaal.odoo.com", "some-staging-db", "not the production database"),
    ("https://other-branch.dev.odoo.com", PROD_DB, "not in ODOO_ALLOWED_HOSTS"),
    ("http://majaal.odoo.com", PROD_DB, "https"),
])
def test_guard_rejects(url, db, match):
    with pytest.raises(OdooGuardError, match=match):
        check_production_target(url, db, prod_db=PROD_DB, allowed_hosts=HOSTS, allow_non_prod=False)


def test_guard_requires_configuration():
    with pytest.raises(OdooGuardError, match="ODOO_PROD_DB and ODOO_ALLOWED_HOSTS"):
        check_production_target("https://majaal.odoo.com", PROD_DB, prod_db="", allowed_hosts=(), allow_non_prod=False)


def test_guard_override_warns(caplog):
    caplog.set_level(logging.WARNING)
    check_production_target("https://x.dev.odoo.com", "dev-db", prod_db=PROD_DB, allowed_hosts=HOSTS, allow_non_prod=True)
    assert "ALLOW_NON_PROD=1" in caplog.text


# -- credentials ------------------------------------------------------------------------------------------------
def test_credential_profiles_and_secret_hygiene(monkeypatch):
    monkeypatch.setenv("ODOO_DEBT_LOGIN", "finance-bot@example.com")
    monkeypatch.setenv("ODOO_DEBT_API_KEY", "test-secret-value")
    monkeypatch.setenv("ODOO_DEBT_KEY_EXPIRES", "2026-12-15")
    creds = OdooCredentials.from_env("debt")
    assert (creds.login, creds.key_expires) == ("finance-bot@example.com", dt.date(2026, 12, 15))
    assert "test-secret-value" not in repr(creds)
    assert OdooCredentials.env_names("default") == ("ODOO_USER", "ODOO_API_KEY", "ODOO_KEY_EXPIRES")


def test_missing_credentials_name_the_variables_not_the_values(monkeypatch):
    monkeypatch.delenv("ODOO_DEBT_LOGIN", raising=False)
    monkeypatch.setenv("ODOO_DEBT_API_KEY", "test-secret-value")
    with pytest.raises(OdooConfigError) as exc:
        OdooCredentials.from_env("debt")
    assert "ODOO_DEBT_LOGIN" in str(exc.value) and "test-secret-value" not in str(exc.value)


@pytest.mark.parametrize("expires, level", [(None, None), ("2027-01-01", None), ("2026-10-15", "WARNING"), ("2026-10-01", "WARNING"), ("2026-09-30", "ERROR")])
def test_key_expiry_warning_window(expires, level):
    creds = OdooCredentials("debt", "bot", "k", dt.date.fromisoformat(expires) if expires else None)
    msg = key_expiry_message(creds, dt.date(2026, 10, 1), 14)
    assert (msg[0] if msg else None) == level


def test_rejected_key_raises_auth_error_and_alerts(caplog):
    caplog.set_level(logging.ERROR)
    client = GuardedOdooClient(url="https://majaal.odoo.com", db=PROD_DB, username="bot", api_key="test-not-a-key",
                               max_retries=1, connect_retry_window_seconds=0)
    client._common = FakeCommon(uid=False)
    with pytest.raises(OdooAuthError):
        OdooSource(client, profile="debt").open()
    assert "rejected the API key" in caplog.text and "ODOO_DEBT_API_KEY" in caplog.text
    assert "test-not-a-key" not in caplog.text


# -- fields, paging, chunking -------------------------------------------------------------------------------------
def test_available_fields_skips_missing_with_one_warning(caplog):
    caplog.set_level(logging.WARNING)
    src = _source(FakeModels(fields={"id": {}, "name": {}, "credit_limit": {}}))
    present, skipped = src.available_fields("res.partner", ["id", "name", "credit_limit", "x_custom"])
    src.available_fields("res.partner", ["id", "x_custom"])  # same skipped set: not reported again
    assert present == ["id", "name", "credit_limit"] and skipped == ["x_custom"]
    assert caplog.text.count("res.partner: field(s) not available and skipped: x_custom") == 1
    assert src.client._models.calls.count(("res.partner", "fields_get", [], {"attributes": ["type", "relation", "store", "string"]})) == 1


def test_search_read_all_pages_by_offset_and_sends_context():
    models = FakeModels([{"id": i, "name": f"p{i}"} for i in range(1, 6)])
    src = _source(models, page_size=2)
    rows = src.search_read_all("res.partner", [], ["id", "name"])
    assert [r["id"] for r in rows] == [1, 2, 3, 4, 5]
    calls = [c for c in models.calls if c[1] == "search_read"]
    assert [c[3]["offset"] for c in calls] == [0, 2, 4]
    assert all(c[3]["limit"] == 2 and c[3]["order"] == "id" for c in calls)
    assert calls[0][3]["context"] == {"lang": "en_US", "allowed_company_ids": [1, 3]}


def test_incremental_pages_in_id_order_and_terminates_when_many_share_one_second():
    # 7 records in the same second with page size 2: the old keyset paging looped forever on this shape
    # (Odoo returns write_date truncated to the second, so "write_date = boundary" never matches).
    same = "2026-10-01 08:00:00"
    recs = [{"id": i, "write_date": same} for i in (5, 1, 3, 4, 6, 7, 8)] + [
        {"id": 2, "write_date": "2026-10-01 09:00:00"}, {"id": 9, "write_date": "2026-09-01 00:00:00"}]
    models = FakeModels(recs)
    src = _source(models, page_size=2)
    rows = src.search_read_incremental("res.partner", [], ["id"], since=dt.datetime(2026, 10, 1, 7, 55))
    assert [r["id"] for r in rows] == [1, 2, 3, 4, 5, 6, 7, 8]  # id 9 is older than since; no duplicates
    calls = [c for c in models.calls if c[1] == "search_read"]
    assert len(calls) == 5
    assert all(c[3]["order"] == "id asc" for c in calls) and calls[0][3]["context"]["active_test"] is False
    assert [c[3]["offset"] for c in calls] == [0, 2, 4, 6, 8]
    assert calls[0][2][0] == [("write_date", ">=", "2026-10-01 07:55:00")]


def test_read_by_ids_chunks_of_500():
    models = FakeModels([{"id": i} for i in range(1, 1201)])
    rows = _source(models).read_by_ids("res.partner", list(range(1, 1201)) + [5, None], ["id"])
    calls = [c for c in models.calls if c[1] == "search_read"]
    assert [len(c[2][0][0][2]) for c in calls] == [500, 500, 200]
    assert len(rows) == 1200


def test_connect_checks_guard_before_touching_credentials(platform_config, monkeypatch):
    from dataclasses import replace

    monkeypatch.delenv("ODOO_USER", raising=False)
    with pytest.raises(OdooGuardError):
        OdooSource.connect(replace(platform_config, odoo_db="not-prod"), "default")
