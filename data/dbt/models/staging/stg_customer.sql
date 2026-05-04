{{ config(materialized='view') }}

-- One row per customer. Type-cast, trimmed, deduped on customer_id
-- (latest row wins by onboarded_at desc).
WITH src AS (
    SELECT
        customer_id::text                         AS customer_id,
        NULLIF(trim(full_name),'')                AS full_name,
        NULLIF(trim(national_id),'')              AS national_id,
        date_of_birth::date                       AS date_of_birth,
        lower(NULLIF(trim(gender),''))            AS gender,
        lower(NULLIF(trim(marital_status),''))    AS marital_status,
        lower(NULLIF(trim(employment_status),'')) AS employment_status,
        monthly_income::numeric(18,2)             AS monthly_income,
        NULLIF(trim(branch_code),'')              AS branch_code,
        lower(NULLIF(trim(segment),''))           AS segment,
        onboarded_at::timestamptz                 AS onboarded_at,
        lower(NULLIF(trim(kyc_status),''))        AS kyc_status,
        lower(NULLIF(trim(risk_rating),''))       AS risk_rating
    FROM {{ source('raw','seed_customers') }}
),
dedup AS (
    SELECT *,
           row_number() OVER (
               PARTITION BY customer_id
               ORDER BY onboarded_at DESC NULLS LAST
           ) AS rn
    FROM src
)
SELECT
    -- T4.24 Phase 13: stamp every row with the BANK_DEMO tenant. The seed
    -- CSV doesn't carry a tenant column today; when BIL synthetic data
    -- ships, swap this literal for `coalesce(tenant_id, 'BANK_DEMO')`
    -- and re-seed.
    'BANK_DEMO'::text AS tenant_id,
    customer_id,
    full_name,
    national_id,
    date_of_birth,
    gender,
    marital_status,
    employment_status,
    monthly_income,
    branch_code,
    segment,
    onboarded_at,
    kyc_status,
    risk_rating
FROM dedup
WHERE rn = 1
