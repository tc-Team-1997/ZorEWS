-- 035_unified_views.sql
-- Unified read-only view layer (T4.25 / spec: docs/unified-view-layer-design.md)
-- Owner: agent-data | Co-owner: agent-integration
--
-- Additive only. Rolls back via 035_unified_views_rollback.sql.
-- Apply via: cd data/schema && make migrate (or psql -f 035_unified_views.sql)
--
-- Sections:
--   1. unified schema
--   2. app_audit.approvals tenant_id column + supporting indexes (spec §6 precondition)
--   3. Supporting indexes on underlying tables (spec §10.5 audit)
--   4. unified.customer_360 view              (added in Task 4)
--   5. unified.alerts view                    (added in Task 5)
--   6. unified.cases view                     (added in Task 6)
--   7. unified.audit_activity view            (added in Task 7)
--   8. COMMENT ON VIEW + COMMENT ON COLUMN    (added in Task 8)
--   9. FUTURE: materialized-view promotion template (commented; added in Task 8)

BEGIN;

-- --------------------------------------------------------------------------
-- Section 1: schema
-- --------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS unified;
COMMENT ON SCHEMA unified IS
  'Read-only view layer flattening cross-schema joins for SPA + reporting + ad-hoc DBeaver. '
  'Underlying schemas (raw/staging/mart/audit/app_*) remain authoritative for writes. '
  'See docs/unified-view-layer-design.md';

-- --------------------------------------------------------------------------
-- Section 2: app_audit.approvals tenant_id (T4.20 shipped pre-T4.24 P3)
-- --------------------------------------------------------------------------
ALTER TABLE app_audit.approvals
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'
    REFERENCES app_iam.tenants(tenant_id);

CREATE INDEX IF NOT EXISTS approvals_tenant_idx
  ON app_audit.approvals(tenant_id);

CREATE INDEX IF NOT EXISTS approvals_correlation_status_idx
  ON app_audit.approvals(correlation_id, status);

-- --------------------------------------------------------------------------
-- Section 3: Supporting indexes on underlying tables (spec §10.5)
-- Only those marked ⚠️ verify in spec §10.5 + confirmed missing in pre-flight.
-- IF NOT EXISTS is idempotent — safe to re-apply.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS alerts_tenant_customer_idx
  ON app_alerts.alerts(tenant_id, customer_id);

CREATE INDEX IF NOT EXISTS cases_tenant_customer_idx
  ON app_cases.cases(tenant_id, customer_id);

CREATE INDEX IF NOT EXISTS cas_records_case_review_idx
  ON app_cases.cas_records(case_id, review_status);

CREATE INDEX IF NOT EXISTS caps_case_status_idx
  ON app_cases.caps(case_id, status);

CREATE INDEX IF NOT EXISTS actions_case_id_idx
  ON app_cases.actions(case_id);

COMMIT;
