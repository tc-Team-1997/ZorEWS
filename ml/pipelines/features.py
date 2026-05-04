"""Feature engineering used by training and serving.

Kept tiny on purpose -- the only transforms applied to raw mart data are:

* one-hot encoding for the two categoricals,
* numeric pass-through (NaN-safe).

By centralising here, training and serving stay byte-identical.
"""

from __future__ import annotations

from typing import Iterable, List

import numpy as np
import pandas as pd


NUMERIC_FEATURES: List[str] = [
    "utilization",
    "dpd_max_90d",
    "balance_drop_30d_pct",
    "bureau_score",
    "repayment_delay_streak",
    "txn_volume_zscore_90d",
    "tenure_months",
]

CATEGORICAL_FEATURES: List[str] = ["product_type", "income_bucket"]

PRODUCT_LEVELS = ["personal_loan", "credit_card", "auto_loan", "mortgage", "sme_loan"]
INCOME_LEVELS = ["low", "lower_mid", "mid", "upper_mid", "high"]


def encoded_columns() -> List[str]:
    """The full feature column order produced by :func:`encode`."""
    cols = list(NUMERIC_FEATURES)
    for lvl in PRODUCT_LEVELS:
        cols.append(f"product_type_{lvl}")
    for lvl in INCOME_LEVELS:
        cols.append(f"income_bucket_{lvl}")
    return cols


def encode(df: pd.DataFrame) -> pd.DataFrame:
    """Encode raw feature frame to model input frame.

    Returns a DataFrame whose columns match :func:`encoded_columns`, in order.
    Missing numerics become 0; missing categoricals become an all-zero one-hot.
    """
    out = pd.DataFrame(index=df.index)
    for col in NUMERIC_FEATURES:
        if col in df.columns:
            out[col] = pd.to_numeric(df[col], errors="coerce").astype("float32").fillna(0.0)
        else:
            out[col] = np.float32(0.0)

    pt = df.get("product_type", pd.Series([""] * len(df), index=df.index)).astype(str)
    for lvl in PRODUCT_LEVELS:
        out[f"product_type_{lvl}"] = (pt == lvl).astype("float32")

    ib = df.get("income_bucket", pd.Series([""] * len(df), index=df.index)).astype(str)
    for lvl in INCOME_LEVELS:
        out[f"income_bucket_{lvl}"] = (ib == lvl).astype("float32")

    # Order is load-bearing -- xgboost remembers feature names but downstream
    # code (SHAP, registry payloads) expects this column order.
    return out[encoded_columns()]


def encode_record(record: dict) -> pd.DataFrame:
    """Encode a single dict-like record (FastAPI input) to a 1-row frame."""
    return encode(pd.DataFrame([record]))


def encoded_to_human(feature_name: str) -> str:
    """Map an encoded column back to a user-facing label.

    e.g. ``product_type_credit_card -> 'product_type=credit_card'``.
    """
    if feature_name.startswith("product_type_"):
        return f"product_type={feature_name[len('product_type_'):]}"
    if feature_name.startswith("income_bucket_"):
        return f"income_bucket={feature_name[len('income_bucket_'):]}"
    return feature_name
