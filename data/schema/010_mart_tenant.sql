-- 010_mart_tenant.sql
-- APEX EWS — tenant-tag the analytics mart (T4.24 Phase 13).
--
-- Final schema migration in the T4.24 multi-tenant initiative. Every
-- operational store (Phases 4-6) and the entire `/v1/*` API surface
-- already speak tenant; this migration brings the analytics warehouse
-- into the same shape so a BIL operator's queries can be tenant-scoped
-- end-to-end (mart-tagged data → tenant-scoped BFF → tenant-scoped
-- regulatory-svc).
--
-- Strategy:
--   * ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'.
--     Existing rows backfill to BANK_DEMO (which is correct — all current
--     mart data IS BANK_DEMO, and BIL has no synthetic dataset yet).
--   * Idempotent — re-running this migration after a `dbt run` works:
--     dbt's CREATE TABLE includes tenant_id (added in the model SQL via
--     a literal projection at the staging layer), and the ADD COLUMN
--     becomes a no-op.
--   * No FK to app_iam.tenants. Mart tables are append-only analytics
--     output, not operational records; tying them to the live tenant
--     registry would block dbt from rebuilding the tables when a tenant
--     is deleted from app_iam. Convention: any tenant_id present in mart
--     must also exist in app_iam.tenants, but enforced by application
--     code, not the database.
--
-- Out of scope:
--   * BIL synthetic data generation (a future phase / separate ticket).
--     Until that ships, BIL operators see an empty mart — which is the
--     correct behaviour. The plumbing in this migration ensures BIL data
--     can land later without touching the schema again.
--   * raw.seed_* tables — the dbt seed CSVs are the source of truth and
--     stay unchanged. The dbt staging layer stamps `'BANK_DEMO'::TEXT AS
--     tenant_id` as a literal projection so the materialised mart tables
--     still get the column even though the underlying seed data doesn't
--     carry it.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'mart' AND table_name = 'customer_360') THEN
        EXECUTE $sql$
            ALTER TABLE mart.customer_360
                ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO';
            CREATE INDEX IF NOT EXISTS ix_mart_customer_360_tenant
                ON mart.customer_360 (tenant_id);
        $sql$;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'mart' AND table_name = 'loan_360') THEN
        EXECUTE $sql$
            ALTER TABLE mart.loan_360
                ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO';
            CREATE INDEX IF NOT EXISTS ix_mart_loan_360_tenant
                ON mart.loan_360 (tenant_id);
        $sql$;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'mart' AND table_name = 'txn_features') THEN
        EXECUTE $sql$
            ALTER TABLE mart.txn_features
                ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO';
            CREATE INDEX IF NOT EXISTS ix_mart_txn_features_tenant
                ON mart.txn_features (tenant_id);
        $sql$;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'mart' AND table_name = 'indicator_values') THEN
        EXECUTE $sql$
            ALTER TABLE mart.indicator_values
                ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO';
            CREATE INDEX IF NOT EXISTS ix_mart_indicator_values_tenant
                ON mart.indicator_values (tenant_id);
        $sql$;
    END IF;
END $$;

-- Comments — the convention reference for any service code that joins
-- against mart.* + tenant context.
COMMENT ON COLUMN mart.customer_360.tenant_id IS
    'Tenant the customer record belongs to. Stamped by the dbt staging layer; defaults to BANK_DEMO for the current synthetic dataset (T4.24 Phase 13). BIL data lands when its synthetic generator ships.';
