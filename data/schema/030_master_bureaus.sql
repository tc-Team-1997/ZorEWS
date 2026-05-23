-- data/schema/030_master_bureaus.sql
--
-- Phase B.2 — External Bureau Master (PDF §8 Master Setup item 6).
-- Per-tenant config for CIBIL/CRIF/EXPERIAN/EQUIFAX. Distinct from
-- M14.5 BureauAdapter (read-side report fetcher); this is the
-- WEIGHT/CONFIG layer used as a scoring overlay.
--
-- Apply order: AFTER 005 (app_iam.tenants) and 023 (recovery store).

CREATE SCHEMA IF NOT EXISTS app_master;

CREATE TABLE IF NOT EXISTS app_master.bureaus (
    bureau_id          TEXT         NOT NULL CHECK (bureau_id IN (
        'CIBIL', 'CRIF', 'EXPERIAN', 'EQUIFAX'
    )),
    tenant_id          TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    enabled            BOOLEAN      NOT NULL DEFAULT TRUE,
    score_weight       NUMERIC(4,3) NOT NULL CHECK (score_weight >= 0 AND score_weight <= 1),
    score_range_min    INTEGER      NOT NULL DEFAULT 300 CHECK (score_range_min >= 0),
    score_range_max    INTEGER      NOT NULL DEFAULT 900,
    contract_ref       TEXT         NULL,
    refresh_cadence    TEXT         NOT NULL DEFAULT 'daily' CHECK (refresh_cadence IN (
        'hourly', 'daily', 'weekly', 'monthly', 'on_demand'
    )),
    fallback_mode      BOOLEAN      NOT NULL DEFAULT FALSE,
    notes              TEXT         NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by         TEXT         NOT NULL,
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by         TEXT         NOT NULL,
    deleted_at         TIMESTAMPTZ  NULL,
    deleted_by         TEXT         NULL,
    PRIMARY KEY (tenant_id, bureau_id),
    CHECK (score_range_max > score_range_min),
    CHECK (contract_ref IS NULL OR length(contract_ref) <= 200),
    CHECK (notes IS NULL OR length(notes) <= 1000),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

-- Hot path 1: enabled-bureau lookup (M6.x overlay queries).
CREATE INDEX IF NOT EXISTS bureau_master_tenant_enabled_idx
    ON app_master.bureaus (tenant_id, enabled)
    WHERE deleted_at IS NULL AND enabled = TRUE;

-- Hot path 2: Recovery Center recently-deleted.
CREATE INDEX IF NOT EXISTS bureau_master_tenant_deleted_idx
    ON app_master.bureaus (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE app_master.bureaus IS
    'Phase B.2 — External Bureau Master config. Per-tenant CIBIL/CRIF/'
    'EXPERIAN/EQUIFAX setup with score weights for the M6.x scoring '
    'overlay. Soft-delete + Recovery (entity_type=bureau_master).';
