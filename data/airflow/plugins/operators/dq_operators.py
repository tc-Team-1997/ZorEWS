"""Lightweight data-quality operators used by the DAGs."""
from __future__ import annotations

try:
    from airflow.models import BaseOperator
except Exception:  # pragma: no cover
    class BaseOperator:  # type: ignore
        def __init__(self, *_, **__): pass


class RowCountGate(BaseOperator):
    """Fails the run if the rowcount XCom from `upstream_task_id` is < min_rows."""
    template_fields = ("upstream_task_id", "min_rows")

    def __init__(self, upstream_task_id: str, min_rows: int = 1, **kwargs):
        super().__init__(**kwargs)
        self.upstream_task_id = upstream_task_id
        self.min_rows = min_rows

    def execute(self, context):
        ti = context["ti"]
        result = ti.xcom_pull(task_ids=self.upstream_task_id) or {}
        rows = int(result.get("rows", 0))
        if rows < self.min_rows:
            raise ValueError(
                f"row count gate failed for {self.upstream_task_id}: "
                f"got {rows}, expected >= {self.min_rows}"
            )
        return rows
