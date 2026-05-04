{{ config(materialized='view') }}

WITH src AS (
    SELECT
        repayment_id::text                       AS repayment_id,
        loan_id::text                            AS loan_id,
        customer_id::text                        AS customer_id,
        repayment_date::date                     AS repayment_date,
        scheduled_amount::numeric(18,2)          AS scheduled_amount,
        paid_amount::numeric(18,2)               AS paid_amount,
        principal_paid::numeric(18,2)            AS principal_paid,
        interest_paid::numeric(18,2)             AS interest_paid,
        fees_paid::numeric(18,2)                 AS fees_paid,
        upper(coalesce(currency,'KES'))::char(3) AS currency,
        lower(NULLIF(trim(channel),''))          AS channel,
        coalesce(is_arrears_payment,false)       AS is_arrears_payment
    FROM {{ source('raw','seed_repayments') }}
)
SELECT
    -- T4.24 Phase 13: stamped at the staging layer; literal until BIL data lands.
    'BANK_DEMO'::text AS tenant_id,
    repayment_id,
    loan_id,
    customer_id,
    repayment_date,
    scheduled_amount,
    paid_amount,
    principal_paid,
    interest_paid,
    fees_paid,
    currency,
    channel,
    is_arrears_payment,
    -- shortfall is a useful behavioural feature
    GREATEST(coalesce(scheduled_amount,0) - coalesce(paid_amount,0), 0)::numeric(18,2)
        AS shortfall_amount
FROM src
