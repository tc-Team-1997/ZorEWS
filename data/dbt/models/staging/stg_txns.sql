{{ config(materialized='view') }}

WITH src AS (
    SELECT
        txn_id::text                              AS txn_id,
        customer_id::text                         AS customer_id,
        NULLIF(trim(account_id),'')               AS account_id,
        txn_timestamp::timestamptz                AS txn_timestamp,
        lower(txn_type)                           AS txn_type,
        lower(NULLIF(trim(txn_category),''))      AS txn_category,
        amount::numeric(18,2)                     AS amount,
        upper(coalesce(currency,'KES'))::char(3)  AS currency,
        balance_after::numeric(18,2)              AS balance_after,
        NULLIF(trim(counterparty),'')             AS counterparty,
        lower(NULLIF(trim(channel),''))           AS channel
    FROM {{ source('raw','seed_transactions') }}
)
SELECT
    -- T4.24 Phase 13: stamped at the staging layer; literal until BIL data lands.
    'BANK_DEMO'::text AS tenant_id,
    txn_id,
    customer_id,
    account_id,
    txn_timestamp,
    txn_timestamp::date AS txn_date,
    txn_type,
    txn_category,
    amount,
    currency,
    balance_after,
    counterparty,
    channel,
    (txn_type = 'credit') AS is_inflow,
    CASE WHEN txn_type = 'credit' THEN amount ELSE 0 END::numeric(18,2) AS inflow_amount,
    CASE WHEN txn_type = 'debit'  THEN amount ELSE 0 END::numeric(18,2) AS outflow_amount
FROM src
