# Model Risk Management — APEX EWS PD Model v0.1.0

> **Live numbers source of truth:** `ml/models/pd/v0.1.0/metrics.json`. The
> figures embedded below are taken from the first reproducible training run on
> the engineered synthetic dataset (`seed=42`, n=5,000) and are refreshed
> whenever `python ml/pipelines/train_pd.py` is re-executed against the same
> seed. Re-train against `mart.customer_360` and update §4 / §5 before the
> first production rollout.

| Field | Value |
|-------|-------|
| Model name | `pd_xgboost` |
| Model version | `0.1.0` |
| Owner | agent-ai |
| Risk owner (Risk function) | Head of Credit Risk |
| Compliance owner | DPO + Compliance Officer |
| Business owner | Head of Collections / EWS |
| First trained | 2026-04-26 (synthetic bootstrap) |
| Status | Champion (Phase 2 prototype) |

## 1. Purpose & scope

The PD model produces a customer-level probability of default within the next
60 days, plus a Low/Medium/High risk band and SHAP-based top-5 reason codes.
It is consumed by:

* **Alert Engine** (`agent-alert`) — score band feeds severity merge.
* **Customer Risk Profile** UI (`agent-ui`) — PD + reason panel.
* **Smart prioritisation queue** — Critical / Medium / Low routing.

Scope explicitly **excludes**: pricing / underwriting decisions, IFRS 9 ECL
staging (handled separately by `agent-integration` T3.2), regulatory capital
calculations, and any direct customer-facing decisions without human review.

## 2. Data lineage

| Layer | Source | Owner | Notes |
|-------|--------|-------|-------|
| Source-of-truth | CBS, LOS, bureau, transactions | agent-integration | Phase 0 contracts |
| Raw | `raw.*` Aurora schemas | agent-data | Append-only |
| Staging | `staging.*` (typed, deduped) | agent-data | dbt |
| Feature mart | `mart.customer_360` | agent-data | dbt model (T1.3) |
| Training extract | `ml/data/synthetic_train.parquet` (placeholder) | agent-ai | swap via `ml/data/load_from_mart.py` |

**Current placeholder:** until `mart.customer_360` is delivered (T1.3), training
runs against the synthetic generator in `ml/data/generate_synthetic.py`. The
generator's latent risk function is documented inline; the **schema is byte-
identical** to the expected mart schema so that `load_from_mart.py` is a drop-in
replacement.

### Features (training input)

Numeric: `utilization`, `dpd_max_90d`, `balance_drop_30d_pct`, `bureau_score`,
`repayment_delay_streak`, `txn_volume_zscore_90d`, `tenure_months`.

Categorical (one-hot): `product_type` (personal_loan, credit_card, auto_loan,
mortgage, sme_loan), `income_bucket` (low, lower_mid, mid, upper_mid, high).

Total encoded features: **17**.

Target: `defaulted_within_60d` (0/1).

## 3. Methodology

* **Algorithm:** XGBoost binary classifier (gradient-boosted trees).
* **Hyperparameters:** `max_depth=5`, `learning_rate=0.07`, `n_estimators=500`,
  `min_child_weight=5`, `subsample=0.85`, `colsample_bytree=0.85`,
  `reg_lambda=1.5`, `reg_alpha=0.1`, `tree_method=hist`. Captured in
  `metrics.json` -> `xgb_params`.
* **Validation:** 5-fold stratified CV on the 80% train split.
* **Calibration:** isotonic regression (`CalibratedClassifierCV`, cv=3) on top
  of the XGBoost classifier — chosen over Platt scaling because XGBoost's
  raw scores are visibly miscalibrated at the tails on tree-based learners,
  and isotonic handles non-monotonic miscalibration.
* **Decision threshold:** Youden's J-maximising threshold on holdout, recorded
  in `metrics.json -> youden_threshold` (~0.07 on the bootstrap run). The
  service returns the *probability*, not a hard decision; the Low/Medium/High
  bands (default 0.05 / 0.20) are configurable via env.
* **Reason codes:** SHAP `TreeExplainer` on the uncalibrated booster (SHAP on
  trees does not support the calibrated wrapper); top-5 features by absolute
  contribution are returned with sign (`positive` = increases PD).

## 4. Performance summary (synthetic holdout, seed=42)

> Refreshed automatically on each `python ml/pipelines/train_pd.py` run.
> Source: `ml/models/pd/v0.1.0/metrics.json`.

| Metric | Value | Bar | Status |
|--------|-------|-----|--------|
| AUC (holdout) | ~0.86 | >= 0.78 | PASS |
| Gini | ~0.72 | — | informational |
| KS | ~0.55 | — | informational |
| Brier score | ~0.045 | — | calibration check |
| 5-fold CV AUC (mean +/- sd) | ~0.85 +/- 0.01 | — | stability |
| Holdout prevalence | ~0.06 | matches generator target | PASS |

The values above are representative of the engineered synthetic dataset; the
training pipeline **enforces a hard floor of AUC >= 0.78 on holdout** (training
exits non-zero otherwise — see `ml/pipelines/train_pd.py`).

### Top features by gain

1. `bureau_score`
2. `utilization`
3. `dpd_max_90d`
4. `repayment_delay_streak`
5. `balance_drop_30d_pct`

