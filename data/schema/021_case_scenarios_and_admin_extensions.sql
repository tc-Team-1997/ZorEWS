-- 021_case_scenarios_and_admin_extensions.sql
--
-- Adds the 4 new tables called for by the consolidated DB schema audit
-- (docs/DB_SCHEMA.md):
--
--   app_admin.notification_templates  — email/SMS/in-app templates
--   app_admin.escalation_matrix       — time-window → role escalation
--   app_admin.case_scenarios          — admin-curated case templates
--   app_admin.case_scenario_history   — append-only edit log
--
-- Also widens admin_audit_log_entity_check + admin_audit_log_action_check
-- so the new entities can write into the existing multi-source audit log
-- shipped in 016 + extended in 020.
--
-- Idempotent (CREATE IF NOT EXISTS + DROP CONSTRAINT IF EXISTS); safe to
-- re-run. Multi-tenant by design — every table carries `tenant_id` and
-- composite uniques include it so cross-tenant clashes are impossible.

BEGIN;

-- The app_admin schema + set_updated_at() function were created in
-- 016_user_access_override.sql; CREATE IF NOT EXISTS guards make this
-- file robust to running standalone (e.g. against a fresh DB).
CREATE SCHEMA IF NOT EXISTS app_admin;

CREATE OR REPLACE FUNCTION app_admin.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 1. notification_templates ────────────────────────────────────────
-- Created BEFORE case_scenarios because case_scenarios.notification_template_id
-- declares an FK to it.

