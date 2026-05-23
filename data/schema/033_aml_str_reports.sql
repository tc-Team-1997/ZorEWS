-- data/schema/033_aml_str_reports.sql
--
-- Phase C.1 — AML STR Reporting workflow (PDF §11 AML Integration #4).
-- Tenant-scoped FIU-IND Suspicious Transaction Report ledger with
-- maker-checker lifecycle. Maker can't be checker on submit (RBI
-- segregation of duties).
--
-- Apply order: AFTER 005 (app_iam.tenants) and 023 (recovery store).

CREATE SCHEMA IF NOT EXISTS app_aml;

CREATE TABLE IF NOT EXISTS app_aml.str_reports (
    str_id                TEXT          NOT NULL,
    tenant_id             TEXT          NOT NULL REFERENCES app_iam.tenants(tenant_id),
    customer_id           TEXT          NOT NULL,
    case_id               TEXT          NULL,
    reasons               TEXT[]        NOT NULL,                -- closed enum at app layer
    total_amount_kes      NUMERIC(20,2) NOT NULL CHECK (total_amount_kes > 0),
    transaction_count     INTEGER       NOT NULL CHECK (transaction_count > 0),
    date_range_start      TIMESTAMPTZ   NOT NULL,
    date_range_end        TIMESTAMPTZ   NOT NULL,
    narrative             TEXT          NOT NULL,
    supporting_doc_refs   TEXT[]        NOT NULL DEFAULT '{}'::text[],
    status                TEXT          NOT NULL DEFAULT 'draft' CHECK (
        status IN ('draft', 'ready_for_review', 'submitted', 'acknowledged', 'rejected')
    ),
    maker_username        TEXT          NOT NULL,
    checker_username      TEXT          NULL,
    submitted_at          TIMESTAMPTZ   NULL,
    ack_reference         TEXT          NULL,
    ack_received_at       TIMESTAMPTZ   NULL,
    rejection_reason      TEXT          NULL,
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by            TEXT          NOT NULL,
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_by            TEXT          NOT NULL,
    deleted_at            TIMESTAMPTZ   NULL,
    deleted_by            TEXT          NULL,
    PRIMARY KEY (tenant_id, str_id),
    CHECK (str_id ~ '^[A-Z][A-Z0-9_-]{2,63}$'),
    CHECK (length(narrative) BETWEEN 20 AND 1000),
    CHECK (date_range_end >= date_range_start),
    CHECK (cardinality(reasons) > 0 AND cardinality(reasons) <= 10),
    CHECK (cardinality(supporting_doc_refs) <= 50),
    -- Maker can't be checker on submit/acknowledged (RBI segregation).
    -- Note: enforced at app layer too — pg CHECK can't reference NULL
    -- gracefully across all transition paths, so the app-layer guard
    -- is the canonical enforcement; this is belt-and-braces.
    CHECK (
        checker_username IS NULL OR
        checker_username <> maker_username
    ),
    -- ack_reference must be set on acknowledged.
    CHECK (
        status <> 'acknowledged' OR
        (ack_reference IS NOT NULL AND ack_received_at IS NOT NULL)
    ),
    -- rejection_reason must be set on rejected.
    CHECK (
        status <> 'rejected' OR rejection_reason IS NOT NULL
    ),
    -- submitted_at populated when status reaches submitted.
    CHECK (
        status NOT IN ('submitted', 'acknowledged', 'rejected') OR
        submitted_at IS NOT NULL
    ),
    CHECK (
        (deleted_at IS NULL  AND deleted_by IS NULL) OR
        (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    )
);

-- Hot path 1: SPA review queue (ready_for_review or submitted-pending).
CREATE INDEX IF NOT EXISTS str_reports_tenant_status_idx
    ON app_aml.str_reports (tenant_id, status, created_at DESC)
    WHERE deleted_at IS NULL;

-- Hot path 2: per-customer history (regulator inquiry).
CREATE INDEX IF NOT EXISTS str_reports_tenant_customer_idx
    ON app_aml.str_reports (tenant_id, customer_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- Hot path 3: unack-tracking (compliance SLA monitoring).
CREATE INDEX IF NOT EXISTS str_reports_tenant_unacked_idx
    ON app_aml.str_reports (tenant_id, submitted_at)
    WHERE deleted_at IS NULL AND status = 'submitted';

-- Hot path 4: Recovery filter.
CREATE INDEX IF NOT EXISTS str_reports_tenant_deleted_idx
    ON app_aml.str_reports (tenant_id, deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

COMMENT ON TABLE app_aml.str_reports IS
    'Phase C.1 — AML STR Reporting (FIU-IND). Maker-checker workflow '
    'with draft → ready_for_review → submitted → acknowledged/rejected. '
    'RBI segregation of duties: maker ≠ checker on submit. Only '
    'draft/ready_for_review can be soft-deleted; submitted/acked/rejected '
    'are immutable per FIU-IND retention. Recovery adapter '
    'entity_type=str_report.';
