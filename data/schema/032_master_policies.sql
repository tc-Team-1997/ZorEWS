-- data/schema/032_master_policies.sql
--
-- Phase B.4 — Product & Policy Master (PDF §5 Master Setup item 3).
-- Per-tenant catalog of insurance policy types. Drives the SPA
-- "issue policy" picker; M11.2 Underwriting + M14.1 InsuranceAdapter
-- cross-reference the category enum so all three modules speak the
-- same vocabulary.

CREATE SCHEMA IF NOT EXISTS app_master;

CREATE TABLE IF NOT EXISTS app_master.policies (
    policy_type_id         TEXT          NOT NULL,
    tenant_id              TEXT          NOT NULL REFERENCES app_iam.tenants(tenant_id),
    display_name           TEXT          NOT NULL,
    -- 4 BIL canonical categories — matches M14.1 InsuranceAdapter.
    category               TEXT          NOT NULL CHECK (category IN (
        'TERM_LIFE', 'ENDOWMENT', 'ULIP', 'GENERAL_HEALTH'
    )),
    premium_frequency      TEXT          NOT NULL DEFAULT 'yearly' CHECK (
        premium_frequency IN (
            'monthly', 'quarterly', 'half_yearly', 'yearly', 'single_pay'
        )
    ),
    min_premium            NUMERIC(20,2) NOT NULL CHECK (min_premium >= 0),
    max_premium            NUMERIC(20,2) NOT NULL,
    min_coverage           NUMERIC(20,2) NOT NULL CHECK (min_coverage >= 0),
    max_coverage           NUMERIC(20,2) NOT NULL,
    waiting_period_days    INTEGER       NOT NULL DEFAULT 0 CHECK (
        waiting_period_days >= 0 AND waiting_period_days <= 365
    ),
    grace_period_days      INTEGER       NOT NULL DEFAULT 30 CHECK (
        grace_period_days >= 0 AND grace_period_days <= 365
    ),
    renewal_type           TEXT          NOT NULL DEFAULT 'manual' CHECK (
        renewal_type IN ('auto', 'manual', 'on_demand')
    ),
    active                 BOOLEAN       NOT NULL DEFAULT TRUE,
    description            TEXT          NULL,
    notes                  TEXT          NULL,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by             TEXT          NOT NULL,
    updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_by             TEXT          NOT NULL,
    deleted_at             TIMESTAMPTZ   NULL,
    deleted_by             TEXT          NULL,
    PRIMARY KEY (tenant_id, policy_type_id),
    CHECK (policy_type_id ~ '^[A-Z][A-Z0-9_]{2,63}$'),
    CHECK (length(display_name) BETWEEN 1 AND 200),
    -- Range invariants: max ≥ min on both premium + coverage.
    CHECK (max_premium >= min_premium),
    CHECK (max_coverage >= min_coverage),
    CHECK (description IS NULL OR length(description) <= 500),
    CHECK (notes IS NULL OR length(notes) <= 1000),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

-- Hot paths.
CREATE INDEX IF NOT EXISTS policy_master_tenant_category_idx
    ON app_master.policies (tenant_id, category)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS policy_master_tenant_active_idx
    ON app_master.policies (tenant_id, active)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS policy_master_tenant_deleted_idx
    ON app_master.policies (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE app_master.policies IS
    'Phase B.4 — Product & Policy Master (Insurance). Per-tenant catalog '
    'of TERM_LIFE/ENDOWMENT/ULIP/GENERAL_HEALTH policy types with premium '
    '+ coverage ranges, waiting + grace periods, renewal type. '
    'Soft-delete + Recovery (entity_type=policy_master). Categories '
    'aligned to M14.1 InsuranceAdapter convention.';
