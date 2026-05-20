-- T4.6.3 — Self-service reporting: saved-report store.
--
-- Mirrors the `app_bff.webhook_subscriptions` + `app_scenario.saved_scenarios`
-- patterns (T4.13 / T4.18). Tenant-scoped per T4.24 Phase 4 with FK CASCADE
-- on tenant deletion + an index supporting the per-tenant list + visibility
-- filter (the most common SPA query).
--
-- Visibility column drives role-scoped sharing:
--   * 'private' — only created_by sees it.
--   * 'role'    — every user with at least one role in visible_to_roles[].
--   * 'tenant'  — every user in the tenant.
-- Admin (audit:read superuser) sees everything regardless.
--
-- Activation: runs as part of `make migrate` after the existing 026 migration.
-- BFF schema-resolution lives in services/bff/src/reports/builder_store.ts;
-- this file is the production-target schema (in-memory store is the default
-- until BFF_PG_URL is set + a pg-backed store factory ships in a follow-up).

CREATE TABLE IF NOT EXISTS app_bff.saved_reports (
    report_id           text PRIMARY KEY,
    tenant_id           text NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
    name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    description         text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    -- Full ReportDefinition (T4.6.2) — source_id + filters + group_by +
    -- metrics + sort + limit + sections. JSONB so analytics ad-hoc queries
    -- can introspect (e.g. "how many reports filter on risk_level?").
    definition          jsonb NOT NULL,
    created_by          text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    visibility          text NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('private', 'role', 'tenant')),
    visible_to_roles    text[] NOT NULL DEFAULT '{}'::text[],
    tags                text[] NOT NULL DEFAULT '{}'::text[],
    -- Belt-and-braces: 'role' visibility requires non-empty array.
    CONSTRAINT saved_reports_role_visibility_has_roles
        CHECK (visibility <> 'role' OR cardinality(visible_to_roles) > 0)
);

COMMENT ON TABLE app_bff.saved_reports IS
    'T4.6.3 — Saved-report configurations for the self-service report builder. JSONB definition column holds the ReportDefinition AST validated at write time by services/bff/src/reports/builder_filter.ts:compileReportDefinition.';

-- Per-tenant list is the hottest read path; index supports both the
-- visibility filter + created_by filter without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_saved_reports_tenant_visibility
    ON app_bff.saved_reports(tenant_id, visibility);

CREATE INDEX IF NOT EXISTS idx_saved_reports_tenant_created_by
    ON app_bff.saved_reports(tenant_id, created_by);

-- Newest-first ordering on list().
CREATE INDEX IF NOT EXISTS idx_saved_reports_tenant_created_at
    ON app_bff.saved_reports(tenant_id, created_at DESC);

-- GIN index on tags[] supports the `?tag=` filter without expanding the
-- array client-side.
CREATE INDEX IF NOT EXISTS idx_saved_reports_tenant_tags
    ON app_bff.saved_reports USING gin(tags);

-- Trigger to keep updated_at fresh on UPDATE (mirrors the M2.2 onboarding
-- trigger pattern).
CREATE OR REPLACE FUNCTION app_bff.saved_reports_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_saved_reports_touch_updated_at ON app_bff.saved_reports;
CREATE TRIGGER trg_saved_reports_touch_updated_at
    BEFORE UPDATE ON app_bff.saved_reports
    FOR EACH ROW
    EXECUTE FUNCTION app_bff.saved_reports_touch_updated_at();
