-- data/schema/057_data_fabric.sql
--
-- Enterprise Data Fabric Center — additive schema (14th IA addition this session).
--
-- 11 tables backing the new /data-fabric-center surface. Idempotent: safe to
-- re-run via `make migrate`. Zero alterations to existing tables.
--
-- Tables (all under app_iam.*)
--   1. data_sources                — source registry (CBS / LOS / IRDAI Claims / Kafka / SFTP / …)
--   2. integration_connections     — source → target wiring with throughput/latency
--   3. integration_executions      — execution log per connection
--   4. data_pipelines              — pipeline definitions + schedule
--   5. pipeline_runs               — pipeline run log
--   6. metadata_catalog            — business glossary + data dictionary
--   7. data_lineage                — lineage edges across sources / transformations / models / dashboards
--   8. data_governance             — policies (retention / access / classification / masking / anonymization)
--   9. data_quality_metrics        — 6-dimension quality scores per source × dimension
--  10. data_observability_events   — freshness / volume / schema / drift events
--  11. ai_data_readiness           — per-dataset readiness for training / inference / validation
--
-- Backward compatibility — every existing table untouched. Migrations 001-056
-- continue to apply cleanly. Existing data modules
-- (Data Ingestion / Profiling / Validation Rules / Standardization / Anomaly
-- Detection / Reconciliation / Data Quality Score) are sibling overlays, not
-- replaced.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. data_sources — source registry
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.data_sources (
    source_id             TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name                  TEXT NOT NULL,
    kind                  TEXT NOT NULL,
    domain                TEXT NOT NULL,
    integration_type      TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'active',
    endpoint              TEXT NOT NULL,
    schema_version        TEXT NOT NULL DEFAULT 'v1.0',
    owner                 TEXT NOT NULL,
    steward               TEXT,
    classification        TEXT NOT NULL DEFAULT 'internal',
    refresh_frequency     TEXT NOT NULL DEFAULT 'daily',
    last_sync_at          TIMESTAMPTZ,
    tags                  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    description           TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT data_sources_domain_chk CHECK (domain IN ('banking', 'insurance', 'common')),
    CONSTRAINT data_sources_integration_type_chk CHECK (
        integration_type IN ('api', 'file', 'streaming', 'database_replication', 'event_driven')
    ),
    CONSTRAINT data_sources_status_chk CHECK (
        status IN ('active', 'paused', 'failed', 'retrying', 'degraded')
    ),
    CONSTRAINT data_sources_classification_chk CHECK (
        classification IN ('public', 'internal', 'confidential', 'restricted', 'pii', 'pci', 'phi', 'regulatory')
    )
);

CREATE INDEX IF NOT EXISTS data_sources_tenant_status_idx
    ON app_iam.data_sources(tenant_id, status);
CREATE INDEX IF NOT EXISTS data_sources_tenant_domain_idx
    ON app_iam.data_sources(tenant_id, domain);
