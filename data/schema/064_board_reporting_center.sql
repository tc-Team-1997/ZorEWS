-- data/schema/064_board_reporting_center.sql
-- Enterprise Reporting & Board Packs Center — additive schema (Phase 21 IA overlay).
-- 8 additive tables for board reporting lifecycle management.
-- Idempotent: CREATE TABLE IF NOT EXISTS on every object.
-- Zero changes to any existing tables.

CREATE TABLE IF NOT EXISTS app_iam.board_packs (
    pack_id            TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    pack_type          TEXT NOT NULL CHECK (pack_type IN ('board_risk','executive_risk','cro','ceo','cfo','audit_committee','risk_committee','compliance_committee','regulatory_filing')),
    title              TEXT NOT NULL,
    owner              TEXT NOT NULL,
    version            TEXT NOT NULL DEFAULT '1.0.0',
    approval_status    TEXT NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft','under_review','approved','distributed','archived')),
    last_generated_at  TIMESTAMPTZ,
    next_due_at        TIMESTAMPTZ,
    review_cycle       TEXT NOT NULL DEFAULT 'quarterly' CHECK (review_cycle IN ('daily','weekly','monthly','quarterly','annual')),
    distribution_list  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    pages_count        INTEGER,
    size_kb            INTEGER,
    sections           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    approved_by        TEXT,
    signed_off_at      TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.regulatory_filings (
    filing_id          TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    framework          TEXT NOT NULL CHECK (framework IN ('RBI','IRDAI','Basel','SEBI','PMLA','IFRS9')),
    report_name        TEXT NOT NULL,
    domain             TEXT NOT NULL CHECK (domain IN ('banking','insurance')),
    frequency          TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','quarterly','annual')),
    submission_status  TEXT NOT NULL DEFAULT 'in_preparation' CHECK (submission_status IN ('filed','due_soon','overdue','in_preparation')),
    due_date           DATE NOT NULL,
    last_filed_at      DATE,
    approval_status    TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('approved','pending','requires_revision')),
    filing_authority   TEXT NOT NULL,
    penalty_risk       TEXT NOT NULL DEFAULT 'none' CHECK (penalty_risk IN ('none','low','medium','high')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.report_schedules_board (
    schedule_id        TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    pack_id            TEXT REFERENCES app_iam.board_packs(pack_id) ON DELETE SET NULL,
    report_name        TEXT NOT NULL,
    frequency          TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','quarterly','annual')),
    next_run_at        TIMESTAMPTZ,
    last_run_at        TIMESTAMPTZ,
    last_run_status    TEXT DEFAULT 'success' CHECK (last_run_status IN ('success','failed','skipped')),
    success_rate_pct   NUMERIC(6,3),
    failure_count_30d  INTEGER NOT NULL DEFAULT 0,
    recipients_count   INTEGER NOT NULL DEFAULT 0,
    is_active          BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.pack_generation_log (
    generation_id      TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    pack_id            TEXT REFERENCES app_iam.board_packs(pack_id) ON DELETE SET NULL,
    pack_type          TEXT NOT NULL,
    formats            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    requested_by       TEXT NOT NULL,
    requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','generating','ready','failed')),
    completed_at       TIMESTAMPTZ,
    generation_time_ms INTEGER,
    version            TEXT NOT NULL DEFAULT '1.0.0',
    error_message      TEXT
);

CREATE TABLE IF NOT EXISTS app_iam.executive_kpi_history (
    kpi_id             BIGSERIAL PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    kpi_name           TEXT NOT NULL,
    domain             TEXT NOT NULL CHECK (domain IN ('banking','insurance','enterprise')),
    period_label       TEXT NOT NULL,
    value_numeric      NUMERIC(20,4),
    value_text         TEXT,
    unit               TEXT,
    trend_direction    TEXT CHECK (trend_direction IN ('improving','stable','deteriorating')),
    threshold_status   TEXT CHECK (threshold_status IN ('within','watch','breach')),
    benchmark          TEXT,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.board_intelligence_summaries (
    summary_id         TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confidence_score   NUMERIC(4,3) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
    board_health_score INTEGER CHECK (board_health_score BETWEEN 0 AND 100),
    top_risks          JSONB NOT NULL DEFAULT '[]'::jsonb,
    top_opportunities  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    emerging_threats   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    compliance_concerns TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    forecast_highlights TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    executive_narrative TEXT
);

CREATE TABLE IF NOT EXISTS app_iam.board_pack_approvals (
    approval_id        TEXT PRIMARY KEY,
    pack_id            TEXT NOT NULL REFERENCES app_iam.board_packs(pack_id) ON DELETE CASCADE,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    stage              TEXT NOT NULL CHECK (stage IN ('draft','review','approved','distributed','archived')),
    actor              TEXT NOT NULL,
    actor_role         TEXT NOT NULL,
    actioned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    comments           TEXT,
    version            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_iam.ai_governance_report_history (
    history_id         TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    report_type        TEXT NOT NULL CHECK (report_type IN ('model_performance','drift','explainability','prediction_accuracy','ai_risk')),
    title              TEXT NOT NULL,
    period_label       TEXT NOT NULL,
    overall_status     TEXT NOT NULL CHECK (overall_status IN ('healthy','watch','action_required')),
    summary            TEXT,
    key_metrics        JSONB NOT NULL DEFAULT '[]'::jsonb,
    recommendations    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    confidence_score   NUMERIC(4,3),
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_review_at     DATE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_board_packs_tenant_type ON app_iam.board_packs(tenant_id, pack_type, approval_status);
CREATE INDEX IF NOT EXISTS idx_regulatory_filings_tenant ON app_iam.regulatory_filings(tenant_id, framework, submission_status);
CREATE INDEX IF NOT EXISTS idx_report_schedules_board_tenant ON app_iam.report_schedules_board(tenant_id, is_active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_pack_gen_log_tenant ON app_iam.pack_generation_log(tenant_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_kpi_history_tenant ON app_iam.executive_kpi_history(tenant_id, domain, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_intel_tenant ON app_iam.board_intelligence_summaries(tenant_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pack_approvals_pack ON app_iam.board_pack_approvals(pack_id, actioned_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_gov_report_history_tenant ON app_iam.ai_governance_report_history(tenant_id, report_type, generated_at DESC);
