-- 016_user_access_override.sql
--
-- Per-user EWS access override on top of role-based access.
-- Maps to BAC A Bank EWS User Manual v1.0 §3.1.6 (Admin) + §3.1.7 (Security Admin).
--
-- Tables created (schema = app_admin):
--   user_access_override : per-(user, module_path, permission) override rows
--   admin_audit_log      : specialised admin-action audit trail
--
-- Backward-compat: pure CREATE; no ALTER/DROP on existing objects.
--   Re-runnable via IF NOT EXISTS guards.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app_admin;

-- ── 1. user_access_override ───────────────────────────────────────────
-- Status flow:
--   PENDING_APPROVAL  → ACTIVE | REJECTED
--   ACTIVE            → REVOKED | EXPIRED
--
-- Rows are NEVER deleted; status moves forward only so the audit
-- chain stays intact for compliance review.

CREATE TABLE IF NOT EXISTS app_admin.user_access_override (
    override_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            TEXT         NOT NULL,
    user_id              TEXT         NOT NULL,
    module_path          TEXT         NOT NULL,
    override_type        TEXT         NOT NULL,
    permission_type      TEXT         NOT NULL,
    effective_from       TIMESTAMPTZ  NOT NULL,
    effective_till       TIMESTAMPTZ,
    reason               TEXT         NOT NULL,
    requires_approval    BOOLEAN      NOT NULL DEFAULT TRUE,
    status               TEXT         NOT NULL DEFAULT 'PENDING_APPROVAL',
    -- maker-checker actor trail
    created_by           TEXT         NOT NULL,
    approved_by          TEXT,
    rejected_by          TEXT,
    revoked_by           TEXT,
    rejection_reason     TEXT,
    revocation_reason    TEXT,
    approval_note        TEXT,
    -- timestamps
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    approved_at          TIMESTAMPTZ,
    rejected_at          TIMESTAMPTZ,
    revoked_at           TIMESTAMPTZ,
    -- enums
    CONSTRAINT user_access_override_type_check
        CHECK (override_type IN ('GRANT','REVOKE')),
    CONSTRAINT user_access_override_permission_check
        CHECK (permission_type IN ('VIEW','EDIT','APPROVE','FULL')),
    CONSTRAINT user_access_override_status_check
        CHECK (status IN ('PENDING_APPROVAL','ACTIVE','REJECTED','REVOKED','EXPIRED')),
    -- temporal sanity
    CONSTRAINT user_access_override_temporal_check
        CHECK (effective_till IS NULL OR effective_till > effective_from),
    CONSTRAINT user_access_override_reason_len_check
        CHECK (length(reason) >= 10),
    -- maker-checker — creator can never be approver/rejecter
    CONSTRAINT user_access_override_no_self_approval_check
        CHECK (approved_by IS NULL OR approved_by <> created_by),
    CONSTRAINT user_access_override_no_self_rejection_check
        CHECK (rejected_by IS NULL OR rejected_by <> created_by),
    -- approval-state coherence (which actor columns may be set per status)
    CONSTRAINT user_access_override_state_coherence_check
        CHECK (
            (status = 'PENDING_APPROVAL'
                AND approved_by IS NULL AND rejected_by IS NULL AND revoked_by IS NULL)
         OR (status = 'ACTIVE'
                AND (approved_by IS NOT NULL OR requires_approval = FALSE)
                AND revoked_by IS NULL)
         OR (status = 'REJECTED'
                AND rejected_by IS NOT NULL)
         OR (status = 'REVOKED'
                AND revoked_by IS NOT NULL)
         OR (status = 'EXPIRED'
                AND effective_till IS NOT NULL)
        )
);

-- One ACTIVE override per (user, module_path, permission_type) at a time.
-- REJECTED/REVOKED/EXPIRED rows can pile up for audit without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_access_override_active
    ON app_admin.user_access_override
       (tenant_id, user_id, module_path, permission_type)
    WHERE status = 'ACTIVE';

-- Listing/filter indexes
CREATE INDEX IF NOT EXISTS ix_user_access_override_user
    ON app_admin.user_access_override (tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS ix_user_access_override_pending
    ON app_admin.user_access_override (tenant_id, status, created_at DESC)
    WHERE status = 'PENDING_APPROVAL';
CREATE INDEX IF NOT EXISTS ix_user_access_override_expiring
    ON app_admin.user_access_override (tenant_id, effective_till)
    WHERE status = 'ACTIVE' AND effective_till IS NOT NULL;

COMMENT ON TABLE app_admin.user_access_override IS
  'Per-user access override layered on top of role-based access. Maker-checker enforced at DB (created_by != approved_by). Status moves forward only — never deletes, for audit compliance.';

-- ── 2. admin_audit_log ────────────────────────────────────────────────
-- Specialised admin-action audit. Each override mutation writes one
-- row here; the same row also fans into audit.event_log so the
-- tamper-evident hash chain covers it.

CREATE TABLE IF NOT EXISTS app_admin.admin_audit_log (
    audit_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT         NOT NULL,
    entity_type     TEXT         NOT NULL,
    entity_id       TEXT         NOT NULL,
    action          TEXT         NOT NULL,
    actor_id        TEXT         NOT NULL,
    actor_role      TEXT         NOT NULL,
    before_state    JSONB,
    after_state     JSONB,
    reason          TEXT,
    request_id      TEXT,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT admin_audit_log_entity_check
        CHECK (entity_type IN ('user_access_override')),
    CONSTRAINT admin_audit_log_action_check
        CHECK (action IN ('create','update','approve','reject','revoke','expire'))
);

CREATE INDEX IF NOT EXISTS ix_admin_audit_log_entity
    ON app_admin.admin_audit_log (tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_admin_audit_log_actor
    ON app_admin.admin_audit_log (tenant_id, actor_id, created_at DESC);

COMMENT ON TABLE app_admin.admin_audit_log IS
  'Specialised admin-action audit trail. Each row also fans into audit.event_log for hash-chain coverage.';

-- ── 3. updated_at trigger (mirror of pattern in 004_app_schemas.sql) ──
CREATE OR REPLACE FUNCTION app_admin.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_access_override_updated_at
    ON app_admin.user_access_override;
CREATE TRIGGER trg_user_access_override_updated_at
    BEFORE UPDATE ON app_admin.user_access_override
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.set_updated_at();

COMMIT;
