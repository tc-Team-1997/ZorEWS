-- 005_tenants.sql
-- APEX EWS — multi-tenant API foundation (T4.24).
--
-- Source: "Banking API Integration – EWS Full Technical Documentation" §3
-- (Multi-Tenant API Design — flagged "VERY IMPORTANT") and §7 (OAuth 2.0
-- token flow). Companion to the DataNetworks BIL pitch deck which targets
-- a Bhutan Insurance tenant alongside the existing bank demo — without
-- tenant isolation we can't run both demos against the same backend.
--
-- This migration introduces three things:
--   1. `app_iam.tenants` — the registry of tenants the API will serve.
--      Seeded with BANK_DEMO (the existing prototype) and BIL (Bhutan
--      Insurance Limited).
--   2. `app_iam.service_clients` — OAuth client-credentials principals.
--      Used by `POST /oauth/token` (auth-svc) to mint M2M access tokens
--      for partner / mobile / LOS callers (Banking API doc §7).
--   3. `tenant_id` column on `app_iam.users` (default 'BANK_DEMO') so
--      every operator account is bound to a tenant. Sessions/audit/etc.
--      derive tenant context from the user's tenant_id.
--
-- What this migration does NOT do (deferred to per-table follow-ups):
--   - Tag mart.* / app_cases.* / app_alerts.* / app_bff.* with tenant_id.
--     That's a domain-data scope-out and lives behind the API gate first.
--   - Enforce row-level tenant isolation in services. The middleware
--     enforces tenant context on the wire; service code uses
--     `req.tenant.id` to scope reads.

-- =========================================================================
-- app_iam.tenants — tenant registry
-- =========================================================================

CREATE TABLE IF NOT EXISTS app_iam.tenants (
    tenant_id        TEXT        PRIMARY KEY,
        -- Stable opaque code: 'BANK_DEMO', 'BIL', etc. Sent as X-Tenant-ID
        -- on every request. Uppercase + underscore by convention.
    name             TEXT        NOT NULL,
        -- Human-readable label for admin UIs ("Bhutan Insurance Limited").
    vertical         TEXT        NOT NULL,
        -- 'banking' | 'insurance' — drives KRI catalogue + dashboard set.
    channels_allowed TEXT[]      NOT NULL,
        -- Whitelist for X-Channel header. e.g. ['LOS','MOBILE','BRANCH'].
        -- Request rejected when X-Channel is set but not in this list.
    active           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (vertical IN ('banking','insurance')),
    CHECK (cardinality(channels_allowed) > 0)
);
CREATE INDEX IF NOT EXISTS ix_app_iam_tenants_active ON app_iam.tenants (active);

COMMENT ON TABLE app_iam.tenants IS
    'Tenant registry. Each request carries X-Tenant-ID matching tenant_id; the BFF tenant middleware validates this against the row.';

-- Seed: the two demo tenants. Banking API doc §3 example uses 'BIL';
-- 'BANK_DEMO' is the existing prototype's implicit tenant.
INSERT INTO app_iam.tenants (tenant_id, name, vertical, channels_allowed)
VALUES
    ('BANK_DEMO', 'APEX Bank (demo)',          'banking',   ARRAY['LOS','MOBILE','BRANCH','API']),
    ('BIL',       'Bhutan Insurance Limited',  'insurance', ARRAY['BRANCH','AGENT_PORTAL','API'])
ON CONFLICT (tenant_id) DO NOTHING;

-- =========================================================================
-- app_iam.users — add tenant_id (FK -> tenants)
-- =========================================================================

ALTER TABLE app_iam.users
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'
        REFERENCES app_iam.tenants(tenant_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ix_app_iam_users_tenant ON app_iam.users (tenant_id);

COMMENT ON COLUMN app_iam.users.tenant_id IS
    'Tenant the operator belongs to. Backfilled to BANK_DEMO for existing rows; new tenants assign on user-create.';

-- =========================================================================
-- app_iam.service_clients — OAuth client-credentials principals
-- =========================================================================
--
-- POST /oauth/token (auth-svc) accepts grant_type=client_credentials and
-- looks up the row by (tenant_id, client_id), checking the bcrypt-hashed
-- secret. Returns an access_token bound to the tenant. No refresh token
-- (M2M; the client just re-grants when the access_token expires).

CREATE TABLE IF NOT EXISTS app_iam.service_clients (
    client_id       TEXT        NOT NULL,
        -- Public identifier: 'apex-mobile-bank-demo', 'bil-los-stub', etc.
    tenant_id       TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
    client_secret_hash TEXT     NOT NULL,
        -- argon2id; same hashing path as user password_hash.
    display_name    TEXT        NOT NULL,
    scopes          TEXT[]      NOT NULL DEFAULT '{}',
        -- Reserved for future fine-grained scope checks. Empty = "all
        -- endpoints the tenant can reach" — adequate for this prototype.
    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, client_id)
);
CREATE INDEX IF NOT EXISTS ix_app_iam_service_clients_active
    ON app_iam.service_clients (tenant_id) WHERE active;

COMMENT ON TABLE app_iam.service_clients IS
    'OAuth client-credentials principals. POST /oauth/token authenticates against (tenant_id, client_id, secret).';
