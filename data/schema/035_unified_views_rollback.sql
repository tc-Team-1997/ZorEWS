-- 035_unified_views_rollback.sql
-- Reverts the migration applied by 035_unified_views.sql.
-- Apply via: PGPASSWORD=apex psql -h localhost -p 55432 -U zorews_user -d zorews -f 035_unified_views_rollback.sql
--
-- Sections (executed in reverse order):
--   1. Drop views (DROP IF EXISTS — no-op when views absent in early-task state)
--   2. Drop schema unified
--   3. Drop supporting indexes added in 035 Section 3
--   4. Drop approvals tenant_id index + column (OPTIONAL — additive change is harmless;
--      uncomment the last block to fully revert)

BEGIN;

-- Section 1: views (placeholders for Tasks 4-7; IF EXISTS = no-op when absent)
DROP VIEW IF EXISTS unified.audit_activity CASCADE;
DROP VIEW IF EXISTS unified.cases CASCADE;
DROP VIEW IF EXISTS unified.alerts CASCADE;
DROP VIEW IF EXISTS unified.customer_360 CASCADE;

-- Section 2: schema
DROP SCHEMA IF EXISTS unified;

-- Section 3: supporting indexes
DROP INDEX IF EXISTS app_alerts.alerts_tenant_customer_idx;
DROP INDEX IF EXISTS app_cases.cases_tenant_customer_idx;
DROP INDEX IF EXISTS app_cases.cas_records_case_review_idx;
DROP INDEX IF EXISTS app_cases.caps_case_status_idx;
DROP INDEX IF EXISTS app_cases.actions_case_id_idx;

-- Section 4: approvals tenant_id (kept by default — additive, harmless).
-- Uncomment the next three statements to fully revert the precondition:
-- DROP INDEX IF EXISTS app_audit.approvals_correlation_status_idx;
-- DROP INDEX IF EXISTS app_audit.approvals_tenant_idx;
-- ALTER TABLE app_audit.approvals DROP COLUMN IF EXISTS tenant_id;

COMMIT;
