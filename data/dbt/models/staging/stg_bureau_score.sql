{{ config(materialized='view') }}

-- Latest bureau row per customer.
WITH src AS (
    SELECT
        customer_id::text                  AS customer_id,
        bureau_name::text                  AS bureau_name,
        score::integer                     AS score,
        upper(NULLIF(trim(score_band),'')) AS score_band,
        score_as_of::date                  AS score_as_of,
        delinquencies_12m::integer         AS delinquencies_12m,
        open_facilities::integer           AS open_facilities,
        total_exposure::numeric(18,2)      AS total_exposure,
        enquiries_3m::integer              AS enquiries_3m
    FROM {{ source('raw','seed_bureau_score') }}
),
ranked AS (
    SELECT *,
           row_number() OVER (
               PARTITION BY customer_id
               ORDER BY score_as_of DESC
           ) AS rn
    FROM src
)
SELECT
    -- T4.24 Phase 13: stamped at the staging layer; literal until BIL data lands.
    'BANK_DEMO'::text AS tenant_id,
    customer_id,
    bureau_name,
    score,
    score_band,
    score_as_of,
    delinquencies_12m,
    open_facilities,
    total_exposure,
    enquiries_3m
FROM ranked
WHERE rn = 1
