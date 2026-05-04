"""
CBSMockHook — pretends to be a CBS REST gateway for the prototype.

The hook is intentionally thin: it returns a few fabricated rows from an
in-memory fixture so the DAG can run end-to-end without external services.

In production this becomes an `HttpHook(conn_id='cbs')` that paginates
`/loans?since=…` against the CBS gateway.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Mapping

try:
    from airflow.hooks.base import BaseHook
except Exception:  # pragma: no cover — when imported outside Airflow
    class BaseHook:  # type: ignore
        def __init__(self, *_, **__): pass


_FIXTURE: dict[str, list[dict]] = {
    "cbs_loans": [
        {"loan_id": "L000001", "customer_id": "C00001", "outstanding_amount": 80000, "npa_status": "PERFORMING"},
        {"loan_id": "L000002", "customer_id": "C00002", "outstanding_amount": 120000, "npa_status": "WATCH"},
    ],
    "cbs_repayments": [
        {"repayment_id": "R0000100", "loan_id": "L000001", "customer_id": "C00001", "paid_amount": 12500},
    ],
    "cbs_transactions": [
        {"txn_id": "T00010001", "customer_id": "C00001", "amount": 5000, "txn_type": "debit"},
    ],
    "cbs_customer_profile": [
        {"customer_id": "C00001", "kyc_status": "verified"},
    ],
}


class CBSMockHook(BaseHook):
    def __init__(self, conn_id: str = "cbs_mock"):
        super().__init__()
        self.conn_id = conn_id

    def fetch(self, table: str, since: datetime | None = None) -> list[dict]:
        return list(_FIXTURE.get(table, []))

    def bulk_insert(self, target: str, rows: Iterable[Mapping]) -> int:
        # In production this would COPY into Aurora.
        rows = list(rows)
        return len(rows)
