-- 009_alerts_tenant.sql
-- APEX EWS — tenant-scope regulatory-svc/alerts (T4.24 Phase 6).
--
-- Mirrors Phase 5 (008_cases_tenant.sql) for the alert queue. After this
-- migration a BIL operator pulling from the smart queue only ever sees
-- BIL alerts; the same alert_id can never be served to BANK_DEMO and BIL
-- because every alert is created with exactly one tenant_id.
--
-- Scope:
--   * app_alerts.alerts gets tenant_id. queue_assignments inherits via
--     the alert_id FK chain — no direct tenant column.
--
-- Out of scope (Phase 7+):
--   * mart.* analytics warehouse — domain pivot.
--   * Mart-side BIL synthetic data generation.

ALTER TABLE app_alerts.alerts
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'
        REFERENCES app_iam.tenants(tenant_id) ON DELETE RESTRICT;

-- The dispatcher's hottest read is "open critical alerts in tenant X
-- ordered by criticality_score" — index on the composite for that.
CREATE INDEX IF NOT EXISTS ix_app_alerts_tenant_open_priority
    ON app_alerts.alerts (tenant_id, status, criticality_score DESC)
    WHERE status = 'open';

CREATE INDEX IF NOT EXISTS ix_app_alerts_tenant_assignee
    ON app_alerts.alerts (tenant_id, assignee) WHERE assignee IS NOT NULL;

COMMENT ON COLUMN app_alerts.alerts.tenant_id IS
    'Tenant the alert belongs to. Inherited from the originating customer / rule firing. Backfilled to BANK_DEMO for pre-Phase-6 rows.';
