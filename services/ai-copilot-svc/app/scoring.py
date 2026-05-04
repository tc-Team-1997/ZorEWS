"""Scoring + reason-code logic for the ai-copilot-svc.

The model bundle is loaded from the path the registry's champion entry points
at. We keep a thin loader so unit tests can swap in a stub model directory.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

# Repo-root-relative imports work regardless of CWD when launched via uvicorn,
# because we add the repo root to sys.path in app.main.
from ml.pipelines.features import encode, encoded_columns, encoded_to_human


# ----------------------------------------------------------------------
# Risk level bands
# ----------------------------------------------------------------------
def _env_float(name: str, default: float) -> float:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    try:
        return float(val)
    except ValueError as exc:
        raise RuntimeError(f"Env {name} must be float, got {val!r}") from exc


LOW_THRESHOLD = _env_float("APEX_LEVEL_LOW_MAX", 0.05)   # PD < this -> Low
HIGH_THRESHOLD = _env_float("APEX_LEVEL_HIGH_MIN", 0.20)  # PD >= this -> High


def band(pd_value: float) -> str:
    """Map a PD into Low / Medium / High."""
    if pd_value < LOW_THRESHOLD:
        return "Low"
    if pd_value >= HIGH_THRESHOLD:
        return "High"
    return "Medium"


# ----------------------------------------------------------------------
# Bundle loader
# ----------------------------------------------------------------------
@dataclass
class ModelBundle:
    name: str
    version: str
    artifact_path: Path
    model: object        # CalibratedClassifierCV
    explainer: object    # shap.TreeExplainer
    metrics: dict
    feature_columns: List[str]


def load_bundle(name: str, version: str, artifact_path: str) -> ModelBundle:
    import joblib

    art = Path(artifact_path)
    model = joblib.load(art / "model.joblib")
    explainer_path = art / "shap_explainer.joblib"
    explainer = joblib.load(explainer_path) if explainer_path.exists() else None
    metrics_path = art / "metrics.json"
    metrics = json.loads(metrics_path.read_text()) if metrics_path.exists() else {}
    feature_cols = metrics.get("feature_columns") or encoded_columns()
    return ModelBundle(
        name=name,
        version=version,
        artifact_path=art,
        model=model,
        explainer=explainer,
        metrics=metrics,
        feature_columns=feature_cols,
    )


# ----------------------------------------------------------------------
# Scoring + SHAP reasoning
# ----------------------------------------------------------------------
def _shap_for_row(bundle: ModelBundle, row_encoded: pd.DataFrame) -> Optional[np.ndarray]:
    if bundle.explainer is None:
        return None
    try:
        sv = bundle.explainer.shap_values(row_encoded)
    except Exception:
        return None
    if isinstance(sv, list):
        # Older SHAP returned a list of [neg_class_shap, pos_class_shap]
        sv = sv[1] if len(sv) >= 2 else sv[0]
    sv = np.asarray(sv)
    if sv.ndim == 2:
        return sv[0]
    return sv


def top_reasons(
    bundle: ModelBundle,
    raw_record: dict,
    encoded_row: pd.DataFrame,
    top_k: int = 5,
) -> List[dict]:
    """Build reason-code payload using SHAP values.

    Each item: ``{feature, value, shap_value, direction}`` where direction is
    ``"positive"`` if the feature pushes PD higher, else ``"negative"``.
    """
    sv = _shap_for_row(bundle, encoded_row)
    if sv is None:
        return []

    cols = bundle.feature_columns
    # Defensive: alignment with columns.
    sv = sv[: len(cols)]

    items = []
    for col, shap_val in zip(cols, sv):
        # Look up the human-facing feature value from the raw record.
        if col in raw_record:
            value = raw_record[col]
        elif col.startswith("product_type_"):
            level = col[len("product_type_") :]
            value = level if raw_record.get("product_type") == level else None
        elif col.startswith("income_bucket_"):
            level = col[len("income_bucket_") :]
            value = level if raw_record.get("income_bucket") == level else None
        else:
            value = None
        items.append(
            {
                "feature": encoded_to_human(col),
                "value": value,
                "shap_value": float(shap_val),
                "direction": "positive" if shap_val > 0 else "negative",
            }
        )

    # Top-k by absolute SHAP magnitude.
    items.sort(key=lambda d: abs(d["shap_value"]), reverse=True)
    return items[:top_k]


def score_record(
    bundle: ModelBundle,
    record: dict,
    top_k: int = 5,
) -> dict:
    encoded = encode(pd.DataFrame([record]))
    pd_value = float(bundle.model.predict_proba(encoded)[:, 1][0])
    return {
        "customer_id": record.get("customer_id"),
        "pd": pd_value,
        "level": band(pd_value),
        "top_reasons": top_reasons(bundle, record, encoded, top_k=top_k),
        "model_name": bundle.name,
        "model_version": bundle.version,
    }


def score_batch(
    bundle: ModelBundle,
    records: Iterable[dict],
    top_k: int = 5,
) -> List[dict]:
    records = list(records)
    if not records:
        return []
    df = pd.DataFrame(records)
    encoded = encode(df)
    pd_values = bundle.model.predict_proba(encoded)[:, 1]
    out: List[dict] = []
    for i, rec in enumerate(records):
        encoded_row = encoded.iloc[[i]]
        pd_v = float(pd_values[i])
        out.append(
            {
                "customer_id": rec.get("customer_id"),
                "pd": pd_v,
                "level": band(pd_v),
                "top_reasons": top_reasons(bundle, rec, encoded_row, top_k=top_k),
                "model_name": bundle.name,
                "model_version": bundle.version,
            }
        )
    return out
