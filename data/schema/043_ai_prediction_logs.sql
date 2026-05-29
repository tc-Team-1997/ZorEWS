-- 043_ai_prediction_logs.sql
-- Local-additive migration. Backward-compatible.
-- T7 Module 8 — Prediction Audit Logs (ENHANCES the existing prediction
-- surface). 036_ai_persistence.sql already persists ai_predictions (the
-- decision itself). This is the SEPARATE compliance audit-action trail:
-- every user action (acknowledge/override/escalate/dismiss/view) + system
-- event (alert_triggered/feedback_recorded) against a prediction, with actor
-- + timestamp. Append-only — the "who did what to this model decision, and
-- what did it trigger?" log. The BFF runs an in-memory store today
-- (services/bff/src/ai_prediction_logs.ts); this table is the env-gated
-- pg-backed swap target. NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- ai_prediction_logs — append-only audit-action trail over ai_predictions
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.ai_prediction_logs (
  log_id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  prediction_id      TEXT         NOT NULL,                  -- references app_copilot.ai_predictions.prediction_id
  model_id           TEXT,
  model_version      TEXT,
  action             TEXT         NOT NULL
                                  CHECK (action IN ('created','viewed','acknowledged','overridden',
                                                    'escalated','dismissed','alert_triggered','feedback_recorded')),
  actor              TEXT         NOT NULL,
  actor_role         TEXT,
  confidence         NUMERIC(10,6),                          -- snapshot at action time
  triggered_alert_id TEXT,                                   -- set when the action raised/links an alert
  note               TEXT,
  metadata           JSONB,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ                             -- soft delete (audit logs rarely deleted)
);

-- Hot path: chronological trail for one prediction (the Explainability audit panel).
CREATE INDEX IF NOT EXISTS idx_ai_predlog_tenant_prediction
  ON app_copilot.ai_prediction_logs (tenant_id, prediction_id, created_at)
  WHERE deleted_at IS NULL;

-- Compliance query: tenant-wide by action / actor / time.
CREATE INDEX IF NOT EXISTS idx_ai_predlog_tenant_action_time
  ON app_copilot.ai_prediction_logs (tenant_id, action, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_predlog_tenant_actor_time
  ON app_copilot.ai_prediction_logs (tenant_id, actor, created_at DESC)
  WHERE deleted_at IS NULL;

-- Triggered-alert linkage (which model decisions raised alerts).
CREATE INDEX IF NOT EXISTS idx_ai_predlog_triggered_alert
  ON app_copilot.ai_prediction_logs (tenant_id, triggered_alert_id)
  WHERE triggered_alert_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE app_copilot.ai_prediction_logs IS
'T7 M8 prediction audit-action trail — compliance log of every user action + system event against a prediction (over ai_predictions). Append-only. In-memory in prototype; env-gated pg-backed swap target.';

COMMIT;
