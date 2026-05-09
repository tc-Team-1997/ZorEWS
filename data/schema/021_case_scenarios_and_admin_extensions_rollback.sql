-- 021_case_scenarios_and_admin_extensions_rollback.sql
--
-- Rollback for 021_case_scenarios_and_admin_extensions.sql.
--
-- Drops the 4 new tables in reverse FK order (history → scenarios →
-- escalation/templates) and restores admin_audit_log_entity_check +
-- admin_audit_log_action_check to the post-020 state (the next-most-recent
-- migration that touched them).
--
-- Idempotent (DROP IF EXISTS / DROP CONSTRAINT IF EXISTS).
--
-- DOES NOT touch:
--   - the app_admin schema itself (created in 016)
--   - app_admin.set_updated_at() (created in 016)
--   - app_admin.user_access_override / admin_audit_log / sla_config /
--     saved_report_filters (created in 016/018/020)
--
-- Lossy by design — 021 seed data is dropped along with the tables.

BEGIN;

-- 1. Drop append-only triggers + the trigger function
DROP TRIGGER IF EXISTS trg_case_scenario_history_block_update
    ON app_admin.case_scenario_history;
DROP TRIGGER IF EXISTS trg_case_scenario_history_block_delete
    ON app_admin.case_scenario_history;
DROP FUNCTION IF EXISTS app_admin.case_scenario_history_block_mutate();

-- 2. Drop tables in reverse FK order
DROP TABLE IF EXISTS app_admin.case_scenario_history;
DROP TABLE IF EXISTS app_admin.case_scenarios;
DROP TABLE IF EXISTS app_admin.escalation_matrix;
DROP TABLE IF EXISTS app_admin.notification_templates;

-- 3. Restore admin_audit_log_entity_check to the post-020 set
ALTER TABLE app_admin.admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_entity_check;
ALTER TABLE app_admin.admin_audit_log
    ADD CONSTRAINT admin_audit_log_entity_check
        CHECK (entity_type IN ('user_access_override','report_export'));

-- 4. Restore admin_audit_log_action_check to the post-020 set
ALTER TABLE app_admin.admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE app_admin.admin_audit_log
    ADD CONSTRAINT admin_audit_log_action_check
        CHECK (action IN (
            'create','update','approve','reject','revoke','expire',
            'export','view'
        ));

COMMIT;
