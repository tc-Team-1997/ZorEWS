{{ config(
    materialized='incremental',
    schema='feature_store',
    alias='feat_values_backfill',
    unique_key=['tenant_id', 'entity_id', 'feature_name', 'observed_at'],
    incremental_strategy='delete+insert'
) }}

-- T2.1.3 — 24-month feature-store backfill from the existing mart.
--
-- Produces (tenant_id, entity_id, feature_name, observed_at, value)
-- rows that the BFF PgFeatureStore reads. Each customer × feature ×
-- daily snapshot combo materialises one row.
--
-- The backfill anchors on mart.customer_360 + mart.loan_360 +
-- mart.txn_features as of the same `as_of` timestamp on each
-- customer_360 row. A future-improvement DAG can sweep historic
-- as_of values to populate the 24-month window; this initial model
-- materialises today's snapshot only — call it from a daily Airflow
-- DAG to accumulate the rolling window over time.
--
-- 8 PD-model features matching ml/data/load_from_mart.py:
--   - utilization, dpd_max_90d, bureau_score, repayment_delay_streak
--   - txn_volume_zscore_90d, tenure_months
--   - product_level (enum-encoded), income_level (enum-encoded)

WITH c360 AS (
    SELECT
        tenant_id,
        customer_id                                  AS entity_id,
        coalesce(as_of, now())                       AS observed_at,
        LEAST(coalesce(exposure_to_income_ratio, 0)::double precision, 1.5)
                                                     AS utilization,
        coalesce(worst_dpd, 0)::double precision     AS dpd_max_90d,
        coalesce(bureau_score, 600)::double precision AS bureau_score,
        coalesce(arrears_repayment_count, 0)::double precision
                                                     AS repayment_delay_streak,
        coalesce(
            extract(epoch FROM (coalesce(as_of, now()) - onboarded_at)) / 2592000.0,
            0
        )::double precision                          AS tenure_months
    FROM {{ ref('customer_360') }}
),
txn AS (
    -- mart.txn_features doesn't carry a precomputed zscore column today —
    -- compute it inline from txn_count_90d via window function over the
    -- per-tenant population. Backward-compatible patch: model output shape
    -- unchanged, just sources the value differently.
    SELECT
        tenant_id,
        customer_id AS entity_id,
        coalesce(
            (txn_count_90d::double precision
             - avg(txn_count_90d::double precision) OVER (PARTITION BY tenant_id))
            / nullif(stddev_pop(txn_count_90d::double precision) OVER (PARTITION BY tenant_id), 0),
            0
        )::double precision AS txn_volume_zscore_90d
    FROM {{ ref('txn_features') }}
),
loans AS (
    SELECT
        tenant_id,
        customer_id AS entity_id,
        -- product_level encoded: PL_RET=0, AUTO_RET=1, INV_SME=2, WC_SME=3, CORP_TL=4
        CASE
            WHEN max(product_code) = 'PL_RET'  THEN 0
            WHEN max(product_code) = 'AUTO_RET' THEN 1
            WHEN max(product_code) = 'INV_SME' THEN 2
            WHEN max(product_code) = 'WC_SME'  THEN 3
            WHEN max(product_code) = 'CORP_TL' THEN 4
            ELSE 0
        END::double precision AS product_level
    FROM {{ ref('loan_360') }}
    GROUP BY tenant_id, customer_id
),
income_enc AS (
    SELECT
        tenant_id,
        customer_id AS entity_id,
        -- income_level band: <25k=0, 25-50k=1, 50-100k=2, 100-250k=3, 250k+=4
        CASE
            WHEN monthly_income < 25000  THEN 0
            WHEN monthly_income < 50000  THEN 1
            WHEN monthly_income < 100000 THEN 2
            WHEN monthly_income < 250000 THEN 3
            ELSE 4
        END::double precision AS income_level
    FROM {{ ref('customer_360') }}
),
joined AS (
    SELECT
        c360.tenant_id,
        c360.entity_id,
        c360.observed_at,
        c360.utilization,
        c360.dpd_max_90d,
        c360.bureau_score,
        c360.repayment_delay_streak,
        coalesce(txn.txn_volume_zscore_90d, 0)::double precision AS txn_volume_zscore_90d,
        c360.tenure_months,
        coalesce(loans.product_level, 0)::double precision        AS product_level,
        coalesce(income_enc.income_level, 0)::double precision    AS income_level
    FROM c360
    LEFT JOIN txn        USING (tenant_id, entity_id)
    LEFT JOIN loans      USING (tenant_id, entity_id)
    LEFT JOIN income_enc USING (tenant_id, entity_id)
)
-- Pivot wide → long: one row per (tenant, entity, feature, observed_at).
SELECT tenant_id, entity_id, 'utilization'            AS feature_name, observed_at, utilization            AS value FROM joined
UNION ALL
SELECT tenant_id, entity_id, 'dpd_max_90d'            AS feature_name, observed_at, dpd_max_90d            AS value FROM joined
UNION ALL
SELECT tenant_id, entity_id, 'bureau_score'           AS feature_name, observed_at, bureau_score           AS value FROM joined
UNION ALL
SELECT tenant_id, entity_id, 'repayment_delay_streak' AS feature_name, observed_at, repayment_delay_streak AS value FROM joined
UNION ALL
SELECT tenant_id, entity_id, 'txn_volume_zscore_90d'  AS feature_name, observed_at, txn_volume_zscore_90d  AS value FROM joined
UNION ALL
SELECT tenant_id, entity_id, 'tenure_months'          AS feature_name, observed_at, tenure_months          AS value FROM joined
UNION ALL
SELECT tenant_id, entity_id, 'product_level'          AS feature_name, observed_at, product_level          AS value FROM joined
UNION ALL
SELECT tenant_id, entity_id, 'income_level'           AS feature_name, observed_at, income_level           AS value FROM joined
