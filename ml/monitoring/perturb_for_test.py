"""Helper -- create a perturbed copy of synthetic_train.parquet for drift tests.

Usage::

    python -m ml.monitoring.perturb_for_test \
        --in ml/data/synthetic_train.parquet \
        --out ml/data/synthetic_train_perturbed.parquet \
        --feature utilization --shift 0.25
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="inp", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--feature", default="utilization")
    parser.add_argument("--shift", type=float, default=0.25)
    args = parser.parse_args()

    df = pd.read_parquet(args.inp)
    if args.feature not in df.columns:
        raise SystemExit(f"Feature {args.feature} not found in {args.inp}")
    df[args.feature] = df[args.feature] + args.shift
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(args.out, index=False)
    print(f"Wrote perturbed copy to {args.out} (shifted {args.feature} by {args.shift})")


if __name__ == "__main__":
    main()
