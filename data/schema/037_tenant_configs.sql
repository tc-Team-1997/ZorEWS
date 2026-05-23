-- 037_tenant_configs.sql
-- Local-additive migration. Backward-compatible.
-- Persists tenant-scoped admin config overrides (the M13 admin_config store).
-- Currently lives only in `services/bff/src/admin_config.ts` InMemoryConfigStore.
-- This migration provides the pg-backed swap target without touching existing in-memory tests.
-- NO existing tables modified. NO existing data touched.

BEGIN;

-- ============================================================================
-- tenant_configs — per-tenant overrides for the 13 platform default keys (M13.1)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_admin.tenant_configs (
  tenant_id      TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  config_key     TEXT         NOT NULL,                       -- e.g. 'alerts.red_sla_hours', 'features.maker_checker_enabled'
  value_type     TEXT         NOT NULL CHECK (value_type IN ('number','string','boolean','json')),
  value          JSONB        NOT NULL,                       -- typed value serialized into JSONB
  category       TEXT         NOT NULL CHECK (category IN ('alerts','notifications','reporting','scoring','features')),
  is_default     BOOLEAN      NOT NULL DEFAULT false,         -- true when explicit override matches platform default
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by     TEXT         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,                                 -- soft delete
  PRIMARY KEY (tenant_id, config_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_configs_category
  ON app_admin.tenant_configs (tenant_id, category)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_configs_recently_updated
  ON app_admin.tenant_configs (tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE app_admin.tenant_configs IS
'Pg-backed mirror of services/bff/src/admin_config.ts InMemoryConfigStore. M13.1+ admin config persistence. The PLATFORM defaults stay in code (DEFAULTS array); only TENANT OVERRIDES live in this table.';

COMMENT ON COLUMN app_admin.tenant_configs.value IS
'JSONB serialization of the typed value. Reading code must coerce via value_type column. Example: {"value": 24} for number, {"value": "alice@example.com"} for string, {"value": true} for boolean, {"value": {"k": "v"}} for json.';

-- BEFORE-UPDATE trigger keeps updated_at fresh
CREATE OR REPLACE FUNCTION app_admin.tenant_configs_touch_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_configs_updated_at ON app_admin.tenant_configs;
CREATE TRIGGER trg_tenant_configs_updated_at
  BEFORE UPDATE ON app_admin.tenant_configs
  FOR EACH ROW EXECUTE FUNCTION app_admin.tenant_configs_touch_updated_at();

COMMIT;
