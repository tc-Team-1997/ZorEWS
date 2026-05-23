-- data/schema/026_dq_engine.sql
--
-- Phase A.3 — Data Quality (DQ) Engine (PDF §6 Ecosystem item E5).
--
-- Two tables: rules (CRUD master) + executions (append-only history).
-- Runtime is in-memory per prototype convention; schema documents the
-- pg-backed swap target.
--
-- Apply order: AFTER 005 (app_iam.tenants) and 023 (recovery store).

CREATE SCHEMA IF NOT EXISTS app_dq;

CREATE TABLE IF NOT EXISTS app_dq.rules (
    rule_id           TEXT         NOT NULL,
    tenant_id         TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name              TEXT         NOT NULL,
    description       TEXT         NULL,
    table_name        TEXT         NOT NULL,
    column_name       TEXT         NOT NULL,
    kind              TEXT         NOT NULL CHECK (kind IN (
        'not_null', 'unique', 'range', 'regex', 'enum', 'freshness'
    )),
    config            JSONB        NOT NULL DEFAULT '{}'::jsonb,
    severity          TEXT         NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('high', 'medium', 'low')),
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by        TEXT         NOT NULL,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by        TEXT         NOT NULL,
    deleted_at        TIMESTAMPTZ  NULL,
    deleted_by        TEXT         NULL,
    PRIMARY KEY (tenant_id, rule_id),
    CHECK (rule_id ~ '^[a-z][a-z0-9_]{2,63}$'),
    CHECK (length(name) BETWEEN 1 AND 200),
    CHECK (description IS NULL OR length(description) <= 1000),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

-- Hot paths: dashboard rollup by kind + severity; lookup-by-table for
-- ingestion-time integration; Recovery list of tombstoned rows.
CREATE INDEX IF NOT EXISTS dq_rules_tenant_kind_idx
    ON app_dq.rules (tenant_id, kind, severity)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS dq_rules_tenant_table_idx
    ON app_dq.rules (tenant_id, table_name)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS dq_rules_tenant_deleted_idx
    ON app_dq.rules (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_dq.executions (
    execution_id       TEXT         PRIMARY KEY,
    tenant_id          TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    rule_id            TEXT         NOT NULL,
    rule_kind          TEXT         NOT NULL,
    rule_severity      TEXT         NOT NULL,
    started_at         TIMESTAMPTZ  NOT NULL,
    finished_at        TIMESTAMPTZ  NOT NULL,
    status             TEXT         NOT NULL CHECK (status IN (
        'running', 'passed', 'failed', 'error'
    )),
    total_records      INTEGER      NOT NULL DEFAULT 0,
    passed_records     INTEGER      NOT NULL DEFAULT 0,
    failed_records     INTEGER      NOT NULL DEFAULT 0,
    error_message      TEXT         NULL,
    sample_failures    JSONB        NOT NULL DEFAULT '[]'::jsonb,
    triggered_by       TEXT         NOT NULL,
    FOREIGN KEY (tenant_id, rule_id) REFERENCES app_dq.rules (tenant_id, rule_id)
);

-- Hot paths: dashboard rollup (per rule, newest-first), tenant
-- isolation, status filter.
CREATE INDEX IF NOT EXISTS dq_executions_tenant_rule_idx
    ON app_dq.executions (tenant_id, rule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS dq_executions_tenant_status_idx
    ON app_dq.executions (tenant_id, status, started_at DESC);

COMMENT ON TABLE app_dq.rules IS
    'Phase A.3 — DQ Engine rule master. 6 kinds (not_null/unique/range/'
    'regex/enum/freshness). Soft-delete via deleted_at/_by; Recovery '
    'Center adapter entity_type=dq_rule re-inserts on restore.';

COMMENT ON TABLE app_dq.executions IS
    'Phase A.3 — DQ Engine execution history. Append-only audit trail; '
    'no soft-delete (kept for compliance evidence).';
