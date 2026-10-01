"""Run start: a short network/DNS outage is retried with backoff; Odoo's own errors are not."""

import socket
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
