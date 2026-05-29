-- 041_ai_drift_tracking.sql
-- Local-additive migration. Backward-compatible.
-- T7 Module 7 — Drift Detection (operational surface). Persists per-model
-- drift snapshots: per-feature PSI + KS prediction drift + rolling-AUC +
-- anomaly spike. Mirrors the offline ml/monitoring/drift.py concepts/thresholds
-- (PSI bands stable<0.10 / warn<0.25 / drift). The BFF runs an in-memory
-- synthesiser today (services/bff/src/ai_drift.ts); this table is the env-gated
-- pg-backed swap target. NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- ai_drift_tracking — one row per (model, computed_at) drift snapshot
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.ai_drift_tracking (
  snapshot_id       TEXT         PRIMARY KEY,                 -- drift-<tenant>-<model>-<day>[-rN]
  tenant_id         TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  model_id          TEXT         NOT NULL,
  model_type        TEXT         NOT NULL,                    -- 'pd'|'fraud'|'churn'|'lapse'|'anomaly'|'claim_severity'
  model_version     TEXT         NOT NULL,
  computed_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reference_window  TEXT         NOT NULL DEFAULT 'training',
  current_window    TEXT         NOT NULL DEFAULT 'last_7d',
  overall_status    TEXT         NOT NULL CHECK (overall_status IN ('stable','warn','drift')),
  -- per-feature PSI rows: {feature, psi, band, feature_type}[]
  data_drift        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- KS two-sample on the prediction distribution: {ks_stat, p_value, drifted}
  model_drift       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- rolling AUC vs baseline: {current_auc, baseline_auc, delta, drifted}
  performance_drift JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- anomaly rate vs baseline: {baseline_rate, current_rate, ratio, spiked}
  anomaly_spike     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ                               -- soft delete
);

-- Hot path: tenant-scoped, newest-first per model (latest snapshot + history).
CREATE INDEX IF NOT EXISTS idx_ai_drift_tenant_model_time
  ON app_copilot.ai_drift_tracking (tenant_id, model_id, computed_at DESC)
  WHERE deleted_at IS NULL;

-- Fleet roll-up by status (which models are warn/drift right now).
CREATE INDEX IF NOT EXISTS idx_ai_drift_tenant_status
  ON app_copilot.ai_drift_tracking (tenant_id, overall_status, computed_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE app_copilot.ai_drift_tracking IS
'T7 M7 operational drift snapshots — per-feature PSI + KS prediction drift + rolling-AUC + anomaly spike. Mirrors ml/monitoring/drift.py thresholds. In-memory synthesised in prototype; this table is the env-gated pg-backed swap target.';

COMMIT;