CREATE INDEX IF NOT EXISTS data_sources_kind_idx
    ON app_iam.data_sources(tenant_id, kind);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. integration_connections — source → target wiring
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.integration_connections (
    connection_id         TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    source_id             TEXT NOT NULL REFERENCES app_iam.data_sources(source_id) ON DELETE CASCADE,
    target                TEXT NOT NULL,
    integration_type      TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'active',
    throughput_per_min    NUMERIC(10, 2) NOT NULL DEFAULT 0,
    avg_latency_ms        NUMERIC(10, 2) NOT NULL DEFAULT 0,
    availability_pct      NUMERIC(5, 2) NOT NULL DEFAULT 100.00,
    success_rate          NUMERIC(4, 3) NOT NULL DEFAULT 1.000,
    retry_count_last_hour INTEGER NOT NULL DEFAULT 0,
    last_run_at           TIMESTAMPTZ,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT integration_connections_status_chk CHECK (
        status IN ('active', 'paused', 'failed', 'retrying', 'degraded')
    ),
    CONSTRAINT integration_connections_type_chk CHECK (
        integration_type IN ('api', 'file', 'streaming', 'database_replication', 'event_driven')
    ),
    CONSTRAINT integration_connections_availability_chk CHECK (availability_pct BETWEEN 0 AND 100),
    CONSTRAINT integration_connections_success_chk CHECK (success_rate BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS integration_connections_tenant_status_idx
    ON app_iam.integration_connections(tenant_id, status);
CREATE INDEX IF NOT EXISTS integration_connections_source_idx
    ON app_iam.integration_connections(source_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. integration_executions — execution log
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.integration_executions (
    execution_id          TEXT PRIMARY KEY,
    connection_id         TEXT NOT NULL REFERENCES app_iam.integration_connections(connection_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    status                TEXT NOT NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at           TIMESTAMPTZ,
    duration_ms           BIGINT NOT NULL DEFAULT 0,
    records_processed     BIGINT NOT NULL DEFAULT 0,
    records_failed        BIGINT NOT NULL DEFAULT 0,
    error_message         TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT integration_executions_status_chk CHECK (
        status IN ('success', 'failure', 'partial', 'running', 'queued')
    ),
    CONSTRAINT integration_executions_finished_chk CHECK (
        finished_at IS NULL OR finished_at >= started_at
    )
);

CREATE INDEX IF NOT EXISTS integration_executions_connection_idx
    ON app_iam.integration_executions(connection_id, started_at DESC);
CREATE INDEX IF NOT EXISTS integration_executions_tenant_status_idx
    ON app_iam.integration_executions(tenant_id, status, started_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. data_pipelines — pipeline definitions
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.data_pipelines (
    pipeline_id           TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name                  TEXT NOT NULL,
    domain                TEXT NOT NULL,
    description           TEXT,
    status                TEXT NOT NULL DEFAULT 'idle',
    schedule_cron         TEXT NOT NULL DEFAULT 'manual',
    source_ids            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    target_ids            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    owner                 TEXT NOT NULL,
    sla_minutes           INTEGER NOT NULL DEFAULT 60,
    last_run_at           TIMESTAMPTZ,
    next_run_at           TIMESTAMPTZ,
    success_rate_30d      NUMERIC(4, 3) NOT NULL DEFAULT 1.000,
    tags                  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT data_pipelines_domain_chk CHECK (domain IN ('banking', 'insurance', 'common')),
    CONSTRAINT data_pipelines_status_chk CHECK (
        status IN ('idle', 'scheduled', 'running', 'paused', 'failed', 'success')
    ),
    CONSTRAINT data_pipelines_sla_chk CHECK (sla_minutes >= 1),
    CONSTRAINT data_pipelines_success_chk CHECK (success_rate_30d BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS data_pipelines_tenant_status_idx
    ON app_iam.data_pipelines(tenant_id, status);
CREATE INDEX IF NOT EXISTS data_pipelines_next_run_idx
    ON app_iam.data_pipelines(tenant_id, next_run_at)
    WHERE status IN ('scheduled', 'idle');

-- ───────────────────────────────────────────────────────────────────────────
-- 5. pipeline_runs — pipeline run log
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.pipeline_runs (
    run_id                TEXT PRIMARY KEY,
    pipeline_id           TEXT NOT NULL REFERENCES app_iam.data_pipelines(pipeline_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    status                TEXT NOT NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at           TIMESTAMPTZ,
    duration_ms           BIGINT NOT NULL DEFAULT 0,
    records_in            BIGINT NOT NULL DEFAULT 0,
    records_out           BIGINT NOT NULL DEFAULT 0,
    records_failed        BIGINT NOT NULL DEFAULT 0,
    sla_met               BOOLEAN NOT NULL DEFAULT TRUE,
    trigger               TEXT NOT NULL DEFAULT 'scheduled',
    error_summary         TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT pipeline_runs_status_chk CHECK (
        status IN ('success', 'failure', 'partial', 'running', 'queued')
    ),
    CONSTRAINT pipeline_runs_trigger_chk CHECK (trigger IN ('manual', 'scheduled', 'retry'))
);

CREATE INDEX IF NOT EXISTS pipeline_runs_pipeline_idx
    ON app_iam.pipeline_runs(pipeline_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_runs_tenant_status_idx
    ON app_iam.pipeline_runs(tenant_id, status, started_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. metadata_catalog — business glossary + data dictionary
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.metadata_catalog (
    entry_id              TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    entry_kind            TEXT NOT NULL,
    source_id             TEXT REFERENCES app_iam.data_sources(source_id) ON DELETE SET NULL,
    field_name            TEXT,
    term                  TEXT,
    definition            TEXT NOT NULL,
    data_type             TEXT,
    nullable              BOOLEAN,
    classification        TEXT,
    is_pii                BOOLEAN NOT NULL DEFAULT FALSE,
    is_critical_data_element BOOLEAN NOT NULL DEFAULT FALSE,
    is_regulatory         BOOLEAN NOT NULL DEFAULT FALSE,
    sample_value          TEXT,
    domain                TEXT,
    owner                 TEXT NOT NULL,
    steward               TEXT,
    related_entry_ids     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT metadata_catalog_kind_chk CHECK (entry_kind IN ('glossary_term', 'dictionary_entry')),
    CONSTRAINT metadata_catalog_classification_chk CHECK (
        classification IS NULL OR classification IN
            ('public', 'internal', 'confidential', 'restricted', 'pii', 'pci', 'phi', 'regulatory')
    ),
    CONSTRAINT metadata_catalog_domain_chk CHECK (
        domain IS NULL OR domain IN ('banking', 'insurance', 'common')
    )
);

CREATE INDEX IF NOT EXISTS metadata_catalog_tenant_kind_idx
    ON app_iam.metadata_catalog(tenant_id, entry_kind);
CREATE INDEX IF NOT EXISTS metadata_catalog_pii_idx
    ON app_iam.metadata_catalog(tenant_id) WHERE is_pii = TRUE;
CREATE INDEX IF NOT EXISTS metadata_catalog_source_idx
    ON app_iam.metadata_catalog(source_id) WHERE source_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. data_lineage — lineage graph (nodes + edges as denormalised rows)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.data_lineage (
    edge_id               BIGSERIAL PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    from_node             TEXT NOT NULL,
    to_node               TEXT NOT NULL,
    from_kind             TEXT NOT NULL,
    to_kind               TEXT NOT NULL,
    transformation        TEXT,
    edge_kind             TEXT NOT NULL DEFAULT 'batch',
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT data_lineage_edge_kind_chk CHECK (edge_kind IN ('realtime', 'batch', 'manual')),
    CONSTRAINT data_lineage_node_kind_chk CHECK (
        from_kind IN ('source', 'transformation', 'data_quality', 'risk_engine', 'ai_model', 'dashboard', 'report')
        AND to_kind IN ('source', 'transformation', 'data_quality', 'risk_engine', 'ai_model', 'dashboard', 'report')
    )
);

CREATE INDEX IF NOT EXISTS data_lineage_tenant_from_idx
    ON app_iam.data_lineage(tenant_id, from_node);
CREATE INDEX IF NOT EXISTS data_lineage_tenant_to_idx
    ON app_iam.data_lineage(tenant_id, to_node);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. data_governance — policies
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.data_governance (
    policy_id             TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name                  TEXT NOT NULL,
    policy_kind           TEXT NOT NULL,
    description           TEXT,
    applies_to_classification TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    retention_days        INTEGER,
    approver              TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'active',
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT data_governance_kind_chk CHECK (
        policy_kind IN ('retention', 'access', 'classification', 'masking', 'anonymization')
    ),
    CONSTRAINT data_governance_status_chk CHECK (status IN ('active', 'draft', 'retired'))
);

CREATE INDEX IF NOT EXISTS data_governance_tenant_kind_idx
    ON app_iam.data_governance(tenant_id, policy_kind, status);

-- ───────────────────────────────────────────────────────────────────────────
-- 9. data_quality_metrics — 6-dimension quality scores
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.data_quality_metrics (
    metric_id             BIGSERIAL PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    source_id             TEXT NOT NULL REFERENCES app_iam.data_sources(source_id) ON DELETE CASCADE,
    dimension             TEXT NOT NULL,
    score                 NUMERIC(5, 2) NOT NULL,
    target                NUMERIC(5, 2) NOT NULL DEFAULT 85.00,
    band                  TEXT NOT NULL,
    failed_records        INTEGER NOT NULL DEFAULT 0,
    profiled_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT data_quality_metrics_dimension_chk CHECK (
        dimension IN ('completeness', 'accuracy', 'consistency', 'validity', 'timeliness', 'uniqueness')
    ),
    CONSTRAINT data_quality_metrics_band_chk CHECK (
        band IN ('excellent', 'good', 'fair', 'poor', 'critical')
    ),
    CONSTRAINT data_quality_metrics_score_chk CHECK (score BETWEEN 0 AND 100),
    CONSTRAINT data_quality_metrics_target_chk CHECK (target BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS data_quality_metrics_source_dim_idx
    ON app_iam.data_quality_metrics(source_id, dimension, profiled_at DESC);
CREATE INDEX IF NOT EXISTS data_quality_metrics_tenant_band_idx
    ON app_iam.data_quality_metrics(tenant_id, band, profiled_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 10. data_observability_events — freshness / volume / schema / drift events
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.data_observability_events (
    event_id              TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    source_id             TEXT NOT NULL REFERENCES app_iam.data_sources(source_id) ON DELETE CASCADE,
    kind                  TEXT NOT NULL,
    severity              TEXT NOT NULL DEFAULT 'info',
    title                 TEXT NOT NULL,
    description           TEXT,
    metric_value          NUMERIC(14, 4),
    threshold             NUMERIC(14, 4),
    owner                 TEXT NOT NULL,
    detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at           TIMESTAMPTZ,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT data_observability_events_kind_chk CHECK (
        kind IN ('freshness_lag', 'volume_anomaly', 'schema_change', 'failed_load',
                 'pipeline_latency_spike', 'data_drift', 'quality_degradation')
    ),
    CONSTRAINT data_observability_events_severity_chk CHECK (severity IN ('info', 'warning', 'critical')),
    CONSTRAINT data_observability_events_resolved_chk CHECK (
        resolved_at IS NULL OR resolved_at >= detected_at
    )
);

CREATE INDEX IF NOT EXISTS data_observability_events_open_idx
    ON app_iam.data_observability_events(tenant_id, severity, detected_at DESC)
    WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS data_observability_events_source_idx
    ON app_iam.data_observability_events(source_id, detected_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 11. ai_data_readiness — per-dataset readiness for AI workloads
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_data_readiness (
    dataset_id            TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    dataset_name          TEXT NOT NULL,
    purpose               TEXT NOT NULL,
    model_id              TEXT NOT NULL,
    model_label           TEXT NOT NULL,
    features_available    INTEGER NOT NULL DEFAULT 0,
    features_required     INTEGER NOT NULL DEFAULT 0,
    features_fresh        INTEGER NOT NULL DEFAULT 0,
    feature_availability_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    feature_freshness_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    quality_score         NUMERIC(5, 2) NOT NULL DEFAULT 0,
    input_validation_pass_rate NUMERIC(4, 3) NOT NULL DEFAULT 1.000,
    readiness_state       TEXT NOT NULL DEFAULT 'ready',
    last_evaluated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT ai_data_readiness_purpose_chk CHECK (
        purpose IN ('training', 'inference', 'validation')
    ),
    CONSTRAINT ai_data_readiness_state_chk CHECK (
        readiness_state IN ('ready', 'degraded', 'unavailable')
    ),
    CONSTRAINT ai_data_readiness_pct_chk CHECK (
        feature_availability_pct BETWEEN 0 AND 100
        AND feature_freshness_pct BETWEEN 0 AND 100
        AND quality_score BETWEEN 0 AND 100
        AND input_validation_pass_rate BETWEEN 0 AND 1
    )
);

CREATE INDEX IF NOT EXISTS ai_data_readiness_tenant_state_idx
    ON app_iam.ai_data_readiness(tenant_id, readiness_state, last_evaluated_at DESC);
CREATE INDEX IF NOT EXISTS ai_data_readiness_model_idx
    ON app_iam.ai_data_readiness(model_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Touch triggers
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_iam.data_sources_touch()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'data_sources_touch_updated_at') THEN
        CREATE TRIGGER data_sources_touch_updated_at
        BEFORE UPDATE ON app_iam.data_sources
        FOR EACH ROW EXECUTE FUNCTION app_iam.data_sources_touch();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'data_pipelines_touch_updated_at') THEN
        CREATE TRIGGER data_pipelines_touch_updated_at
        BEFORE UPDATE ON app_iam.data_pipelines
        FOR EACH ROW EXECUTE FUNCTION app_iam.data_sources_touch();
    END IF;
END $$;
