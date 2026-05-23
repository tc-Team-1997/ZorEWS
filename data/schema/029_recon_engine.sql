-- data/schema/027_recon_engine.sql
--
-- Phase A.4 — Reconciliation & Controls (PDF §6 Ecosystem item E12).
-- Same pattern as 026_dq_engine.sql: definitions (CRUD master) +
-- runs (append-only audit history).
--
-- Apply order: AFTER 005 (app_iam.tenants) and 023 (recovery store).

CREATE SCHEMA IF NOT EXISTS app_recon;

CREATE TABLE IF NOT EXISTS app_recon.definitions (
    recon_id          TEXT         NOT NULL,
    tenant_id         TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name              TEXT         NOT NULL,
    description       TEXT         NULL,
    source_label      TEXT         NOT NULL,
    target_label      TEXT         NOT NULL,
    kind              TEXT         NOT NULL CHECK (kind IN (
        'count_only', 'amount_match', 'set_diff'
    )),
    key_field         TEXT         NOT NULL,
    amount_field      TEXT         NULL,
    amount_tolerance  NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (amount_tolerance >= 0),
    severity          TEXT         NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('high', 'medium', 'low')),
    active            BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by        TEXT         NOT NULL,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by        TEXT         NOT NULL,
    deleted_at        TIMESTAMPTZ  NULL,
    deleted_by        TEXT         NULL,
    PRIMARY KEY (tenant_id, recon_id),
    CHECK (recon_id ~ '^[a-z][a-z0-9_]{2,63}$'),
    CHECK (length(name) BETWEEN 1 AND 200),
    CHECK (length(source_label) > 0 AND length(target_label) > 0),
    CHECK (description IS NULL OR length(description) <= 1000),
    -- When kind=amount_match, amount_field must be set.
    CHECK (
        kind <> 'amount_match' OR (amount_field IS NOT NULL AND length(amount_field) > 0)
    ),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS recon_defs_tenant_kind_idx
    ON app_recon.definitions (tenant_id, kind, severity)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS recon_defs_tenant_deleted_idx
    ON app_recon.definitions (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_recon.runs (
    run_id                TEXT         PRIMARY KEY,
    tenant_id             TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    recon_id              TEXT         NOT NULL,
    recon_kind            TEXT         NOT NULL,
    recon_severity        TEXT         NOT NULL,
    source_label          TEXT         NOT NULL,
    target_label          TEXT         NOT NULL,
    started_at            TIMESTAMPTZ  NOT NULL,
    finished_at           TIMESTAMPTZ  NOT NULL,
    status                TEXT         NOT NULL CHECK (status IN (
        'running', 'balanced', 'breaks_found', 'error'
    )),
    source_count          INTEGER      NOT NULL DEFAULT 0,
    target_count          INTEGER      NOT NULL DEFAULT 0,
    matched_count         INTEGER      NOT NULL DEFAULT 0,
    source_only_count     INTEGER      NOT NULL DEFAULT 0,
    target_only_count     INTEGER      NOT NULL DEFAULT 0,
    amount_mismatch_count INTEGER      NOT NULL DEFAULT 0,
    source_total          NUMERIC(20,4) NULL,
    target_total          NUMERIC(20,4) NULL,
    difference            NUMERIC(20,4) NULL,
    sample_breaks         JSONB        NOT NULL DEFAULT '[]'::jsonb,
    error_message         TEXT         NULL,
    triggered_by          TEXT         NOT NULL,
    FOREIGN KEY (tenant_id, recon_id) REFERENCES app_recon.definitions (tenant_id, recon_id)
);

CREATE INDEX IF NOT EXISTS recon_runs_tenant_recon_idx
    ON app_recon.runs (tenant_id, recon_id, started_at DESC);
CREATE INDEX IF NOT EXISTS recon_runs_tenant_status_idx
    ON app_recon.runs (tenant_id, status, started_at DESC);

COMMENT ON TABLE app_recon.definitions IS
    'Phase A.4 — Reconciliation definition master. 3 kinds (count_only/'
    'amount_match/set_diff). Soft-delete via deleted_at/_by; Recovery '
    'Center adapter entity_type=recon_definition re-inserts on restore.';

COMMENT ON TABLE app_recon.runs IS
    'Phase A.4 — Reconciliation run history. Append-only audit trail; '
    'no soft-delete (compliance evidence retention).';
