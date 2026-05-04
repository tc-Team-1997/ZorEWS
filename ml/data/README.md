# `ml/data/` — PD model training data

This directory currently holds **synthetic placeholder data** used to bootstrap
the PD model training pipeline while `mart.customer_360` is still being
delivered by **agent-data**.

## Files

| File | Purpose |
|------|---------|
| `generate_synthetic.py` | Produces ~5,000 row synthetic train + holdout parquet files with engineered risk signal. |
| `synthetic_train.parquet` | ~80% split, used by `ml/pipelines/train_pd.py`. |
| `synthetic_holdout.parquet` | ~20% split, held out for unbiased AUC/KS/Brier reporting. |
| `load_from_mart.py` | Stub for swapping the synthetic feed for the real Aurora `mart.customer_360`. |

## Schema

Every parquet (synthetic or real) **must** carry these columns:

| Column | Type | Description |
|--------|------|-------------|
| `customer_id` | string | Customer primary key. |
| `utilization` | float32 | Revolving utilization, 0..1. |
| `dpd_max_90d` | float32 | Max DPD in last 90 days. |
| `balance_drop_30d_pct` | float32 | Avg-balance % change vs prior 30d (negative = drop). |
| `bureau_score` | float32 | Bureau score, 300..900. |
| `repayment_delay_streak` | int16 | Consecutive months with late repayment. |
| `txn_volume_zscore_90d` | float32 | Monthly transaction volume z-score vs 90d. |
| `tenure_months` | int16 | Months since onboarding. |
| `product_type` | string | `personal_loan`/`credit_card`/`auto_loan`/`mortgage`/`sme_loan`. |
| `income_bucket` | string | `low`/`lower_mid`/`mid`/`upper_mid`/`high`. |
| `defaulted_within_60d` | int8 | Target — 1 if account defaulted within next 60 days. |

## Generating the synthetic files

```bash
python ml/data/generate_synthetic.py --out ml/data --n 5000 --seed 42
```

Default prevalence is **6% positive**. The latent risk function is documented
inline in `generate_synthetic.py` — the design goal is a realistically *learnable*
problem (AUC ~0.85 expected on holdout) without label leakage.

## Swapping in real data (hand-off note for agent-data)

When `mart.customer_360` is materialised:

1. Set the environment variable `APEX_MART_URL` to the Aurora SQLAlchemy URL.
2. Run:
   ```bash
   python ml/data/load_from_mart.py \
       --start 2024-01-01 --end 2026-04-01 --out ml/data
   ```
3. Re-train: `python ml/pipelines/train_pd.py`.
4. The registered model gets a new version (bump `__VERSION__` in
   `ml/pipelines/train_pd.py`), and the registry CLI promotes the new artifact.

No other code in `ml/` or `services/ai-copilot-svc/` should need to change —
the training pipeline reads parquet files at fixed paths.
