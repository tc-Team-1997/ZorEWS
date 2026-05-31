-- data/schema/050_app_recovery.sql
--
-- Enterprise Recovery Management Center — schema extension.
-- Additive over migration 023_recovery.sql (app_recovery.deleted_records unchanged).
--
-- Introduces:
--   * app_recovery.recovery_approvals       — maker-checker ledger
--   * app_recovery.recovery_policies        — per-tenant retention + auto-purge config
--   * app_recovery.recovery_workflow_events — append-only state-transition log
--
-- Design contract:
--   * No parallel audit table — every approval/decision fans out
--     to audit.event_log via the existing M15 auditTrailStore.
--   * Mirrors M9.3 case_maker_checker.ts contract: maker_username ≠
--     checker_username enforced at row level (RBI segregation of duties).
--   * Apply AFTER 023_recovery.sql + 005_tenants.sql.
--   * Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
--     + INSERT ON CONFLICT DO NOTHING. Re-runs are safe.

CREATE SCHEMA IF NOT EXISTS app_recovery;

-- =========================================================================
-- 1. Recovery Approvals (maker-checker workflow ledger)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_recovery.recovery_approvals (
    approval_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    recovery_id        UUID         NOT NULL REFERENCES app_recovery.deleted_records(recovery_id) ON DELETE RESTRICT,
    action_type        TEXT         NOT NULL,
    status             TEXT         NOT NULL DEFAULT 'submitted',
    risk_score         TEXT,
    maker_username     TEXT         NOT NULL,
    maker_role         TEXT,
    submitted_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    rationale          TEXT         NOT NULL,
    checker_username   TEXT,
    checker_role       TEXT,
    reviewed_at        TIMESTAMPTZ,
    decision_notes     TEXT,
    executed_at        TIMESTAMPTZ,
    execution_outcome  TEXT,
    execution_error    TEXT,
    correlation_id     UUID,
    context_payload    JSONB        NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT recovery_approvals_action_type_chk CHECK (action_type IN (
        'recovery.restore',
        'recovery.purge',
        'recovery.bulk_restore',
        'recovery.bulk_purge',
        'recovery.anonymize'
    )),
    CONSTRAINT recovery_approvals_status_chk CHECK (status IN (
        'draft','submitted','approved','rejected','executed','cancelled'
    )),
    CONSTRAINT recovery_approvals_risk_chk CHECK (
        risk_score IS NULL OR risk_score IN ('low','medium','high','critical')
    ),
    CONSTRAINT recovery_approvals_outcome_chk CHECK (
        execution_outcome IS NULL OR execution_outcome IN ('success','conflict','adapter_error','timeout')
    ),
    CONSTRAINT recovery_approvals_rationale_len CHECK (
        char_length(rationale) BETWEEN 10 AND 4000
    ),
    CONSTRAINT recovery_approvals_decision_notes_len CHECK (
        decision_notes IS NULL OR char_length(decision_notes) <= 4000
    ),
    CONSTRAINT recovery_approvals_maker_neq_checker CHECK (
        checker_username IS NULL OR checker_username <> maker_username
    ),
    CONSTRAINT recovery_approvals_review_pair CHECK (
        (reviewed_at IS NULL) = (checker_username IS NULL)
    ),
    CONSTRAINT recovery_approvals_execution_after_approval CHECK (
        executed_at IS NULL OR status IN ('executed','approved')
    )
);

