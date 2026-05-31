-- data/schema/059_demo_readiness.sql
--
-- Demo Readiness & UAT Validation Layer — additive schema (16th IA overlay).
--
-- 8 additive tables backing the deterministic validators under
-- web/src/modules/demoReadiness/. Idempotent: every CREATE TABLE wraps in
-- IF NOT EXISTS. Existing tables (raw, staging, mart, audit, app_iam.*,
-- app_alerts.*, app_cases.*, app_bff.*, app_scenario.*, demo_*) untouched.
--
-- Persistence target for when ops want to retain UAT run history beyond
-- the in-browser deterministic snapshot. The SPA reads from the engines
-- today; a future BFF can swap each call for a /v1/demo-readiness/*
-- route writing here.
--
-- Tables (8):
--   1. uat_scenarios                 — 20-row UAT scenario inventory (banking / insurance / cross_domain / admin)
--   2. uat_runs                      — per-execution history of a UAT scenario
--   3. readiness_snapshots           — point-in-time overall readiness snapshot
--   4. readiness_dimension_scores    — per-snapshot per-dimension score row (7 dimensions × snapshot)
--   5. flow_validation_findings      — banking + insurance flow check results
--   6. role_validation_findings      — persona × axis access matrix check results
--   7. data_quality_findings         — per-entity data quality issue records
--   8. release_readiness_reports     — generated release readiness report metadata

-- ───────────────────────────────────────────────────────────────────────────
-- 1. uat_scenarios — UAT scenario inventory
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.uat_scenarios (
    scenario_id       TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name              TEXT NOT NULL,
    module            TEXT NOT NULL,
    owner             TEXT NOT NULL,
    description       TEXT,
    expected_outcome  TEXT NOT NULL DEFAULT 'passed',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uat_scenarios_module_chk CHECK (
        module IN ('banking', 'insurance', 'cross_domain', 'admin')
    ),
    CONSTRAINT uat_scenarios_outcome_chk CHECK (
        expected_outcome IN ('passed', 'warning', 'failed')
    )
);

CREATE INDEX IF NOT EXISTS uat_scenarios_tenant_module_idx
    ON app_iam.uat_scenarios(tenant_id, module);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. uat_runs — per-execution log
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.uat_runs (
    run_id            TEXT PRIMARY KEY,
    scenario_id       TEXT NOT NULL REFERENCES app_iam.uat_scenarios(scenario_id) ON DELETE CASCADE,
    tenant_id         TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    executor          TEXT NOT NULL,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ,
    outcome           TEXT NOT NULL,
    duration_ms       BIGINT NOT NULL DEFAULT 0,
    notes             TEXT,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT uat_runs_outcome_chk CHECK (outcome IN ('passed', 'warning', 'failed'))
);

CREATE INDEX IF NOT EXISTS uat_runs_scenario_started_idx
    ON app_iam.uat_runs(scenario_id, started_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. readiness_snapshots
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.readiness_snapshots (
    snapshot_id       TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    overall_score     NUMERIC(5, 2) NOT NULL,
    overall_status    TEXT NOT NULL,
    release_status    TEXT NOT NULL,
    critical_count    INTEGER NOT NULL DEFAULT 0,
    warning_count     INTEGER NOT NULL DEFAULT 0,
    total_checks      INTEGER NOT NULL DEFAULT 0,
    generated_by      TEXT NOT NULL,

    CONSTRAINT readiness_snapshots_status_chk CHECK (
        overall_status IN ('critical', 'at_risk', 'ready', 'production_ready')
    ),
    CONSTRAINT readiness_snapshots_release_chk CHECK (
        release_status IN ('not_ready', 'uat_ready', 'demo_ready', 'production_ready')
    ),
    CONSTRAINT readiness_snapshots_score_chk CHECK (overall_score BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS readiness_snapshots_tenant_generated_idx
    ON app_iam.readiness_snapshots(tenant_id, generated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. readiness_dimension_scores
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.readiness_dimension_scores (
    score_id          BIGSERIAL PRIMARY KEY,
    snapshot_id       TEXT NOT NULL REFERENCES app_iam.readiness_snapshots(snapshot_id) ON DELETE CASCADE,
    tenant_id         TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    dimension         TEXT NOT NULL,
    score             NUMERIC(5, 2) NOT NULL,
    status            TEXT NOT NULL,
    checks_passed     INTEGER NOT NULL DEFAULT 0,
    checks_failed     INTEGER NOT NULL DEFAULT 0,
    checks_warning    INTEGER NOT NULL DEFAULT 0,
    weight            NUMERIC(4, 3) NOT NULL,
    captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT readiness_dimension_scores_dim_chk CHECK (
        dimension IN ('functional', 'data', 'security', 'compliance',
                      'integration', 'uat_coverage', 'release')
    ),
    CONSTRAINT readiness_dimension_scores_status_chk CHECK (
        status IN ('critical', 'at_risk', 'ready', 'production_ready')
    ),
    CONSTRAINT readiness_dimension_scores_score_chk CHECK (score BETWEEN 0 AND 100),
    CONSTRAINT readiness_dimension_scores_weight_chk CHECK (weight BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS readiness_dimension_scores_snapshot_idx
    ON app_iam.readiness_dimension_scores(snapshot_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. flow_validation_findings
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.flow_validation_findings (
    finding_id        TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    flow_kind         TEXT NOT NULL,
    stage             TEXT NOT NULL,
    subject_id        TEXT NOT NULL,
    next_subject_id   TEXT,
    outcome           TEXT NOT NULL,
    detail            TEXT,
    detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT flow_findings_kind_chk CHECK (flow_kind IN ('banking', 'insurance')),
    CONSTRAINT flow_findings_outcome_chk CHECK (outcome IN ('passed', 'warning', 'failed'))
);

CREATE INDEX IF NOT EXISTS flow_findings_tenant_outcome_idx
    ON app_iam.flow_validation_findings(tenant_id, outcome, detected_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. role_validation_findings
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.role_validation_findings (
    finding_id        TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    persona           TEXT NOT NULL,
    axis              TEXT NOT NULL,
    required_count    INTEGER NOT NULL,
    granted_count     INTEGER NOT NULL,
    missing           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    outcome           TEXT NOT NULL,
    detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT role_findings_persona_chk CHECK (
        persona IN ('super_admin', 'country_admin', 'bank_admin', 'insurance_admin',
                    'risk_analyst', 'fraud_analyst', 'auditor', 'operations_user', 'executive')
    ),
    CONSTRAINT role_findings_axis_chk CHECK (
        axis IN ('menu_visibility', 'route_access', 'dashboard_access',
                 'data_access', 'permission_alignment')
    ),
    CONSTRAINT role_findings_outcome_chk CHECK (
        outcome IN ('passed', 'warning', 'failed')
    )
);

CREATE INDEX IF NOT EXISTS role_findings_tenant_persona_idx
    ON app_iam.role_validation_findings(tenant_id, persona, axis);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. data_quality_findings
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.data_quality_findings (
    finding_id        TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    entity_kind       TEXT NOT NULL,
    entity_id         TEXT NOT NULL,
    field             TEXT,
    kind              TEXT NOT NULL,
    severity          TEXT NOT NULL,
    outcome           TEXT NOT NULL,
    detail            TEXT,
    detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT dq_findings_kind_chk CHECK (
        kind IN ('null_value', 'missing_reference', 'orphan_record',
                 'duplicate_entity', 'invalid_relationship')
    ),
    CONSTRAINT dq_findings_severity_chk CHECK (
        severity IN ('info', 'warning', 'error', 'critical')
    ),
    CONSTRAINT dq_findings_outcome_chk CHECK (outcome IN ('passed', 'warning', 'failed'))
);

CREATE INDEX IF NOT EXISTS dq_findings_tenant_entity_idx
    ON app_iam.data_quality_findings(tenant_id, entity_kind, severity);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. release_readiness_reports
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.release_readiness_reports (
    report_id         TEXT PRIMARY KEY,
    tenant_id         TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by      TEXT NOT NULL,
    release_status    TEXT NOT NULL,
    passed_checks     INTEGER NOT NULL DEFAULT 0,
    failed_checks     INTEGER NOT NULL DEFAULT 0,
    warning_checks    INTEGER NOT NULL DEFAULT 0,
    total_checks      INTEGER NOT NULL DEFAULT 0,
    estimated_uat_days INTEGER NOT NULL DEFAULT 0,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT rr_reports_release_chk CHECK (
        release_status IN ('not_ready', 'uat_ready', 'demo_ready', 'production_ready')
    )
);

CREATE INDEX IF NOT EXISTS rr_reports_tenant_generated_idx
    ON app_iam.release_readiness_reports(tenant_id, generated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Seed: 20 UAT scenarios for BANK_DEMO so the SPA shows non-empty inventory
-- on first apply. Engines synthesise everything else on demand.
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO app_iam.uat_scenarios (scenario_id, tenant_id, name, module, owner, description) VALUES
    ('UAT-001', 'BANK_DEMO', 'Borrower onboarding to NPA classification',           'banking',      'qa.lead@bank.demo',   'Walk through customer KYC → loan sanction → DPD progression → NPA classification.'),
    ('UAT-002', 'BANK_DEMO', 'SMA breach triggers risk alert + case',                'banking',      'qa.lead@bank.demo',   'Confirm SMA0/1/2 thresholds produce ranked alerts and auto-assigned cases.'),
    ('UAT-003', 'BANK_DEMO', 'Collections recovery flow with maker-checker',         'banking',      'qa.lead@bank.demo',   'Multi-step recovery action with 4-eye approval.'),
    ('UAT-004', 'BANK_DEMO', 'Fraud signal escalation to investigation',             'banking',      'fraud.lead@bank.demo','High fraud-score alert routes to investigation queue with SLA timer.'),
    ('UAT-005', 'BANK_DEMO', 'Sector stress trigger flags portfolio cohort',         'banking',      'risk.lead@bank.demo', 'GDP shock simulation flags cohort of msme borrowers.'),
    ('UAT-006', 'BANK_DEMO', 'Policy issuance with underwriting score',              'insurance',    'qa.ins@bank.demo',    'New policy → underwriting deviation check → status set to high_risk if triggered.'),
    ('UAT-007', 'BANK_DEMO', 'Claim filing → investigation → payout',                'insurance',    'qa.ins@bank.demo',    'End-to-end claim lifecycle covering investigating → approved → paid.'),
    ('UAT-008', 'BANK_DEMO', 'Claim flagged as fraud → cleared via evidence',        'insurance',    'fraud.ins@bank.demo', 'Fraud_score >=70 triggers fraud case; cleared after document review.'),
    ('UAT-009', 'BANK_DEMO', 'Persistency breach generates agent performance alert', 'insurance',    'ops.ins@bank.demo',   'Agent persistency drop fires persistency_breach alert and updates dashboard.'),
    ('UAT-010', 'BANK_DEMO', 'Policy lapse risk → renewal nudge',                    'insurance',    'ops.ins@bank.demo',   'Lapse_risk status surfaces in operational dashboard and triggers renewal workflow.'),
    ('UAT-011', 'BANK_DEMO', 'Cross-domain customer 360 lookup',                     'cross_domain', 'cdo@bank.demo',       'Customer with both banking + insurance products renders unified 360 view.'),
    ('UAT-012', 'BANK_DEMO', 'Cross-domain executive cockpit refresh',               'cross_domain', 'cro@bank.demo',       'Executive cockpit shows banking + insurance KPIs side-by-side with 30-day trends.'),
    ('UAT-013', 'BANK_DEMO', 'Predictive risk forecast loads with confidence band',  'cross_domain', 'cdo@bank.demo',       '24 forecasts across 4 horizons render with confidence scores and recommended actions.'),
    ('UAT-014', 'BANK_DEMO', 'Compliance obligation overdue triggers escalation',    'cross_domain', 'compliance@bank.demo','Obligation crossing due-date fires breach status + creates finding.'),
    ('UAT-015', 'BANK_DEMO', 'Data fabric pipeline failure surfaces in observability', 'cross_domain', 'data.eng@bank.demo','Failed pipeline run creates data_observability_event and updates source health.'),
    ('UAT-016', 'BANK_DEMO', 'Role provisioning: bank_admin grants menu access',     'admin',        'iam.admin@bank.demo', 'New bank_admin sees the right sidebar entries (banking + cross-domain only).'),
    ('UAT-017', 'BANK_DEMO', 'Audit trail integrity check on config change',         'admin',        'audit.lead@bank.demo','Admin config change writes hash-chained audit row; integrity check passes.'),
    ('UAT-018', 'BANK_DEMO', 'Webhook subscription delivers alert event',            'admin',        'integration@bank.demo','Outbound webhook receives alert.created event with HMAC signature.'),
    ('UAT-019', 'BANK_DEMO', 'Scenario simulation: RBI severely-adverse run',        'admin',        'risk.lead@bank.demo', 'RBI severely-adverse preset produces portfolio PD shift + 3x3 stage migration.'),
    ('UAT-020', 'BANK_DEMO', 'Maker-checker on sensitive case closure',              'admin',        'supervisor@bank.demo','Sensitive case-close requires 4-eyes approval; self-approval refused.')
ON CONFLICT (scenario_id) DO NOTHING;
