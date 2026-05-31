-- data/schema/060_digital_twin.sql
--
-- Digital Twin Risk Simulation Center — additive schema (17th IA overlay).
--
-- 10 additive tables under app_iam.* backing the deterministic engines under
-- web/src/modules/digitalTwin/. Idempotent — every CREATE TABLE wraps in
-- IF NOT EXISTS. Existing tables (raw / staging / mart / audit / app_iam.* /
-- app_alerts.* / app_cases.* / app_bff.* / app_scenario.* / demo_* / uat_* /
-- readiness_* / flow_/role_/data_/release_*) untouched.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. scenario_templates — built-in banking + insurance templates
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.scenario_templates (
    template_id        TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT NOT NULL,
    description        TEXT,
    domain             TEXT NOT NULL,
    kind               TEXT NOT NULL,
    default_severity_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    default_horizon    TEXT NOT NULL DEFAULT '30d',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT scenario_templates_domain_chk CHECK (
        domain IN ('banking', 'insurance', 'cross_domain')
    ),
    CONSTRAINT scenario_templates_horizon_chk CHECK (
        default_horizon IN ('30d', '60d', '90d', '180d')
    ),
    CONSTRAINT scenario_templates_severity_chk CHECK (
        default_severity_pct BETWEEN 0 AND 100
    )
);

CREATE INDEX IF NOT EXISTS scenario_templates_tenant_domain_idx
    ON app_iam.scenario_templates(tenant_id, domain);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. saved_simulations — scenario library with state machine
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.saved_simulations (
    scenario_id        TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT NOT NULL,
    template_id        TEXT REFERENCES app_iam.scenario_templates(template_id) ON DELETE SET NULL,
    domain             TEXT NOT NULL,
    kind               TEXT NOT NULL,
    severity_pct       NUMERIC(5, 2) NOT NULL DEFAULT 0,
    horizon            TEXT NOT NULL DEFAULT '30d',
    state              TEXT NOT NULL DEFAULT 'draft',
    created_by         TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by        TEXT,
    reviewed_at        TIMESTAMPTZ,
    approver           TEXT,
    approved_at        TIMESTAMPTZ,
    notes              TEXT,

    CONSTRAINT saved_simulations_domain_chk CHECK (
        domain IN ('banking', 'insurance', 'cross_domain')
    ),
    CONSTRAINT saved_simulations_state_chk CHECK (
        state IN ('draft', 'review', 'approved', 'rejected', 'archived')
    ),
    CONSTRAINT saved_simulations_horizon_chk CHECK (
        horizon IN ('30d', '60d', '90d', '180d')
    ),
    CONSTRAINT saved_simulations_severity_chk CHECK (
        severity_pct BETWEEN 0 AND 100
    )
);

