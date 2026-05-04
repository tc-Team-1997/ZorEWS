{{ config(
    materialized='table',
    schema='mart',
    alias='indicator_values'
) }}

-- mart.indicator_values
-- ----------------------------------------------------------------------------
-- Long-format indicator output: one row per (customer_id, snapshot_date,
-- indicator_id). Consumed by agent-rule's rule engine (predicates select rows
-- where indicator_id = '...' and use the `value` column) and by agent-alert
-- (severity merge).
--
-- The catalog at services/regulatory-svc/indicators/catalog.json defines 30
-- indicators across 4 families. Most need columns the dbt mart does NOT yet
-- expose (daily_balance series, restructure_requests JSON, IFRS9 prior-stage,
-- bureau-score-90d-ago, etc.) — those are computed at runtime by
-- regulatory-svc/indicators's `POST /indicators/compute` endpoint.
--
-- This model implements 8 of the 30 — the cheap, rolling-window subset that
-- works on columns we already have. The picks are documented below; the rest
-- are intentionally NOT materialised here and must be requested via the
-- runtime service.
--
-- Picks (and why):
--   TXN-001  outflow_to_inflow_ratio_30d  — already in mart.txn_features
--   FIN-005  net_cashflow_30d (proxy)     — uses customer.monthly_income as the
--                                           EMI proxy until loan_360 exposes
--                                           emi_amount; breach when ratio < 0.5
--   FIN-007  loan_to_income_ratio         — derives directly from
--                                           customer_360.exposure_to_income_ratio
--                                           (annualised by ÷12)
--   CRD-006  internal_dpd_current         — customer_360.worst_dpd
--   CRD-007  collateral_coverage_ratio    — sum(collateral_value) ÷
--                                           sum(outstanding_amount) per customer
--                                           (from stg_loans)
--   BEH-002  repayment_delay_streak_proxy — count of trailing arrears
--                                           payments per customer; uses
--                                           is_arrears_payment as the
--                                           "late" marker until days_late
--                                           lands on stg_repayments
--   BEH-003  partial_repayment_ratio_90d  — share of last-90d repayments where
--                                           shortfall_amount > 0
--   TXN-005  bounced_payment_count_60d    — count of last-60d repayments
--                                           where shortfall_amount =
--                                           scheduled_amount (full miss = NSF
--                                           proxy until txn_status lands)
--
-- Severity buckets are derived from the catalog's severity_weight on the
-- runtime side; here we encode the same bucketing as a CASE so consumers
-- can read this table without touching the JSON. Buckets:
--   weight ≥ 0.85 → critical
--   weight ≥ 0.65 → high
--   weight ≥ 0.45 → medium
--   weight <  0.45 → low
--
-- Schema: (customer_id, snapshot_date, indicator_id, value, breached, severity)
-- ----------------------------------------------------------------------------

