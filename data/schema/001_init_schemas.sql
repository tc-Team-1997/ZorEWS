-- 001_init_schemas.sql
-- APEX EWS — initialise the four logical schemas used throughout the platform.
-- raw      : landing zone for upstream system extracts (CBS, bureau, …)
-- staging  : conformed / lightly cleaned models built by dbt
-- mart     : business-level marts consumed by indicator + AI engines + UI
-- audit    : append-only, hash-chained audit trail (NFR-AUDIT)

CREATE SCHEMA IF NOT EXISTS raw     AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS staging AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS mart    AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS audit   AUTHORIZATION CURRENT_USER;

COMMENT ON SCHEMA raw     IS 'Landing zone — raw extracts from CBS, bureau, LOS. Append/replace; no transforms.';
COMMENT ON SCHEMA staging IS 'Conformed / cleaned views built by dbt. One-to-one with raw, type-cast, deduped.';
COMMENT ON SCHEMA mart    IS 'Business marts: customer_360, loan_360, txn_features, indicator_values.';
COMMENT ON SCHEMA audit   IS 'Append-only, hash-chained event log (NFR-AUDIT, 7-year retention).';