(Full importance list in `feature_importance.json`.)

## 5. Limitations

1. **Synthetic data caveat.** Phase 2 numbers are bootstrapped on a
   self-generated dataset. AUC on real `mart.customer_360` will likely be
   lower (0.75–0.82 range is realistic for retail PD on Kenyan portfolios)
   because real defaulters carry more idiosyncratic noise. Do not promote
   to production without re-validating on real holdout.
2. **Class imbalance.** 6% positive prevalence; we did not apply SMOTE or
   class weights — XGBoost handles modest imbalance natively, and over-
   sampling would distort the calibration we paid for. Revisit if real
   prevalence drifts below 2%.
3. **Concept drift.** Macro shocks (FX, GDP, interest-rate spikes) are not
   features. The scenario engine (T4.2) will run the model under shocked
   feature distributions; this MRM should be re-issued if the bank takes a
   firm-wide rates view that contradicts the current training window.
4. **Categorical novelty.** New `product_type` or `income_bucket` levels
   pass through as all-zero one-hot rows. Acceptable for the prototype;
   for production we will add an "unknown" bucket and trigger a model
   refresh when it exceeds 1% of traffic.
5. **No causal interpretation.** SHAP explains the *model*, not the
   *world*. UI copy must say "factors associated with this score" rather
   than "reasons this customer will default."
6. **No protected-attribute features.** Gender, age, ethnicity, location
   are deliberately excluded. See §6.

## 6. Fairness / subgroup analysis

The model does not consume protected attributes directly. Indirect proxies
(notably `income_bucket`) carry fairness risk. Required quarterly checks:

| Subgroup axis | Source | Test | Pass criterion |
|---------------|--------|------|----------------|
| `income_bucket` | feature | AUC parity across buckets | max gap < 0.05 |
| `income_bucket` | feature | False-negative-rate parity | max gap < 0.05 |
| `product_type` | feature | AUC parity | max gap < 0.05 |
| Gender (DPA-classified) | external join | Selection-rate ratio (4/5 rule) | ratio > 0.80 |
| Region (county) | external join | Selection-rate parity | max gap < 5pp |

Subgroup tests are defined as TODO automation under
`ml/monitoring/fairness.py` (Phase 5 — T5.1). Until then the duty falls on
the Risk + Compliance reviewers at each promotion gate.

## 7. Monitoring plan

| Drift type | Frequency | Tool | Trigger |
|------------|-----------|------|---------|
| Data drift (PSI) | daily | `ml/monitoring/drift.py` | PSI >= 0.10 -> warn; >= 0.25 -> page |
| Prediction drift (KS) | daily | same | KS p<0.01 and stat>0.10 -> page |
| Performance drift | weekly* | same | current AUC < baseline - 0.05 -> page |
| Fairness | quarterly | `ml/monitoring/fairness.py` (TODO) | any subgroup test fails -> review |
| Champion vs challenger divergence | continuous | service log | mean PD delta > 0.02 over 24h -> review |

\* Performance drift requires labels, available 60+ days after scoring.
A short-horizon proxy (DPD-30 within 30 days) is logged weekly.

Drift CLI:

```
python -m ml.monitoring.drift \
    --reference ml/data/synthetic_train.parquet \
    --current   <production-snapshot>.parquet \
    --model-dir ml/models/pd/v0.1.0 \
    --out drift_report.json
```

## 8. Change-management workflow

1. **Develop** — agent-ai trains a new candidate; pipeline auto-registers as
   `challenger`.
2. **Shadow** — service shadow-scores production traffic against the
   challenger; logs are reviewed for at least 5 business days OR 50,000
   scores, whichever is greater.
3. **Validate** — Risk reviewer signs off on the `metrics.json`, drift report,
   and fairness check (§6).
4. **Promote** — `python -m ml.registry.cli promote --name pd_xgboost --version <v>`.
5. **Rollback** — promote previous champion (`status=archived` flips back to
   `champion`); registry is append-only enough to preserve audit trail.

Every promotion writes a row to the audit log (`apex.audit.events` topic via
`audit-svc`, hash-chained).

## 9. Sign-off matrix

| Role | Name (placeholder until org assignment) | Required at |
|------|------------------------------------------|-------------|
| Risk owner | Head of Credit Risk | every promotion |
| Compliance owner | DPO + Compliance Officer | every promotion + quarterly fairness |
| Business owner | Head of Collections / EWS | every promotion |
| Model developer | agent-ai | every train run |
| Independent validator | Internal Audit / second-line Risk | annually + on major version (>=1.0 bumps) |

A promotion is blocked unless **Risk + Compliance + Business** have all
signed the corresponding registry entry note (captured in the
`metrics.json` -> `signoffs` field — to be added in Phase 3 alongside the
audit-svc hash chain).

## 10. Glossary

* **PD** — Probability of Default (within next 60 days, in our setup).
* **PSI** — Population Stability Index, used for data drift.
* **KS** — Kolmogorov-Smirnov statistic, used for separation and prediction
  drift.
* **Champion / Challenger** — Champion is the model serving production
  traffic; challenger is shadow-scored alongside until promotion.
* **SHAP** — SHapley Additive exPlanations, the per-feature contribution
  numbers powering the reason codes.
