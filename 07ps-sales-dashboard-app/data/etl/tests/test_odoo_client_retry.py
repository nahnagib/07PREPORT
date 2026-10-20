"""Run start: a short network/DNS outage is retried with backoff; Odoo's own errors are not."""

import http.client
import socket
import ssl
import xmlrpc.client

import pytest

from sales_pipeline.odoo import client as client_module
from sales_pipeline.odoo.client import OdooApiError, OdooClient


class FakeCommon:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def authenticate(self, *_args):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


@pytest.fixture
def clock(monkeypatch):
    """Fake time: sleep() advances monotonic() instead of waiting."""
    now = {"t": 0.0}
    sleeps: list[float] = []
    monkeypatch.setattr(client_module.time, "monotonic", lambda: now["t"])

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now["t"] += seconds

    monkeypatch.setattr(client_module.time, "sleep", fake_sleep)
    return sleeps


def _client(outcomes, **kw) -> OdooClient:
    c = OdooClient("https://example.odoo.com", "db", "user", "key", max_retries=5, **kw)
    c._common = FakeCommon(outcomes)
    return c


def test_dns_outage_is_retried_with_exponential_backoff_until_odoo_answers(clock) -> None:
    dns = socket.gaierror(-2, "Name or service not known")
    c = _client([dns] * 7 + [42], connect_retry_window_seconds=900)
    assert c.authenticate() == 42
    assert c._common.calls == 8  # more than max_retries (5): the retry window decides, not the attempt count
    assert clock == [5, 10, 20, 40, 80, 120, 120]  # doubling, capped at 120s


def test_outage_longer_than_the_window_fails_with_a_clear_message(clock) -> None:
    dns = socket.gaierror(-2, "Name or service not known")
    c = _client([dns] * 50, connect_retry_window_seconds=60)
    with pytest.raises(OdooApiError, match="failed after .* attempt\\(s\\) over .*s for https://example.odoo.com.*Name or service not known"):
        c.authenticate()
    assert sum(clock) <= 60 + 30  # stops near the window, never loops forever


def test_odoo_errors_are_not_retried(clock) -> None:
    c = _client([xmlrpc.client.Fault(1, "Access Denied")])
    with pytest.raises(OdooApiError, match="RPC fault"):
        c.authenticate()
    assert c._common.calls == 1 and clock == []
    c = _client([False])  # wrong credentials: Odoo answers uid False
    with pytest.raises(OdooApiError, match="Check ODOO_DB"):
        c.authenticate()
    assert c._common.calls == 1


def test_window_zero_keeps_the_old_attempt_limit(clock) -> None:
    c = _client([ConnectionRefusedError()] * 10, connect_retry_window_seconds=0)
    with pytest.raises(OdooApiError):
        c.authenticate()
    assert c._common.calls == 5


# -- model calls (execute_kw) ------------------------------------------------------------------------------------
class FakeModels:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def execute_kw(self, *_args):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _rpc_client(models: FakeModels, max_retries: int = 5) -> tuple[OdooClient, list[int]]:
    c = OdooClient("https://example.odoo.com", "db", "user", "key", max_retries=max_retries)
    c.uid = 7
    c._models = models
    reconnects: list[int] = []
    c._connect = lambda: reconnects.append(1)  # type: ignore[method-assign]
    return c, reconnects


@pytest.mark.parametrize("error", [
    http.client.IncompleteRead(b"x" * 10),                       # 2026-10-12 sales_incremental
    http.client.ResponseNotReady("Request-sent"),                # 2026-10-19 sales_incremental
    http.client.RemoteDisconnected("Remote end closed connection without response"),
    ssl.SSLEOFError(8, "EOF occurred in violation of protocol"),  # 2026-10-17
    socket.gaierror(-5, "No address associated with hostname"),  # 2026-10-19
])
def test_transport_errors_are_retried_on_a_new_connection(clock, error) -> None:
    models = FakeModels([error, error, [{"id": 1}]])
    c, reconnects = _rpc_client(models)
    assert c.execute_kw("sale.order", "search_read", [[]], {}) == [{"id": 1}]
    assert models.calls == 3
    assert len(reconnects) == 2  # a fresh transport before every retry
    assert 2 <= clock[0] <= 2.5 and 4 <= clock[1] <= 5  # exponential backoff with <= 25% jitter


def test_backoff_is_capped_and_the_last_error_is_named(clock) -> None:
    models = FakeModels([http.client.IncompleteRead(b"")] * 8)
    c, _ = _rpc_client(models, max_retries=8)
    with pytest.raises(OdooApiError, match="failed after 8 attempts: IncompleteRead"):
        c.execute_kw("stock.move", "search_read", [[]], {})
    assert models.calls == 8
    assert len(clock) == 7  # no pointless sleep after the last attempt
    assert max(clock) <= 60 * 1.25


def test_odoo_faults_on_model_calls_are_not_retried(clock) -> None:
    models = FakeModels([xmlrpc.client.Fault(2, "ValueError: Invalid field")])
    c, reconnects = _rpc_client(models)
    with pytest.raises(OdooApiError, match="RPC fault"):
        c.execute_kw("sale.order", "search_read", [[]], {})
    assert models.calls == 1 and clock == [] and reconnects == []
