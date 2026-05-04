{{ config(
    materialized='table',
    schema='mart',
    alias='txn_features'
) }}

-- mart.txn_features — rolling 7/30/90-day aggregates per customer.
-- One row per customer × as_of date. For the prototype we generate a
-- single snapshot at run time (current_date); the production DAG
-- partitions by `as_of` and rolls forward.

WITH t AS (
    SELECT
        -- T4.24 Phase 13: tenant_id from stg_txns; group by it so a
        -- future BIL dataset doesn't merge with BANK_DEMO transactions.
        tenant_id,
        customer_id,
        txn_date,
        inflow_amount,
        outflow_amount
    FROM {{ ref('stg_txns') }}
),
window_aggs AS (
    SELECT
        tenant_id,
        customer_id,
        -- 7-day window
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_short") }} day'
                 THEN inflow_amount  ELSE 0 END)::numeric(18,2)  AS inflow_7d,
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_short") }} day'
                 THEN outflow_amount ELSE 0 END)::numeric(18,2)  AS outflow_7d,
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_short") }} day'
                 THEN 1 ELSE 0 END)                              AS txn_count_7d,
        -- 30-day window
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_med") }} day'
                 THEN inflow_amount  ELSE 0 END)::numeric(18,2)  AS inflow_30d,
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_med") }} day'
                 THEN outflow_amount ELSE 0 END)::numeric(18,2)  AS outflow_30d,
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_med") }} day'
                 THEN 1 ELSE 0 END)                              AS txn_count_30d,
        -- 90-day window
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_long") }} day'
                 THEN inflow_amount  ELSE 0 END)::numeric(18,2)  AS inflow_90d,
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_long") }} day'
                 THEN outflow_amount ELSE 0 END)::numeric(18,2)  AS outflow_90d,
        sum(CASE WHEN txn_date >= current_date - INTERVAL '{{ var("txn_window_long") }} day'
                 THEN 1 ELSE 0 END)                              AS txn_count_90d
    FROM t
    GROUP BY tenant_id, customer_id
)
SELECT
    tenant_id,
    customer_id,
    current_date AS as_of,
    inflow_7d,
    outflow_7d,
    txn_count_7d,
    (inflow_7d - outflow_7d)::numeric(18,2)              AS net_flow_7d,
    inflow_30d,
    outflow_30d,
    txn_count_30d,
    (inflow_30d - outflow_30d)::numeric(18,2)            AS net_flow_30d,
    inflow_90d,
    outflow_90d,
    txn_count_90d,
    (inflow_90d - outflow_90d)::numeric(18,2)            AS net_flow_90d,
    -- velocity ratios used by behavioural indicators
    CASE WHEN inflow_30d = 0 THEN NULL
         ELSE round(outflow_30d / inflow_30d, 4)
    END                                                  AS burn_ratio_30d,
    CASE WHEN inflow_90d = 0 THEN NULL
         ELSE round(inflow_30d / NULLIF(inflow_90d/3.0, 0), 4)
    END                                                  AS inflow_velocity_ratio
FROM window_aggs
