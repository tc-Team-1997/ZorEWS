-- 008_cases_tenant.sql
-- APEX EWS — tenant-scope regulatory-svc/cases (T4.24 Phase 5).
--
-- Extends the Phase 4 data-isolation pattern to operational cases.
-- Phase 4 handled BFF-owned stores (webhooks + scenarios); this
-- migration tags the cases lifecycle so a BIL operator's cases stay
-- distinct from BANK_DEMO's.
--
-- Scope:
--   * app_cases.cases gets a tenant_id column. The downstream tables
--     (actions, cas_records, caps) inherit tenancy via their case_id FK
--     and stay un-tagged — JOIN to cases.tenant_id when filtering.
--     Rationale: avoids fan-out of identical tenant_id rows; the FK
--     chain already guarantees consistency.
--
-- Out of scope (Phase 6+):
--   * app_alerts.* — same pattern, separate migration.
--   * mart.* — domain pivot (needs BIL synthetic data generation).

ALTER TABLE app_cases.cases
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'
        REFERENCES app_iam.tenants(tenant_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_app_cases_tenant_state
    ON app_cases.cases (tenant_id, state);

CREATE INDEX IF NOT EXISTS ix_app_cases_tenant_assignee
    ON app_cases.cases (tenant_id, assignee) WHERE assignee IS NOT NULL;

COMMENT ON COLUMN app_cases.cases.tenant_id IS
    'Tenant the case belongs to. Inherited from the originating alert / API caller. Backfilled to BANK_DEMO for pre-Phase-5 rows.';
