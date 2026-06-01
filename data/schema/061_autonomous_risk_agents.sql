-- data/schema/061_autonomous_risk_agents.sql
-- Autonomous Risk Operations Center — additive schema (18th IA overlay).
-- 8 additive tables under app_iam schema.
-- Idempotent: CREATE TABLE IF NOT EXISTS on every table.
-- Zero changes to existing tables.

-- ---------------------------------------------------------------------------
-- Table 1: ai_agent_registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_iam.ai_agent_registry (
    agent_id           TEXT        PRIMARY KEY,
    tenant_id          TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT        NOT NULL,
    agent_type         TEXT        NOT NULL,
    domain             TEXT        NOT NULL,
    description        TEXT,
    responsibilities   TEXT[]      DEFAULT ARRAY[]::TEXT[],
    state              TEXT        NOT NULL DEFAULT 'idle',
    is_enabled         BOOLEAN     DEFAULT true,
    version            TEXT        DEFAULT '1.0.0',
    success_rate       NUMERIC(5,3),
    avg_resolution_ms  BIGINT      DEFAULT 0,
    escalation_count   INTEGER     DEFAULT 0,
    last_execution_at  TIMESTAMPTZ,
    created_by         TEXT,
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ai_agent_type_chk CHECK (agent_type IN (
        'credit_risk','fraud_detection','collections','portfolio_risk',
        'claims','insurance_fraud','policy_retention','solvency',
        'compliance','investigation','executive_briefing','recovery','governance'
    )),
    CONSTRAINT ai_agent_domain_chk CHECK (domain IN ('banking','insurance','enterprise')),
    CONSTRAINT ai_agent_state_chk CHECK (state IN ('active','idle','busy','escalated','suspended','offline'))
);

-- ---------------------------------------------------------------------------
-- Table 2: ai_agent_executions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_iam.ai_agent_executions (
    execution_id      TEXT        PRIMARY KEY,
    agent_id          TEXT        NOT NULL REFERENCES app_iam.ai_agent_registry(agent_id),
    tenant_id         TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id),
    started_at        TIMESTAMPTZ DEFAULT NOW(),
    finished_at       TIMESTAMPTZ,
    duration_ms       BIGINT      DEFAULT 0,
    status            TEXT        NOT NULL DEFAULT 'running',
    input_summary     TEXT,
    output_summary    TEXT,
    confidence_score  NUMERIC(4,3),
    risk_level        TEXT,
    escalated_to      TEXT,
    error_message     TEXT,
    CONSTRAINT ai_exec_status_chk CHECK (status IN ('running','completed','failed','escalated')),
    CONSTRAINT ai_exec_risk_chk   CHECK (risk_level IN ('low','medium','high','critical') OR risk_level IS NULL),
    CONSTRAINT ai_exec_conf_chk   CHECK (confidence_score BETWEEN 0 AND 1 OR confidence_score IS NULL)
);

-- ---------------------------------------------------------------------------
-- Table 3: ai_agent_recommendations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_iam.ai_agent_recommendations (
    recommendation_id TEXT        PRIMARY KEY,
    execution_id      TEXT        REFERENCES app_iam.ai_agent_executions(execution_id) ON DELETE SET NULL,
    agent_id          TEXT        NOT NULL REFERENCES app_iam.ai_agent_registry(agent_id),
    tenant_id         TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id),
    generated_at      TIMESTAMPTZ DEFAULT NOW(),
    title             TEXT        NOT NULL,
    findings          TEXT[]      DEFAULT ARRAY[]::TEXT[],
    root_causes       TEXT[]      DEFAULT ARRAY[]::TEXT[],
    risk_drivers      TEXT[]      DEFAULT ARRAY[]::TEXT[],
    suggested_actions TEXT[]      DEFAULT ARRAY[]::TEXT[],
    impact_assessment TEXT,
    confidence_score  NUMERIC(4,3) NOT NULL,
    risk_level        TEXT        NOT NULL,
    requires_approval BOOLEAN     DEFAULT false,
    approval_status   TEXT,
    approved_by       TEXT,
    approved_at       TIMESTAMPTZ,
    review_notes      TEXT,
    expires_at        TIMESTAMPTZ,
    CONSTRAINT ai_rec_risk_chk     CHECK (risk_level IN ('low','medium','high','critical')),
    CONSTRAINT ai_rec_approval_chk CHECK (approval_status IN ('pending','approved','rejected','escalated') OR approval_status IS NULL),
    CONSTRAINT ai_rec_conf_chk     CHECK (confidence_score BETWEEN 0 AND 1)
);

