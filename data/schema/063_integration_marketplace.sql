-- data/schema/063_integration_marketplace.sql
-- Enterprise Integration Marketplace — additive schema (Phase 20 IA overlay).
-- 8 additive tables for integration lifecycle management.
-- Idempotent: CREATE TABLE IF NOT EXISTS on every object.
-- Zero changes to any existing tables.

CREATE TABLE IF NOT EXISTS app_iam.integration_registry (
    integration_id     TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT NOT NULL,
    category           TEXT NOT NULL CHECK (category IN ('banking','insurance','enterprise')),
    sub_category       TEXT NOT NULL,
    owner              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','inactive','degraded','maintenance','deprecated')),
    health_score       INTEGER CHECK (health_score BETWEEN 0 AND 100),
    last_sync_at       TIMESTAMPTZ,
    version            TEXT NOT NULL DEFAULT '1.0.0',
    description        TEXT,
    records_per_day    BIGINT NOT NULL DEFAULT 0,
    sla_uptime_pct     NUMERIC(6,3),
    dependencies       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    governance_state   TEXT NOT NULL DEFAULT 'draft'
                           CHECK (governance_state IN ('draft','review','approved','rejected','retired')),
    risk_level         TEXT NOT NULL DEFAULT 'medium'
                           CHECK (risk_level IN ('low','medium','high','critical')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.api_registry (
    api_id             TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT NOT NULL,
    version            TEXT NOT NULL,
    endpoint           TEXT NOT NULL,
    owner              TEXT NOT NULL,
    environment        TEXT NOT NULL DEFAULT 'production'
                           CHECK (environment IN ('production','staging','sandbox')),
    api_type           TEXT NOT NULL CHECK (api_type IN ('REST','GraphQL','Webhook','Event')),
    auth_type          TEXT NOT NULL CHECK (auth_type IN ('OAuth2','API Key','mTLS','JWT','Basic')),
    sla_ms             INTEGER NOT NULL DEFAULT 1000,
    availability_pct   NUMERIC(6,3),
    calls_per_day      BIGINT NOT NULL DEFAULT 0,
    error_rate_pct     NUMERIC(6,3),
    status             TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','deprecated','beta')),
    description        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.data_exchange_flows (
    flow_id            TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    source_system      TEXT NOT NULL,
    target_system      TEXT NOT NULL,
    data_type          TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'idle'
                           CHECK (status IN ('running','paused','failed','idle')),
    records_per_day    BIGINT NOT NULL DEFAULT 0,
    avg_latency_ms     INTEGER,
    throughput_per_min INTEGER,
    last_run_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.event_subscriptions (
    subscription_id    TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    event_type         TEXT NOT NULL,
    subscriber         TEXT NOT NULL,
    endpoint           TEXT NOT NULL,
    delivery_status    TEXT NOT NULL DEFAULT 'healthy'
                           CHECK (delivery_status IN ('healthy','degraded','failed')),
    retry_count        INTEGER NOT NULL DEFAULT 0,
    success_rate_pct   NUMERIC(6,3),
    last_delivered_at  TIMESTAMPTZ,
    auth_type          TEXT NOT NULL DEFAULT 'API Key',
    is_active          BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.partner_registry (
    partner_id         TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT NOT NULL,
    partner_type       TEXT NOT NULL
                           CHECK (partner_type IN ('credit_bureau','collection_agency','investigator','audit_firm','recovery_agency','insurance_surveyor')),
    contract_status    TEXT NOT NULL DEFAULT 'active'
                           CHECK (contract_status IN ('active','renewal_due','expired','under_negotiation')),
    sla_response_hours INTEGER NOT NULL DEFAULT 24,
    sla_met_pct        NUMERIC(6,3),
    performance_score  INTEGER CHECK (performance_score BETWEEN 0 AND 100),
    compliance_rating  TEXT CHECK (compliance_rating IN ('AAA','AA','A','BBB','BB')),
    contract_value_cr  NUMERIC(20,2),
    contract_expiry    DATE,
    region             TEXT,
    incidents_30d      INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.integration_governance (
    record_id          TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    integration_id     TEXT REFERENCES app_iam.integration_registry(integration_id) ON DELETE SET NULL,
    state              TEXT NOT NULL DEFAULT 'draft'
                           CHECK (state IN ('draft','review','approved','rejected','retired')),
    security_review    TEXT NOT NULL DEFAULT 'pending'
                           CHECK (security_review IN ('passed','pending','failed','not_required')),
    risk_level         TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
    data_classification TEXT NOT NULL CHECK (data_classification IN ('public','internal','confidential','restricted')),
    compliance_review  TEXT NOT NULL DEFAULT 'pending'
                           CHECK (compliance_review IN ('passed','pending','failed')),
    approver           TEXT,
    submitted_by       TEXT NOT NULL,
    submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at        TIMESTAMPTZ,
    comments           TEXT
);

CREATE TABLE IF NOT EXISTS app_iam.integration_insights (
    insight_id         TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    insight_type       TEXT NOT NULL CHECK (insight_type IN ('risk','bottleneck','sla_breach','capacity','optimization')),
    severity           TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    title              TEXT NOT NULL,
    description        TEXT NOT NULL,
    affected_system    TEXT,
    recommendation     TEXT,
    estimated_impact   TEXT,
    confidence_score   NUMERIC(4,3) CHECK (confidence_score BETWEEN 0 AND 1),
    status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.integration_readiness_scores (
    score_id           TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    overall_score      INTEGER NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
    grade              TEXT NOT NULL CHECK (grade IN ('A+','A','B+','B','C','D')),
    security_score     INTEGER CHECK (security_score BETWEEN 0 AND 100),
    reliability_score  INTEGER CHECK (reliability_score BETWEEN 0 AND 100),
    performance_score  INTEGER CHECK (performance_score BETWEEN 0 AND 100),
    governance_score   INTEGER CHECK (governance_score BETWEEN 0 AND 100),
    compliance_score   INTEGER CHECK (compliance_score BETWEEN 0 AND 100),
    documentation_score INTEGER CHECK (documentation_score BETWEEN 0 AND 100),
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_integration_registry_tenant_cat ON app_iam.integration_registry(tenant_id, category, status);
CREATE INDEX IF NOT EXISTS idx_api_registry_tenant_type ON app_iam.api_registry(tenant_id, api_type, status);
CREATE INDEX IF NOT EXISTS idx_data_exchange_tenant ON app_iam.data_exchange_flows(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_event_subscriptions_tenant ON app_iam.event_subscriptions(tenant_id, event_type, is_active);
CREATE INDEX IF NOT EXISTS idx_partner_registry_tenant ON app_iam.partner_registry(tenant_id, partner_type, contract_status);
CREATE INDEX IF NOT EXISTS idx_integration_governance_tenant ON app_iam.integration_governance(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_integration_insights_tenant ON app_iam.integration_insights(tenant_id, severity, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_readiness_scores_tenant ON app_iam.integration_readiness_scores(tenant_id, generated_at DESC);
