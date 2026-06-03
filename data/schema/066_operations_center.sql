-- data/schema/066_operations_center.sql
-- Production Operations Center — additive schema (Phase 23 IA overlay).
-- 9 additive tables for production operations lifecycle management.
-- Idempotent: CREATE TABLE IF NOT EXISTS on every object.
-- Zero changes to any existing tables.

CREATE TABLE IF NOT EXISTS app_iam.ops_services (
    service_id         TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT NOT NULL,
    version            TEXT NOT NULL DEFAULT '1.0.0',
    owner              TEXT NOT NULL,
    environment        TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('development','sit','uat','pre_production','production')),
    status             TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy','degraded','critical','offline','maintenance')),
    uptime_pct         NUMERIC(6,3),
    port               INTEGER,
    instances          INTEGER NOT NULL DEFAULT 1,
    avg_response_ms    INTEGER,
    cpu_pct            NUMERIC(5,2),
    memory_pct         NUMERIC(5,2),
    last_deployment_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.ops_incidents (
    incident_id        TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    title              TEXT NOT NULL,
    severity           TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
    state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','assigned','investigating','mitigated','resolved','closed')),
    affected_service   TEXT,
    owner              TEXT,
    root_cause         TEXT,
    business_impact    TEXT,
    war_room_active    BOOLEAN NOT NULL DEFAULT false,
    opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at        TIMESTAMPTZ,
    resolution_time_min INTEGER,
    postmortem_due     DATE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.ops_change_requests (
    cr_id              TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    title              TEXT NOT NULL,
    state              TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','review','approved','implemented','rejected')),
    change_type        TEXT NOT NULL DEFAULT 'normal' CHECK (change_type IN ('standard','emergency','normal')),
    affected_service   TEXT,
    risk_level         TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
    submitter          TEXT NOT NULL,
    approver           TEXT,
    submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    planned_window_at  TIMESTAMPTZ,
    rollback_plan      TEXT,
    estimated_downtime_min INTEGER NOT NULL DEFAULT 0,
    has_rollback       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS app_iam.ops_releases (
    release_id         TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    version            TEXT NOT NULL,
    service            TEXT NOT NULL,
    deployed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deployed_by        TEXT NOT NULL,
    environment        TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('development','sit','uat','pre_production','production')),
    success            BOOLEAN NOT NULL DEFAULT true,
    rollback_triggered BOOLEAN NOT NULL DEFAULT false,
    deployment_time_min INTEGER,
    release_notes      TEXT,
    features_count     INTEGER NOT NULL DEFAULT 0,
    bug_fixes_count    INTEGER NOT NULL DEFAULT 0,
    breaking_changes   BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS app_iam.ops_environments (
    env_id             TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT NOT NULL CHECK (name IN ('development','sit','uat','pre_production','production')),
    health_score       INTEGER CHECK (health_score BETWEEN 0 AND 100),
    active_deployments INTEGER NOT NULL DEFAULT 0,
    active_incidents   INTEGER NOT NULL DEFAULT 0,
    services_healthy   INTEGER NOT NULL DEFAULT 0,
    services_total     INTEGER NOT NULL DEFAULT 0,
    cpu_pct            NUMERIC(5,2),
    memory_pct         NUMERIC(5,2),
    uptime_days        INTEGER NOT NULL DEFAULT 0,
    last_deployment_at TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS app_iam.ops_capacity_snapshots (
    snapshot_id        BIGSERIAL PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cpu_pct            NUMERIC(5,2) NOT NULL,
    memory_pct         NUMERIC(5,2) NOT NULL,
    storage_pct        NUMERIC(5,2) NOT NULL,
    db_connections_pct NUMERIC(5,2),
    queue_backlog      INTEGER NOT NULL DEFAULT 0,
    pod_count          INTEGER NOT NULL DEFAULT 0,
    pod_capacity       INTEGER NOT NULL DEFAULT 0,
    scale_out_recommended BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS app_iam.ops_security_events (
    event_id           TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    event_type         TEXT NOT NULL CHECK (event_type IN ('failed_login','suspicious_activity','privilege_change','security_incident','patch_applied','vulnerability_detected')),
    severity           TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical','warning','info')),
    actor              TEXT,
    description        TEXT NOT NULL,
    occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.ops_bcp_status (
    bcp_id             TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    backup_status      TEXT NOT NULL DEFAULT 'current' CHECK (backup_status IN ('current','stale','failed')),
    last_backup_at     TIMESTAMPTZ,
    backup_success_rate_pct NUMERIC(6,3),
    recovery_readiness TEXT NOT NULL DEFAULT 'ready' CHECK (recovery_readiness IN ('ready','partial','not_ready')),
    dr_readiness       TEXT NOT NULL DEFAULT 'ready' CHECK (dr_readiness IN ('ready','partial','not_ready')),
    rto_target_min     INTEGER NOT NULL DEFAULT 15,
    rto_tested_min     INTEGER,
    rpo_target_min     INTEGER NOT NULL DEFAULT 5,
    rpo_tested_min     INTEGER,
    last_dr_drill_at   DATE,
    next_dr_drill_at   DATE,
    failover_tested    BOOLEAN NOT NULL DEFAULT false,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.ops_ai_insights (
    insight_id         TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    insight_type       TEXT NOT NULL CHECK (insight_type IN ('failure_prediction','capacity_forecast','incident_hotspot','release_risk','recommendation')),
    severity           TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
    title              TEXT NOT NULL,
    description        TEXT NOT NULL,
    affected_service   TEXT,
    confidence_score   NUMERIC(4,3) CHECK (confidence_score BETWEEN 0 AND 1),
    recommendation     TEXT,
    predicted_impact   TEXT,
    status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ops_services_tenant ON app_iam.ops_services(tenant_id, status, environment);
CREATE INDEX IF NOT EXISTS idx_ops_incidents_tenant ON app_iam.ops_incidents(tenant_id, severity, state, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_changes_tenant ON app_iam.ops_change_requests(tenant_id, state, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_releases_tenant ON app_iam.ops_releases(tenant_id, environment, deployed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_capacity_tenant ON app_iam.ops_capacity_snapshots(tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_sec_events_tenant ON app_iam.ops_security_events(tenant_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_ai_insights_tenant ON app_iam.ops_ai_insights(tenant_id, severity, generated_at DESC);