CREATE INDEX IF NOT EXISTS idx_recovery_approvals_tenant_status
    ON app_recovery.recovery_approvals(tenant_id, status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_recovery_approvals_maker
    ON app_recovery.recovery_approvals(tenant_id, maker_username, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_recovery_approvals_checker
    ON app_recovery.recovery_approvals(tenant_id, checker_username, reviewed_at DESC)
    WHERE checker_username IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recovery_approvals_recovery_ref
    ON app_recovery.recovery_approvals(recovery_id);

CREATE INDEX IF NOT EXISTS idx_recovery_approvals_pending_by_risk
    ON app_recovery.recovery_approvals(tenant_id, risk_score, submitted_at DESC)
    WHERE status = 'submitted';

CREATE INDEX IF NOT EXISTS idx_recovery_approvals_correlation
    ON app_recovery.recovery_approvals(correlation_id)
    WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE app_recovery.recovery_approvals IS
'Maker-checker ledger for restore/purge/anonymize actions. RBI segregation of duties enforced at row level: maker_username must differ from checker_username. Every transition writes a recovery_workflow_events row and an audit.event_log entry via M15 auditTrailStore.';

-- =========================================================================
-- 2. Recovery Policies (per-tenant retention + workflow config)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_recovery.recovery_policies (
    policy_id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    entity_type              TEXT         NOT NULL,
    retention_days           INTEGER      NOT NULL DEFAULT 90,
    auto_purge_enabled       BOOLEAN      NOT NULL DEFAULT false,
    requires_maker_checker   BOOLEAN      NOT NULL DEFAULT true,
    min_checker_role         TEXT         NOT NULL DEFAULT 'supervisor',
    breach_quarantine_days   INTEGER,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by               TEXT         NOT NULL,
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by               TEXT,

    CONSTRAINT recovery_policies_retention_chk CHECK (
        retention_days BETWEEN 1 AND 2555
    ),
    CONSTRAINT recovery_policies_min_role_chk CHECK (
        min_checker_role IN ('supervisor','admin','compliance_officer')
    ),
    CONSTRAINT recovery_policies_quarantine_chk CHECK (
        breach_quarantine_days IS NULL OR breach_quarantine_days >= 0
    ),
    CONSTRAINT recovery_policies_unique UNIQUE (tenant_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_recovery_policies_auto_purge
    ON app_recovery.recovery_policies(tenant_id)
    WHERE auto_purge_enabled = true;

COMMENT ON TABLE app_recovery.recovery_policies IS
'Per-tenant retention + workflow configuration per entity_type. Read by the auto-purge cron job and by the workflow engine to decide if a maker-checker step is required for a given restore/purge request.';

-- =========================================================================
-- 3. Recovery Workflow Events (append-only state-transition log)
-- =========================================================================
CREATE TABLE IF NOT EXISTS app_recovery.recovery_workflow_events (
    event_id            BIGSERIAL    PRIMARY KEY,
    tenant_id           TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    approval_id         UUID         NOT NULL REFERENCES app_recovery.recovery_approvals(approval_id) ON DELETE CASCADE,
    from_status         TEXT,
    to_status           TEXT         NOT NULL,
    actor_username      TEXT         NOT NULL,
    actor_role          TEXT,
    occurred_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    transition_reason   TEXT,

    CONSTRAINT recovery_workflow_events_status_chk CHECK (
        to_status IN ('draft','submitted','approved','rejected','executed','cancelled')
    ),
    CONSTRAINT recovery_workflow_events_reason_len CHECK (
        transition_reason IS NULL OR char_length(transition_reason) <= 1000
    )
);

CREATE INDEX IF NOT EXISTS idx_recovery_workflow_events_approval
    ON app_recovery.recovery_workflow_events(approval_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_recovery_workflow_events_tenant
    ON app_recovery.recovery_workflow_events(tenant_id, occurred_at DESC);

COMMENT ON TABLE app_recovery.recovery_workflow_events IS
'Append-only state-transition timeline per approval. Lightweight — no payload duplication, references approval_id. Drives the per-approval timeline view in the Workflow Queue page.';

-- =========================================================================
-- 4. BEFORE UPDATE trigger — keep updated_at fresh on recovery_policies
-- =========================================================================
CREATE OR REPLACE FUNCTION app_recovery.fn_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recovery_policies_touch ON app_recovery.recovery_policies;
CREATE TRIGGER trg_recovery_policies_touch
    BEFORE UPDATE ON app_recovery.recovery_policies
    FOR EACH ROW EXECUTE FUNCTION app_recovery.fn_touch_updated_at();

-- =========================================================================
-- 5. Seed default policies for the 2 known tenants (idempotent)
-- =========================================================================
INSERT INTO app_recovery.recovery_policies
    (tenant_id, entity_type, retention_days, auto_purge_enabled, requires_maker_checker, min_checker_role, created_by)
VALUES
    ('BANK_DEMO', '*', 90, false, true, 'supervisor', 'system:migration_050'),
    ('BIL',       '*', 90, false, true, 'supervisor', 'system:migration_050')
ON CONFLICT (tenant_id, entity_type) DO NOTHING;