CREATE INDEX IF NOT EXISTS saved_simulations_tenant_state_idx
    ON app_iam.saved_simulations(tenant_id, state, updated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. scenario_workflow_events — maker/checker/approver audit
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.scenario_workflow_events (
    event_id           TEXT PRIMARY KEY,
    scenario_id        TEXT NOT NULL REFERENCES app_iam.saved_simulations(scenario_id) ON DELETE CASCADE,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    action             TEXT NOT NULL,
    actor              TEXT NOT NULL,
    ts                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    from_state         TEXT,
    to_state           TEXT NOT NULL,
    comment            TEXT,

    CONSTRAINT swe_action_chk CHECK (
        action IN ('submit_for_review', 'approve', 'reject', 'archive', 'restore', 'clone')
    ),
    CONSTRAINT swe_to_state_chk CHECK (
        to_state IN ('draft', 'review', 'approved', 'rejected', 'archived')
    ),
    CONSTRAINT swe_from_state_chk CHECK (
        from_state IS NULL OR from_state IN ('draft', 'review', 'approved', 'rejected', 'archived')
    )
);

CREATE INDEX IF NOT EXISTS swe_scenario_ts_idx
    ON app_iam.scenario_workflow_events(scenario_id, ts DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. simulation_runs — per-run output ledger
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.simulation_runs (
    run_id             TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    scenario_id        TEXT REFERENCES app_iam.saved_simulations(scenario_id) ON DELETE SET NULL,
    domain             TEXT NOT NULL,
    kind               TEXT NOT NULL,
    severity_pct       NUMERIC(5, 2) NOT NULL,
    horizon            TEXT NOT NULL,
    triggered_by       TEXT NOT NULL,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at        TIMESTAMPTZ,
    duration_ms        BIGINT NOT NULL DEFAULT 0,
    confidence_score   NUMERIC(4, 3),
    impact_level       TEXT NOT NULL DEFAULT 'low',
    payload            JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT sim_runs_domain_chk CHECK (domain IN ('banking', 'insurance', 'cross_domain')),
    CONSTRAINT sim_runs_horizon_chk CHECK (horizon IN ('30d', '60d', '90d', '180d')),
    CONSTRAINT sim_runs_impact_chk CHECK (
        impact_level IN ('low', 'medium', 'high', 'critical')
    ),
    CONSTRAINT sim_runs_severity_chk CHECK (severity_pct BETWEEN 0 AND 100),
    CONSTRAINT sim_runs_confidence_chk CHECK (
        confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1
    )
);

CREATE INDEX IF NOT EXISTS sim_runs_tenant_domain_idx
    ON app_iam.simulation_runs(tenant_id, domain, started_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. simulation_results — denormalised metric rows per run
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.simulation_results (
    result_id          BIGSERIAL PRIMARY KEY,
    run_id             TEXT NOT NULL REFERENCES app_iam.simulation_runs(run_id) ON DELETE CASCADE,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    metric             TEXT NOT NULL,
    baseline_value     NUMERIC(20, 4) NOT NULL,
    projected_value    NUMERIC(20, 4) NOT NULL,
    delta_value        NUMERIC(20, 4) NOT NULL,
    delta_pct          NUMERIC(8, 4),
    captured_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sim_results_run_metric_idx
    ON app_iam.simulation_results(run_id, metric);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. impact_analyses — 5-category impact rollup per run
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.impact_analyses (
    analysis_id        TEXT PRIMARY KEY,
    run_id             TEXT REFERENCES app_iam.simulation_runs(run_id) ON DELETE CASCADE,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    overall_score      NUMERIC(5, 2) NOT NULL,
    overall_level      TEXT NOT NULL,
    payload            JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT impact_overall_level_chk CHECK (
        overall_level IN ('low', 'medium', 'high', 'critical')
    ),
    CONSTRAINT impact_overall_score_chk CHECK (overall_score BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS impact_tenant_generated_idx
    ON app_iam.impact_analyses(tenant_id, generated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. impact_category_scores — per-category breakdown
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.impact_category_scores (
    score_id           BIGSERIAL PRIMARY KEY,
    analysis_id        TEXT NOT NULL REFERENCES app_iam.impact_analyses(analysis_id) ON DELETE CASCADE,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    category           TEXT NOT NULL,
    score              NUMERIC(5, 2) NOT NULL,
    level              TEXT NOT NULL,
    key_drivers        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    financial_estimate_inr NUMERIC(20, 2),

    CONSTRAINT ics_category_chk CHECK (
        category IN ('financial', 'operational', 'compliance', 'risk', 'executive')
    ),
    CONSTRAINT ics_level_chk CHECK (
        level IN ('low', 'medium', 'high', 'critical')
    ),
    CONSTRAINT ics_score_chk CHECK (score BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS ics_analysis_category_idx
    ON app_iam.impact_category_scores(analysis_id, category);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. ai_recommendations — AI-generated narrative + actions per run
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_recommendations (
    recommendation_id  TEXT PRIMARY KEY,
    run_id             TEXT REFERENCES app_iam.simulation_runs(run_id) ON DELETE CASCADE,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confidence_score   NUMERIC(4, 3) NOT NULL,
    narrative          TEXT NOT NULL,
    payload            JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT ai_rec_confidence_chk CHECK (confidence_score BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS ai_rec_tenant_generated_idx
    ON app_iam.ai_recommendations(tenant_id, generated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 9. scenario_comparisons — saved A-vs-B comparisons
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.scenario_comparisons (
    comparison_id      TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    left_run_id        TEXT REFERENCES app_iam.simulation_runs(run_id) ON DELETE SET NULL,
    right_run_id       TEXT REFERENCES app_iam.simulation_runs(run_id) ON DELETE SET NULL,
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by       TEXT NOT NULL,
    risk_delta_pp      NUMERIC(8, 4) NOT NULL DEFAULT 0,
    revenue_delta_inr  NUMERIC(20, 2) NOT NULL DEFAULT 0,
    compliance_delta_pp NUMERIC(8, 4) NOT NULL DEFAULT 0,
    solvency_delta_pp  NUMERIC(8, 4) NOT NULL DEFAULT 0,
    npa_delta_pp       NUMERIC(8, 4) NOT NULL DEFAULT 0,
    payload            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS scen_comp_tenant_generated_idx
    ON app_iam.scenario_comparisons(tenant_id, generated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 10. board_reports — generated PDF/Excel/CSV reports
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.board_reports (
    report_id          TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by       TEXT NOT NULL,
    kind               TEXT NOT NULL,
    format             TEXT NOT NULL,
    period_label       TEXT,
    recipient_audience TEXT,
    scenarios_included INTEGER NOT NULL DEFAULT 0,
    high_impact_count  INTEGER NOT NULL DEFAULT 0,
    download_size_kb   INTEGER NOT NULL DEFAULT 0,
    sign_off_required_from TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    payload            JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT board_reports_kind_chk CHECK (
        kind IN ('board', 'risk_committee', 'audit_committee', 'regulatory')
    ),
    CONSTRAINT board_reports_format_chk CHECK (
        format IN ('pdf', 'excel', 'csv')
    )
);

CREATE INDEX IF NOT EXISTS board_reports_tenant_kind_idx
    ON app_iam.board_reports(tenant_id, kind, generated_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Seed: 10 scenario templates (5 banking + 5 insurance) for BANK_DEMO.
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO app_iam.scenario_templates (template_id, tenant_id, name, description, domain, kind, default_severity_pct, default_horizon) VALUES
    ('TPL-BNK-RATE-RBI',  'BANK_DEMO', 'RBI Rate Increase',     'RBI hikes repo rate by 100..500 bps in the next monetary cycle.', 'banking', 'interest_rate_shock', 200, '90d'),
    ('TPL-BNK-LIQ-CRISIS','BANK_DEMO', 'Liquidity Crisis',      'System-wide liquidity drain triggers withdrawal pressure on branches.', 'banking', 'liquidity_crisis',     35, '60d'),
    ('TPL-BNK-MSME',      'BANK_DEMO', 'MSME Collapse',         'Concentrated MSME stress driven by demand shock + working-capital squeeze.', 'banking', 'sector_shock',          40, '90d'),
    ('TPL-BNK-HOUSING',   'BANK_DEMO', 'Housing Market Crash',  'Real-estate price correction triggers home-loan defaults in mid-tier cities.', 'banking', 'sector_shock',          30, '180d'),
    ('TPL-BNK-REGIONAL',  'BANK_DEMO', 'Regional Stress',       'Localised GDP contraction in 2-3 states drives broad portfolio deterioration.', 'banking', 'economic_stress',       25, '90d'),
    ('TPL-INS-CLAIM-INF', 'BANK_DEMO', 'Claims Inflation',      'Sustained 15..30% claims-volume growth across health + motor lines.',      'insurance', 'claims_surge',         25, '90d'),
    ('TPL-INS-FRAUD',     'BANK_DEMO', 'Fraud Wave',            'Organised fraud cluster spikes investigation workload + SIU capacity.',    'insurance', 'fraud_spike',          50, '60d'),
    ('TPL-INS-PERSIST',   'BANK_DEMO', 'Persistency Decline',   'Renewal slump driven by competitive pressure + economic uncertainty.',     'insurance', 'lapse_surge',          20, '90d'),
    ('TPL-INS-CATASTRO',  'BANK_DEMO', 'Catastrophe Event',     'Cyclone + flooding in coastal states triggers high-volume claims surge.',  'insurance', 'catastrophic_event',   60, '30d'),
    ('TPL-INS-SOLVENCY',  'BANK_DEMO', 'Solvency Shock',        'Adverse-development + reserve strengthening drives solvency ratio down.',   'insurance', 'solvency_stress',      35, '90d')
ON CONFLICT (template_id) DO NOTHING;
