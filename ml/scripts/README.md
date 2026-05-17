# Monthly PD retrain — orchestrator + DAG

Module 4 (AI risk scoring) of the dev plan called for a **live monthly retrain
DAG**. This directory ships the orchestration; the actual model code lives in
[`ml/pipelines/train_pd.py`](../pipelines/train_pd.py).

## Pieces

| Path | What it does |
|---|---|
| [`run_retrain.py`](run_retrain.py) | Pure-Python orchestrator. Trains a fresh model with auto-bumped version, runs drift check, compares against prior champion, writes `retrain_summary.json` next to the new artifacts. |
| [`notify.py`](notify.py) | Tiny `urllib`-only POST helper that targets the BFF's `/v1/notifications/publish`. Used by the DAG to surface the outcome in the SPA bell. |
| [`../../data/airflow/dags/pd_retrain_monthly.py`](../../data/airflow/dags/pd_retrain_monthly.py) | Airflow DAG. Schedule `0 3 1 * *` (03:00 UTC, 1st of every month). |

## Pipeline (DAG view)

```
┌────────┐   ┌──────────────────┐   ┌────────────┐   ┌────────┐   ┌────────────────┐   ┌─────┐
│ start  │──▶│ wait_for_marts   │──▶│ dbt_refresh│──▶│ retrain│──▶│ publish_audit  │──▶│ end │
└────────┘   │ (ext sensor)     │   └────────────┘   └────────┘   │ (TRIG ALL_DONE)│   └─────┘
             └──────────────────┘                                  └────────────────┘
```

- **`wait_for_marts`** — `ExternalTaskSensor` on the `feature_build` DAG. Won't
  start retraining until the daily mart build for the same `execution_date`
  has succeeded.
- **`dbt_refresh`** — full `dbt deps + run + test`. Skip via `PD_RETRAIN_SKIP_DBT=1`
  if the daily incremental refresh is sufficient.
- **`retrain`** — `python -m ml.scripts.run_retrain --auc-gate $AUC_GATE --notify`.
  Exits non-zero if the new AUC is below the gate, which fails the DAG and
  leaves the previous champion in place.
- **`publish_audit`** — emits a `TRAINING` audit event regardless of retrain
  outcome (so the audit log records failures honestly).

## What the orchestrator does

```
        ┌── prior champion in registry? ──┐
        │                                 │
        ▼                                 ▼
  read prior AUC               (skip drift, skip delta)
        │                                 │
  train fresh model ◀──────────────────────┘
        │
  load metrics.json
        │
  data-drift check (PSI per feature, KS for predictions)
        │
  draft RetrainSummary {auc, gate_passed, drift_band, auc_delta}
        │
  write <out_dir>/v<new_version>/retrain_summary.json
        │
  POST notification (best-effort)
        │
  exit 0 if gate_passed else 2
```

## Promotion is intentionally manual

`run_retrain` only registers the new model **as a challenger**. Promotion to
champion is gated on a model-risk-management review (see
[`docs/model-risk-management.md`](../../docs/model-risk-management.md)) and is
done by hand with:

```bash
python -m ml.registry.cli promote --name pd_xgboost --version 0.2.0
```

This matches the policy: every champion swap goes through human review.

## Local dev — run it without Airflow

```bash
# Skip dbt + skip notification — fastest sanity check.
python -m ml.scripts.run_retrain --skip-dbt

# Same, plus push the outcome to a running BFF (port 8084 by default).
python -m ml.scripts.run_retrain --skip-dbt --notify

# With a tighter AUC gate.
python -m ml.scripts.run_retrain --auc-gate 0.85 --skip-dbt
```

## Notifications wiring

`run_retrain --notify` calls the BFF endpoint we built in the previous
session:

```
POST /v1/notifications/publish
{ "level": "warning", "title": "PD retrain v0.2.0 — DATA DRIFT detected", "body": "..." }
```

Severity rules (`_draft_notification` in [`run_retrain.py`](run_retrain.py)):

| Condition | Level |
|---|---|
| `gate_passed == false` | `danger` |
| `drift_band == "drift"` | `warning` |
| `auc_delta < -0.02` | `warning` |
| else | `success` |

The notification deep-links to `/admin/integrations` so the on-call analyst
lands on a page where they can spot-check upstream data quality before
deciding to promote.

## Tests

```bash
# 13 pytest cases — orchestrator branches + notify helper
python -m pytest ml/tests/test_run_retrain.py -v
```

These tests stub `train_pd.train` so they run in <3s. The actual training
pipeline has its own pytest suite under `ml/pipelines/__tests__/` (when present)
plus the AUC ≥ 0.78 hard gate inside `train_pd.py`.

## Env vars (DAG)

| Var | Default | Notes |
|---|---|---|
| `APEX_REPO_ROOT` | `/opt/airflow/repo` | Working dir for the retrain task |
| `DBT_PROJECT_DIR` | `/opt/airflow/dbt/zorews` | Passed to `dbt run` |
| `DBT_PROFILES_DIR` | `/opt/airflow/dbt` | dbt profiles location |
| `PD_RETRAIN_SKIP_DBT` | `0` | `1` skips the dbt_refresh task |
| `PD_RETRAIN_AUC_GATE` | `0.78` | Hard floor on holdout AUC |
| `APEX_BFF_URL` | `http://localhost:8084` | Where notifications POST |
| `APEX_BFF_ROLE` | `admin` | RBAC header sent with the POST |
| `APEX_BFF_AUTH_TOKEN` | _(unset)_ | Bearer token if BFF requires it |
