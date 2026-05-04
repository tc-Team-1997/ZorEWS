"""pd_retrain_monthly DAG — monthly PD model retrain + drift check.

Schedule: 1st of the month, 03:00 UTC. Owns the live retraining cadence
called out in Module 4 of the development plan.

Pipeline:
    1. wait_for_marts  — gate on feature_build's daily run finishing.
    2. dbt_refresh     — dbt deps + run + test (full mart refresh, not the
                          incremental nightly one). Skip via env var if a
                          partial-refresh policy is active.
    3. retrain         — python -m ml.scripts.run_retrain --notify
                          → trains, computes drift, writes summary, posts
                          notification.
    4. publish_audit   — emit a TRAINING audit event with new_version +
                          AUC, signed via the audit trigger downstream.
    5. challenger_only — print the registry status. Promotion is manual
                          via `python -m ml.registry.cli promote` after a
                          model risk-management review (per
                          docs/model-risk-management.md).

If the retrain step exits non-zero (AUC below gate), the DAG fails — the
champion is left in place and ops gets paged via the BFF notification +
the Airflow alert.
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


REPO_ROOT = os.environ.get("APEX_REPO_ROOT", "/opt/airflow/repo")
DBT_PROJECT_DIR = os.environ.get("DBT_PROJECT_DIR", "/opt/airflow/dbt/apex_ews")
DBT_PROFILES_DIR = os.environ.get("DBT_PROFILES_DIR", "/opt/airflow/dbt")
SKIP_DBT_REFRESH = os.environ.get("PD_RETRAIN_SKIP_DBT", "0") == "1"

# AUC gate is configurable so SRE can tighten/loosen without a code push.
AUC_GATE = os.environ.get("PD_RETRAIN_AUC_GATE", "0.78")

DEFAULT_ARGS = {
    "owner": "agent-ai",
    "retries": 1,
    "retry_delay": timedelta(minutes=15),
    "execution_timeout": timedelta(hours=2),
    "depends_on_past": False,
    "email_on_failure": False,  # we ping the BFF bell instead
}


def _publish_training(**context):
    ti = context["ti"]
    summary_json = ti.xcom_pull(task_ids="retrain", key="return_value") or "{}"
    emit_audit_event(
        event_type="TRAINING",
        actor="pd_retrain_monthly",
        subject_id="ml.model.pd_xgboost",
        payload={"summary": summary_json, "schedule": "monthly"},
    )


with DAG(
    dag_id="pd_retrain_monthly",
    description="Monthly PD model retrain — train, drift-check, register as challenger.",
    default_args=DEFAULT_ARGS,
    schedule_interval="0 3 1 * *",  # 03:00 UTC on the 1st of every month
    start_date=datetime(2026, 1, 1),
    catchup=False,
    max_active_runs=1,
    tags=["ml", "pd", "monthly"],
) as dag:

    start = EmptyOperator(task_id="start")

    wait_for_marts = ExternalTaskSensor(
        task_id="wait_for_marts",
        external_dag_id="feature_build",
        external_task_id=None,  # entire feature_build DAG must succeed
        mode="reschedule",
        poke_interval=600,
        timeout=60 * 60 * 4,  # give the daily DAG up to 4h to finish
        allowed_states=["success"],
        failed_states=["failed", "upstream_failed"],
        execution_date_fn=lambda exec_date: exec_date,
    )

    if SKIP_DBT_REFRESH:
        dbt_refresh = EmptyOperator(task_id="dbt_refresh_skipped")
    else:
        dbt_refresh = BashOperator(
            task_id="dbt_refresh",
            bash_command=(
                f"cd {DBT_PROJECT_DIR} "
                f"&& DBT_PROFILES_DIR={DBT_PROFILES_DIR} dbt deps "
                f"&& DBT_PROFILES_DIR={DBT_PROFILES_DIR} dbt run "
                f"&& DBT_PROFILES_DIR={DBT_PROFILES_DIR} dbt test"
            ),
        )

    retrain = BashOperator(
        task_id="retrain",
        bash_command=(
            f"cd {REPO_ROOT} && python -m ml.scripts.run_retrain "
            f"--auc-gate {AUC_GATE} --skip-dbt --notify"
        ),
        do_xcom_push=True,
    )

    publish_audit = PythonOperator(
        task_id="publish_audit",
        python_callable=_publish_training,
        trigger_rule=TriggerRule.ALL_DONE,  # fire even on retrain failure so the audit log is honest
    )

    end = EmptyOperator(task_id="end")

    start >> wait_for_marts >> dbt_refresh >> retrain >> publish_audit >> end
