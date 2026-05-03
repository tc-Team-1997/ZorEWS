-- 007_app_tenant.sql
-- APEX EWS — tenant-scope BFF-owned operational stores (T4.24 Phase 4).
--
-- Phases 1-3 introduced tenant context at the wire (X-Tenant-ID header)
-- and at auth (JWT carries tenant_id, BFF middleware verifies it).
-- This migration takes the natural next step: the BFF-owned data stores
-- (webhooks + saved scenarios) get a tenant_id column so reads/writes
-- can actually be isolated per-tenant. Today the gate is theatrical —
-- a BIL admin who calls GET /v1/webhooks would see BANK_DEMO's
-- subscriptions because the underlying store has no tenant tag.
--
-- Scope (intentional):
--   * BFF-owned tables: app_bff.webhook_subscriptions, webhook_deliveries,
--     app_scenario.saved_scenarios.
-- Out of scope (separate codebase / different domain):
--   * regulatory-svc/cases (app_cases.*)         — Phase 5 follow-up.
--   * regulatory-svc/alerts (app_alerts.*)       — Phase 5 follow-up.
--   * mart.* analytics warehouse                 — would need synthetic
--     BIL data; that's a domain pivot, not data-layer plumbing.
--
-- Hash chain (audit.event_log) was already extended in 006 — that's
-- prior art for "additive metadata column on an existing table".
--
-- Backfill: existing rows default to BANK_DEMO. Once this migration
-- runs, demo BIL data must be inserted explicitly with tenant_id='BIL'.

-- =========================================================================
-- app_bff.webhook_subscriptions
-- =========================================================================

ALTER TABLE app_bff.webhook_subscriptions
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'
        REFERENCES app_iam.tenants(tenant_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_app_bff_webhooks_tenant_active
    ON app_bff.webhook_subscriptions (tenant_id, active);

COMMENT ON COLUMN app_bff.webhook_subscriptions.tenant_id IS
    'Tenant the subscription belongs to. Tenant-scoped stores list / get / delete only their own.';

-- =========================================================================
-- app_bff.webhook_deliveries — denormalised for query speed
-- =========================================================================
-- The delivery row is conceptually "owned" by its subscription's tenant.
-- We denormalise tenant_id here too so admin queries like "all deliveries
-- for tenant X in the last hour" don't have to JOIN. Backfill via the
-- subscription's tenant. There's no FK on the column directly — the
-- existing FK to webhook_subscriptions(subscription_id) keeps it consistent.

ALTER TABLE app_bff.webhook_deliveries
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO';

CREATE INDEX IF NOT EXISTS ix_app_bff_deliveries_tenant_time
    ON app_bff.webhook_deliveries (tenant_id, completed_at DESC);

-- Backfill: anything that existed before this migration came from
-- BANK_DEMO (the only tenant before Phase 1). A defensive UPDATE in
-- case any rows already carry a non-default value (no-op the first
-- time this migration runs). Read from the subscription's tenant_id
-- so future re-runs stay correct.
UPDATE app_bff.webhook_deliveries d
   SET tenant_id = s.tenant_id
  FROM app_bff.webhook_subscriptions s
 WHERE d.subscription_id = s.subscription_id
   AND d.tenant_id IS DISTINCT FROM s.tenant_id;

-- =========================================================================
-- app_scenario.saved_scenarios
-- =========================================================================

ALTER TABLE app_scenario.saved_scenarios
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'
        REFERENCES app_iam.tenants(tenant_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_app_scenario_saved_tenant_user
    ON app_scenario.saved_scenarios (tenant_id, saved_by, saved_at DESC);

COMMENT ON COLUMN app_scenario.saved_scenarios.tenant_id IS
    'Tenant the scenario belongs to. The (tenant_id, saved_by) composite is what the BFF list/get filters scope on.';
