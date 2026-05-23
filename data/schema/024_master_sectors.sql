-- data/schema/024_master_sectors.sql
--
-- Phase A.1 — Sector & Industry Master Setup (PDF §6 Master Setup item 4).
--
-- Tenant-scoped master-data table for industry sectors. The BFF
-- in-memory store (services/bff/src/master/sector_master.ts) is the
-- runtime source of truth; this migration documents the production
-- target schema so the pg-backed swap is mechanical (same pattern
-- as M3.1 / M13.1 / M16.4 — prototype runs in-memory, schema is
-- forward-looking).
--
-- Design notes:
--   * sector_id is a tenant-scoped natural key (e.g. AGRICULTURE,
--     MANUFACTURING). Format ^[A-Z][A-Z0-9_]{1,47}$ enforced at the
--     application layer (not in CHECK so future relaxation doesn't
--     require a migration).
--   * risk_weight ∈ (0, 1] mirrors M6.2 indicator weight semantics so
--     the value is interchangeable with scoring inputs without a
--     scaling step.
--   * regulatory_category is a closed enum at the app layer; not a
--     PG ENUM since adding values to a PG ENUM requires a migration.
--   * Soft-delete via deleted_at/_by — Recovery Center adapter
--     re-inserts on restore. The row itself stays in this table; the
--     archive copy is in app_recovery.deleted_records.
--   * Audit fields baked in: created_at/_by, updated_at/_by, deleted_at/_by.
--   * Tenant isolation via FK + the (tenant_id, sector_id) UNIQUE
--     constraint — the same sector_id can exist in two tenants as
--     two independent rows.
--
-- Apply order: AFTER 005 (app_iam.tenants exists) and 023 (recovery store).

CREATE SCHEMA IF NOT EXISTS app_master;

CREATE TABLE IF NOT EXISTS app_master.sectors (
    sector_id            TEXT         NOT NULL,
    tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    sector_name          TEXT         NOT NULL,
    risk_weight          NUMERIC(4,3) NOT NULL CHECK (risk_weight > 0 AND risk_weight <= 1),
    regulatory_category  TEXT         NOT NULL,
    description          TEXT         NULL,
    active               BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by           TEXT         NOT NULL,
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by           TEXT         NOT NULL,
    deleted_at           TIMESTAMPTZ  NULL,
    deleted_by           TEXT         NULL,
    -- Natural key is (tenant_id, sector_id). Using PRIMARY KEY here
    -- so Recovery Center restores via UPSERT can target it cleanly.
    PRIMARY KEY (tenant_id, sector_id),
    CHECK (length(sector_name) > 0 AND length(sector_name) <= 200),
    CHECK (description IS NULL OR length(description) <= 1000),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

-- Hot path 1: SPA admin master-data list filtered to live rows.
CREATE INDEX IF NOT EXISTS sectors_tenant_active_idx
    ON app_master.sectors (tenant_id, active)
    WHERE deleted_at IS NULL;

-- Hot path 2: sector-risk dashboard aggregating by category.
CREATE INDEX IF NOT EXISTS sectors_tenant_category_idx
    ON app_master.sectors (tenant_id, regulatory_category)
    WHERE deleted_at IS NULL;

-- Hot path 3: Recovery Center filter (audit "what was recently deleted
-- in this tenant?").
CREATE INDEX IF NOT EXISTS sectors_tenant_deleted_idx
    ON app_master.sectors (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE app_master.sectors IS
    'Phase A.1 Sector & Industry Master Setup. Tenant-scoped master-data '
    'table for industry sectors. risk_weight ∈ (0, 1] interchangeable with '
    'M6.2 scoring inputs. Soft-delete via deleted_at/_by; Recovery Center '
    'adapter (entity_type=sector_master) re-inserts on restore.';
