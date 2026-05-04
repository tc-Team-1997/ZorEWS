"""Stub showing how to swap synthetic data for ``mart.customer_360``.

When agent-data has produced ``mart.customer_360`` in Aurora, replace
``ml/data/synthetic_train.parquet`` and ``ml/data/synthetic_holdout.parquet``
by running this script. The training pipeline (`ml/pipelines/train_pd.py`)
points at the same parquet file names, so re-training is one command.

Expected mart schema (must align with ``ml/data/generate_synthetic.py``):

    customer_id              VARCHAR  -- primary key
    utilization              FLOAT    -- 0..1, current revolving utilization
    dpd_max_90d              FLOAT    -- max days past due in last 90d
    balance_drop_30d_pct     FLOAT    -- % change in avg balance vs prior 30d
    bureau_score             FLOAT    -- bureau credit score (300..900)
    repayment_delay_streak   INT      -- consecutive months with late payment
    txn_volume_zscore_90d    FLOAT    -- z-score of monthly txn volume vs 90d
    tenure_months            INT      -- months since onboarding
    product_type             VARCHAR  -- personal_loan|credit_card|auto_loan|mortgage|sme_loan
    income_bucket            VARCHAR  -- low|lower_mid|mid|upper_mid|high
    defaulted_within_60d     INT      -- {0,1} target

Hand-off
--------
agent-data: please materialise the above columns in ``mart.customer_360``
and ensure agent-ai has read access to a SQLAlchemy URL via env var
``APEX_MART_URL`` (e.g. ``postgresql+psycopg2://user:pw@host:5432/apex``).
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import pandas as pd


SCHEMA_QUERY = """
WITH customer_product AS (
    SELECT DISTINCT ON (customer_id)
        customer_id,
        product_code
    FROM mart.loan_360
    ORDER BY customer_id, outstanding_amount DESC NULLS LAST
),
txn_z AS (
    SELECT
        customer_id,
        txn_count_90d,
        (txn_count_90d - AVG(txn_count_90d) OVER ())
            / NULLIF(STDDEV_POP(txn_count_90d) OVER (), 0) AS txn_volume_zscore_90d,
        inflow_velocity_ratio
    FROM mart.txn_features
)
SELECT
    c.customer_id,
    LEAST(COALESCE(c.exposure_to_income_ratio, 0)::float, 1.5)        AS utilization,
    COALESCE(c.worst_dpd, 0)::float                                   AS dpd_max_90d,
    (1.0 - COALESCE(z.inflow_velocity_ratio, 1)::float)               AS balance_drop_30d_pct,
    COALESCE(c.bureau_score, 600)::float                              AS bureau_score,
    COALESCE(c.arrears_repayment_count, 0)::int                       AS repayment_delay_streak,
    COALESCE(z.txn_volume_zscore_90d, 0)::float                       AS txn_volume_zscore_90d,
    GREATEST(
        EXTRACT(EPOCH FROM (NOW() - c.onboarded_at)) / 2629800.0, 0
    )::int                                                            AS tenure_months,
    CASE p.product_code
        WHEN 'PL_RET'   THEN 'personal_loan'
        WHEN 'AUTO_RET' THEN 'auto_loan'
        WHEN 'INV_SME'  THEN 'sme_loan'
        WHEN 'WC_SME'   THEN 'sme_loan'
        WHEN 'CORP_TL'  THEN 'sme_loan'
        ELSE 'personal_loan'
    END                                                               AS product_type,
    CASE
        WHEN c.monthly_income <  50000  THEN 'low'
        WHEN c.monthly_income < 100000  THEN 'lower_mid'
        WHEN c.monthly_income < 300000  THEN 'mid'
        WHEN c.monthly_income < 800000  THEN 'upper_mid'
        ELSE 'high'
    END                                                               AS income_bucket,
    c.has_npa::int                                                    AS defaulted_within_60d
FROM mart.customer_360 c
LEFT JOIN customer_product p USING (customer_id)
LEFT JOIN txn_z            z USING (customer_id)
WHERE c.as_of::date BETWEEN :start AND :end
"""


def load(mart_url: str, start: str, end: str) -> pd.DataFrame:
    """Pull the training slice from Aurora ``mart.customer_360``.

    This is intentionally a thin wrapper -- it lets agent-data swap in the
    real query without touching the training pipeline.
    """
    from sqlalchemy import create_engine, text  # type: ignore

    engine = create_engine(mart_url, pool_pre_ping=True)
    with engine.connect() as conn:
        df = pd.read_sql(text(SCHEMA_QUERY), conn, params={"start": start, "end": end})
    return df


def split_and_save(df: pd.DataFrame, out_dir: Path, holdout_frac: float = 0.2, seed: int = 42) -> None:
    import numpy as np

    rng = np.random.default_rng(seed)
    idx = np.arange(len(df))
    rng.shuffle(idx)
    cut = int(len(df) * (1.0 - holdout_frac))
    train = df.iloc[idx[:cut]].reset_index(drop=True)
    holdout = df.iloc[idx[cut:]].reset_index(drop=True)

    out_dir.mkdir(parents=True, exist_ok=True)
    train.to_parquet(out_dir / "synthetic_train.parquet", index=False)
    holdout.to_parquet(out_dir / "synthetic_holdout.parquet", index=False)
    print(f"Wrote {len(train)} train + {len(holdout)} holdout rows to {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mart-url",
        default=os.environ.get("APEX_MART_URL"),
        help="SQLAlchemy URL for Aurora; defaults to env APEX_MART_URL",
    )
    parser.add_argument("--start", required=True, help="Snapshot start date YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="Snapshot end date YYYY-MM-DD")
    parser.add_argument("--out", default="ml/data", help="Output directory")
    parser.add_argument("--holdout-frac", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if not args.mart_url:
        raise SystemExit(
            "APEX_MART_URL env var (or --mart-url) must be set once mart.customer_360 is live."
        )

    df = load(args.mart_url, args.start, args.end)
    if df.empty:
        raise SystemExit("mart.customer_360 returned 0 rows for the requested window.")
    split_and_save(df, Path(args.out), holdout_frac=args.holdout_frac, seed=args.seed)


if __name__ == "__main__":
    main()
