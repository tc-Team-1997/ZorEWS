"""
feature_build DAG — daily mart build (customer_360, loan_360, txn_features).

Triggered after cbs_ingestion completes successfully.
Pipeline:
    1. dbt deps   — install packages.
    2. dbt seed   — only on full refresh (skipped daily).
    3. dbt run    — staging + marts.
    4. dbt test   — schema + dbt_expectations checks. Failure short-circuits.
    5. publish    — emit feature-table refreshed event.

The dbt-test step is the **quality gate**. If it fails, the DAG raises and
downstream consumers (indicator-engine, alert-engine) are not notified.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.bash import BashOperator
from airflow.operators.python import PythonOperator
from airflow.operators.empty import EmptyOperator
from airflow.sensors.external_task import ExternalTaskSensor
from airflow.utils.trigger_rule import TriggerRule

try:
    from plugins.operators.audit_operators import emit_audit_event
except ModuleNotFoundError:  # pragma: no cover

    def emit_audit_event(**_kwargs):
        return None


DBT_PROJECT_DIR  = os.environ.get("DBT_PROJECT_DIR",  "/opt/airflow/dbt/apex_ews")
DBT_PROFILES_DIR = os.environ.get("DBT_PROFILES_DIR", "/opt/airflow/dbt")

DEFAULT_ARGS = {
    "owner": "agent-data",
    "retries": 1,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(minutes=30),
}


def _publish(**context):
    emit_audit_event(
        event_type="TRANSFORM",
        actor="feature_build",
        subject_id="mart.customer_360",
        payload={"run_id": context["run_id"], "ds": str(context["ds"])},
    )
    return {"published": True}


with DAG(
    dag_id="feature_build",
    description="dbt run + test producing mart.customer_360 / loan_360 / txn_features",
    start_date=datetime(2026, 1, 1),
    schedule="0 3 * * *",
    catchup=False,
    max_active_runs=1,
    default_args=DEFAULT_ARGS,
    tags=["apex-ews", "data", "mart"],
) as dag:

    start = EmptyOperator(task_id="start")

    wait_for_ingest = ExternalTaskSensor(
        task_id="wait_for_cbs_ingestion",
        external_dag_id="cbs_ingestion",
        external_task_id="done",
        execution_delta=timedelta(hours=1),
        mode="reschedule",
        timeout=60 * 60,
        poke_interval=60,
    )

    dbt_deps = BashOperator(
        task_id="dbt_deps",
        bash_command=(
            f"cd {DBT_PROJECT_DIR} && "
            f"dbt deps --profiles-dir {DBT_PROFILES_DIR}"
        ),
    )

    dbt_run = BashOperator(
        task_id="dbt_run",
        bash_command=(
            f"cd {DBT_PROJECT_DIR} && "
            f"dbt run --profiles-dir {DBT_PROFILES_DIR} "
            f"--select staging+ marts"
        ),
    )

    dbt_test = BashOperator(
        task_id="dbt_test_quality_gate",
        bash_command=(
            f"cd {DBT_PROJECT_DIR} && "
            f"dbt test --profiles-dir {DBT_PROFILES_DIR} "
            f"--select staging marts"
        ),
        # ALL_SUCCESS so a failed dbt run aborts the test step too.
        trigger_rule=TriggerRule.ALL_SUCCESS,
    )

    publish = PythonOperator(
        task_id="publish_mart_refresh_event",
        python_callable=_publish,
        trigger_rule=TriggerRule.ALL_SUCCESS,
    )

    done = EmptyOperator(task_id="done")

    start >> wait_for_ingest >> dbt_deps >> dbt_run >> dbt_test >> publish >> done
