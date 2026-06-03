-- data/schema/065_event_streaming_center.sql
-- Real-Time Event Streaming Center — additive schema (Phase 22 IA overlay).
-- 8 additive tables for event streaming lifecycle management.
-- Idempotent: CREATE TABLE IF NOT EXISTS on every object.
-- Zero changes to any existing tables.

CREATE TABLE IF NOT EXISTS app_iam.event_topics (
    topic_id           TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    topic_name         TEXT NOT NULL,
    category           TEXT NOT NULL CHECK (category IN ('risk','case','investigation','compliance','ai','governance')),
    publisher_module   TEXT NOT NULL,
    partition_count    INTEGER NOT NULL DEFAULT 4,
    replication_factor INTEGER NOT NULL DEFAULT 3,
    retention_hours    INTEGER NOT NULL DEFAULT 168,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deprecated')),
    schema_version     TEXT NOT NULL DEFAULT 'v1.0.0',
    compression        TEXT NOT NULL DEFAULT 'gzip' CHECK (compression IN ('gzip','lz4','none')),
    events_per_day     BIGINT NOT NULL DEFAULT 0,
    subscribers_count  INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, topic_name)
);

CREATE TABLE IF NOT EXISTS app_iam.event_publishers (
    publisher_id       TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    module_name        TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','degraded','offline')),
    events_published   BIGINT NOT NULL DEFAULT 0,
    success_count      BIGINT NOT NULL DEFAULT 0,
    failure_count      BIGINT NOT NULL DEFAULT 0,
    avg_publish_ms     INTEGER,
    last_event_at      TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.event_subscribers (
    subscriber_id      TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    subscriber_name    TEXT NOT NULL,
    consumer_group     TEXT NOT NULL,
    delivery_status    TEXT NOT NULL DEFAULT 'healthy' CHECK (delivery_status IN ('healthy','degraded','failed','lagging')),
    events_consumed    BIGINT NOT NULL DEFAULT 0,
    lag_messages       INTEGER NOT NULL DEFAULT 0,
    avg_processing_ms  INTEGER,
    retry_count        INTEGER NOT NULL DEFAULT 0,
    last_consumed_at   TIMESTAMPTZ,
    is_active          BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.event_subscriber_topics (
    id                 BIGSERIAL PRIMARY KEY,
    subscriber_id      TEXT NOT NULL REFERENCES app_iam.event_subscribers(subscriber_id) ON DELETE CASCADE,
    topic_id           TEXT NOT NULL REFERENCES app_iam.event_topics(topic_id) ON DELETE CASCADE,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    UNIQUE(subscriber_id, topic_id)
);

CREATE TABLE IF NOT EXISTS app_iam.event_replay_jobs (
    job_id             TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    replay_type        TEXT NOT NULL CHECK (replay_type IN ('single','batch','topic')),
    topic_id           TEXT REFERENCES app_iam.event_topics(topic_id) ON DELETE SET NULL,
    event_count        BIGINT NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_progress','completed','failed')),
    requested_by       TEXT NOT NULL,
    target_consumer_group TEXT NOT NULL,
    reason             TEXT,
    requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    duration_ms        BIGINT,
    error_message      TEXT
);

CREATE TABLE IF NOT EXISTS app_iam.event_dlq (
    dlq_id             TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    original_event_id  TEXT NOT NULL,
    event_type         TEXT NOT NULL,
    topic_id           TEXT REFERENCES app_iam.event_topics(topic_id) ON DELETE SET NULL,
    publisher_module   TEXT NOT NULL,
    failure_reason     TEXT NOT NULL,
    error_code         TEXT NOT NULL,
    retry_count        INTEGER NOT NULL DEFAULT 0,
    max_retries        INTEGER NOT NULL DEFAULT 5,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retrying','resolved','abandoned')),
    payload_size_bytes INTEGER,
    first_failure_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_retry_at      TIMESTAMPTZ,
    recovery_action    TEXT
);

CREATE TABLE IF NOT EXISTS app_iam.stream_processors (
    processor_id       TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name               TEXT NOT NULL,
    processor_type     TEXT NOT NULL CHECK (processor_type IN ('aggregation','correlation','pattern_detection','risk_enrichment')),
    status             TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','error')),
    events_processed   BIGINT NOT NULL DEFAULT 0,
    patterns_detected  INTEGER NOT NULL DEFAULT 0,
    alerts_generated   INTEGER NOT NULL DEFAULT 0,
    avg_processing_ms  INTEGER,
    output_topic_id    TEXT REFERENCES app_iam.event_topics(topic_id) ON DELETE SET NULL,
    description        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_iam.event_bus_metrics (
    metric_id          BIGSERIAL PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    events_per_minute  INTEGER NOT NULL DEFAULT 0,
    throughput_per_sec INTEGER NOT NULL DEFAULT 0,
    total_events       BIGINT NOT NULL DEFAULT 0,
    failed_events      BIGINT NOT NULL DEFAULT 0,
    retry_queue_size   INTEGER NOT NULL DEFAULT 0,
    dlq_size           INTEGER NOT NULL DEFAULT 0,
    avg_latency_ms     INTEGER NOT NULL DEFAULT 0,
    p95_latency_ms     INTEGER NOT NULL DEFAULT 0,
    p99_latency_ms     INTEGER NOT NULL DEFAULT 0,
    active_topics      INTEGER NOT NULL DEFAULT 0,
    active_publishers  INTEGER NOT NULL DEFAULT 0,
    active_subscribers INTEGER NOT NULL DEFAULT 0
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_event_topics_tenant ON app_iam.event_topics(tenant_id, category, status);
CREATE INDEX IF NOT EXISTS idx_event_publishers_tenant ON app_iam.event_publishers(tenant_id, status, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_subscribers_tenant ON app_iam.event_subscribers(tenant_id, delivery_status, is_active);
CREATE INDEX IF NOT EXISTS idx_event_replay_jobs_tenant ON app_iam.event_replay_jobs(tenant_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dlq_tenant ON app_iam.event_dlq(tenant_id, status, first_failure_at DESC);
CREATE INDEX IF NOT EXISTS idx_stream_processors_tenant ON app_iam.stream_processors(tenant_id, processor_type, status);
CREATE INDEX IF NOT EXISTS idx_bus_metrics_tenant ON app_iam.event_bus_metrics(tenant_id, recorded_at DESC);
