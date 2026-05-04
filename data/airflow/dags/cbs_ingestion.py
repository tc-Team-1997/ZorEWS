"""
cbs_ingestion DAG — daily batch pull of CBS extracts into raw.*.

Schedule:    @daily, ds at 02:00 UTC.
SLA:         15 min wall-clock.
Quality gate: row counts > 0 + dbt-test on staging models.
              Failure short-circuits the pipeline so feature_build skips.

Sources hit:
    GET {CBS_BASE}/loans?since=...
    GET {CBS_BASE}/repayments?since=...
    GET {CBS_BASE}/transactions?since=...
    GET {CBS_BASE}/customers?since=...

Targets:
    raw.cbs_loans, raw.cbs_repayments, raw.cbs_transactions,
    raw.cbs_customer_profile

The DAG keeps the I/O thin and pushes shaping into dbt (feature_build).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from airflow import DAG
from airflow.operators.python import PythonOperator, ShortCircuitOperator
from airflow.operators.empty import EmptyOperator
from airflow.utils.trigger_rule import TriggerRule

# Local plugins live in /data/airflow/plugins/. We import lazily so this file
# also imports cleanly under `python -c "import dags.cbs_ingestion"`.
try:
    from plugins.hooks.cbs_mock_hook import CBSMockHook
    from plugins.operators.dq_operators import RowCountGate
    from plugins.operators.audit_operators import emit_audit_event
except ModuleNotFoundError:  # pragma: no cover — only when run outside Airflow
    CBSMockHook = None  # type: ignore
    RowCountGate = None  # type: ignore

    def emit_audit_event(**_kwargs):  # type: ignore
        return None


DEFAULT_ARGS = {
    "owner": "agent-data",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "email_on_failure": False,
    "execution_timeout": timedelta(minutes=15),
}


def _ingest(table: str, **context):
    """Pull a slice from the mock CBS endpoint and write into raw.*."""
    if CBSMockHook is None:
        return {"table": table, "rows": 0, "skipped": "no airflow runtime"}
    hook = CBSMockHook(conn_id="cbs_mock")
    rows = hook.fetch(table=table, since=context["data_interval_start"])
    inserted = hook.bulk_insert(target=f"raw.{table}", rows=rows)
    emit_audit_event(
        event_type="INGEST",
        actor="cbs_ingestion",
        subject_id=table,
        payload={"table": table, "rows": inserted},
    )
    return {"table": table, "rows": inserted}


def _quality_gate(**context):
    """Hard gate — every table must have a non-zero row count for the slice."""
    ti = context["ti"]
    results = {
        t: ti.xcom_pull(task_ids=f"ingest_{t}")
        for t in ("cbs_loans","cbs_repayments","cbs_transactions","cbs_customer_profile")
    }
    bad = [t for t, r in results.items() if not r or r.get("rows", 0) == 0]
    if bad:
        raise ValueError(f"row-count gate failed for: {bad}")
    return True


with DAG(
    dag_id="cbs_ingestion",
    description="Daily CBS batch ingest into raw.*",
    start_date=datetime(2026, 1, 1),
    schedule="0 2 * * *",
    catchup=False,
    max_active_runs=1,
    default_args=DEFAULT_ARGS,
    tags=["apex-ews", "data", "raw"],
) as dag:

    start = EmptyOperator(task_id="start")

    ingest_tasks = []
    for _table in ("cbs_loans", "cbs_repayments", "cbs_transactions", "cbs_customer_profile"):
        ingest_tasks.append(
            PythonOperator(
                task_id=f"ingest_{_table}",
                python_callable=_ingest,
                op_kwargs={"table": _table},
            )
        )

    quality_gate = ShortCircuitOperator(
        task_id="quality_gate_rowcounts",
        python_callable=_quality_gate,
        trigger_rule=TriggerRule.ALL_SUCCESS,
    )

    done = EmptyOperator(
        task_id="done",
        trigger_rule=TriggerRule.ALL_SUCCESS,
    )

    start >> ingest_tasks >> quality_gate >> done
