"""Drift monitoring for the PD model.

Three flavours of drift, all reported in a single JSON document:

1. **Data drift** -- Population Stability Index per numeric feature, plus a
   chi-square style PSI for categoricals.
2. **Prediction drift** -- two-sample KS test against the reference predicted
   PD distribution.
3. **Performance drift** -- rolling AUC on the current window if labels are
   present, compared to the baseline AUC (read from ``metrics.json``).

Usage::

    python -m ml.monitoring.drift \
        --reference ml/data/synthetic_train.parquet \
        --current   ml/data/synthetic_train_perturbed.parquet \
        --model-dir ml/models/pd/v0.1.0 \
        --out drift_report.json

The model dir is optional; without it, only data-drift is reported.
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ml.pipelines.features import (  # noqa: E402
    CATEGORICAL_FEATURES,
    NUMERIC_FEATURES,
    encode,
)


# PSI severity bands (industry convention).
PSI_OK = 0.10
PSI_WARN = 0.25


def _bin_edges(reference: np.ndarray, n_bins: int = 10) -> np.ndarray:
    """Quantile-based bin edges from the reference series.

    Falls back to linear bins when the reference is degenerate (all-equal).
    """
    reference = reference[~np.isnan(reference)]
    if reference.size == 0:
        return np.array([0.0, 1.0])
    quantiles = np.linspace(0.0, 1.0, n_bins + 1)
    edges = np.unique(np.quantile(reference, quantiles))
    if edges.size < 2:
        # All values identical -- create a tiny synthetic spread so PSI still defined.
        edges = np.array([reference.min() - 1e-6, reference.max() + 1e-6])
    edges[0] = -np.inf
    edges[-1] = np.inf
    return edges


def psi_numeric(reference: np.ndarray, current: np.ndarray, n_bins: int = 10) -> float:
    edges = _bin_edges(reference, n_bins=n_bins)
    ref_counts, _ = np.histogram(reference, bins=edges)
    cur_counts, _ = np.histogram(current, bins=edges)
    ref_pct = ref_counts / max(ref_counts.sum(), 1)
    cur_pct = cur_counts / max(cur_counts.sum(), 1)
    # Smooth zero buckets so log is finite.
    eps = 1e-6
    ref_pct = np.where(ref_pct == 0, eps, ref_pct)
    cur_pct = np.where(cur_pct == 0, eps, cur_pct)
    return float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))


def psi_categorical(reference: pd.Series, current: pd.Series) -> float:
    levels = sorted(set(reference.dropna().unique()) | set(current.dropna().unique()))
    if not levels:
        return 0.0
    ref_pct = np.array([(reference == lvl).mean() for lvl in levels])
    cur_pct = np.array([(current == lvl).mean() for lvl in levels])
    eps = 1e-6
    ref_pct = np.where(ref_pct == 0, eps, ref_pct)
    cur_pct = np.where(cur_pct == 0, eps, cur_pct)
    return float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))


def _band(psi: float) -> str:
    if psi < PSI_OK:
        return "stable"
    if psi < PSI_WARN:
        return "warn"
    return "drift"


def data_drift(reference: pd.DataFrame, current: pd.DataFrame) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for col in NUMERIC_FEATURES:
        if col in reference.columns and col in current.columns:
            psi = psi_numeric(
                reference[col].astype(float).to_numpy(),
                current[col].astype(float).to_numpy(),
            )
            out[col] = {"psi": psi, "band": _band(psi), "type": "numeric"}
    for col in CATEGORICAL_FEATURES:
        if col in reference.columns and col in current.columns:
            psi = psi_categorical(reference[col], current[col])
            out[col] = {"psi": psi, "band": _band(psi), "type": "categorical"}
    return out


def _ks_two_sample(a: np.ndarray, b: np.ndarray) -> Tuple[float, float]:
    """Two-sample KS without scipy dependency.

    Returns (statistic, approximate p-value).
    """
    a = np.sort(a[~np.isnan(a)])
    b = np.sort(b[~np.isnan(b)])
    if a.size == 0 or b.size == 0:
        return 0.0, 1.0
    grid = np.unique(np.concatenate([a, b]))
    cdf_a = np.searchsorted(a, grid, side="right") / a.size
    cdf_b = np.searchsorted(b, grid, side="right") / b.size
    d = float(np.max(np.abs(cdf_a - cdf_b)))
    n_eff = a.size * b.size / (a.size + b.size)
    # Asymptotic Kolmogorov distribution approximation.
    lam = (np.sqrt(n_eff) + 0.12 + 0.11 / np.sqrt(n_eff)) * d
    p = 2.0 * np.exp(-2.0 * lam * lam)
    p = max(0.0, min(1.0, float(p)))
    return d, p


def prediction_drift(
    reference_pd: np.ndarray, current_pd: np.ndarray
) -> Dict[str, float]:
    stat, p = _ks_two_sample(reference_pd, current_pd)
    return {
        "ks_stat": stat,
        "p_value": p,
        "ref_mean": float(np.nanmean(reference_pd)) if reference_pd.size else 0.0,
        "cur_mean": float(np.nanmean(current_pd)) if current_pd.size else 0.0,
        "drifted": bool(p < 0.01 and stat > 0.10),
    }


def performance_drift(
    y_true: np.ndarray, y_score: np.ndarray, baseline_auc: Optional[float]
) -> Dict[str, Optional[float]]:
    from sklearn.metrics import roc_auc_score

    if y_true.size == 0 or len(np.unique(y_true)) < 2:
        return {"current_auc": None, "baseline_auc": baseline_auc, "delta": None, "drifted": None}
    auc = float(roc_auc_score(y_true, y_score))
    delta = None if baseline_auc is None else float(auc - baseline_auc)
    drifted = None if delta is None else bool(delta < -0.05)
    return {
        "current_auc": auc,
        "baseline_auc": baseline_auc,
        "delta": delta,
        "drifted": drifted,
    }


def _load_model_artifacts(model_dir: Path):
    import joblib

    model_path = model_dir / "model.joblib"
    if not model_path.exists():
        return None, None
    model = joblib.load(model_path)
    metrics_path = model_dir / "metrics.json"
    metrics = json.loads(metrics_path.read_text()) if metrics_path.exists() else {}
    return model, metrics


def run(
    reference_path: Path,
    current_path: Path,
    model_dir: Optional[Path] = None,
    target_col: str = "defaulted_within_60d",
) -> dict:
    ref = pd.read_parquet(reference_path)
    cur = pd.read_parquet(current_path)

    report: dict = {
        "reference": str(reference_path),
        "current": str(current_path),
        "n_reference": int(len(ref)),
        "n_current": int(len(cur)),
        "data_drift": data_drift(ref, cur),
    }

    if model_dir is not None:
        model, metrics = _load_model_artifacts(model_dir)
        if model is not None:
            try:
                ref_pd = model.predict_proba(encode(ref))[:, 1]
                cur_pd = model.predict_proba(encode(cur))[:, 1]
                report["prediction_drift"] = prediction_drift(ref_pd, cur_pd)
                if target_col in cur.columns:
                    report["performance_drift"] = performance_drift(
                        cur[target_col].astype(int).to_numpy(),
                        cur_pd,
                        baseline_auc=(metrics or {}).get("auc_holdout"),
                    )
            except Exception as exc:  # noqa: BLE001
                warnings.warn(f"Prediction drift skipped: {exc}")
                report["prediction_drift_error"] = str(exc)
        else:
            report["model_warning"] = f"No model.joblib found under {model_dir}"

    # Severity rollup: highest band wins.
    bands = [v["band"] for v in report["data_drift"].values()]
    if "drift" in bands:
        report["overall_band"] = "drift"
    elif "warn" in bands:
        report["overall_band"] = "warn"
    else:
        report["overall_band"] = "stable"

    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", required=True)
    parser.add_argument("--current", required=True)
    parser.add_argument("--model-dir", default=None, help="Optional path to model artifact dir")
    parser.add_argument("--out", default=None, help="Write JSON report to this path")
    parser.add_argument("--target-col", default="defaulted_within_60d")
    args = parser.parse_args()

    report = run(
        Path(args.reference),
        Path(args.current),
        Path(args.model_dir) if args.model_dir else None,
        target_col=args.target_col,
    )
    payload = json.dumps(report, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
    print(payload)


if __name__ == "__main__":
    main()
