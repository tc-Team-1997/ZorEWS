# `ml/` — APEX EWS AI Risk Scoring (agent-ai)

End-to-end Probability-of-Default model + serving + drift monitoring.

## Layout

```
ml/
  data/                Synthetic data + mart-loading stub
    generate_synthetic.py
    load_from_mart.py
    README.md
  pipelines/           Training (XGBoost + isotonic calibration + SHAP)
    features.py        Encoding, used by training and serving
    train_pd.py        Main training entrypoint (writes metrics.json)
  models/pd/           Trained artifacts versioned per-folder
    v0.1.0/            Created by train_pd.py
  registry/            JSON-backed model registry + CLI
    registry.py
    cli.py
    registry.json      Source of truth (initially [])
  monitoring/          Drift CLI
    drift.py
    perturb_for_test.py
  docs/
    model-risk-management.md
```

## Bootstrap (in order)

```bash
# 1. Make synthetic data (placeholder for mart.customer_360)
python ml/data/generate_synthetic.py --out ml/data --n 5000 --seed 42

# 2. Train + auto-register as challenger
python ml/pipelines/train_pd.py
# -> ml/models/pd/v0.1.0/{model.joblib, metrics.json, shap_explainer.joblib, ...}

# 3. Promote to champion
python -m ml.registry.cli promote --name pd_xgboost --version 0.1.0

# 4. Inspect
python -m ml.registry.cli list
python -m ml.registry.cli get-champion --name pd_xgboost
cat ml/models/pd/v0.1.0/metrics.json | python -m json.tool

# 5. Drift smoke test (perturbed copy)
python -m ml.monitoring.perturb_for_test \
    --in  ml/data/synthetic_train.parquet \
    --out ml/data/synthetic_train_perturbed.parquet \
    --feature utilization --shift 0.25
python -m ml.monitoring.drift \
    --reference ml/data/synthetic_train.parquet \
    --current   ml/data/synthetic_train_perturbed.parquet \
    --model-dir ml/models/pd/v0.1.0 \
    --out ml/monitoring/drift_smoke.json

# 6. Service tests
cd services/ai-copilot-svc && pytest -q
```

## Definition of Done (Phase 2 scope)

- [x] PD training pipeline (XGBoost) — `ml/pipelines/train_pd.py`
- [x] SHAP explainer + reason-code payload — `services/ai-copilot-svc/app/scoring.py`
- [x] Model registry + champion/challenger flag — `ml/registry/`
- [x] Drift monitor (data, prediction, performance) — `ml/monitoring/drift.py`
- [x] MRM doc — `ml/docs/model-risk-management.md`
- [x] FastAPI scoring service — `services/ai-copilot-svc/`

The `python ml/pipelines/train_pd.py` step **enforces a hard floor of holdout
AUC >= 0.78** (the script exits non-zero otherwise). With the engineered
synthetic dataset (`seed=42`, `n=5000`) AUC typically lands ~0.85.
