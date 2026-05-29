-- 044_ai_hybrid_rules.sql
-- Local-additive migration. Backward-compatible.
-- T7 AI Rule + ML Hybrid Support — ARCHITECTURE ONLY (per spec).
-- Stores hybrid rule DEFINITIONS combining a deterministic metric condition
-- with an AI-score threshold, e.g.:
--   IF DPD > 90 AND ai_score(pd_xgb_v3) > 0.82 THEN CREATE CRITICAL ALERT
-- This is the authoring/config surface a FUTURE orchestrator would consume —
-- no live alert-firing engine is wired here. The BFF runs an in-memory store
-- today (services/bff/src/ai_hybrid_rules.ts); this table is the env-gated
-- pg-backed swap target. NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- ai_hybrid_rules — hybrid (metric + AI-score) rule definitions
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.ai_hybrid_rules (
  rule_id       TEXT         PRIMARY KEY,                    -- hyb-<tenant>-<YYYY-MM-DD>-<seq>
  tenant_id     TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  name          TEXT         NOT NULL,
  description   TEXT,
  domain        TEXT         NOT NULL CHECK (domain IN ('banking','insurance')),
  logic         TEXT         NOT NULL CHECK (logic IN ('AND','OR')),
  -- conditions[]: {kind:'metric', field, op, value} | {kind:'ai_score', model_ref, op, threshold}
  conditions    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  action        TEXT         NOT NULL CHECK (action IN ('create_alert','open_case','notify','escalate')),
  severity      TEXT         NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  status        TEXT         NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','disabled')),
  created_by    TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ                                  -- soft delete
);

-- Hot path: tenant-scoped list with optional domain/status filters.
CREATE INDEX IF NOT EXISTS idx_ai_hybrid_tenant_status
  ON app_copilot.ai_hybrid_rules (tenant_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_hybrid_tenant_domain
  ON app_copilot.ai_hybrid_rules (tenant_id, domain, updated_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE app_copilot.ai_hybrid_rules IS
'T7 AI rule + ML hybrid rule definitions (metric condition + AI-score threshold → action). Architecture/authoring surface only — no live orchestrator. In-memory in prototype; env-gated pg-backed swap target.';

COMMIT;