WITH cust AS (
    -- T4.24 Phase 13: tenant_id flows through from customer_360 so each
    -- indicator row can be filtered by the operator's tenant downstream.
    SELECT tenant_id, customer_id, monthly_income, total_outstanding, worst_dpd,
           exposure_to_income_ratio
    FROM {{ ref('customer_360') }}
),
txn AS (
    SELECT customer_id, inflow_30d, outflow_30d
    FROM {{ ref('txn_features') }}
),
loans AS (
    SELECT customer_id,
           sum(outstanding_amount)::numeric(18,2) AS sum_outstanding,
           sum(coalesce(collateral_value, 0))::numeric(18,2) AS sum_collateral
    FROM {{ ref('stg_loans') }}
    GROUP BY customer_id
),
repay_90d AS (
    SELECT customer_id,
           count(*)                                                     AS rep_count_90d,
           sum(CASE WHEN shortfall_amount > 0 THEN 1 ELSE 0 END)         AS partial_count_90d
    FROM {{ ref('stg_repayments') }}
    WHERE repayment_date >= current_date - INTERVAL '90 day'
    GROUP BY customer_id
),
repay_60d_bounced AS (
    SELECT customer_id,
           sum(CASE
                 WHEN scheduled_amount > 0 AND shortfall_amount >= scheduled_amount
                 THEN 1 ELSE 0 END) AS bounced_count_60d
    FROM {{ ref('stg_repayments') }}
    WHERE repayment_date >= current_date - INTERVAL '60 day'
    GROUP BY customer_id
),
-- BEH-002 proxy: trailing run of arrears payments per customer.
-- We compute by finding the latest non-arrears repayment, then counting the
-- number of arrears repayments after it. Uses a window function.
repay_streak AS (
    SELECT
        customer_id,
        sum(CASE WHEN is_arrears_payment THEN 1 ELSE 0 END)
            OVER (PARTITION BY customer_id) AS arrears_total,
        sum(CASE WHEN NOT is_arrears_payment THEN 1 ELSE 0 END)
            OVER (PARTITION BY customer_id ORDER BY repayment_date DESC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS non_arrears_seen,
        is_arrears_payment,
        repayment_date,
        row_number() OVER (PARTITION BY customer_id ORDER BY repayment_date DESC) AS rn
    FROM {{ ref('stg_repayments') }}
),
streak_per_customer AS (
    SELECT
        customer_id,
        sum(CASE WHEN is_arrears_payment AND non_arrears_seen = 0 THEN 1 ELSE 0 END) AS arrears_streak
    FROM repay_streak
    GROUP BY customer_id
),
-- pivot rows ----------------------------------------------------------
txn_001 AS (
    SELECT
        c.tenant_id,
        c.customer_id,
        current_date AS snapshot_date,
        'TXN-001'::text AS indicator_id,
        CASE WHEN coalesce(t.inflow_30d, 0) <= 0 AND coalesce(t.outflow_30d, 0) <= 0 THEN NULL
             ELSE round(coalesce(t.outflow_30d,0) / GREATEST(coalesce(t.inflow_30d,0), 1), 4) END AS value,
        0.55::numeric AS weight
    FROM cust c LEFT JOIN txn t ON t.customer_id = c.customer_id
),
fin_005 AS (
    SELECT
        c.tenant_id,
        c.customer_id,
        current_date AS snapshot_date,
        'FIN-005'::text AS indicator_id,
        CASE WHEN c.monthly_income IS NULL OR c.monthly_income = 0 THEN NULL
             ELSE round((coalesce(t.inflow_30d,0) - coalesce(t.outflow_30d,0)) / c.monthly_income, 4) END AS value,
        0.65::numeric AS weight
    FROM cust c LEFT JOIN txn t ON t.customer_id = c.customer_id
),
fin_007 AS (
    SELECT
        tenant_id,
        customer_id,
        current_date AS snapshot_date,
        'FIN-007'::text AS indicator_id,
        CASE WHEN exposure_to_income_ratio IS NULL THEN NULL
             ELSE round(exposure_to_income_ratio / 12, 4) END AS value,
        0.6::numeric AS weight
    FROM cust
),
crd_006 AS (
    SELECT
        tenant_id,
        customer_id,
        current_date AS snapshot_date,
        'CRD-006'::text AS indicator_id,
        worst_dpd::numeric AS value,
        0.95::numeric AS weight
    FROM cust
),
crd_007 AS (
    SELECT
        c.tenant_id,
        c.customer_id,
        current_date AS snapshot_date,
        'CRD-007'::text AS indicator_id,
        CASE WHEN coalesce(l.sum_outstanding,0) = 0 OR coalesce(l.sum_collateral,0) = 0 THEN NULL
             ELSE round(l.sum_collateral / l.sum_outstanding, 4) END AS value,
        0.5::numeric AS weight
    FROM cust c LEFT JOIN loans l ON l.customer_id = c.customer_id
),
beh_002 AS (
    SELECT
        c.tenant_id,
        c.customer_id,
        current_date AS snapshot_date,
        'BEH-002'::text AS indicator_id,
        coalesce(s.arrears_streak, 0)::numeric AS value,
        0.8::numeric AS weight
    FROM cust c LEFT JOIN streak_per_customer s ON s.customer_id = c.customer_id
),
beh_003 AS (
    SELECT
        c.tenant_id,
        c.customer_id,
        current_date AS snapshot_date,
        'BEH-003'::text AS indicator_id,
        CASE WHEN coalesce(r.rep_count_90d,0) = 0 THEN NULL
             ELSE round(coalesce(r.partial_count_90d,0)::numeric / r.rep_count_90d, 4) END AS value,
        0.65::numeric AS weight
    FROM cust c LEFT JOIN repay_90d r ON r.customer_id = c.customer_id
),
txn_005 AS (
    SELECT
        c.tenant_id,
        c.customer_id,
        current_date AS snapshot_date,
        'TXN-005'::text AS indicator_id,
        coalesce(rb.bounced_count_60d, 0)::numeric AS value,
        0.85::numeric AS weight
    FROM cust c LEFT JOIN repay_60d_bounced rb ON rb.customer_id = c.customer_id
),
unioned AS (
    SELECT * FROM txn_001
    UNION ALL SELECT * FROM fin_005
    UNION ALL SELECT * FROM fin_007
    UNION ALL SELECT * FROM crd_006
    UNION ALL SELECT * FROM crd_007
    UNION ALL SELECT * FROM beh_002
    UNION ALL SELECT * FROM beh_003
    UNION ALL SELECT * FROM txn_005
)
SELECT
    tenant_id,
    customer_id,
    snapshot_date,
    indicator_id,
    value,
    -- breach predicates per indicator. Aligned with the runtime compute fns.
    CASE
        WHEN indicator_id = 'TXN-001' THEN value IS NOT NULL AND value >= 1.2
        WHEN indicator_id = 'FIN-005' THEN value IS NOT NULL AND value < 0.5
        WHEN indicator_id = 'FIN-007' THEN value IS NOT NULL AND value >= 0.5
        WHEN indicator_id = 'CRD-006' THEN value IS NOT NULL AND value >= 30
        WHEN indicator_id = 'CRD-007' THEN value IS NOT NULL AND value < 1
        WHEN indicator_id = 'BEH-002' THEN value IS NOT NULL AND value >= 2
        WHEN indicator_id = 'BEH-003' THEN value IS NOT NULL AND value >= 0.4
        WHEN indicator_id = 'TXN-005' THEN value IS NOT NULL AND value >= 1
        ELSE false
    END AS breached,
    -- severity bucket from catalog weight (only meaningful when breached;
    -- otherwise we still encode the bucket so downstream consumers can
    -- read it as an "if-this-fires-how-bad" hint).
    CASE
        WHEN
            CASE
                WHEN indicator_id = 'TXN-001' THEN value IS NOT NULL AND value >= 1.2
                WHEN indicator_id = 'FIN-005' THEN value IS NOT NULL AND value < 0.5
                WHEN indicator_id = 'FIN-007' THEN value IS NOT NULL AND value >= 0.5
                WHEN indicator_id = 'CRD-006' THEN value IS NOT NULL AND value >= 30
                WHEN indicator_id = 'CRD-007' THEN value IS NOT NULL AND value < 1
                WHEN indicator_id = 'BEH-002' THEN value IS NOT NULL AND value >= 2
                WHEN indicator_id = 'BEH-003' THEN value IS NOT NULL AND value >= 0.4
                WHEN indicator_id = 'TXN-005' THEN value IS NOT NULL AND value >= 1
                ELSE false
            END
        THEN
            CASE
                WHEN weight >= 0.85 THEN 'critical'
                WHEN weight >= 0.65 THEN 'high'
                WHEN weight >= 0.45 THEN 'medium'
                ELSE 'low'
            END
        ELSE 'low'
    END AS severity,
    current_timestamp AS computed_at
FROM unioned
