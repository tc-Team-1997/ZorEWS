-- 040_ai_experiments.sql
-- Local-additive migration. Backward-compatible.
-- T7 Module 10 — Experiment Tracking. Adds app_copilot.ai_experiments:
-- the pre-deployment ML experiment-run record (dataset / params / metrics /
-- outcome / owner) that FEEDS the M7.2 model-promotion decision.
-- Distinct from ai_predictions (per-customer inference) + model_versions
-- (deployed champions) added in 036_ai_persistence.sql.
-- The BFF runs an in-memory store today (services/bff/src/ai_experiments.ts);
-- this table is the production-swap target (env-gated, same as ai_predictions).
-- NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- ai_experiments — one row per ML experiment run
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.ai_experiments (
  experiment_id   TEXT         PRIMARY KEY,                  -- exp-<tenant>-<YYYY-MM-DD>-<seq>
  tenant_id       TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  name            TEXT         NOT NULL,
  domain          TEXT         NOT NULL CHECK (domain IN ('banking','insurance')),
  model_type      TEXT         NOT NULL,                     -- 'pd'|'fraud'|'churn'|'lapse'|'anomaly'|'claim_severity'
  status          TEXT         NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running','completed','failed','archived')),
  dataset_ref     TEXT         NOT NULL,                     -- e.g. 'mart.customer_360@2026-Q1'
  dataset_rows    INTEGER      NOT NULL DEFAULT 0 CHECK (dataset_rows >= 0),
  params          JSONB        NOT NULL DEFAULT '{}'::jsonb, -- flat hyper-parameter map
  metrics         JSONB        NOT NULL DEFAULT '{}'::jsonb, -- flat eval-metric map (auc/precision/recall/f1/brier…)
  outcome         TEXT         CHECK (outcome IN ('promoted','rejected','inconclusive')),  -- NULL until judged
  owner           TEXT         NOT NULL,
  notes           TEXT,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,                               -- set when status → completed|failed
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ                                -- soft delete
);

-- Hot path: tenant-scoped, newest-first list with optional status/domain/model_type filters.
CREATE INDEX IF NOT EXISTS idx_ai_exp_tenant_started
  ON app_copilot.ai_experiments (tenant_id, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_exp_tenant_status
  ON app_copilot.ai_experiments (tenant_id, status, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_exp_tenant_domain_type
  ON app_copilot.ai_experiments (tenant_id, domain, model_type, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_exp_tenant_owner
  ON app_copilot.ai_experiments (tenant_id, owner, started_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE app_copilot.ai_experiments IS
'T7 M10 experiment tracking — pre-deployment ML run record (dataset/params/metrics/outcome/owner). Feeds the M7.2 promotion decision. In-memory in prototype; this table is the env-gated pg-backed swap target.';

COMMIT;
