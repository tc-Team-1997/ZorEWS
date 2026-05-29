-- 045_risk_score_config.sql
-- Local-additive migration. Backward-compatible.
-- Master Setup — Risk Score Configuration (MASTER SETUP spec screen #11).
-- A per-tenant set of NAMED scoring FACTORS, each carrying a percentage
-- weight. The composite risk score is Σ(factor.weight_pct × factor signal),
-- so the ENABLED factors of a domain are expected to sum to 100%.
-- Distinct from app_copilot.weight_presets (per-INDICATOR multipliers) —
-- this is high-level factor-grain (Overdue / EMI Bounce / Bureau Score …).
-- The BFF runs an in-memory store today (services/bff/src/risk_score_config.ts);
-- this table is the env-gated pg-backed swap target.
-- NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- risk_score_factors — named scoring factors with percentage weights
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.risk_score_factors (
  factor_id     TEXT         PRIMARY KEY,                    -- rsf-<tenant>-<seq>
  tenant_id     TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  code          TEXT         NOT NULL,                       -- uppercase A-Z0-9_ , unique per tenant
  name          TEXT         NOT NULL,
  description   TEXT,
  domain        TEXT         NOT NULL CHECK (domain IN ('banking','insurance','both')),
  weight_pct    NUMERIC(6,2) NOT NULL CHECK (weight_pct >= 0 AND weight_pct <= 100),
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  created_by    TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Hot path: tenant-scoped list filtered by domain, ordered for the UI.
CREATE INDEX IF NOT EXISTS idx_risk_score_factors_tenant_domain
  ON app_copilot.risk_score_factors (tenant_id, domain, sort_order);

COMMENT ON TABLE app_copilot.risk_score_factors IS
'Master Setup screen #11 — named risk-score factors with percentage weights (enabled factors per domain sum to 100%). Factor-grain config surface; distinct from per-indicator weight presets. In-memory in prototype; env-gated pg-backed swap target.';

COMMIT;