-- ---------------------------------------------------------------------------
-- Table 4: ai_human_approvals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_iam.ai_human_approvals (
    item_id             TEXT        PRIMARY KEY,
    agent_id            TEXT        NOT NULL REFERENCES app_iam.ai_agent_registry(agent_id),
    recommendation_id   TEXT        REFERENCES app_iam.ai_agent_recommendations(recommendation_id) ON DELETE SET NULL,
    tenant_id           TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id),
    action_description  TEXT        NOT NULL,
    risk_level          TEXT        NOT NULL,
    generated_at        TIMESTAMPTZ DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,
    status              TEXT        DEFAULT 'pending',
    requested_by        TEXT        NOT NULL,
    reviewed_by         TEXT,
    reviewed_at         TIMESTAMPTZ,
    review_notes        TEXT,
    CONSTRAINT ai_approval_status_chk CHECK (status IN ('pending','approved','rejected','escalated')),
    CONSTRAINT ai_approval_risk_chk   CHECK (risk_level IN ('low','medium','high','critical'))
);

-- ---------------------------------------------------------------------------
-- Table 5: ai_agent_collaborations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_iam.ai_agent_collaborations (
    collaboration_id   TEXT        PRIMARY KEY,
    tenant_id          TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id),
    from_agent_id      TEXT        NOT NULL,
    from_agent_name    TEXT        NOT NULL,
    to_agent_id        TEXT        NOT NULL,
    to_agent_name      TEXT        NOT NULL,
    collaboration_type TEXT        NOT NULL,
    started_at         TIMESTAMPTZ DEFAULT NOW(),
    completed_at       TIMESTAMPTZ,
    message_count      INTEGER     DEFAULT 0,
    status             TEXT        DEFAULT 'active',
    outcome_summary    TEXT,
    trigger_reason     TEXT,
    CONSTRAINT ai_collab_type_chk   CHECK (collaboration_type IN ('handoff','parallel','sequential','escalation')),
    CONSTRAINT ai_collab_status_chk CHECK (status IN ('active','completed'))
);

-- ---------------------------------------------------------------------------
-- Table 6: ai_agent_messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_iam.ai_agent_messages (
    message_id         TEXT        PRIMARY KEY,
    collaboration_id   TEXT        NOT NULL REFERENCES app_iam.ai_agent_collaborations(collaboration_id) ON DELETE CASCADE,
    from_agent_id      TEXT        NOT NULL,
    to_agent_id        TEXT        NOT NULL,
    tenant_id          TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id),
    sent_at            TIMESTAMPTZ DEFAULT NOW(),
    message_type       TEXT        NOT NULL,
    content            TEXT        NOT NULL,
    metadata           JSONB       DEFAULT '{}'::jsonb,
    CONSTRAINT ai_msg_type_chk CHECK (message_type IN ('finding','recommendation','escalation','acknowledgment'))
);

-- ---------------------------------------------------------------------------
-- Table 7: ai_executive_briefings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_iam.ai_executive_briefings (
    briefing_id           TEXT         PRIMARY KEY,
    tenant_id             TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    briefing_type         TEXT         NOT NULL,
    generated_at          TIMESTAMPTZ  DEFAULT NOW(),
    period_label          TEXT,
    period_start          TIMESTAMPTZ,
    period_end            TIMESTAMPTZ,
    top_risks             JSONB        DEFAULT '[]'::jsonb,
    emerging_risks        TEXT[]       DEFAULT ARRAY[]::TEXT[],
    compliance_risks      TEXT[]       DEFAULT ARRAY[]::TEXT[],
    investigation_status  JSONB        DEFAULT '{}'::jsonb,
    forecast_summary      TEXT,
    risk_appetite_status  TEXT         DEFAULT 'within_limits',
    confidence_score      NUMERIC(4,3) NOT NULL,
    generated_by          TEXT         DEFAULT 'executive_briefing_agent',
    CONSTRAINT ai_briefing_type_chk    CHECK (briefing_type IN ('daily','weekly','monthly')),
    CONSTRAINT ai_briefing_appetite_chk CHECK (risk_appetite_status IN ('within_limits','approaching_limit','breach')),
    CONSTRAINT ai_briefing_conf_chk    CHECK (confidence_score BETWEEN 0 AND 1)
);

