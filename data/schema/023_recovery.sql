-- data/schema/023_recovery.sql
--
-- Centralised soft-delete + recovery store. Every service that adopts
-- this pattern archives a copy of the row HERE before deleting from
-- its own table, so the row is recoverable via the /v1/recovery API
-- and the SPA /admin/recycle-bin page.
--
-- Design notes:
--   * `payload` carries the FULL original row as JSONB so restore
--     doesn't need a service-specific shape — the adapter just
--     reinserts what's in the payload back into the original table.
--   * `(entity_type, original_id, deleted_at)` is the natural identity:
--     a single entity can be archived multiple times over its
--     lifetime (delete → restore → delete again → restore again).
--   * `restored_at` + `purged_at` are nullable timestamps. State derives:
--       both NULL              → archived (recoverable)
--       restored_at NOT NULL   → restored (the original now exists again)
--       purged_at NOT NULL     → permanently deleted (audit-only)
--     Mutually exclusive — enforced by CHECK constraint below.
--   * tenant_id is denormalised (FK to app_iam.tenants) so cross-tenant
--     queries are cheap and tenant-isolation is enforced at the row level.
--
-- Apply this AFTER 004 (app_iam.tenants exists) and 005 (the tenants
-- table is populated).

CREATE SCHEMA IF NOT EXISTS app_recovery;

CREATE TABLE IF NOT EXISTS app_recovery.deleted_records (
    recovery_id     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    module          TEXT         NOT NULL,    -- 'bff' / 'auth-svc' / 'cases-svc' / 'alerts-svc'
    entity_type     TEXT         NOT NULL,    -- 'webhook_subscription' / 'saved_scenario' / 'user' / ...
    original_id     TEXT         NOT NULL,    -- PK of the original row (stringified for portability)
    original_table  TEXT         NOT NULL,    -- 'app_bff.webhook_subscriptions' etc. — auditable provenance
    payload         JSONB        NOT NULL,    -- full row snapshot at delete time
    deleted_by      TEXT         NOT NULL,    -- actor username (or 'system:<source>')
    deleted_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deletion_reason TEXT,                     -- optional free-text
    source_action   TEXT,                     -- 'user_initiated' / 'cascade' / 'api' / 'cleanup_job'
    prior_status    TEXT,                     -- e.g. 'active' / 'revoked' / 'open' — domain snapshot
    restored_at     TIMESTAMPTZ,
    restored_by     TEXT,
    purged_at       TIMESTAMPTZ,
    purged_by       TEXT,

    -- A record can be either archived, restored, or purged — never two at once.
    CONSTRAINT recovery_status_mutex CHECK (
        (restored_at IS NULL OR purged_at IS NULL)
    ),
    -- restored_at requires restored_by, purged_at requires purged_by
    CONSTRAINT recovery_restored_pair CHECK (
        (restored_at IS NULL) = (restored_by IS NULL)
    ),
    CONSTRAINT recovery_purged_pair CHECK (
        (purged_at IS NULL) = (purged_by IS NULL)
    )
);

-- Indexes:
--   - SPA list: filter by tenant, sort by deleted_at desc
--   - Filter by module / entity_type for tab UI
--   - Adoption-side existence check: did we already archive this entity?
CREATE INDEX IF NOT EXISTS idx_deleted_records_tenant_deleted_at
    ON app_recovery.deleted_records(tenant_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_deleted_records_tenant_module
    ON app_recovery.deleted_records(tenant_id, module);

CREATE INDEX IF NOT EXISTS idx_deleted_records_entity_orig
    ON app_recovery.deleted_records(entity_type, original_id, deleted_at DESC);

-- Partial index over the "active" subset (not restored, not purged) —
-- the SPA's default view filters here so it's the hot path.
CREATE INDEX IF NOT EXISTS idx_deleted_records_active
    ON app_recovery.deleted_records(tenant_id, deleted_at DESC)
    WHERE restored_at IS NULL AND purged_at IS NULL;

COMMENT ON TABLE app_recovery.deleted_records IS
'Centralised soft-delete archive. Services adopt this by calling the BFF RecoveryStore.archive() before DELETE FROM their own tables. Restore + purge are admin-only via /v1/recovery routes.';
