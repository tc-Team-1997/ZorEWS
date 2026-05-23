-- data/schema/031_master_accounts.sql
--
-- Phase B.3 — Account & Exposure Master (PDF §4 Master Setup item 2).
-- Per-tenant catalog of account_types + loan_types with default
-- exposure caps + credit limits. Drives the SPA "create account"
-- picker; M11.6 Customer 360 reads max_exposure_cap as alert threshold.

CREATE SCHEMA IF NOT EXISTS app_master;

CREATE TABLE IF NOT EXISTS app_master.accounts (
    account_type_id        TEXT          NOT NULL,
    tenant_id              TEXT          NOT NULL REFERENCES app_iam.tenants(tenant_id),
    display_name           TEXT          NOT NULL,
    category               TEXT          NOT NULL CHECK (category IN (
        'deposit', 'loan', 'credit_card', 'overdraft'
    )),
    product_subtype        TEXT          NULL,
    default_credit_limit   NUMERIC(20,2) NULL CHECK (
        default_credit_limit IS NULL OR default_credit_limit >= 0
    ),
    max_exposure_cap       NUMERIC(20,2) NULL CHECK (
        max_exposure_cap IS NULL OR max_exposure_cap >= 0
    ),
    repayment_frequency    TEXT          NOT NULL DEFAULT 'monthly' CHECK (
        repayment_frequency IN (
            'monthly', 'quarterly', 'half_yearly', 'yearly', 'bullet', 'none'
        )
    ),
    interest_rate_pct      NUMERIC(5,3)  NULL CHECK (
        interest_rate_pct IS NULL OR
        (interest_rate_pct >= 0 AND interest_rate_pct <= 100)
    ),
    active                 BOOLEAN       NOT NULL DEFAULT TRUE,
    notes                  TEXT          NULL,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by             TEXT          NOT NULL,
    updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_by             TEXT          NOT NULL,
    deleted_at             TIMESTAMPTZ   NULL,
    deleted_by             TEXT          NULL,
    PRIMARY KEY (tenant_id, account_type_id),
    CHECK (account_type_id ~ '^[A-Z][A-Z0-9_]{2,63}$'),
    CHECK (length(display_name) BETWEEN 1 AND 200),
    CHECK (product_subtype IS NULL OR length(product_subtype) <= 80),
    CHECK (notes IS NULL OR length(notes) <= 1000),
    -- Cap must be ≥ credit_limit when both set.
    CHECK (
        default_credit_limit IS NULL OR
        max_exposure_cap IS NULL OR
        max_exposure_cap >= default_credit_limit
    ),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS account_master_tenant_category_idx
    ON app_master.accounts (tenant_id, category)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS account_master_tenant_active_idx
    ON app_master.accounts (tenant_id, active)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS account_master_tenant_deleted_idx
    ON app_master.accounts (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE app_master.accounts IS
    'Phase B.3 — Account & Exposure Master. Tenant-scoped catalog of '
    'account_type + loan_type + default credit limits + max exposure '
    'caps. Soft-delete + Recovery Center (entity_type=account_master).';
