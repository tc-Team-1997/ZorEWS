-- 019_cms_cases_case_category.sql
--
-- Adds a case_category column to app_cases.cms_cases so the dashboard
-- SLA breach matrix (BAC §3.1.9.1.4) can join against
-- app_admin.sla_config keyed by (tenant_id, case_category, priority).
--
-- The column is nullable so existing rows + future inserts that don't
-- supply a category fall back to 'default_fallback' at the resolver
-- layer. The backfill below is a heuristic over `tags`; it intentionally
-- only sets the most confident matches and leaves the rest NULL.
--
-- Backward-compat: pure ALTER ADD COLUMN; idempotent via DO block.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app_cases'
           AND table_name   = 'cms_cases'
           AND column_name  = 'case_category'
    ) THEN
        ALTER TABLE app_cases.cms_cases ADD COLUMN case_category TEXT;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_cms_cases_tenant_category
    ON app_cases.cms_cases (tenant_id, case_category)
    WHERE status NOT IN ('CLOSED');

-- Heuristic backfill: only confident matches. Anything else stays NULL
-- so the resolver falls through to default_fallback.
UPDATE app_cases.cms_cases
   SET case_category = 'fraud'
 WHERE case_category IS NULL
   AND ('fraud-watch' = ANY(tags) OR 'aml' = ANY(tags) OR title ILIKE '%fraud%');

UPDATE app_cases.cms_cases
   SET case_category = 'credit_risk'
 WHERE case_category IS NULL
   AND ('credit-shopping' = ANY(tags)
        OR 'restructure' = ANY(tags)
        OR 'collections' = ANY(tags)
        OR 'cross-product' = ANY(tags)
        OR 'employment-shock' = ANY(tags)
        OR title ILIKE '%delinquen%'
        OR title ILIKE '%dpd%'
        OR title ILIKE '%default%');

UPDATE app_cases.cms_cases
   SET case_category = 'lapse'
 WHERE case_category IS NULL
   AND title ILIKE '%lapse%';

UPDATE app_cases.cms_cases
   SET case_category = 'compliance'
 WHERE case_category IS NULL
   AND ('maker-checker' = ANY(tags) OR 'msme' = ANY(tags));

COMMENT ON COLUMN app_cases.cms_cases.case_category IS
  'Broad case category (credit_risk / fraud / kyc / lapse / compliance / …). Resolves against app_admin.sla_config to compute breach status. NULL falls through to the default_fallback row.';

COMMIT;
