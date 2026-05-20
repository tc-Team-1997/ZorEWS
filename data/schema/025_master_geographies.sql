-- data/schema/025_master_geographies.sql
--
-- Phase A.2 — Geography & Risk Region Master Setup (PDF §7 Master Setup
-- item 5). Tenant-scoped master data for country / region risk +
-- sanction flags. Used by AML M14.3 + EWS scoring overlays. Same shape
-- as 024_master_sectors.sql (Phase A.1).
--
-- Design notes:
--   * country_code is ISO 3166-1 alpha-2 (IN, US, BT). Format enforced
--     at the application layer.
--   * risk_level closed enum (high/medium/low) — not PG ENUM since
--     adding values would require a migration.
--   * sanction_flag is a boolean overlay; M14.3 adapter consults this
--     in addition to upstream watchlist match probes.
--   * aml_regime closed enum (fatf_blacklist / fatf_greylist /
--     enhanced_due_diligence / standard / low_risk).
--   * Soft-delete via deleted_at/_by — Recovery Center adapter
--     re-inserts on restore.
--   * Audit fields baked in.
--
-- Apply order: AFTER 005 (app_iam.tenants) and 024 (sister table).

CREATE SCHEMA IF NOT EXISTS app_master;

CREATE TABLE IF NOT EXISTS app_master.geographies (
    country_code     TEXT         NOT NULL,
    tenant_id        TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    country_name     TEXT         NOT NULL,
    risk_level       TEXT         NOT NULL CHECK (risk_level IN ('high', 'medium', 'low')),
    sanction_flag    BOOLEAN      NOT NULL DEFAULT FALSE,
    aml_regime       TEXT         NOT NULL DEFAULT 'standard'
        CHECK (aml_regime IN ('fatf_blacklist', 'fatf_greylist', 'enhanced_due_diligence', 'standard', 'low_risk')),
    region           TEXT         NULL,
    notes            TEXT         NULL,
    active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by       TEXT         NOT NULL,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by       TEXT         NOT NULL,
    deleted_at       TIMESTAMPTZ  NULL,
    deleted_by       TEXT         NULL,
    PRIMARY KEY (tenant_id, country_code),
    CHECK (country_code ~ '^[A-Z]{2}$'),
    CHECK (length(country_name) BETWEEN 1 AND 120),
    CHECK (region IS NULL OR length(region) <= 80),
    CHECK (notes IS NULL OR length(notes) <= 1000),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

-- Hot path 1: SPA admin list (live + optional risk filter).
CREATE INDEX IF NOT EXISTS geographies_tenant_risk_idx
    ON app_master.geographies (tenant_id, risk_level)
    WHERE deleted_at IS NULL;

-- Hot path 2: AML M14.3 overlay query — "is this country sanctioned?"
CREATE INDEX IF NOT EXISTS geographies_tenant_sanction_idx
    ON app_master.geographies (tenant_id, sanction_flag)
    WHERE deleted_at IS NULL AND sanction_flag = TRUE;

-- Hot path 3: Recovery Center recently-deleted filter.
CREATE INDEX IF NOT EXISTS geographies_tenant_deleted_idx
    ON app_master.geographies (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE app_master.geographies IS
    'Phase A.2 Geography & Risk Region Master Setup. Tenant-scoped ' ||
    'master data for country risk + sanctions. Soft-delete via ' ||
    'deleted_at/_by; Recovery Center adapter (entity_type=geography_master) ' ||
    're-inserts on restore. Consumed by AML M14.3 + EWS scoring overlays.';
