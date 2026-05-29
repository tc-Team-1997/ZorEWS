-- 048_job_scheduler_config.sql
-- Local-additive migration. Backward-compatible.
-- Configuration — Job & Scheduler Config (MASTER SETUP spec screen #19).
-- A single consolidated registry of every SCHEDULED JOB on the platform —
-- ingestion DAGs, report schedules, ML retraining, the escalation worker,
-- DQ runs, audit retention, etc. — with frequency + last-run-status + enable
-- toggle. Today these live scattered across ingestion connectors (M3.1),
-- report schedules (M12.2), AI retraining (T5.1.1), and the escalation worker;
-- this is the unified ops view + control surface a real scheduler would back.
-- The BFF runs an in-memory store today (services/bff/src/job_scheduler_config.ts);
-- this table is the env-gated pg-backed swap target.
-- NO existing data touched. NO existing tables dropped.

BEGIN;

-- ============================================================================
-- job_scheduler_config — per-tenant scheduled-job registry
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_copilot.job_scheduler_config (
  job_id               TEXT         PRIMARY KEY,             -- job-<tenant>-<KEY>
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  name                 TEXT         NOT NULL,
  category             TEXT         NOT NULL CHECK (category IN ('ingestion','reporting','ml','workflow','data_quality','system')),
  description          TEXT,
  owner_service        TEXT         NOT NULL,
  frequency            TEXT         NOT NULL CHECK (frequency IN ('realtime','every_5min','every_15min','hourly','every_6h','daily','weekly','monthly')),
  enabled              BOOLEAN      NOT NULL DEFAULT true,
  last_run_status      TEXT         NOT NULL DEFAULT 'never_run' CHECK (last_run_status IN ('success','failure','partial','running','never_run')),
  last_run_at          TIMESTAMPTZ,
  last_run_duration_ms INTEGER,
  consecutive_failures INTEGER      NOT NULL DEFAULT 0,
  next_run_at          TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Hot path: tenant-scoped list filtered by category / status.
CREATE INDEX IF NOT EXISTS idx_job_scheduler_tenant_category
  ON app_copilot.job_scheduler_config (tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_job_scheduler_tenant_status
  ON app_copilot.job_scheduler_config (tenant_id, last_run_status);

COMMENT ON TABLE app_copilot.job_scheduler_config IS
'Master Setup screen #19 — consolidated scheduled-job registry (frequency / last-run-status / enable toggle) spanning ingestion, reporting, ml, workflow, data_quality, system. In-memory in prototype; env-gated pg-backed swap target.';

COMMIT;
