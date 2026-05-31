-- data/schema/055_investigation_center.sql
--
-- Investigation Center — additive schema (12th IA addition this session).
--
-- Seven tables backing the new /investigation-center surface. Idempotent:
-- safe to re-run via `make migrate` against an already-applied DB. Zero
-- alterations to existing tables; only IF NOT EXISTS additions.
--
-- Tables (all under app_iam.*)
--   1. investigations              — investigation record + workflow state
--   2. investigation_assignments   — assignee history (audit trail)
--   3. investigation_evidence      — evidence vault items + chain of custody
--   4. investigation_notes         — investigator notes thread
--   5. investigation_actions       — workflow action log (assign/escalate/approve/reject/close/reopen)
--   6. investigation_timelines     — per-investigation event timeline
--   7. investigation_recommendations — AI-suggested recommendations
--
-- Backward compatibility — every existing table untouched. Migrations 001-054
-- continue to apply cleanly. Existing CMS (`app_cases.*`) is the operational
-- case store; the Investigation Center is an additive overlay providing the
-- enterprise investigation lens.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. investigations — investigation record + workflow state
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.investigations (
    investigation_id      TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    case_id               TEXT,
    alert_id              TEXT,
    domain                TEXT NOT NULL,
    kind                  TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'open',
    severity              TEXT NOT NULL,
    title                 TEXT NOT NULL,
    summary               TEXT NOT NULL DEFAULT '',
    customer_id           TEXT,
    policy_id             TEXT,
    borrower_id           TEXT,
    assignee_username     TEXT,
    opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_at                TIMESTAMPTZ NOT NULL,
    closed_at             TIMESTAMPTZ,
    exposure_kes          NUMERIC(14, 2) NOT NULL DEFAULT 0,
    fraud_indicator       BOOLEAN NOT NULL DEFAULT FALSE,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT investigations_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT investigations_status_chk CHECK (status IN ('open', 'assigned', 'in_review', 'pending_approval', 'escalated', 'closed')),
    CONSTRAINT investigations_severity_chk CHECK (severity IN ('low', 'moderate', 'high', 'severe', 'critical')),
    CONSTRAINT investigations_kind_chk CHECK (
        kind IN (
            'borrower', 'sma', 'npa', 'fraud', 'collections', 'sector_risk',
            'claim_fraud', 'policy_risk', 'underwriting', 'agent', 'channel', 'solvency'
        )
    ),
    CONSTRAINT investigations_due_chk CHECK (due_at >= opened_at),
    CONSTRAINT investigations_closed_chk CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE INDEX IF NOT EXISTS investigations_tenant_status_idx
    ON app_iam.investigations(tenant_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS investigations_tenant_severity_idx
    ON app_iam.investigations(tenant_id, severity)
    WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS investigations_assignee_idx
    ON app_iam.investigations(tenant_id, assignee_username, status)
    WHERE assignee_username IS NOT NULL;
CREATE INDEX IF NOT EXISTS investigations_sla_breached_idx
    ON app_iam.investigations(tenant_id, due_at)
    WHERE status <> 'closed';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. investigation_assignments — assignee history audit trail
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.investigation_assignments (
    assignment_id         BIGSERIAL PRIMARY KEY,
    investigation_id      TEXT NOT NULL REFERENCES app_iam.investigations(investigation_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    assigned_to           TEXT NOT NULL,
    assigned_by           TEXT NOT NULL,
    assigned_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unassigned_at         TIMESTAMPTZ,
    reason                TEXT,

    CONSTRAINT investigation_assignments_unassigned_chk CHECK (
        unassigned_at IS NULL OR unassigned_at >= assigned_at
    )
);

CREATE INDEX IF NOT EXISTS investigation_assignments_inv_idx
    ON app_iam.investigation_assignments(investigation_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS investigation_assignments_assignee_idx
    ON app_iam.investigation_assignments(tenant_id, assigned_to, assigned_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. investigation_evidence — evidence vault items + chain of custody
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.investigation_evidence (
    evidence_id           TEXT PRIMARY KEY,
    investigation_id      TEXT NOT NULL REFERENCES app_iam.investigations(investigation_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    evidence_type         TEXT NOT NULL,
    title                 TEXT NOT NULL,
    description           TEXT,
    file_name             TEXT NOT NULL,
    file_size_bytes       BIGINT NOT NULL DEFAULT 0,
    storage_uri           TEXT,
    hash_sha256           TEXT NOT NULL,
    version               INTEGER NOT NULL DEFAULT 1,
    uploaded_by           TEXT NOT NULL,
    uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verification_status   TEXT NOT NULL DEFAULT 'unverified',
    verified_by           TEXT,
    verified_at           TIMESTAMPTZ,
    chain_of_custody_json JSONB NOT NULL DEFAULT '[]'::jsonb,

    CONSTRAINT investigation_evidence_type_chk CHECK (
        evidence_type IN ('document', 'pdf', 'image', 'screenshot', 'external_reference')
    ),
    CONSTRAINT investigation_evidence_verification_chk CHECK (
        verification_status IN ('unverified', 'verified', 'failed')
    ),
    CONSTRAINT investigation_evidence_hash_chk CHECK (length(hash_sha256) = 64),
    CONSTRAINT investigation_evidence_version_chk CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS investigation_evidence_inv_idx
    ON app_iam.investigation_evidence(investigation_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS investigation_evidence_type_idx
    ON app_iam.investigation_evidence(tenant_id, evidence_type);
CREATE INDEX IF NOT EXISTS investigation_evidence_unverified_idx
    ON app_iam.investigation_evidence(tenant_id, uploaded_at DESC)
    WHERE verification_status = 'unverified';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. investigation_notes — investigator notes thread
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.investigation_notes (
    note_id               BIGSERIAL PRIMARY KEY,
    investigation_id      TEXT NOT NULL REFERENCES app_iam.investigations(investigation_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    author_username       TEXT NOT NULL,
    body                  TEXT NOT NULL,
    is_internal           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT investigation_notes_body_chk CHECK (length(body) > 0 AND length(body) <= 4000)
);

CREATE INDEX IF NOT EXISTS investigation_notes_inv_idx
    ON app_iam.investigation_notes(investigation_id, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. investigation_actions — workflow action log
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.investigation_actions (
    action_id             BIGSERIAL PRIMARY KEY,
    investigation_id      TEXT NOT NULL REFERENCES app_iam.investigations(investigation_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    action                TEXT NOT NULL,
    actor_username        TEXT NOT NULL,
    from_status           TEXT,
    to_status             TEXT,
    note                  TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT investigation_actions_action_chk CHECK (
        action IN ('assign', 'reassign', 'escalate', 'approve', 'reject', 'close', 'reopen')
    ),
    CONSTRAINT investigation_actions_from_status_chk CHECK (
        from_status IS NULL OR from_status IN ('open', 'assigned', 'in_review', 'pending_approval', 'escalated', 'closed')
    ),
    CONSTRAINT investigation_actions_to_status_chk CHECK (
        to_status IS NULL OR to_status IN ('open', 'assigned', 'in_review', 'pending_approval', 'escalated', 'closed')
    )
);

CREATE INDEX IF NOT EXISTS investigation_actions_inv_idx
    ON app_iam.investigation_actions(investigation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS investigation_actions_actor_idx
    ON app_iam.investigation_actions(tenant_id, actor_username, occurred_at DESC);
CREATE INDEX IF NOT EXISTS investigation_actions_action_idx
    ON app_iam.investigation_actions(tenant_id, action, occurred_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. investigation_timelines — per-investigation timeline events
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.investigation_timelines (
    timeline_event_id     BIGSERIAL PRIMARY KEY,
    investigation_id      TEXT NOT NULL REFERENCES app_iam.investigations(investigation_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    event_kind            TEXT NOT NULL,
    event_label           TEXT NOT NULL,
    actor_username        TEXT,
    description           TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT investigation_timelines_event_kind_chk CHECK (
        event_kind IN (
            'alert_generated', 'case_created', 'assigned', 'investigation_started',
            'evidence_added', 'note_added', 'review', 'approval', 'escalation', 'closure', 'reopened'
        )
    )
);

CREATE INDEX IF NOT EXISTS investigation_timelines_inv_idx
    ON app_iam.investigation_timelines(investigation_id, occurred_at ASC);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. investigation_recommendations — AI-suggested recommendations
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.investigation_recommendations (
    recommendation_id     TEXT PRIMARY KEY,
    investigation_id      TEXT NOT NULL REFERENCES app_iam.investigations(investigation_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL,
    priority              TEXT NOT NULL DEFAULT 'medium',
    category              TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'open',
    suggested_by_model    TEXT,
    suggested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acted_by              TEXT,
    acted_at              TIMESTAMPTZ,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT investigation_recs_priority_chk CHECK (priority IN ('low', 'medium', 'high')),
    CONSTRAINT investigation_recs_category_chk CHECK (
        category IN ('evidence', 'interview', 'verification', 'escalation', 'closure')
    ),
    CONSTRAINT investigation_recs_status_chk CHECK (
        status IN ('open', 'in_progress', 'completed', 'dismissed')
    )
);

CREATE INDEX IF NOT EXISTS investigation_recs_inv_idx
    ON app_iam.investigation_recommendations(investigation_id, suggested_at DESC);
CREATE INDEX IF NOT EXISTS investigation_recs_status_idx
    ON app_iam.investigation_recommendations(tenant_id, status, priority);

-- ───────────────────────────────────────────────────────────────────────────
-- Touch trigger for investigations.updated_at
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_iam.investigations_touch()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'investigations_touch_updated_at'
    ) THEN
        CREATE TRIGGER investigations_touch_updated_at
        BEFORE UPDATE ON app_iam.investigations
        FOR EACH ROW EXECUTE FUNCTION app_iam.investigations_touch();
    END IF;
END $$;