-- ---------------------------------------------------------------------------
-- Table 8: ai_agent_performance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_iam.ai_agent_performance (
    metric_id                BIGSERIAL    PRIMARY KEY,
    agent_id                 TEXT         NOT NULL REFERENCES app_iam.ai_agent_registry(agent_id),
    tenant_id                TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    recorded_at              TIMESTAMPTZ  DEFAULT NOW(),
    period_type              TEXT         DEFAULT 'daily',
    executions_count         INTEGER      DEFAULT 0,
    success_count            INTEGER      DEFAULT 0,
    failure_count            INTEGER      DEFAULT 0,
    escalation_count         INTEGER      DEFAULT 0,
    avg_confidence_score     NUMERIC(4,3),
    avg_resolution_ms        BIGINT,
    recommendations_generated INTEGER     DEFAULT 0,
    approvals_required       INTEGER      DEFAULT 0,
    approvals_granted        INTEGER      DEFAULT 0,
    CONSTRAINT ai_perf_period_chk CHECK (period_type IN ('hourly','daily','weekly'))
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ai_reg_tenant_idx
    ON app_iam.ai_agent_registry (tenant_id);

CREATE INDEX IF NOT EXISTS ai_reg_state_type_idx
    ON app_iam.ai_agent_registry (tenant_id, state, agent_type);

CREATE INDEX IF NOT EXISTS ai_exec_agent_tenant_idx
    ON app_iam.ai_agent_executions (agent_id, tenant_id);

CREATE INDEX IF NOT EXISTS ai_exec_started_idx
    ON app_iam.ai_agent_executions (tenant_id, started_at DESC);

CREATE INDEX IF NOT EXISTS ai_rec_agent_tenant_idx
    ON app_iam.ai_agent_recommendations (agent_id, tenant_id);

CREATE INDEX IF NOT EXISTS ai_rec_risk_generated_idx
    ON app_iam.ai_agent_recommendations (tenant_id, risk_level, generated_at DESC);

CREATE INDEX IF NOT EXISTS ai_approval_tenant_status_idx
    ON app_iam.ai_human_approvals (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Seed data — 13 BIL agent registry entries for BANK_DEMO tenant
-- ---------------------------------------------------------------------------
INSERT INTO app_iam.ai_agent_registry
    (agent_id, tenant_id, name, agent_type, domain, state, success_rate, escalation_count, avg_resolution_ms, version)
VALUES
    ('agent-credit-risk',      'BANK_DEMO', 'Credit Risk Intelligence Agent',   'credit_risk',       'banking',    'active',    0.94,  5,  85000, '1.0.0'),
    ('agent-fraud-detect',     'BANK_DEMO', 'Banking Fraud Detection Agent',    'fraud_detection',   'banking',    'active',    0.91,  8,  62000, '1.0.0'),
    ('agent-collections',      'BANK_DEMO', 'Collections Intelligence Agent',   'collections',       'banking',    'busy',      0.88,  4,  95000, '1.0.0'),
    ('agent-portfolio-risk',   'BANK_DEMO', 'Portfolio Risk Agent',             'portfolio_risk',    'banking',    'idle',      0.92,  3, 120000, '1.0.0'),
    ('agent-claims',           'BANK_DEMO', 'Claims Analysis Agent',            'claims',            'insurance',  'active',    0.89,  9,  75000, '1.0.0'),
    ('agent-ins-fraud',        'BANK_DEMO', 'Insurance Fraud Detection Agent',  'insurance_fraud',   'insurance',  'busy',      0.93,  7,  58000, '1.0.0'),
    ('agent-policy-retention', 'BANK_DEMO', 'Policy Retention Agent',           'policy_retention',  'insurance',  'active',    0.87,  4, 105000, '1.0.0'),
    ('agent-solvency',         'BANK_DEMO', 'Solvency Monitoring Agent',        'solvency',          'insurance',  'idle',      0.96,  2, 145000, '1.0.0'),
    ('agent-compliance',       'BANK_DEMO', 'Regulatory Compliance Agent',      'compliance',        'enterprise', 'active',    0.91,  6,  98000, '1.0.0'),
    ('agent-investigation',    'BANK_DEMO', 'Investigation Intelligence Agent', 'investigation',     'enterprise', 'busy',      0.85, 12,  72000, '1.0.0'),
    ('agent-exec-briefing',    'BANK_DEMO', 'Executive Briefing Agent',         'executive_briefing','enterprise', 'active',    0.97,  2, 165000, '1.0.0'),
    ('agent-recovery',         'BANK_DEMO', 'Recovery Management Agent',        'recovery',          'enterprise', 'suspended', 0.82, 14, 110000, '1.0.0'),
    ('agent-governance',       'BANK_DEMO', 'Governance Policy Agent',          'governance',        'enterprise', 'offline',   0.90,  5, 175000, '1.0.0')
ON CONFLICT (agent_id) DO NOTHING;
