-- 022_notification_dispatch_log.sql
--
-- Durable storage for the M14.24 notification dispatch log. The
-- in-memory FIFO store from M14.24 (services/bff/src/admin/
-- notification_dispatch_store.ts) backs dev + tests; this migration
-- ships the PG-backed implementation that production wires when
-- ADMIN_PG_URL / BFF_PG_URL is set (M14.24c).
--
-- Append-only by design — every dispatch attempt (admin test-fire,
-- case_create_pipeline, escalation_worker) writes one row. Mirrors
-- the case_scenario_history pattern (021): BEFORE UPDATE/DELETE
-- trigger raises restrict_violation so SPA bugs can't silently mutate
-- the audit trail.
--
-- Idempotent (CREATE IF NOT EXISTS + DROP CONSTRAINT IF EXISTS); safe
-- to re-run. Tenant-scoped via tenant_id on every row.

BEGIN;

-- Schema + updated_at function were created in 016 + 021. CREATE IF
-- NOT EXISTS guards keep this file robust to running standalone.
CREATE SCHEMA IF NOT EXISTS app_admin;

CREATE TABLE IF NOT EXISTS app_admin.notification_dispatch_log (
    dispatch_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT         NOT NULL,
    -- FK to notification_templates is intentionally tenant-aware via
    -- the composite — but a notification template can be soft-deleted
    -- AFTER the dispatch fired, so we don't enforce a hard FK; the
    -- template_name + channel are denormalised so the log row stays
    -- self-describing even if the template is later archived.
    template_id        UUID         NOT NULL,
    template_name      TEXT         NOT NULL,
    channel            TEXT         NOT NULL,
    recipient          TEXT         NOT NULL,
    trigger            TEXT         NOT NULL,
    -- Optional caller correlation hint, e.g. "case:c-001" so admins
    -- can pivot from a case to all notifications dispatched for it.
    reference          TEXT,
    rendered_subject   TEXT,
    rendered_body      TEXT         NOT NULL,
    missing_vars       JSONB        NOT NULL DEFAULT '[]'::jsonb,
    status             TEXT         NOT NULL,
    status_reason      TEXT,
    performed_by       TEXT         NOT NULL,
    performed_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT notification_dispatch_log_channel_check
        CHECK (channel IN ('EMAIL','SMS','IN_APP')),
    CONSTRAINT notification_dispatch_log_trigger_check
        CHECK (trigger IN ('admin_test_fire','case_create_pipeline','escalation_worker')),
    CONSTRAINT notification_dispatch_log_status_check
        CHECK (status IN ('sent','preview','failed')),
    CONSTRAINT notification_dispatch_log_recipient_check
        CHECK (length(recipient) BETWEEN 1 AND 200),
    CONSTRAINT notification_dispatch_log_missing_vars_is_array_check
        CHECK (jsonb_typeof(missing_vars) = 'array'),
    -- SMS dispatches must have null subject (mirrors the
    -- notification_templates DB CHECK)
    CONSTRAINT notification_dispatch_log_subject_channel_check
        CHECK (
            (channel = 'SMS' AND rendered_subject IS NULL) OR
            (channel IN ('EMAIL','IN_APP') AND rendered_subject IS NOT NULL)
        )
);

-- Listing path: newest-first per tenant.
CREATE INDEX IF NOT EXISTS ix_notification_dispatch_log_tenant
    ON app_admin.notification_dispatch_log (tenant_id, performed_at DESC);
-- Per-template pivot ("show me the last N notifications for template X").
CREATE INDEX IF NOT EXISTS ix_notification_dispatch_log_template
    ON app_admin.notification_dispatch_log (tenant_id, template_id, performed_at DESC);
-- Per-reference pivot ("show me what we sent for case c-001"). Partial
-- so the index stays small — most rows are admin test-fires with no
-- reference; only case-pipeline + escalation rows carry one in practice.
CREATE INDEX IF NOT EXISTS ix_notification_dispatch_log_reference
    ON app_admin.notification_dispatch_log (tenant_id, reference, performed_at DESC)
    WHERE reference IS NOT NULL;
-- Status / trigger filter paths (less hot, but cheap to add).
CREATE INDEX IF NOT EXISTS ix_notification_dispatch_log_status
    ON app_admin.notification_dispatch_log (tenant_id, status, performed_at DESC);
CREATE INDEX IF NOT EXISTS ix_notification_dispatch_log_trigger
    ON app_admin.notification_dispatch_log (tenant_id, trigger, performed_at DESC);

COMMENT ON TABLE app_admin.notification_dispatch_log IS
    'Append-only dispatch attempt log (M14.24). One row per render+send (or render+preview / render+fail). Trigger discriminates admin test-fires from runtime sources (case-create pipeline, escalation worker). UPDATE + DELETE blocked by trigger — operators dispute via a new compensating entry, not by mutating history.';

-- Append-only enforcement (matches the case_scenario_history pattern).
CREATE OR REPLACE FUNCTION app_admin.notification_dispatch_log_block_mutate()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'app_admin.notification_dispatch_log is append-only — % blocked', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notification_dispatch_log_block_update
    ON app_admin.notification_dispatch_log;
CREATE TRIGGER trg_notification_dispatch_log_block_update
    BEFORE UPDATE ON app_admin.notification_dispatch_log
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.notification_dispatch_log_block_mutate();

DROP TRIGGER IF EXISTS trg_notification_dispatch_log_block_delete
    ON app_admin.notification_dispatch_log;
CREATE TRIGGER trg_notification_dispatch_log_block_delete
    BEFORE DELETE ON app_admin.notification_dispatch_log
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.notification_dispatch_log_block_mutate();

COMMIT;
