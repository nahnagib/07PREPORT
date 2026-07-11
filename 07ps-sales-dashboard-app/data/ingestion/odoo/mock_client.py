"""A duck-typed stand-in for the vendored ``sales_pipeline.odoo.client.OdooClient``.

Why this exists: this session's explicit instruction is "Do not run a live extraction against
production Odoo in this session without confirming with me first." At the same time, the whole
point of this ingestion layer is to reuse - not redesign - the existing pipeline's Odoo
extraction logic (repositories, field-availability checks, many2one flattening, quotation
classification, CRM status derivation, etc.), all of which is exercised by feeding it real-shaped
Odoo XML-RPC responses.

MockOdooClient implements exactly the same public surface the vendored
``sales_pipeline.odoo.base_repository.OdooRepositoryBase`` and
``sales_pipeline.odoo.sales_report_repository.SalesReportRepository`` call on a client:
``authenticate()``, ``fields_get(model, attributes=None)``, ``search_count(model, domain,
context=None)``, ``search_read(model, domain, fields, offset=0, limit=500, order="id",
context=None)`` - plus the ``.uid`` attribute the pipeline reads directly. None of the vendored
repository/pipeline code needed to change to accept this in place of a real OdooClient; it never
touches ``._common``/``._models``/xmlrpc directly, only these methods.

No network calls happen anywhere in this module. Swapping in the real
``sales_pipeline.odoo.client.OdooClient`` (unmodified, imported from the vendored package) is a
one-line change in ``extract.py`` - gated behind an explicit ``ALLOW_LIVE_ODOO=1`` environment
variable AND separate human confirmation, per this session's instruction.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


class MockOdooApiError(RuntimeError):
    """Mirrors sales_pipeline.odoo.client.OdooApiError's role, without importing xmlrpc."""


@dataclass
class MockOdooClient:
    """In-memory replacement for OdooClient. Backed by ``fixtures.MOCK_ODOO_DATA``.

    ``models`` maps model name -> {"records": [...], "field_types": {field: odoo_type}}.
    ``field_types`` stands in for what a real ``fields_get`` call would return from Odoo's live
    schema; every repository calls ``available_fields()`` which calls this before deciding which
    requested fields actually exist - so field lists here are deliberately a realistic *subset*
    match of what each repository requests (a couple of intentionally-mocked-as-missing fields are
    included per model, mirroring how ``available_fields()`` gracefully drops fields that don't
    exist in a given Odoo installation's customization).
    """

    models: dict[str, dict[str, Any]] = field(default_factory=dict)
    batch_size_seen: list[int] = field(default_factory=list)
    uid: int | None = None

    def authenticate(self) -> int:
        self.uid = 1
        return self.uid

    def fields_get(self, model: str, attributes: list[str] | None = None) -> dict[str, Any]:
        info = self.models.get(model)
        if info is None:
            return {}
        return info["field_types"]

    def search_count(self, model: str, domain: list[Any], context: dict[str, Any] | None = None) -> int:
        return len(self._filtered_records(model, domain))

    def search_read(
        self,
        model: str,
        domain: list[Any],
        fields: list[str],
        offset: int = 0,
        limit: int = 500,
        order: str = "id",
        context: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        self.batch_size_seen.append(limit)
        records = self._filtered_records(model, domain)
        records = sorted(records, key=lambda r: r.get("id", 0))
        page = records[offset : offset + limit]
        return [{f: rec.get(f, False) for f in fields} for rec in page]

    def execute_kw(self, model: str, method: str, args: list[Any] | None = None, kwargs: dict[str, Any] | None = None) -> Any:
        # Not exercised directly by any vendored repository (they all go through the typed
        # helper methods above), but included so MockOdooClient is a complete drop-in for
        # OdooClient's public surface.
        raise MockOdooApiError(f"execute_kw({model}.{method}) not implemented on MockOdooClient - "
                                "add a typed method instead, matching what the real repositories call.")

    def _filtered_records(self, model: str, domain: list[Any]) -> list[dict[str, Any]]:
        info = self.models.get(model)
        if info is None:
            return []
        records = info["records"]
        if not domain:
            return list(records)
        return [r for r in records if _matches_domain(r, domain)]


def _matches_domain(record: dict[str, Any], domain: list[Any]) -> bool:
    """Minimal Odoo-domain evaluator - handles the flat AND-of-triples shape every vendored
    repository actually sends (no '|'/'&' prefix operators are used anywhere in pipeline.py's
    calls), which is all the mock needs to support.
    """
    for clause in domain:
        if not isinstance(clause, (list, tuple)) or len(clause) != 3:
            continue  # skip logical operators like '|', '&' - none of the pipeline's own calls use them
        field_name, op, value = clause
        # dotted lookups like "order_id.state" - the mock stores the flattened value directly
        # under the dotted key for the couple of fixture rows that need it (see fixtures.py).
        actual = record.get(field_name, False)
        if op == "=":
            if actual != value:
                return False
        elif op in ("!=", "<>"):
            if actual == value:
                return False
        elif op == ">=":
            if not (actual is not False and actual >= value):
                return False
        elif op == "in":
            if actual not in value:
                return False
        elif op == "not in":
            if actual in value:
                return False
        else:
            raise MockOdooApiError(f"MockOdooClient domain operator not supported: {clause!r}")
    return True
