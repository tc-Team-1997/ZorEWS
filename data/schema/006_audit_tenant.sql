-- 006_audit_tenant.sql
-- APEX EWS — multi-tenant audit context (T4.24 Phase 3).
--
-- Adds `tenant_id` and `channel` columns to both audit tables so the
-- regulatory trail is queryable per-tenant. Critical for the BIL
-- demo: when "show me all login events for BIL last week" is asked,
-- a tenant-tagged audit row is the only durable answer.
--
-- Both tables get the columns as additive metadata. The hash chain on
-- `audit.event_log` is INTENTIONALLY NOT modified — its canonical input
-- (event_ts || event_type || actor || subject_id || payload) stays the
-- same so existing chained rows verify correctly. tenant_id + channel
-- live alongside the chain, not inside it. If a future audit-svc rewrite
-- needs them in the hash, that's a chain-breaking migration we'd version
-- separately.

-- =========================================================================
-- audit.event_log — append-only hash-chained log (003_audit_table.sql)
-- =========================================================================

ALTER TABLE audit.event_log
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO';

ALTER TABLE audit.event_log
    ADD COLUMN IF NOT EXISTS channel TEXT;
        -- e.g. 'LOS' / 'MOBILE' / 'BRANCH' / 'API' / 'AGENT_PORTAL'.
        -- Nullable because system-internal events (DAG runs, dbt jobs)
        -- have no caller channel.

CREATE INDEX IF NOT EXISTS ix_audit_event_log_tenant_ts
    ON audit.event_log (tenant_id, event_ts DESC);

CREATE INDEX IF NOT EXISTS ix_audit_event_log_tenant_subject
    ON audit.event_log (tenant_id, subject_id) WHERE subject_id IS NOT NULL;

COMMENT ON COLUMN audit.event_log.tenant_id IS
    'Tenant the event belongs to. Backfilled to BANK_DEMO for pre-T4.24 rows. NOT part of the hash chain.';
COMMENT ON COLUMN audit.event_log.channel IS
    'Calling channel (X-Channel header). Nullable for system events.';

-- =========================================================================
-- app_iam.audit_events — service-local mirror (004_app_schemas.sql)
-- =========================================================================

ALTER TABLE app_iam.audit_events
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO';

ALTER TABLE app_iam.audit_events
    ADD COLUMN IF NOT EXISTS channel TEXT;

CREATE INDEX IF NOT EXISTS ix_app_iam_audit_tenant_ts
    ON app_iam.audit_events (tenant_id, occurred_at DESC);

COMMENT ON COLUMN app_iam.audit_events.tenant_id IS
    'Tenant the event belongs to. Backfilled to BANK_DEMO for pre-T4.24 rows.';
