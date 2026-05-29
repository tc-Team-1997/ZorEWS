-- 047_case_type_config.sql
-- Local-additive migration. Backward-compatible.
-- Master Setup — Case Management Setup (MASTER SETUP spec screen #13).
-- Per-tenant master of CASE TYPES, each with a default priority (P1-P4),
-- an SLA in hours (time-to-resolve), and a default assigned team. When the
-- CMS opens a case of a given type these defaults seed priority + SLA + queue.
-- Distinct from app_bff.sla_config (a single GLOBAL sla config) and the
-- reassign_teams master (team vocabulary the assigned_team string references).
-- The BFF runs an in-memory store today (services/bff/src/case_type_config.ts);
-- this table is the env-gated pg-backed swap target.
-- NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- case_type_config — per-tenant case-type catalogue
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.case_type_config (
  case_type_id   TEXT         PRIMARY KEY,                  -- cty-<tenant>-<seq>
  tenant_id      TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  code           TEXT         NOT NULL,                      -- uppercase A-Z0-9_ , unique per tenant
  name           TEXT         NOT NULL,
  description    TEXT,
  priority       TEXT         NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  sla_hours      NUMERIC(8,2) NOT NULL CHECK (sla_hours > 0 AND sla_hours <= 8760),
  assigned_team  TEXT         NOT NULL,
  enabled        BOOLEAN      NOT NULL DEFAULT true,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  created_by     TEXT         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Hot path: tenant-scoped list filtered by priority, ordered for the UI.
CREATE INDEX IF NOT EXISTS idx_case_type_config_tenant_priority
  ON app_copilot.case_type_config (tenant_id, priority, sort_order);

COMMENT ON TABLE app_copilot.case_type_config IS
'Master Setup screen #13 — per-tenant case-type catalogue (priority / SLA hours / assigned team). Seeds CMS case defaults. In-memory in prototype; env-gated pg-backed swap target.';

COMMIT;
