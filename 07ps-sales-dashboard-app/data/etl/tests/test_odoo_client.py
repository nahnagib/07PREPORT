from __future__ import annotations

import socket

import pytest

from sales_pipeline.odoo.client import OdooApiError, OdooClient


class _FlakyCommon:
    def __init__(self, failures: int, uid: int = 42) -> None:
        self.failures = failures
        self.uid = uid
        self.calls = 0

    def authenticate(self, *_args: object) -> int:
        self.calls += 1
        if self.calls <= self.failures:
            raise socket.gaierror(11001, "getaddrinfo failed")
        return self.uid


def test_odoo_authenticate_retries_transient_network_errors(monkeypatch) -> None:
    monkeypatch.setattr("sales_pipeline.odoo.client.time.sleep", lambda _seconds: None)
    client = OdooClient(
        url="https://majaal.odoo.com",
        db="db",
        username="user",
        api_key="key",
        max_retries=2,
    )
    common = _FlakyCommon(failures=1, uid=7)
    client._common = common

    assert client.authenticate() == 7
    assert common.calls == 2


def test_odoo_authenticate_reports_dns_connectivity_failure(monkeypatch) -> None:
    monkeypatch.setattr("sales_pipeline.odoo.client.time.sleep", lambda _seconds: None)
    client = OdooClient(
        url="https://majaal.odoo.com",
        db="db",
        username="user",
        api_key="key",
        max_retries=2,
    )
    client._common = _FlakyCommon(failures=99)

    with pytest.raises(OdooApiError) as exc_info:
        client.authenticate()

    message = str(exc_info.value)
    assert "failed after 2 attempt" in message
    assert "https://majaal.odoo.com" in message
    assert "internet/DNS/VPN/firewall" in message
