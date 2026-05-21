"""feature_store_backfill DAG — daily incremental backfill of the 24-month
feature_store layer (T2.1 Year-2 Theme E).

Closes the operational glue for T2.1.3 — the Aurora-backed PgFeatureStore
+ dbt incremental model are already in repo; this DAG schedules the daily
run so feature_store.feature_values accumulates rolling 24 months of
point-in-time feature snapshots.

Schedule: 06:30 IST (01:00 UTC), 30min after feature_build completes.
Depends on: feature_build (mart layer must be fresh first).

Pipeline:
    1. wait_for_marts          — gate on feature_build's daily success
    2. dbt_run_backfill        — dbt run --select feat_values_backfill
                                  (incremental delete+insert per
                                  data/dbt/models/feature_store/)
    3. dbt_test_backfill       — assert row count grows monotonically,
                                  no PII leak (tenure_months bound check)
    4. retention_purge         — DELETE feature_values WHERE observed_at
                                  < NOW() - INTERVAL '24 months'
    5. s3_offline_sync         — copy mart's latest snapshot to
                                  s3://apex-ews-curated/feature_store/
                                  for historical analytics beyond 24mo
    6. publish_audit           — emit feature_store.backfilled audit event

If dbt_test fails, the DAG raises and the BFF feature_store route falls
back to SynthFeatureStore via the graceful-degradation path in
services/bff/src/feature_store.ts.
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

DBT_PROJECT_DIR = os.environ.get(
    "DBT_PROJECT_DIR",
    "/opt/airflow/dags/repo/data/dbt",
)
RETENTION_DAYS = int(os.environ.get("FEATURE_STORE_RETENTION_DAYS", "744"))  # 24*31
CURATED_BUCKET = os.environ.get(
    "FEATURE_STORE_CURATED_BUCKET",
    "apex-ews-prod-curated",
)

default_args = {
    "owner": "agent-data",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "email_on_failure": True,
    "email": [os.environ.get("DATA_TEAM_EMAIL", "data@apex-ews.example")],
}


with DAG(
    dag_id="feature_store_backfill",
    default_args=default_args,
    description="Daily incremental backfill of feature_store.feature_values (T2.1)",
    schedule_interval="0 1 * * *",  # 06:30 IST daily
    start_date=datetime(2026, 5, 21),
    catchup=False,
    max_active_runs=1,
    tags=["feature-store", "t2.1", "year-2-theme-e"],
) as dag:

    wait_for_marts = ExternalTaskSensor(
        task_id="wait_for_marts",
        external_dag_id="feature_build",
        external_task_id="publish",
        poke_interval=60,
        timeout=3600,
        mode="reschedule",
    )

    dbt_run_backfill = BashOperator(
        task_id="dbt_run_backfill",
        bash_command=f"""
            cd {DBT_PROJECT_DIR}
            dbt deps --no-version-check
            dbt run --select feat_values_backfill --profiles-dir .
        """,
        env={"DBT_TARGET": os.environ.get("DBT_TARGET", "prod")},
    )

    dbt_test_backfill = BashOperator(
        task_id="dbt_test_backfill",
        bash_command=f"""
            cd {DBT_PROJECT_DIR}
            dbt test --select feat_values_backfill --profiles-dir .
        """,
    )

    def _retention_purge(**context):
        """DELETE rows older than RETENTION_DAYS days. Logs purged row count."""
        from airflow.providers.postgres.hooks.postgres import PostgresHook

        hook = PostgresHook(postgres_conn_id="aurora_writer")
        sql = f"""
            DELETE FROM feature_store.feature_values
            WHERE observed_at < NOW() - INTERVAL '{RETENTION_DAYS} days'
            RETURNING tenant_id;
        """
        rows = hook.get_records(sql)
        purged = len(rows)
        context["ti"].xcom_push(key="purged_count", value=purged)
        print(f"Purged {purged} rows older than {RETENTION_DAYS} days")
        return purged

    retention_purge = PythonOperator(
        task_id="retention_purge",
        python_callable=_retention_purge,
        provide_context=True,
    )

    s3_offline_sync = BashOperator(
        task_id="s3_offline_sync",
        bash_command=f"""
            cd {DBT_PROJECT_DIR}
            # Export the day's incremental rows to parquet via dbt run-operation
            dbt run-operation export_feature_store_to_s3 \\
                --args '{{"bucket": "{CURATED_BUCKET}", "prefix": "feature_store/dt={{{{ ds }}}}"}}' \\
                --profiles-dir .
        """,
        trigger_rule=TriggerRule.NONE_FAILED,  # run even if retention_purge had no rows
    )

    def _publish_audit(**context):
        purged = context["ti"].xcom_pull(task_ids="retention_purge", key="purged_count")
        emit_audit_event(
            action="feature_store.backfilled",
            resource_type="feature_store",
            resource_id="feature_values",
            metadata={
                "purged_rows": purged,
                "retention_days": RETENTION_DAYS,
                "execution_date": context["ds"],
            },
        )

    publish_audit = PythonOperator(
        task_id="publish_audit",
        python_callable=_publish_audit,
        provide_context=True,
        trigger_rule=TriggerRule.ALL_SUCCESS,
    )

    end = EmptyOperator(task_id="end", trigger_rule=TriggerRule.ALL_SUCCESS)

    (
        wait_for_marts
        >> dbt_run_backfill
        >> dbt_test_backfill
        >> retention_purge
        >> s3_offline_sync
        >> publish_audit
        >> end
    )
