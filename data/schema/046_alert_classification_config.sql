-- 046_alert_classification_config.sql
-- Local-additive migration. Backward-compatible.
-- Master Setup — Alert Classification Setup (MASTER SETUP spec screen #12).
-- Operator-editable RAG (Red/Amber/Green) score-band configuration. Two
-- boundaries (amber_min, red_min) derive a contiguous green/amber/red
-- partition: green [0, amber_min) / amber [amber_min, red_min) / red [red_min, ∞).
-- Gaps/overlaps are structurally impossible. Per-band action_required text
-- is independently editable.
-- Distinct from the fixed M8.1 severity→colour spec — this is the tenant-
-- editable SCORE-band setup the runtime classifier would consume.
-- The BFF runs an in-memory store today (services/bff/src/alert_classification_config.ts);
-- this table is the env-gated pg-backed swap target.
-- NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- alert_classification_config — one RAG-band config row per tenant
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.alert_classification_config (
  tenant_id        TEXT         PRIMARY KEY REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  score_floor      NUMERIC(8,2) NOT NULL DEFAULT 0,
  amber_min        NUMERIC(8,2) NOT NULL,                 -- green→amber boundary (inclusive lower of amber)
  red_min          NUMERIC(8,2) NOT NULL,                 -- amber→red boundary (inclusive lower of red)
  action_green     TEXT         NOT NULL,
  action_amber     TEXT         NOT NULL,
  action_red       TEXT         NOT NULL,
  updated_by       TEXT         NOT NULL,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Partition invariant: 0 < amber_min < red_min keeps every band reachable.
  CONSTRAINT alert_classification_band_order CHECK (score_floor < amber_min AND amber_min < red_min)
);

COMMENT ON TABLE app_copilot.alert_classification_config IS
'Master Setup screen #12 — operator-editable RAG score bands. amber_min + red_min derive a contiguous green/amber/red partition (green [0,amber_min) / amber [amber_min,red_min) / red [red_min,∞)). In-memory in prototype; env-gated pg-backed swap target.';

COMMIT;
