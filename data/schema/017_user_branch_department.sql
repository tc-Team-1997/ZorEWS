-- 017_user_branch_department.sql
--
-- Add branch + department columns to app_iam.users so the User Access
-- Override list page can filter by them (per the BAC §3.1.7 brief).
--
-- Idempotent via IF NOT EXISTS / DO blocks. Existing rows get NULL
-- branch/department — no breakage; the SPA falls back to '—' when
-- the column is missing.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app_iam'
           AND table_name   = 'users'
           AND column_name  = 'branch'
    ) THEN
        ALTER TABLE app_iam.users ADD COLUMN branch TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app_iam'
           AND table_name   = 'users'
           AND column_name  = 'department'
    ) THEN
        ALTER TABLE app_iam.users ADD COLUMN department TEXT;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_app_iam_users_branch     ON app_iam.users (branch);
CREATE INDEX IF NOT EXISTS ix_app_iam_users_department ON app_iam.users (department);

-- Light seed for the 5 demo accounts so the SPA filter has something
-- to bite on right after migration. ON CONFLICT DO NOTHING so re-running
-- the migration doesn't clobber operator overrides.
UPDATE app_iam.users SET branch = 'BR-NRB-01', department = 'Risk Operations' WHERE username = 'alice.admin'   AND branch IS NULL;
UPDATE app_iam.users SET branch = 'BR-NRB-01', department = 'Risk Operations' WHERE username = 'sue.super'     AND branch IS NULL;
UPDATE app_iam.users SET branch = 'BR-NRB-02', department = 'Risk Analytics'  WHERE username = 'ravi.risk'     AND branch IS NULL;
UPDATE app_iam.users SET branch = 'BR-MSA-01', department = 'Collections'     WHERE username = 'carl.collect'  AND branch IS NULL;
UPDATE app_iam.users SET branch = 'BR-MSA-02', department = 'Field Ops'       WHERE username = 'fiona.field'   AND branch IS NULL;

COMMIT;
