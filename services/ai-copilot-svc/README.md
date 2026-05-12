# ai-copilot-svc

FastAPI service for the ZorEWS PD (Probability of Default) model.

## Endpoints

| Method | Path             | Purpose |
|--------|------------------|---------|
| POST   | `/score`         | Single-customer score: `{pd, level, top_reasons[], model_version}`. |
| POST   | `/score/batch`   | List of customers; returns one score per customer. |
| GET    | `/model/info`    | Champion (and challenger if any) + level bands. |
| GET    | `/health`        | Liveness + whether a champion is loaded. |

### `POST /score` — request

```json
{
  "customer_id": "CUST0000001",
  "utilization": 0.55,
  "dpd_max_90d": 12.0,
  "balance_drop_30d_pct": -8.0,
  "bureau_score": 640.0,
  "repayment_delay_streak": 1,
  "txn_volume_zscore_90d": -0.5,
  "tenure_months": 18,
  "product_type": "personal_loan",
  "income_bucket": "lower_mid"
}
```

### `POST /score` — response

```json
{
  "customer_id": "CUST0000001",
  "pd": 0.184,
  "level": "Medium",
  "top_reasons": [
    {"feature": "bureau_score", "value": 640.0, "shap_value": 0.42, "direction": "positive"},
    {"feature": "utilization",  "value": 0.55,  "shap_value": 0.31, "direction": "positive"},
    {"feature": "dpd_max_90d",  "value": 12.0,  "shap_value": 0.18, "direction": "positive"},
    {"feature": "tenure_months","value": 18,    "shap_value": -0.12, "direction": "negative"},
    {"feature": "product_type=personal_loan", "value": "personal_loan", "shap_value": 0.09, "direction": "positive"}
  ],
  "model_name": "pd_xgboost",
  "model_version": "0.1.0"
}
```

`direction = "positive"` means the feature **increases** PD. UI should render
positives in red, negatives in green (consistent with DMS semantic tokens).

## Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `APEX_REGISTRY_PATH` | `ml/registry/registry.json` | Where the JSON registry lives. |
| `APEX_MODEL_NAME` | `pd_xgboost` | Logical model name to load champion for. |
| `APEX_LEVEL_LOW_MAX` | `0.05` | PD < this -> Low. |
| `APEX_LEVEL_HIGH_MIN` | `0.20` | PD >= this -> High. Otherwise Medium. |
| `LOG_LEVEL` | `INFO` | Logging level. |

## Run locally

```bash
# 1. Generate synthetic data + train model (writes ml/models/pd/v0.1.0/).
python ml/data/generate_synthetic.py
python ml/pipelines/train_pd.py

# 2. Promote the just-trained challenger to champion.
python -m ml.registry.cli promote --name pd_xgboost --version 0.1.0

# 3. Serve.
cd services/ai-copilot-svc
uvicorn app.main:app --reload --port 8080
```

Then `curl http://localhost:8080/health`.

## Tests

```bash
cd services/ai-copilot-svc
pytest -q
```

The fixtures in `tests/conftest.py` build a tiny throwaway model + registry,
so the suite does not depend on `ml/models/pd/v0.1.0` having been trained.

## Champion / challenger

If the registry has both a champion and a challenger for the same `name`, the
service returns the **champion** score and **shadow-scores** the request
through the challenger, logging the divergence. To promote the challenger:

```bash
python -m ml.registry.cli promote --name pd_xgboost --version <new-version>
```

## Docker

```bash
# From the repo root.
docker build -f services/ai-copilot-svc/Dockerfile -t apex-ai-copilot-svc:dev .
docker run --rm -p 8080:8080 \
  -v "$PWD/ml:/app/ml" \
  apex-ai-copilot-svc:dev
```
