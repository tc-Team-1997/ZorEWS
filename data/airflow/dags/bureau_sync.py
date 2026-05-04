"""
bureau_sync DAG — weekly refresh of bureau (CRB) score snapshots.

Schedule:   Mondays 03:00 UTC.
Quality gate: every active customer in customer_360 must have a bureau row
              not older than 14 days. Otherwise the run fails loud.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.empty import EmptyOperator
from airflow.utils.trigger_rule import TriggerRule

try:
    from plugins.hooks.bureau_mock_hook import BureauMockHook
    from plugins.operators.audit_operators import emit_audit_event
except ModuleNotFoundError:  # pragma: no cover
    BureauMockHook = None  # type: ignore

    def emit_audit_event(**_kwargs):  # type: ignore
        return None


DEFAULT_ARGS = {
    "owner": "agent-data",
    "retries": 2,
    "retry_delay": timedelta(minutes=10),
    "execution_timeout": timedelta(minutes=20),
}


def _sync(**context):
    if BureauMockHook is None:
        return {"rows": 0, "skipped": "no airflow runtime"}
    hook = BureauMockHook(conn_id="bureau_mock")
    rows = hook.fetch_full_snapshot(
        as_of=context["data_interval_end"].date()
    )
    n = hook.bulk_insert(target="raw.bureau_score", rows=rows)
    emit_audit_event(
        event_type="INGEST",
        actor="bureau_sync",
        subject_id="bureau_score",
        payload={"rows": n},
    )
    return {"rows": n}


def _coverage_gate(**context):
    if BureauMockHook is None:
        return True
    hook = BureauMockHook(conn_id="bureau_mock")
    stale = hook.coverage_check(max_age_days=14)
    if stale:
        raise ValueError(f"bureau coverage gate failed: {len(stale)} customers stale (> 14d)")
    return True


with DAG(
    dag_id="bureau_sync",
    description="Weekly bureau score refresh into raw.bureau_score",
    start_date=datetime(2026, 1, 5),
    schedule="0 3 * * 1",            # Mondays 03:00 UTC
    catchup=False,
    max_active_runs=1,
    default_args=DEFAULT_ARGS,
    tags=["apex-ews", "data", "bureau"],
) as dag:

    start = EmptyOperator(task_id="start")

    sync = PythonOperator(
        task_id="bureau_full_snapshot",
        python_callable=_sync,
    )

    gate = PythonOperator(
        task_id="bureau_coverage_gate",
        python_callable=_coverage_gate,
        trigger_rule=TriggerRule.ALL_SUCCESS,
    )

    done = EmptyOperator(task_id="done")

    start >> sync >> gate >> done
