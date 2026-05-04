{{ config(materialized='view') }}

-- One row per loan_id (latest snapshot).
WITH src AS (
    SELECT
        loan_id::text                                AS loan_id,
        customer_id::text                            AS customer_id,
        NULLIF(trim(product_code),'')                AS product_code,
        upper(coalesce(currency,'KES'))::char(3)     AS currency,
        principal_amount::numeric(18,2)              AS principal_amount,
        outstanding_amount::numeric(18,2)            AS outstanding_amount,
        interest_rate::numeric(7,4)                  AS interest_rate,
        tenor_months::integer                        AS tenor_months,
        disbursed_at::timestamptz                    AS disbursed_at,
        maturity_date::date                          AS maturity_date,
        upper(coalesce(npa_status,'PERFORMING'))     AS npa_status,
        coalesce(days_past_due,0)::integer           AS days_past_due,
        last_repayment_at::timestamptz               AS last_repayment_at,
        collateral_value::numeric(18,2)              AS collateral_value,
        NULLIF(trim(branch_code),'')                 AS branch_code
    FROM {{ source('raw','seed_loans') }}
),
dedup AS (
    SELECT *,
           row_number() OVER (
               PARTITION BY loan_id
               ORDER BY disbursed_at DESC NULLS LAST
           ) AS rn
    FROM src
)
SELECT
    -- T4.24 Phase 13: stamp the BANK_DEMO tenant; swap for a coalesce
    -- against a real source column when BIL synthetic data ships.
    'BANK_DEMO'::text AS tenant_id,
    loan_id,
    customer_id,
    product_code,
    currency,
    principal_amount,
    outstanding_amount,
    interest_rate,
    tenor_months,
    disbursed_at,
    maturity_date,
    npa_status,
    days_past_due,
    last_repayment_at,
    collateral_value,
    branch_code,
    (npa_status IN ('SUBSTANDARD','DOUBTFUL','LOSS')) AS is_npa
FROM dedup
WHERE rn = 1