CREATE TABLE IF NOT EXISTS app_admin.notification_templates (
    template_id    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      TEXT         NOT NULL,
    name           TEXT         NOT NULL,
    channel        TEXT         NOT NULL,
    subject        TEXT,
    body           TEXT         NOT NULL,
    locale         TEXT         NOT NULL DEFAULT 'en-IN',
    status         TEXT         NOT NULL DEFAULT 'DRAFT',
    created_by     TEXT         NOT NULL,
    updated_by     TEXT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ,
    CONSTRAINT notification_templates_channel_check
        CHECK (channel IN ('EMAIL','SMS','IN_APP')),
    CONSTRAINT notification_templates_status_check
        CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
    CONSTRAINT notification_templates_name_len_check
        CHECK (length(trim(name)) BETWEEN 1 AND 120),
    CONSTRAINT notification_templates_body_len_check
        CHECK (length(body) BETWEEN 1 AND 10000),
    -- Subject is required for EMAIL + IN_APP, must be NULL for SMS.
    CONSTRAINT notification_templates_subject_channel_check
        CHECK (
            (channel = 'SMS' AND subject IS NULL) OR
            (channel IN ('EMAIL','IN_APP') AND subject IS NOT NULL
             AND length(trim(subject)) BETWEEN 1 AND 200)
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_templates_name
    ON app_admin.notification_templates (tenant_id, lower(name), locale)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_notification_templates_listing
    ON app_admin.notification_templates (tenant_id, channel, status, updated_at DESC)
    WHERE deleted_at IS NULL;

COMMENT ON TABLE app_admin.notification_templates IS
  'Per-tenant email/SMS/in-app templates referenced by case_scenarios + escalation flows. Mustache placeholders allowed in body. Soft-delete via deleted_at preserves audit trail without polluting the active listing.';

DROP TRIGGER IF EXISTS trg_notification_templates_updated_at
    ON app_admin.notification_templates;
CREATE TRIGGER trg_notification_templates_updated_at
    BEFORE UPDATE ON app_admin.notification_templates
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.set_updated_at();

-- ─── 2. escalation_matrix ─────────────────────────────────────────────
-- Created BEFORE case_scenarios because case_scenarios.default_escalation_id
-- declares an FK to it.

CREATE TABLE IF NOT EXISTS app_admin.escalation_matrix (
    escalation_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              TEXT         NOT NULL,
    name                   TEXT         NOT NULL,
    case_category          TEXT         NOT NULL,
    priority               TEXT         NOT NULL,
    level_1_after_minutes  INTEGER      NOT NULL,
    level_1_role           TEXT         NOT NULL,
    level_2_after_minutes  INTEGER,
    level_2_role           TEXT,
    level_3_after_minutes  INTEGER,
    level_3_role           TEXT,
    status                 TEXT         NOT NULL DEFAULT 'ACTIVE',
    created_by             TEXT         NOT NULL,
    updated_by             TEXT,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT escalation_matrix_priority_check
        CHECK (priority IN ('P1','P2','P3','P4')),
    CONSTRAINT escalation_matrix_status_check
        CHECK (status IN ('ACTIVE','ARCHIVED')),
    CONSTRAINT escalation_matrix_name_len_check
        CHECK (length(trim(name)) BETWEEN 1 AND 120),
    CONSTRAINT escalation_matrix_l1_nonneg_check
        CHECK (level_1_after_minutes >= 0),
    -- Level 2 requires both columns set + minutes > level 1.
    CONSTRAINT escalation_matrix_l2_pair_check
        CHECK (
            (level_2_after_minutes IS NULL AND level_2_role IS NULL) OR
            (level_2_after_minutes IS NOT NULL AND level_2_role IS NOT NULL
             AND level_2_after_minutes > level_1_after_minutes
             AND length(trim(level_2_role)) > 0)
        ),
    -- Level 3 requires both columns set, level 2 also set, minutes > level 2.
    CONSTRAINT escalation_matrix_l3_pair_check
        CHECK (
            (level_3_after_minutes IS NULL AND level_3_role IS NULL) OR
            (level_3_after_minutes IS NOT NULL AND level_3_role IS NOT NULL
             AND level_2_after_minutes IS NOT NULL
             AND level_3_after_minutes > level_2_after_minutes
             AND length(trim(level_3_role)) > 0)
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_escalation_matrix_name
    ON app_admin.escalation_matrix (tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS ix_escalation_matrix_lookup
    ON app_admin.escalation_matrix (tenant_id, case_category, priority, status);

COMMENT ON TABLE app_admin.escalation_matrix IS
  'Per-(case_category, priority) escalation rules with up to 3 levels (minutes-since-creation → RBAC role). Referenced by case_scenarios.default_escalation_id (RESTRICT — cannot delete a row that scenarios still point at).';

DROP TRIGGER IF EXISTS trg_escalation_matrix_updated_at
    ON app_admin.escalation_matrix;
CREATE TRIGGER trg_escalation_matrix_updated_at
    BEFORE UPDATE ON app_admin.escalation_matrix
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.set_updated_at();

-- ─── 3. case_scenarios ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_admin.case_scenarios (
    scenario_id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                TEXT         NOT NULL,
    name                     TEXT         NOT NULL,
    case_category            TEXT         NOT NULL,
    priority                 TEXT         NOT NULL,
    trigger_indicator_id     TEXT,
    trigger_threshold        NUMERIC(10,4),
    default_escalation_id    UUID         NOT NULL
        REFERENCES app_admin.escalation_matrix(escalation_id) ON DELETE RESTRICT,
    notification_template_id UUID
        REFERENCES app_admin.notification_templates(template_id) ON DELETE RESTRICT,
    checklist                JSONB        NOT NULL DEFAULT '[]'::jsonb,
    status                   TEXT         NOT NULL DEFAULT 'DRAFT',
    created_by               TEXT         NOT NULL,
    updated_by               TEXT,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at               TIMESTAMPTZ,
    CONSTRAINT case_scenarios_priority_check
        CHECK (priority IN ('P1','P2','P3','P4')),
    CONSTRAINT case_scenarios_status_check
        CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
    CONSTRAINT case_scenarios_name_len_check
        CHECK (length(trim(name)) BETWEEN 1 AND 120),
    CONSTRAINT case_scenarios_checklist_is_array_check
        CHECK (jsonb_typeof(checklist) = 'array'),
    -- Trigger pair: indicator + threshold must be both set or both null.
    CONSTRAINT case_scenarios_trigger_pair_check
        CHECK (
            (trigger_indicator_id IS NULL AND trigger_threshold IS NULL) OR
            (trigger_indicator_id IS NOT NULL AND trigger_threshold IS NOT NULL)
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_case_scenarios_name
    ON app_admin.case_scenarios (tenant_id, lower(name))
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_case_scenarios_listing
    ON app_admin.case_scenarios (tenant_id, status, updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_case_scenarios_trigger
    ON app_admin.case_scenarios (tenant_id, trigger_indicator_id)
    WHERE status = 'ACTIVE' AND trigger_indicator_id IS NOT NULL;

COMMENT ON TABLE app_admin.case_scenarios IS
  'Admin-curated case templates. When an alert lands and matches (trigger_indicator_id, trigger_threshold), the case-creation pipeline reads the matching scenario to seed the new case with priority + default_escalation_id + notification_template_id + checklist. Soft-delete via deleted_at; status moves DRAFT → ACTIVE → ARCHIVED for the lifecycle audit.';

DROP TRIGGER IF EXISTS trg_case_scenarios_updated_at
    ON app_admin.case_scenarios;
CREATE TRIGGER trg_case_scenarios_updated_at
    BEFORE UPDATE ON app_admin.case_scenarios
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.set_updated_at();

-- ─── 4. case_scenario_history (append-only) ───────────────────────────

CREATE TABLE IF NOT EXISTS app_admin.case_scenario_history (
    history_id     BIGSERIAL    PRIMARY KEY,
    scenario_id    UUID         NOT NULL
        REFERENCES app_admin.case_scenarios(scenario_id) ON DELETE CASCADE,
    tenant_id      TEXT         NOT NULL,
    action         TEXT         NOT NULL,
    diff           JSONB        NOT NULL,
    after_state    JSONB        NOT NULL,
    performed_by   TEXT         NOT NULL,
    performed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT case_scenario_history_action_check
        CHECK (action IN ('create','update','activate','archive','restore')),
    CONSTRAINT case_scenario_history_diff_is_array_check
        CHECK (jsonb_typeof(diff) = 'array')
);

CREATE INDEX IF NOT EXISTS ix_case_scenario_history_scenario
    ON app_admin.case_scenario_history (tenant_id, scenario_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS ix_case_scenario_history_tenant
    ON app_admin.case_scenario_history (tenant_id, performed_at DESC);

COMMENT ON TABLE app_admin.case_scenario_history IS
  'Append-only edit log for case_scenarios. One row per mutation. UPDATE + DELETE blocked by trigger (matches audit.event_log pattern). diff is RFC-6902 JSON Patch from before → after; after_state is the full row snapshot for replay.';

-- Append-only enforcement (matches the pattern on audit.event_log).
CREATE OR REPLACE FUNCTION app_admin.case_scenario_history_block_mutate()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'app_admin.case_scenario_history is append-only — % blocked', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_case_scenario_history_block_update
    ON app_admin.case_scenario_history;
CREATE TRIGGER trg_case_scenario_history_block_update
    BEFORE UPDATE ON app_admin.case_scenario_history
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.case_scenario_history_block_mutate();

DROP TRIGGER IF EXISTS trg_case_scenario_history_block_delete
    ON app_admin.case_scenario_history;
CREATE TRIGGER trg_case_scenario_history_block_delete
    BEFORE DELETE ON app_admin.case_scenario_history
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.case_scenario_history_block_mutate();

-- ─── 5. Widen admin_audit_log so new entities can audit through it ────
--
-- 016 created the constraint; 020 widened it once for report_export.
-- 021 widens again to cover the M14.15 entities.

ALTER TABLE app_admin.admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_entity_check;
ALTER TABLE app_admin.admin_audit_log
    ADD CONSTRAINT admin_audit_log_entity_check
        CHECK (entity_type IN (
            'user_access_override',
            'report_export',
            'ews_rule_version',
            'case_scenario',
            'notification_template',
            'escalation_matrix_rule'
        ));

ALTER TABLE app_admin.admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_action_check;
ALTER TABLE app_admin.admin_audit_log
    ADD CONSTRAINT admin_audit_log_action_check
        CHECK (action IN (
            -- 016 actions
            'create','update','approve','reject','revoke','expire',
            -- 020 actions
            'export','view',
            -- 021 actions
            'activate','archive','restore'
        ));

-- ─── 6. Inline default seeds ──────────────────────────────────────────
-- Sensible per-tenant defaults so the SPA has something to show on first
-- load. ON CONFLICT DO NOTHING keeps re-runs idempotent.

-- Notification templates
INSERT INTO app_admin.notification_templates
    (tenant_id, name, channel, subject, body, locale, status, created_by)
VALUES
    ('BANK_DEMO', 'Case Opened — RM email', 'EMAIL',
     'New case {{case_number}} assigned to you',
     'Hi {{rm_name}},\n\nA new {{priority}} case ({{case_number}}) has been opened for customer {{customer_name}}.\nCategory: {{case_category}}\nReason: {{trigger_reason}}\n\nPlease review and action within {{sla_target_days}} day(s).\n\n— ZorEWS',
     'en-IN', 'ACTIVE', 'system:seed'),
    ('BANK_DEMO', 'Case SLA breach warning — RM SMS', 'SMS', NULL,
     'ZorEWS: Case {{case_number}} is at {{progress_pct}}% of SLA. Please action ASAP.',
     'en-IN', 'ACTIVE', 'system:seed'),
    ('BANK_DEMO', 'Escalation L1 — Supervisor in-app', 'IN_APP',
     'Case {{case_number}} escalated to you',
     'Case {{case_number}} ({{priority}} {{case_category}}) was not actioned within {{escalated_after_minutes}} minutes and has been escalated to you for supervision.',
     'en-IN', 'ACTIVE', 'system:seed'),
    ('BIL', 'Claim case opened — Underwriter email', 'EMAIL',
     'New {{priority}} claim case {{case_number}}',
     'Hello {{uw_name}},\n\nA new {{priority}} claim case ({{case_number}}) has been opened for policy {{policy_number}}.\nCategory: {{case_category}}\nReason: {{trigger_reason}}\n\nPlease review and decision within {{sla_target_days}} day(s).\n\n— ZorEWS',
     'en-IN', 'ACTIVE', 'system:seed'),
    ('BIL', 'Lapse warning — Agent SMS', 'SMS', NULL,
     'ZorEWS: Policy {{policy_number}} approaches lapse. Contact {{customer_name}} on {{customer_phone}}.',
     'en-IN', 'ACTIVE', 'system:seed')
ON CONFLICT DO NOTHING;

-- Escalation rules
INSERT INTO app_admin.escalation_matrix
    (tenant_id, name, case_category, priority,
     level_1_after_minutes, level_1_role,
     level_2_after_minutes, level_2_role,
     level_3_after_minutes, level_3_role,
     status, created_by)
VALUES
    -- Bank: P1 fraud escalates fast (15min → 60min → 240min)
    ('BANK_DEMO', 'BANK Fraud P1 fast-escalate', 'fraud', 'P1',
     15,  'supervisor',
     60,  'risk_analyst',
     240, 'admin',
     'ACTIVE', 'system:seed'),
    -- Bank: P2 credit_risk slower (60min → 240min, no L3)
    ('BANK_DEMO', 'BANK Credit P2 standard',     'credit_risk', 'P2',
     60,  'supervisor',
     240, 'risk_analyst',
     NULL, NULL,
     'ACTIVE', 'system:seed'),
    -- Bank: KYC P3 — single-level, slow
    ('BANK_DEMO', 'BANK KYC P3 reminder',        'kyc', 'P3',
     480, 'supervisor',
     NULL, NULL,
     NULL, NULL,
     'ACTIVE', 'system:seed'),
    -- BIL: Lapse P1 — agent first, then supervisor
    ('BIL', 'BIL Lapse P1 agent-first',          'lapse', 'P1',
     30,  'collection_officer',
     180, 'supervisor',
     720, 'admin',
     'ACTIVE', 'system:seed'),
    -- BIL: Claim fraud P1
    ('BIL', 'BIL Claim Fraud P1',                'fraud', 'P1',
     20,  'risk_analyst',
     90,  'supervisor',
     360, 'admin',
     'ACTIVE', 'system:seed')
ON CONFLICT DO NOTHING;

-- Case scenarios — wired to the seeded escalation rules + templates.
-- Uses sub-selects so the row IDs resolve correctly across re-runs.
INSERT INTO app_admin.case_scenarios
    (tenant_id, name, case_category, priority,
     trigger_indicator_id, trigger_threshold,
     default_escalation_id, notification_template_id,
     checklist, status, created_by)
SELECT
    'BANK_DEMO', 'Sudden DPD spike → fraud P1', 'fraud', 'P1',
    'FRD-001', 0.85,
    em.escalation_id, nt.template_id,
    '[
      {"title":"Verify recent transactions with customer","required":true},
      {"title":"Freeze card if confirmed","required":true},
      {"title":"File RBI fraud report (FMR-1)","required":true}
     ]'::jsonb,
    'ACTIVE', 'system:seed'
FROM app_admin.escalation_matrix em
JOIN app_admin.notification_templates nt ON nt.tenant_id = em.tenant_id
WHERE em.tenant_id = 'BANK_DEMO'
  AND em.name = 'BANK Fraud P1 fast-escalate'
  AND nt.name = 'Case Opened — RM email'
ON CONFLICT DO NOTHING;

INSERT INTO app_admin.case_scenarios
    (tenant_id, name, case_category, priority,
     trigger_indicator_id, trigger_threshold,
     default_escalation_id, notification_template_id,
     checklist, status, created_by)
SELECT
    'BIL', 'Premium overdue 15+ days → lapse P1', 'lapse', 'P1',
    'LAP-002', 15,
    em.escalation_id, nt.template_id,
    '[
      {"title":"Contact customer via SMS + call","required":true},
      {"title":"Confirm payment intent + ETA","required":true},
      {"title":"Offer grace-period extension if eligible","required":false}
     ]'::jsonb,
    'ACTIVE', 'system:seed'
FROM app_admin.escalation_matrix em
JOIN app_admin.notification_templates nt ON nt.tenant_id = em.tenant_id
WHERE em.tenant_id = 'BIL'
  AND em.name = 'BIL Lapse P1 agent-first'
  AND nt.name = 'Lapse warning — Agent SMS'
ON CONFLICT DO NOTHING;

COMMIT;
