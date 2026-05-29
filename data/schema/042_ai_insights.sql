-- 042_ai_insights.sql
-- Local-additive migration. Backward-compatible.
-- T7 Module 9 — AI Insight Panels. Persists the unified cross-domain AI
-- insight feed (top risky borrowers, fraud anomaly highlights, lapse
-- insights, persistency risk, claim-fraud highlights, unusual trends) under
-- one AiInsight contract. The BFF synthesises these deterministically today
-- (services/bff/src/ai_insights.ts); this table is the env-gated pg-backed
-- swap target where materialised insight snapshots would land.
-- NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- ai_insights — one row per generated insight panel (per tenant per cycle)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.ai_insights (
  insight_row_id  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  insight_id      TEXT         NOT NULL,                    -- catalog id: top_risky_borrowers, fraud_anomaly_highlights, …
  title           TEXT         NOT NULL,
  description     TEXT,
  category        TEXT         NOT NULL CHECK (category IN ('risk','fraud','retention','trend')),
  domain          TEXT         NOT NULL CHECK (domain IN ('banking','insurance','cross')),
  severity        TEXT         NOT NULL CHECK (severity IN ('critical','high','medium','info')),
  model_ref       TEXT         NOT NULL,                    -- the model/signal powering the insight
  confidence      NUMERIC(5,4) NOT NULL DEFAULT 0,          -- 0..1
  headline        TEXT,
  item_count      INTEGER      NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  -- ranked items: {entity_id, entity_label, score, score_label, reason, trend, delta}[]
  items           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  generated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ                               -- soft delete
);

-- Hot path: tenant-scoped, latest insight per catalog id.
CREATE INDEX IF NOT EXISTS idx_ai_insights_tenant_insight_time
  ON app_copilot.ai_insights (tenant_id, insight_id, generated_at DESC)
  WHERE deleted_at IS NULL;

-- Feed roll-up by category/severity.
CREATE INDEX IF NOT EXISTS idx_ai_insights_tenant_cat_sev
  ON app_copilot.ai_insights (tenant_id, category, severity, generated_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE app_copilot.ai_insights IS
'T7 M9 AI insight panels — unified cross-domain insight feed (ranked items + reasons, powered by a named model/signal). Deterministically synthesised in prototype; this table is the env-gated pg-backed swap target.';

COMMIT;
