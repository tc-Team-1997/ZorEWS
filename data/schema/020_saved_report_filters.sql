-- 020_saved_report_filters.sql
--
-- Per-user (optionally shared) saved filters for the Reports section
-- (BAC §3.1.8) + extends app_admin.admin_audit_log to allow
-- `report_export` entries.

BEGIN;

CREATE TABLE IF NOT EXISTS app_admin.saved_report_filters (
    filter_id      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      TEXT         NOT NULL,
    owner_id       TEXT         NOT NULL,
    report_type    TEXT         NOT NULL,
    name           TEXT         NOT NULL,
    filters        JSONB        NOT NULL,
    is_shared      BOOLEAN      NOT NULL DEFAULT FALSE,
    is_default     BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT saved_report_filters_report_type_check
        CHECK (report_type IN ('cases','alerts','snapshot','rbi')),
    CONSTRAINT saved_report_filters_name_len_check
        CHECK (length(trim(name)) BETWEEN 1 AND 80)
);

-- One default per (owner, report_type)
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_filter_default
    ON app_admin.saved_report_filters (tenant_id, owner_id, report_type)
    WHERE is_default = TRUE;
CREATE INDEX IF NOT EXISTS ix_saved_filter_listing
    ON app_admin.saved_report_filters (tenant_id, owner_id, report_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_saved_filter_shared
    ON app_admin.saved_report_filters (tenant_id, report_type, updated_at DESC)
    WHERE is_shared = TRUE;

COMMENT ON TABLE app_admin.saved_report_filters IS
  'Per-user (optionally shared) Reports filter presets. Surfaces in the Reports filter bar; one is_default per (owner, report_type) drives the on-load filter.';

DROP TRIGGER IF EXISTS trg_saved_report_filters_updated_at
    ON app_admin.saved_report_filters;
CREATE TRIGGER trg_saved_report_filters_updated_at
    BEFORE UPDATE ON app_admin.saved_report_filters
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.set_updated_at();

-- ── Extend admin_audit_log to accept report_export entries ─────────
ALTER TABLE app_admin.admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_entity_check;
ALTER TABLE app_admin.admin_audit_log
    ADD CONSTRAINT admin_audit_log_entity_check
        CHECK (entity_type IN ('user_access_override','report_export'));

ALTER TABLE app_admin.admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE app_admin.admin_audit_log
    ADD CONSTRAINT admin_audit_log_action_check
        CHECK (action IN (
            'create','update','approve','reject','revoke','expire',
            'export','view'
        ));

COMMIT;
