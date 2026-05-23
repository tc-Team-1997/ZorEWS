-- 036_ai_persistence.sql
-- Local-additive migration. Backward-compatible.
-- Adds persistence for AI predictions, feedback, and model registry.
-- These were previously computed on-demand (ai-copilot-svc) or file-based (ml/registry/registry.json).
-- All tables follow the existing app_copilot conventions (UUID PK + tenant_id + created_at/by + soft delete).
-- NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- ai_predictions — persists every per-customer ML prediction
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.ai_predictions (
  prediction_id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  model_id          TEXT         NOT NULL,
  model_version     TEXT         NOT NULL,
  prediction_type   TEXT         NOT NULL,                    -- 'pd' | 'fraud' | 'churn' | 'lapse' | 'anomaly' | 'claim_severity'
  customer_id       TEXT,                                     -- nullable for cohort-level scoring
  value             NUMERIC(10,6),                            -- the predicted score (0..1 for probabilities)
  band              TEXT,                                     -- 'low'|'medium'|'high' or NULL
  confidence        NUMERIC(10,6),
  top_features      JSONB        NOT NULL DEFAULT '[]'::jsonb,-- SHAP-style {feature, value, shap_value, direction}[]
  input_snapshot    JSONB,                                    -- features used at prediction time
  generated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by        TEXT         NOT NULL DEFAULT 'system',
  deleted_at        TIMESTAMPTZ                               -- soft delete
);

CREATE INDEX IF NOT EXISTS idx_ai_pred_tenant_customer
  ON app_copilot.ai_predictions (tenant_id, customer_id, generated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_pred_tenant_model
  ON app_copilot.ai_predictions (tenant_id, model_id, model_version, generated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_pred_type
  ON app_copilot.ai_predictions (tenant_id, prediction_type, generated_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE app_copilot.ai_predictions IS
'Persisted ML predictions (T2.4 + M7.x). Each row = one model output. SHAP top-features inline as JSONB for backtesting + explainability replay.';

-- ============================================================================
-- ai_feedback — operator feedback on predictions (drives M7 model registry decisions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.ai_feedback (
  feedback_id       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  prediction_id     UUID         NOT NULL REFERENCES app_copilot.ai_predictions(prediction_id) ON DELETE CASCADE,
  feedback_type     TEXT         NOT NULL CHECK (feedback_type IN ('approve','reject','correct','escalate')),
  feedback_value    JSONB,                                    -- e.g. corrected band, observed outcome
  notes             TEXT,
  submitted_by      TEXT         NOT NULL,
  submitted_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_prediction
  ON app_copilot.ai_feedback (prediction_id, submitted_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_feedback_tenant_type
  ON app_copilot.ai_feedback (tenant_id, feedback_type, submitted_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE app_copilot.ai_feedback IS
'Operator feedback on AI predictions. Drives M7 model risk reviews + retraining signal selection.';

-- ============================================================================
-- model_versions — pg-backed mirror of ml/registry/registry.json
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.model_versions (
  model_version_id  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id          TEXT         NOT NULL,
  version           TEXT         NOT NULL,                    -- SemVer e.g. "0.1.0"
  model_type        TEXT         NOT NULL CHECK (model_type IN ('pd','fraud','churn','lapse','anomaly','claim_severity')),
  framework         TEXT         NOT NULL CHECK (framework IN ('xgboost','sklearn','torch','lightgbm','isolation_forest')),
  status            TEXT         NOT NULL CHECK (status IN ('experimental','staging','shadow','production','retired')),
  metrics           JSONB        NOT NULL DEFAULT '{}'::jsonb,-- {auc, brier, ks, n_train, n_holdout, ...}
  key_features      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  trained_at        TIMESTAMPTZ,
  deployed_at       TIMESTAMPTZ,
  retired_at        TIMESTAMPTZ,
  registry_path     TEXT,                                     -- file path to ml/models/<type>/v<version>/
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by        TEXT         NOT NULL DEFAULT 'system',
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  UNIQUE (model_id, version)
);

CREATE INDEX IF NOT EXISTS idx_model_versions_type_status
  ON app_copilot.model_versions (model_type, status, deployed_at DESC NULLS LAST)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE app_copilot.model_versions IS
'Pg-backed mirror of ml/registry/registry.json. M7.x promotion workflow writes to this table.';

-- BEFORE-UPDATE trigger keeps model_versions.updated_at fresh
CREATE OR REPLACE FUNCTION app_copilot.model_versions_touch_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_model_versions_updated_at ON app_copilot.model_versions;
CREATE TRIGGER trg_model_versions_updated_at
  BEFORE UPDATE ON app_copilot.model_versions
  FOR EACH ROW EXECUTE FUNCTION app_copilot.model_versions_touch_updated_at();

COMMIT;
