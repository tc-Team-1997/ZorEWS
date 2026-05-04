"""Generate the placeholder synthetic training dataset for the PD model.

This is a stand-in until ``mart.customer_360`` is delivered by agent-data.
The schema mirrors the expected mart columns so the swap is mechanical
(see ``load_from_mart.py``).

Design notes
------------
* ~5,000 customers, 6% positive prevalence (`defaulted_within_60d`).
* Signal is engineered so a gradient-boosted model comfortably clears
  AUC >= 0.78 on a held-out split. The latent risk score is a
  monotone-ish blend of utilization, dpd_max_90d, balance_drop, bureau
  score, and repayment delay streak, with non-linear interactions to
  give a tree-based learner something to bite on. Random label noise
  keeps the problem realistic (no AUC=1.0 leakage).
* Categoricals (`product_type`, `income_bucket`) are one-hot ready.

Usage::

    python ml/data/generate_synthetic.py --out ml/data --n 5000 --seed 42
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
import pandas as pd


FEATURE_COLUMNS = [
    "utilization",
    "dpd_max_90d",
    "balance_drop_30d_pct",
    "bureau_score",
    "repayment_delay_streak",
    "txn_volume_zscore_90d",
    "tenure_months",
    "product_type",
    "income_bucket",
]
TARGET_COLUMN = "defaulted_within_60d"
ID_COLUMN = "customer_id"

PRODUCT_TYPES = ["personal_loan", "credit_card", "auto_loan", "mortgage", "sme_loan"]
INCOME_BUCKETS = ["low", "lower_mid", "mid", "upper_mid", "high"]


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def generate(n: int = 5000, seed: int = 42, target_prevalence: float = 0.06) -> pd.DataFrame:
    rng = np.random.default_rng(seed)

    # --- Continuous features ---------------------------------------------
    utilization = np.clip(rng.beta(2.0, 3.0, size=n), 0.0, 1.0)  # 0..1
    dpd_max_90d = np.clip(rng.gamma(shape=1.2, scale=8.0, size=n), 0.0, 90.0).astype(float)
    balance_drop_30d_pct = np.clip(rng.normal(loc=0.0, scale=15.0, size=n), -80.0, 80.0)
    bureau_score = np.clip(rng.normal(loc=680.0, scale=70.0, size=n), 300.0, 900.0)
    repayment_delay_streak = np.clip(rng.poisson(lam=0.6, size=n), 0, 12).astype(int)
    txn_volume_zscore_90d = np.clip(rng.normal(loc=0.0, scale=1.0, size=n), -4.0, 4.0)
    tenure_months = np.clip(rng.gamma(shape=2.0, scale=18.0, size=n), 1.0, 240.0).astype(int)

    product_type = rng.choice(PRODUCT_TYPES, size=n, p=[0.30, 0.25, 0.15, 0.15, 0.15])
    income_bucket = rng.choice(INCOME_BUCKETS, size=n, p=[0.15, 0.25, 0.30, 0.20, 0.10])

    # --- Latent risk score (engineered for learnability) ----------------
    # Standardise components into roughly comparable scales.
    util_term = (utilization - 0.4) * 4.0                       # high util => risk
    dpd_term = (dpd_max_90d / 30.0) * 2.5                       # any DPD => risk
    drop_term = (-balance_drop_30d_pct / 30.0)                  # negative drop => risk
    bureau_term = -((bureau_score - 680.0) / 70.0) * 1.8        # low score => risk
    streak_term = repayment_delay_streak * 0.6                  # consecutive delays
    txn_term = -txn_volume_zscore_90d * 0.5                     # falling txn volumes => risk
    tenure_term = -((tenure_months - 24.0) / 60.0) * 0.4        # very new books => slightly riskier

    # Non-linear interaction: high utilization + low bureau is super-linearly risky.
    interaction = 1.5 * np.maximum(0.0, utilization - 0.6) * np.maximum(0.0, (700.0 - bureau_score) / 100.0)

    # Categorical risk lifts (small, but real).
    product_lift = np.select(
        [product_type == "personal_loan", product_type == "credit_card", product_type == "sme_loan"],
        [0.30, 0.20, 0.40],
        default=0.0,
    )
    income_lift = np.select(
        [income_bucket == "low", income_bucket == "lower_mid", income_bucket == "high"],
        [0.50, 0.20, -0.30],
        default=0.0,
    )

    latent = (
        util_term
        + dpd_term
        + drop_term
        + bureau_term
        + streak_term
        + txn_term
        + tenure_term
        + interaction
        + product_lift
        + income_lift
    )

    # Add label noise so AUC is realistic (not 1.0).
    latent = latent + rng.normal(loc=0.0, scale=0.7, size=n)

    # Calibrate intercept so empirical prevalence ~= target_prevalence.
    # We shift latent by a bias chosen so mean(sigmoid(latent + bias)) ~ target.
    # Bisection (latent is a numpy vector).
    lo, hi = -10.0, 10.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        p_mean = float(_sigmoid(latent + mid).mean())
        if p_mean > target_prevalence:
            hi = mid
        else:
            lo = mid
    bias = 0.5 * (lo + hi)

    p_default = _sigmoid(latent + bias)
    y = (rng.uniform(size=n) < p_default).astype(int)

    df = pd.DataFrame(
        {
            ID_COLUMN: [f"CUST{idx:07d}" for idx in range(n)],
            "utilization": utilization.astype(np.float32),
            "dpd_max_90d": dpd_max_90d.astype(np.float32),
            "balance_drop_30d_pct": balance_drop_30d_pct.astype(np.float32),
            "bureau_score": bureau_score.astype(np.float32),
            "repayment_delay_streak": repayment_delay_streak.astype(np.int16),
            "txn_volume_zscore_90d": txn_volume_zscore_90d.astype(np.float32),
            "tenure_months": tenure_months.astype(np.int16),
            "product_type": product_type.astype(str),
            "income_bucket": income_bucket.astype(str),
            TARGET_COLUMN: y.astype(np.int8),
        }
    )
    return df


def split_train_holdout(df: pd.DataFrame, holdout_frac: float = 0.2, seed: int = 42):
    rng = np.random.default_rng(seed)
    idx = np.arange(len(df))
    rng.shuffle(idx)
    cut = int(len(df) * (1.0 - holdout_frac))
    train = df.iloc[idx[:cut]].reset_index(drop=True)
    holdout = df.iloc[idx[cut:]].reset_index(drop=True)
    return train, holdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="ml/data", help="Output directory")
    parser.add_argument("--n", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--prevalence", type=float, default=0.06)
    parser.add_argument("--holdout-frac", type=float, default=0.2)
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    df = generate(n=args.n, seed=args.seed, target_prevalence=args.prevalence)
    train, holdout = split_train_holdout(df, holdout_frac=args.holdout_frac, seed=args.seed)

    train_path = out_dir / "synthetic_train.parquet"
    holdout_path = out_dir / "synthetic_holdout.parquet"
    train.to_parquet(train_path, index=False)
    holdout.to_parquet(holdout_path, index=False)

    print(
        f"Wrote {train_path} ({len(train)} rows) "
        f"and {holdout_path} ({len(holdout)} rows). "
        f"Empirical prevalence: train={train[TARGET_COLUMN].mean():.4f}, "
        f"holdout={holdout[TARGET_COLUMN].mean():.4f}"
    )


if __name__ == "__main__":
    main()
