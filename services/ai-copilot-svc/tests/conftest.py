"""Pytest fixtures: build a tiny model on the fly, register it, mount the app."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "services" / "ai-copilot-svc"))

from ml.pipelines.features import encode, encoded_columns  # noqa: E402
from ml.registry.registry import Registry  # noqa: E402


def _build_test_model(out_dir: Path):
    """Train a tiny model on a small synthetic frame so tests stay fast."""
    from sklearn.calibration import CalibratedClassifierCV
    import xgboost as xgb

    rng = np.random.default_rng(0)
    n = 800
    df = pd.DataFrame(
        {
            "customer_id": [f"T{idx:05d}" for idx in range(n)],
            "utilization": np.clip(rng.beta(2, 3, n), 0, 1).astype(np.float32),
            "dpd_max_90d": np.clip(rng.gamma(1.2, 8.0, n), 0, 90).astype(np.float32),
            "balance_drop_30d_pct": np.clip(rng.normal(0, 15, n), -80, 80).astype(np.float32),
            "bureau_score": np.clip(rng.normal(680, 70, n), 300, 900).astype(np.float32),
            "repayment_delay_streak": np.clip(rng.poisson(0.6, n), 0, 12).astype(np.int16),
            "txn_volume_zscore_90d": np.clip(rng.normal(0, 1, n), -4, 4).astype(np.float32),
            "tenure_months": np.clip(rng.gamma(2, 18, n), 1, 240).astype(np.int16),
            "product_type": rng.choice(
                ["personal_loan", "credit_card", "auto_loan", "mortgage", "sme_loan"], n
            ),
            "income_bucket": rng.choice(
                ["low", "lower_mid", "mid", "upper_mid", "high"], n
            ),
        }
    )
    latent = (
        (df["utilization"] - 0.4) * 4.0
        + (df["dpd_max_90d"] / 30.0) * 2.5
        - ((df["bureau_score"] - 680.0) / 70.0) * 1.8
        + df["repayment_delay_streak"] * 0.6
        - (df["balance_drop_30d_pct"] / 30.0)
    )
    p = 1.0 / (1.0 + np.exp(-(latent - 2.0)))
    df["defaulted_within_60d"] = (rng.uniform(size=n) < p).astype(int)

    X = encode(df)
    y = df["defaulted_within_60d"].to_numpy()

    base = xgb.XGBClassifier(
        objective="binary:logistic",
        n_estimators=120,
        max_depth=4,
        learning_rate=0.1,
        eval_metric="auc",
        random_state=0,
        tree_method="hist",
    )
    cal = CalibratedClassifierCV(estimator=base, method="isotonic", cv=3)
    cal.fit(X, y)

    raw = xgb.XGBClassifier(
        objective="binary:logistic",
        n_estimators=120,
        max_depth=4,
        learning_rate=0.1,
        eval_metric="auc",
        random_state=0,
        tree_method="hist",
    )
    raw.fit(X, y)

    import shap

    explainer = shap.TreeExplainer(raw)

    out_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(cal, out_dir / "model.joblib")
    raw.get_booster().save_model(str(out_dir / "xgb_booster.json"))
    joblib.dump(explainer, out_dir / "shap_explainer.joblib")
    metrics = {
        "model_name": "pd_xgboost",
        "version": "0.0.1-test",
        "auc_holdout": 0.85,
        "feature_columns": encoded_columns(),
    }
    (out_dir / "metrics.json").write_text(json.dumps(metrics))


@pytest.fixture(scope="session")
def model_artifacts(tmp_path_factory):
    art = tmp_path_factory.mktemp("model") / "v0.0.1-test"
    _build_test_model(art)
    return art


@pytest.fixture(scope="session")
def registry_path(tmp_path_factory, model_artifacts):
    reg_path = tmp_path_factory.mktemp("reg") / "registry.json"
    reg = Registry(reg_path)
    reg.register(
        name="pd_xgboost",
        version="0.0.1-test",
        metrics={"auc_holdout": 0.85},
        artifact_path=str(model_artifacts),
        status="champion",
    )
    return reg_path


@pytest.fixture()
def client(registry_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("APEX_REGISTRY_PATH", str(registry_path))
    monkeypatch.setenv("APEX_MODEL_NAME", "pd_xgboost")
    monkeypatch.setenv("APEX_LEVEL_LOW_MAX", "0.05")
    monkeypatch.setenv("APEX_LEVEL_HIGH_MIN", "0.20")

    # Reload modules so env-var-driven thresholds take effect for this client.
    import importlib

    if "app.scoring" in sys.modules:
        importlib.reload(sys.modules["app.scoring"])
    if "app.main" in sys.modules:
        importlib.reload(sys.modules["app.main"])
    import app.main as main_mod  # noqa: WPS433

    with TestClient(main_mod.app) as c:
        yield c


@pytest.fixture()
def sample_customer():
    return {
        "customer_id": "TEST001",
        "utilization": 0.55,
        "dpd_max_90d": 12.0,
        "balance_drop_30d_pct": -8.0,
        "bureau_score": 640.0,
        "repayment_delay_streak": 1,
        "txn_volume_zscore_90d": -0.5,
        "tenure_months": 18,
        "product_type": "personal_loan",
        "income_bucket": "lower_mid",
    }
