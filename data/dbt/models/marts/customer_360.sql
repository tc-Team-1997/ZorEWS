{{ config(
    materialized='table',
    schema='mart',
    alias='customer_360'
) }}

-- mart.customer_360 — one row per customer with rolled-up exposure,
-- behaviour and bureau score. Consumed by indicator-engine + UI risk
-- profile screen + AI training pipeline.

WITH cust AS (
    SELECT * FROM {{ ref('stg_customer') }}
),
loan_agg AS (
    SELECT
        customer_id,
        count(*)                                                 AS active_loan_count,
        sum(outstanding_amount)::numeric(18,2)                   AS total_outstanding,
        sum(principal_amount)::numeric(18,2)                     AS total_disbursed,
        max(days_past_due)                                       AS worst_dpd,
        sum(CASE WHEN is_npa THEN outstanding_amount ELSE 0 END)::numeric(18,2)
                                                                 AS npa_outstanding,
        bool_or(is_npa)                                          AS has_npa,
        max(disbursed_at)                                        AS last_disbursed_at,
        max(last_repayment_at)                                   AS last_repayment_at
    FROM {{ ref('stg_loans') }}
    GROUP BY customer_id
),
repay_agg AS (
    SELECT
        customer_id,
        count(*)                                                 AS repayment_count_lifetime,
        sum(CASE WHEN is_arrears_payment THEN 1 ELSE 0 END)      AS arrears_repayment_count,
        sum(shortfall_amount)::numeric(18,2)                     AS lifetime_shortfall,
        max(repayment_date)                                      AS last_repayment_date
    FROM {{ ref('stg_repayments') }}
    GROUP BY customer_id
),
txn_agg AS (
    SELECT
        customer_id,
        sum(inflow_amount)::numeric(18,2)                        AS lifetime_inflow,
        sum(outflow_amount)::numeric(18,2)                       AS lifetime_outflow,
        max(txn_timestamp)                                       AS last_txn_at
    FROM {{ ref('stg_txns') }}
    GROUP BY customer_id
),
bureau AS (
    SELECT
        customer_id,
        score        AS bureau_score,
        score_band   AS bureau_score_band,
        score_as_of  AS bureau_as_of,
        delinquencies_12m,
        open_facilities,
        enquiries_3m
    FROM {{ ref('stg_bureau_score') }}
)
SELECT
    -- T4.24 Phase 13: tenant_id propagates from stg_customer (literal
    -- 'BANK_DEMO' until BIL synthetic data ships).
    c.tenant_id,
    c.customer_id,
    c.full_name,
    c.segment,
    c.branch_code,
    c.kyc_status,
    c.risk_rating,
    c.monthly_income,
    c.onboarded_at,
    coalesce(l.active_loan_count, 0)               AS active_loan_count,
    coalesce(l.total_outstanding, 0)::numeric(18,2) AS total_outstanding,
    coalesce(l.total_disbursed,   0)::numeric(18,2) AS total_disbursed,
    coalesce(l.worst_dpd, 0)                       AS worst_dpd,
    coalesce(l.npa_outstanding,   0)::numeric(18,2) AS npa_outstanding,
    coalesce(l.has_npa, false)                     AS has_npa,
    l.last_disbursed_at,
    coalesce(l.last_repayment_at, r.last_repayment_date::timestamptz)
                                                   AS last_repayment_at,
    coalesce(r.repayment_count_lifetime, 0)        AS repayment_count_lifetime,
    coalesce(r.arrears_repayment_count, 0)         AS arrears_repayment_count,
    coalesce(r.lifetime_shortfall, 0)::numeric(18,2) AS lifetime_shortfall,
    coalesce(t.lifetime_inflow,    0)::numeric(18,2) AS lifetime_inflow,
    coalesce(t.lifetime_outflow,   0)::numeric(18,2) AS lifetime_outflow,
    t.last_txn_at,
    b.bureau_score,
    b.bureau_score_band,
    b.bureau_as_of,
    b.delinquencies_12m,
    b.open_facilities,
    b.enquiries_3m,
    -- naive exposure-to-income ratio used by Indicator Engine
    CASE WHEN c.monthly_income IS NULL OR c.monthly_income = 0 THEN NULL
         ELSE round(coalesce(l.total_outstanding,0) / c.monthly_income, 4)
    END                                            AS exposure_to_income_ratio,
    current_timestamp                              AS as_of
FROM cust c
LEFT JOIN loan_agg   l ON l.customer_id = c.customer_id
LEFT JOIN repay_agg  r ON r.customer_id = c.customer_id
LEFT JOIN txn_agg    t ON t.customer_id = c.customer_id
LEFT JOIN bureau     b ON b.customer_id = c.customer_id
