"""PD model training pipeline.

Run::

    python ml/pipelines/train_pd.py

Outputs to ``ml/models/pd/<version>/``:
    * ``model.joblib``               -- fitted CalibratedClassifierCV
    * ``xgb_booster.json``           -- raw XGBoost booster (cross-language)
    * ``shap_explainer.joblib``      -- TreeExplainer for the booster
    * ``feature_importance.json``    -- gain-based importance, sorted
    * ``metrics.json``               -- AUC, KS, Gini, Brier, threshold, prevalence
    * ``calibration.png``            -- reliability diagram (best-effort, optional)

Definition of done: AUC >= 0.78 on holdout.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.model_selection import StratifiedKFold

# Allow running as a script or as a module.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ml.pipelines.features import encode, encoded_columns  # noqa: E402

__VERSION__ = "0.1.0"
MODEL_NAME = "pd_xgboost"
TARGET = "defaulted_within_60d"

DEFAULT_TRAIN = "ml/data/synthetic_train.parquet"
DEFAULT_HOLDOUT = "ml/data/synthetic_holdout.parquet"
DEFAULT_OUT_DIR = "ml/models/pd"

# Modest, well-regularised baseline -- keeps training fast (~seconds on 4k rows)
# while leaving ample headroom above the 0.78 AUC bar on the synthetic feed.
XGB_PARAMS = {
    "objective": "binary:logistic",
    "tree_method": "hist",
    "max_depth": 5,
    "learning_rate": 0.07,
    "n_estimators": 500,
    "min_child_weight": 5,
    "subsample": 0.85,
    "colsample_bytree": 0.85,
    "reg_lambda": 1.5,
    "reg_alpha": 0.1,
    "eval_metric": "auc",
    "random_state": 42,
}

KFOLDS = 5
EARLY_STOPPING_ROUNDS = 30


def _resolve_version(out_dir: str, base_version: str, name: str, *, overwrite: bool) -> str:
    """Pick a free version, auto-bumping the patch component if needed.

    With ``overwrite=False`` (the default), if ``base_version`` already exists
    on disk under ``out_dir`` or in the registry under ``name``, bumps the
    patch component until both are free and warns. With ``overwrite=True``,
    returns ``base_version`` unchanged so callers can replace in place.

    Only plain semver (``major.minor.patch`` with integer patch) is auto-bumpable;
    pre-release suffixes (``0.1.0-rc1``) raise so the user picks a version manually.
    """
    if overwrite:
        return base_version

    try:
        from ml.registry.registry import Registry

        reg: object = Registry()
    except Exception:  # noqa: BLE001 -- registry unavailable -> rely on disk only
        reg = None

    def _is_free(v: str) -> bool:
        if (Path(out_dir) / f"v{v}").exists():
            return False
        if reg is not None and reg.get(name, v) is not None:  # type: ignore[union-attr]
            return False
        return True

    candidate = base_version
    while not _is_free(candidate):
        try:
            major, minor, patch = candidate.split(".")
            candidate = f"{major}.{minor}.{int(patch) + 1}"
        except (ValueError, AttributeError) as exc:
            raise SystemExit(
                f"Cannot auto-bump version {base_version!r}: {exc}. "
                f"Pass an explicit --version or --overwrite."
            )

    if candidate != base_version:
        warnings.warn(
            f"Version {base_version} already registered/on-disk; using {candidate} instead. "
            f"Pass --overwrite to replace v{base_version} in place.",
            stacklevel=2,
        )
    return candidate


def _load_split(path: str) -> pd.DataFrame:
    p = Path(path)
    if not p.exists():
        raise SystemExit(
            f"Missing dataset {p}. Run `python ml/data/generate_synthetic.py` first."
        )
    return pd.read_parquet(p)


def _ks_statistic(y_true: np.ndarray, y_score: np.ndarray) -> float:
    """Kolmogorov-Smirnov statistic for binary classifier scores."""
    pos = np.sort(y_score[y_true == 1])
    neg = np.sort(y_score[y_true == 0])
    if pos.size == 0 or neg.size == 0:
        return 0.0
    grid = np.unique(np.concatenate([pos, neg]))
    cdf_pos = np.searchsorted(pos, grid, side="right") / pos.size
    cdf_neg = np.searchsorted(neg, grid, side="right") / neg.size
    return float(np.max(np.abs(cdf_pos - cdf_neg)))


def _tune_threshold(y_true: np.ndarray, y_score: np.ndarray) -> Tuple[float, float]:
    """Find the threshold that maximises Youden's J = TPR - FPR.

    Returns ``(threshold, j_statistic)``.
    """
    from sklearn.metrics import roc_curve

    fpr, tpr, thresholds = roc_curve(y_true, y_score)
    j = tpr - fpr
    idx = int(np.argmax(j))
    # roc_curve prepends an inf threshold; guard against it.
    thr = float(thresholds[idx]) if np.isfinite(thresholds[idx]) else 0.5
    return thr, float(j[idx])


def _maybe_calibration_plot(y_true: np.ndarray, y_score: np.ndarray, out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from sklearn.calibration import calibration_curve

        prob_true, prob_pred = calibration_curve(y_true, y_score, n_bins=10, strategy="quantile")
        fig, ax = plt.subplots(figsize=(5, 5))
        ax.plot([0, 1], [0, 1], "--", color="grey", label="Perfect")
        ax.plot(prob_pred, prob_true, marker="o", label="Model")
        ax.set_xlabel("Mean predicted PD")
        ax.set_ylabel("Empirical default rate")
        ax.set_title("Calibration (holdout)")
        ax.legend()
        fig.tight_layout()
        fig.savefig(out_path, dpi=120)
        plt.close(fig)
    except Exception as exc:  # noqa: BLE001 -- best-effort plot
        warnings.warn(f"Calibration plot skipped: {exc}")


def train(
    train_path: str = DEFAULT_TRAIN,
    holdout_path: str = DEFAULT_HOLDOUT,
    out_dir: str = DEFAULT_OUT_DIR,
    version: str = __VERSION__,
    calibration: str = "isotonic",
    register: bool = True,
    overwrite: bool = False,
) -> dict:
    import xgboost as xgb

    version = _resolve_version(out_dir, version, MODEL_NAME, overwrite=overwrite)

    train_df = _load_split(train_path)
    holdout_df = _load_split(holdout_path)

    if TARGET not in train_df.columns:
        raise SystemExit(f"Training data missing target column `{TARGET}`")

    X_train = encode(train_df)
    y_train = train_df[TARGET].astype(int).to_numpy()
    X_holdout = encode(holdout_df)
    y_holdout = holdout_df[TARGET].astype(int).to_numpy()

    # Auto-switch to a low-data hyperparameter profile when there are too few
    # positives for the synthetic-tuned defaults (mcw=5 prevents any tree
    # splits with <~20 positives, collapsing the model to a constant). This
    # path is hit when training off the dbt mart (~8 positives) instead of
    # the 4k-row synthetic set.
    xgb_params = dict(XGB_PARAMS)
    n_pos = int(y_train.sum())
    n_folds = KFOLDS
    if n_pos < 20:
        xgb_params.update(min_child_weight=1, n_estimators=300, max_depth=4)
        n_folds = max(2, min(KFOLDS, n_pos))
        warnings.warn(
            f"Low-data profile: n_positives={n_pos} -> mcw=1, n_estimators=300, cv={n_folds}",
            stacklevel=2,
        )

    # ---- K-fold CV -----------------------------------------------------
    skf = StratifiedKFold(n_splits=n_folds, shuffle=True, random_state=42)
    cv_aucs = []
    for fold, (tr_idx, va_idx) in enumerate(skf.split(X_train, y_train)):
        Xt = X_train.iloc[tr_idx]
        Xv = X_train.iloc[va_idx]
        yt, yv = y_train[tr_idx], y_train[va_idx]
        m = xgb.XGBClassifier(**xgb_params)
        try:
            m.fit(Xt, yt, eval_set=[(Xv, yv)], verbose=False)
        except TypeError:
            # Older xgboost signatures may not accept verbose kwarg.
            m.fit(Xt, yt, eval_set=[(Xv, yv)])
        cv_aucs.append(roc_auc_score(yv, m.predict_proba(Xv)[:, 1]))
    cv_auc_mean = float(np.mean(cv_aucs))
    cv_auc_std = float(np.std(cv_aucs))

    # ---- Refit on full train + calibration on a held-out chunk ---------
    cal_cv = max(2, min(3, n_pos)) if n_pos < 20 else 3
    cal_method = "sigmoid" if n_pos < 20 else calibration
    base = xgb.XGBClassifier(**xgb_params)
    cal = CalibratedClassifierCV(estimator=base, method=cal_method, cv=cal_cv)
    cal.fit(X_train, y_train)

    # Raw booster (uncalibrated) for SHAP -- TreeExplainer wants the booster.
    raw_booster = xgb.XGBClassifier(**xgb_params)
    raw_booster.fit(X_train, y_train)

    # ---- Holdout metrics -----------------------------------------------
    p_holdout = cal.predict_proba(X_holdout)[:, 1]
    auc = float(roc_auc_score(y_holdout, p_holdout))
    gini = 2.0 * auc - 1.0
    ks = _ks_statistic(y_holdout, p_holdout)
    brier = float(brier_score_loss(y_holdout, p_holdout))
    threshold, youden_j = _tune_threshold(y_holdout, p_holdout)
    prevalence = float(y_holdout.mean())

    if auc < 0.78:
        raise SystemExit(
            f"Holdout AUC {auc:.4f} below required 0.78 floor. "
            f"Inspect data generator / hyperparameters."
        )

    # ---- Feature importance --------------------------------------------
    importance_raw = raw_booster.get_booster().get_score(importance_type="gain")
    # XGBoost may return either real feature names or f0/f1/... depending on version.
    cols = encoded_columns()
    importance: dict = {}
    for k, v in importance_raw.items():
        if k in cols:
            importance[k] = float(v)
        elif k.startswith("f") and k[1:].isdigit():
            idx = int(k[1:])
            if 0 <= idx < len(cols):
                importance[cols[idx]] = float(v)
    importance_sorted = dict(sorted(importance.items(), key=lambda kv: -kv[1]))

    # ---- Build SHAP explainer ------------------------------------------
    import shap

    explainer = shap.TreeExplainer(raw_booster)

    # ---- Persist artifacts ---------------------------------------------
    version_dir = Path(out_dir) / f"v{version}"
    version_dir.mkdir(parents=True, exist_ok=True)

    joblib.dump(cal, version_dir / "model.joblib")
    raw_booster.get_booster().save_model(str(version_dir / "xgb_booster.json"))
    joblib.dump(explainer, version_dir / "shap_explainer.joblib")

    with open(version_dir / "feature_importance.json", "w") as fh:
        json.dump(importance_sorted, fh, indent=2)

    metrics = {
        "model_name": MODEL_NAME,
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_train": int(len(X_train)),
        "n_holdout": int(len(X_holdout)),
        "prevalence_holdout": prevalence,
        "auc_holdout": auc,
        "gini_holdout": float(gini),
        "ks_holdout": ks,
        "brier_holdout": brier,
        "youden_threshold": threshold,
        "youden_j": youden_j,
        "cv_auc_mean": cv_auc_mean,
        "cv_auc_std": cv_auc_std,
        "calibration": calibration,
        "feature_count": len(cols),
        "xgb_params": xgb_params,
        "feature_columns": cols,
        "top_features_by_importance": list(importance_sorted.keys())[:5],
    }
    with open(version_dir / "metrics.json", "w") as fh:
        json.dump(metrics, fh, indent=2)

    _maybe_calibration_plot(y_holdout, p_holdout, version_dir / "calibration.png")

    print(
        f"[train_pd] v{version} -- AUC={auc:.4f} KS={ks:.4f} "
        f"Brier={brier:.4f} CV-AUC={cv_auc_mean:.4f}+/-{cv_auc_std:.4f}"
    )
    print(f"[train_pd] artifacts in {version_dir}")

    if register:
        try:
            from ml.registry.registry import Registry

            reg = Registry()
            reg.register(
                name=MODEL_NAME,
                version=version,
                metrics={
                    "auc_holdout": auc,
                    "ks_holdout": ks,
                    "gini_holdout": float(gini),
                    "brier_holdout": brier,
                    "cv_auc_mean": cv_auc_mean,
                },
                artifact_path=str(version_dir.resolve()),
                status="challenger",
                overwrite=overwrite,
            )
            print(f"[train_pd] registered v{version} as challenger in {reg.path}")
        except Exception as exc:  # noqa: BLE001
            warnings.warn(f"Registry update skipped: {exc}")

    return metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", default=DEFAULT_TRAIN)
    parser.add_argument("--holdout", default=DEFAULT_HOLDOUT)
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    parser.add_argument("--version", default=__VERSION__)
    parser.add_argument("--calibration", default="isotonic", choices=["isotonic", "sigmoid"])
    parser.add_argument("--no-register", action="store_true")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace v<version> on disk + in the registry. Default auto-bumps the patch version.",
    )
    args = parser.parse_args()

    train(
        train_path=args.train,
        holdout_path=args.holdout,
        out_dir=args.out_dir,
        version=args.version,
        calibration=args.calibration,
        register=not args.no_register,
        overwrite=args.overwrite,
    )


if __name__ == "__main__":
    main()
