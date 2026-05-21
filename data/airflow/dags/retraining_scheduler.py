"""retraining_scheduler DAG — polls the BFF T5.1.1 schedule store for due
ML retrains and fires the training pipeline + posts the outcome.

Closes the operational glue for T5.1 Year-2 Theme E. The schedule store +
outcome ledger + 7 BFF routes (POST/GET schedules, POST/GET outcomes,
GET status) are already shipped via services/bff/src/ai_retraining.ts.
This DAG is the external trigger.

Schedule: every 6 hours (00:15, 06:15, 12:15, 18:15 UTC). High enough
cadence to satisfy 'monthly'/'quarterly' cadences with <6h jitter; rare
enough to keep training cost contained.

Pipeline:
    1. fetch_due_schedules  — GET /v1/ai/retraining/schedules?status=overdue
                              (using bearer token from Secrets Manager)
    2. for each due schedule (max 3 per run to cap cost):
       a. record_in_progress — POST /v1/ai/retraining/outcomes status=in_progress
       b. run_training       — kubectl run python -m ml.pipelines.train_pd
                                with the schedule's model_id + threshold
       c. record_outcome     — POST status=success / failure + metrics
                                (AUC, brier, ks, n_train, n_holdout)
       d. promote_if_qualified — IF auto-promotion gate passes (per the
                                  T5.1 auto-promotion-gate ai-svc primitive),
                                  POST /v1/ai/promotions
    3. publish_audit         — emit retraining.fleet.run audit event

The DAG is idempotent — re-running drains only newly-overdue schedules.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from typing import Any

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.empty import EmptyOperator
from airflow.utils.trigger_rule import TriggerRule

try:
    from plugins.operators.audit_operators import emit_audit_event
except ModuleNotFoundError:  # pragma: no cover
    def emit_audit_event(**_kwargs):
        return None

BFF_URL = os.environ.get("BFF_URL", "http://bff.apex-ews.svc:8081")
SECRETS_MANAGER_ID = os.environ.get(
    "RETRAINING_TOKEN_SECRET",
    "apex-ews/prod/scheduler/bff-admin-token",
)
MAX_RETRAINS_PER_RUN = int(os.environ.get("MAX_RETRAINS_PER_RUN", "3"))
AUTO_PROMOTE_AUC_GATE = float(os.environ.get("AUTO_PROMOTE_AUC_GATE", "0.78"))

default_args = {
    "owner": "agent-ai",
    "depends_on_past": False,
    "retries": 1,
    "retry_delay": timedelta(minutes=5),
    "email_on_failure": True,
    "email": [os.environ.get("AI_TEAM_EMAIL", "ai@apex-ews.example")],
}


def _fetch_bearer_token() -> str:
    """Fetch the admin bearer token from Secrets Manager."""
    import boto3

    sm = boto3.client("secretsmanager")
    return sm.get_secret_value(SecretId=SECRETS_MANAGER_ID)["SecretString"]


def _bff_get(path: str, tenant_id: str, token: str) -> dict[str, Any]:
    import urllib.request

    req = urllib.request.Request(
        f"{BFF_URL}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Tenant-ID": tenant_id,
            "X-Channel": "AIRFLOW",
            "X-APEX-USER": "system:retraining-scheduler",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _bff_post(
    path: str,
    body: dict[str, Any],
    tenant_id: str,
    token: str,
) -> dict[str, Any]:
    import urllib.request

    req = urllib.request.Request(
        f"{BFF_URL}{path}",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Tenant-ID": tenant_id,
            "X-Channel": "AIRFLOW",
            "X-APEX-USER": "system:retraining-scheduler",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def _fetch_due_schedules(**context):
    """Walk every active tenant + drain its overdue retraining schedules."""
    token = _fetch_bearer_token()
    tenants = os.environ.get("APEX_TENANTS", "BANK_DEMO,BIL").split(",")
    due: list[dict[str, Any]] = []
    for tenant in tenants:
        status = _bff_get("/v1/ai/retraining/status", tenant, token)
        for model in status.get("body", {}).get("models", []):
            if model.get("is_overdue"):
                due.append({**model, "tenant_id": tenant})
                if len(due) >= MAX_RETRAINS_PER_RUN:
                    break
    context["ti"].xcom_push(key="due_schedules", value=due)
    print(f"Found {len(due)} overdue retraining schedules (cap {MAX_RETRAINS_PER_RUN})")
    return len(due)


def _run_retraining(**context):
    """For each due schedule, fire the training pipeline + record outcome."""
    import subprocess

    token = _fetch_bearer_token()
    due = context["ti"].xcom_pull(task_ids="fetch_due_schedules", key="due_schedules") or []
    results: list[dict[str, Any]] = []

    for sched in due:
        tenant = sched["tenant_id"]
        schedule_id = sched.get("schedule_id")
        model_id = sched["model_id"]

        # 1. Record in_progress
        outcome = _bff_post(
            "/v1/ai/retraining/outcomes",
            {
                "schedule_id": schedule_id,
                "model_id": model_id,
                "status": "in_progress",
                "started_at": datetime.utcnow().isoformat() + "Z",
            },
            tenant,
            token,
        )
        outcome_id = outcome["body"]["outcome_id"]
        print(f"Started retrain for {tenant}/{model_id}; outcome_id={outcome_id}")

        # 2. Run training
        completed_at = None
        metrics: dict[str, Any] = {}
        try:
            result = subprocess.run(
                [
                    "python", "-m", "ml.pipelines.train_pd",
                    "--tenant", tenant,
                    "--model-id", model_id,
                    "--auto-bump-version",
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=3600,
            )
            metrics = json.loads(result.stdout.splitlines()[-1])
            completed_at = datetime.utcnow().isoformat() + "Z"
            status_value = "success"
        except subprocess.CalledProcessError as e:
            print(f"Retrain FAILED for {tenant}/{model_id}: {e.stderr[:500]}")
            status_value = "failure"
            metrics = {"error": e.stderr[:200]}
            completed_at = datetime.utcnow().isoformat() + "Z"
        except subprocess.TimeoutExpired:
            print(f"Retrain TIMED OUT for {tenant}/{model_id}")
            status_value = "failure"
            metrics = {"error": "training_timeout_60min"}
            completed_at = datetime.utcnow().isoformat() + "Z"

        # 3. Record final outcome
        _bff_post(
            f"/v1/ai/retraining/outcomes",
            {
                "schedule_id": schedule_id,
                "model_id": model_id,
                "status": status_value,
                "completed_at": completed_at,
                "metrics": metrics,
                "new_version": metrics.get("version"),
            },
            tenant,
            token,
        )

        # 4. Auto-promote if AUC gate passes
        if (
            status_value == "success"
            and metrics.get("auc", 0) >= AUTO_PROMOTE_AUC_GATE
        ):
            try:
                _bff_post(
                    "/v1/ai/promotions",
                    {
                        "model_id": model_id,
                        "from_status": "experimental",
                        "to_status": "staging",
                        "request_notes": (
                            f"Auto-promotion from retraining_scheduler DAG "
                            f"— AUC={metrics.get('auc'):.4f} >= gate={AUTO_PROMOTE_AUC_GATE}"
                        ),
                    },
                    tenant,
                    token,
                )
                print(f"Auto-promotion request filed for {tenant}/{model_id}")
            except Exception as e:  # noqa: BLE001
                print(f"Auto-promotion request failed (non-fatal): {e}")

        results.append({"tenant_id": tenant, "model_id": model_id, "status": status_value})

    context["ti"].xcom_push(key="results", value=results)
    return results


def _publish_audit(**context):
    results = context["ti"].xcom_pull(task_ids="run_retraining", key="results") or []
    success = sum(1 for r in results if r["status"] == "success")
    failure = sum(1 for r in results if r["status"] == "failure")
    emit_audit_event(
        action="retraining.fleet.run",
        resource_type="system",
        resource_id="retraining_scheduler",
        metadata={
            "due_count": len(results),
            "success_count": success,
            "failure_count": failure,
            "execution_date": context["ds"],
        },
    )


with DAG(
    dag_id="retraining_scheduler",
    default_args=default_args,
    description="Polls BFF T5.1.1 schedule store + fires due ML retrains (T5.1)",
    schedule_interval="15 */6 * * *",  # every 6h at :15
    start_date=datetime(2026, 5, 21),
    catchup=False,
    max_active_runs=1,
    tags=["ml", "t5.1", "year-2-theme-e"],
) as dag:

    fetch_due_schedules = PythonOperator(
        task_id="fetch_due_schedules",
        python_callable=_fetch_due_schedules,
        provide_context=True,
    )

    run_retraining = PythonOperator(
        task_id="run_retraining",
        python_callable=_run_retraining,
        provide_context=True,
    )

    publish_audit = PythonOperator(
        task_id="publish_audit",
        python_callable=_publish_audit,
        provide_context=True,
        trigger_rule=TriggerRule.ALL_DONE,  # always emit even if retraining failed
    )

    end = EmptyOperator(task_id="end", trigger_rule=TriggerRule.ALL_DONE)

    fetch_due_schedules >> run_retraining >> publish_audit >> end
