# dbt seeds

These CSVs land in the `raw.*` schema (see `dbt_project.yml`) and back the
`source('raw', …)` entries used by every staging model.

## Two-tier seeding

The committed CSVs ship with a **small representative sample** (10–20 rows
per file) so that `dbt parse` / `dbt compile` / `dbt seed` succeed in CI
without a heavyweight regen step. To materialise the **full prototype
dataset** required by the DoD (≥ 200 customers, ≥ 500 loans, ≥ 5000
transactions, defaulted cohort ~6%) run the deterministic generator:

```bash
cd data/dbt/seeds
python3 _generate_seeds.py
dbt seed --full-refresh
```

The generator pins `random.seed(42)`, so output is byte-identical across
runs and machines.

## Files

| File                      | Sample rows | Full rows (after regen) |
|---------------------------|-------------|-------------------------|
| `seed_customers.csv`      | 10          | 220                     |
| `seed_loans.csv`          | 12          | ~520                    |
| `seed_repayments.csv`     | 17          | ~5500                   |
| `seed_transactions.csv`   | 20          | ~6000                   |
| `seed_bureau_score.csv`   | 10          | 220                     |

## Defaulted cohort

Customers `C00008` and similarly-distributed peers (in the regenerated
set) are tagged into a defaulted cohort with:

- bureau score in `[280, 520]`
- one or more loans in `SUBSTANDARD` / `DOUBTFUL` / `LOSS`
- declining inflows in the trailing 60-day txn window
- elevated outflow spikes
- partial / arrears repayments leading up to NPA tagging

The agent-ai training pipeline (T2.2) consumes `customer_360` filtered by
`has_npa = true` plus negative-class samples to produce the PD model.
