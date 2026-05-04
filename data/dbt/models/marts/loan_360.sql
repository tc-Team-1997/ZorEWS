{{ config(
    materialized='table',
    schema='mart',
    alias='loan_360'
) }}

-- mart.loan_360 — one row per loan with current outstanding, dpd and
-- last repayment behaviour. Driving table for loan-level indicators
-- and Collection auto-routing in Phase 3.

WITH l AS (
    SELECT * FROM {{ ref('stg_loans') }}
),
repay AS (
    SELECT
        loan_id,
        count(*)                                              AS repayment_count,
        max(repayment_date)                                   AS last_repayment_date,
        sum(paid_amount)::numeric(18,2)                       AS total_paid,
        sum(shortfall_amount)::numeric(18,2)                  AS total_shortfall,
        sum(CASE WHEN is_arrears_payment THEN 1 ELSE 0 END)   AS arrears_payment_count,
        max(CASE WHEN repayment_date >= current_date - INTERVAL '30 day'
                 THEN repayment_date END)                     AS last_30d_repayment_date
    FROM {{ ref('stg_repayments') }}
    GROUP BY loan_id
),
cust AS (
    SELECT customer_id, segment, branch_code, monthly_income
    FROM {{ ref('stg_customer') }}
)
SELECT
    -- T4.24 Phase 13: tenant_id from stg_loans (BANK_DEMO literal today).
    l.tenant_id,
    l.loan_id,
    l.customer_id,
    c.segment,
    c.branch_code,
    l.product_code,
    l.currency,
    l.principal_amount,
    l.outstanding_amount,
    l.interest_rate,
    l.tenor_months,
    l.disbursed_at,
    l.maturity_date,
    l.npa_status,
    l.is_npa,
    l.days_past_due,
    -- DPD bucket for downstream rule predicates
    CASE
        WHEN l.days_past_due = 0                       THEN '0'
        WHEN l.days_past_due BETWEEN 1   AND 30        THEN '1-30'
        WHEN l.days_past_due BETWEEN 31  AND 60        THEN '31-60'
        WHEN l.days_past_due BETWEEN 61  AND 90        THEN '61-90'
        WHEN l.days_past_due BETWEEN 91  AND 180       THEN '91-180'
        ELSE '180+'
    END                                                AS dpd_bucket,
    l.last_repayment_at,
    coalesce(r.last_repayment_date, l.last_repayment_at::date)
                                                       AS last_repayment_date,
    coalesce(r.repayment_count, 0)                     AS repayment_count,
    coalesce(r.total_paid,     0)::numeric(18,2)       AS total_paid,
    coalesce(r.total_shortfall,0)::numeric(18,2)       AS total_shortfall,
    coalesce(r.arrears_payment_count, 0)               AS arrears_payment_count,
    -- LTV proxy (collateral / outstanding)
    CASE WHEN l.collateral_value IS NULL OR l.collateral_value = 0 THEN NULL
         ELSE round(l.outstanding_amount / l.collateral_value, 4)
    END                                                AS ltv_ratio,
    current_timestamp                                  AS as_of
FROM l
LEFT JOIN repay r ON r.loan_id     = l.loan_id
LEFT JOIN cust  c ON c.customer_id = l.customer_id
