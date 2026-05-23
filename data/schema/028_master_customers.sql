-- data/schema/028_master_customers.sql
--
-- Phase B.1 — Customer Master Setup (PDF §3 Master Setup item 1).
-- Compliance-grade admin overlay on top of mart.customer_360.
-- KYC + PEP + risk_category override + segment + country + industry.
--
-- Distinct from mart.customer_360 (which is the data layer derived
-- from CBS / bureau ingestion); this is the ops-maintained master
-- that supplies the compliance-critical attributes mart.* doesn't
-- carry deterministically.
--
-- Apply order: AFTER 005 (app_iam.tenants) and 023 (recovery store).

CREATE SCHEMA IF NOT EXISTS app_master;

CREATE TABLE IF NOT EXISTS app_master.customers (
    customer_id      TEXT         NOT NULL,
    tenant_id        TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id),
    customer_type    TEXT         NOT NULL CHECK (customer_type IN (
        'retail', 'corporate', 'sme', 'msme', 'priority'
    )),
    segment          TEXT         NULL,
    -- risk_category override; null = use computed/inferred value
    risk_category    TEXT         NULL CHECK (
        risk_category IS NULL OR risk_category IN ('low', 'medium', 'high')
    ),
    kyc_status       TEXT         NOT NULL CHECK (kyc_status IN (
        'pending', 'verified', 'expired', 'failed', 'exempt'
    )),
    kyc_expires_at   TIMESTAMPTZ  NULL,
    pep_flag         BOOLEAN      NOT NULL DEFAULT FALSE,
    -- country is ISO 3166-1 alpha-2; cross-ref to app_master.geographies
    -- is NOT enforced via FK here so the customer master can survive a
    -- soft-delete of a geography master row.
    country          TEXT         NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    industry         TEXT         NULL,
    notes            TEXT         NULL,
    active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by       TEXT         NOT NULL,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by       TEXT         NOT NULL,
    deleted_at       TIMESTAMPTZ  NULL,
    deleted_by       TEXT         NULL,
    PRIMARY KEY (tenant_id, customer_id),
    CHECK (length(customer_id) BETWEEN 1 AND 64),
    CHECK (segment IS NULL OR length(segment) <= 80),
    CHECK (industry IS NULL OR length(industry) <= 80),
    CHECK (notes IS NULL OR length(notes) <= 1000),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

-- Hot path 1: SPA list filtered by compliance criteria.
CREATE INDEX IF NOT EXISTS customer_master_tenant_kyc_idx
    ON app_master.customers (tenant_id, kyc_status, customer_type)
    WHERE deleted_at IS NULL;

-- Hot path 2: PEP roster (compliance review).
CREATE INDEX IF NOT EXISTS customer_master_tenant_pep_idx
    ON app_master.customers (tenant_id, pep_flag)
    WHERE deleted_at IS NULL AND pep_flag = TRUE;

-- Hot path 3: KYC-expiring query (compliance hot-list).
CREATE INDEX IF NOT EXISTS customer_master_tenant_kyc_expiry_idx
    ON app_master.customers (tenant_id, kyc_expires_at)
    WHERE deleted_at IS NULL AND kyc_expires_at IS NOT NULL;

-- Hot path 4: Recovery Center recently-deleted filter.
CREATE INDEX IF NOT EXISTS customer_master_tenant_deleted_idx
    ON app_master.customers (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE app_master.customers IS
    'Phase B.1 — Customer Master Setup. Compliance-grade admin overlay '
    'on top of mart.customer_360 carrying KYC + PEP + risk_category '
    'overrides. Soft-delete via deleted_at/_by; Recovery Center adapter '
    'entity_type=customer_master re-inserts on restore.';
