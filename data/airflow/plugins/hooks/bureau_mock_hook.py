"""BureauMockHook — fake CRB feed for the prototype."""
from __future__ import annotations

from datetime import date
from typing import Iterable, Mapping

try:
    from airflow.hooks.base import BaseHook
except Exception:  # pragma: no cover
    class BaseHook:  # type: ignore
        def __init__(self, *_, **__): pass


class BureauMockHook(BaseHook):
    def __init__(self, conn_id: str = "bureau_mock"):
        super().__init__()
        self.conn_id = conn_id

    def fetch_full_snapshot(self, as_of: date) -> list[dict]:
        return [
            {"customer_id": "C00001", "score": 720, "score_band": "B", "score_as_of": as_of},
            {"customer_id": "C00002", "score": 610, "score_band": "B", "score_as_of": as_of},
        ]

    def bulk_insert(self, target: str, rows: Iterable[Mapping]) -> int:
        return len(list(rows))

    def coverage_check(self, max_age_days: int = 14) -> list[str]:
        # Returns list of customer_ids whose latest score is older than max_age_days.
        return []
