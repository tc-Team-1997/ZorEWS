-- 050_user_domain.sql
--
-- Domain Based Access Control (DBAC) — per-user domain pinning.
--
-- Adds an OPTIONAL `domain` column to app_iam.users so a user can be
-- explicitly scoped to 'banking' or 'insurance'. When NULL the user
-- inherits its tenant's vertical (app_iam.tenants.vertical from T4.24
-- Phase 1). Super-admins (role='admin' / 'super_admin') always see
-- BOTH regardless.
--
-- Resolution order (canonical, used by BFF dbac/domain_resolver.ts):
--   1. user.domain explicit  → wins
--   2. tenant.vertical       → fallback for single-tenant users
--   3. null                  → operator hasn't been scoped yet
--
-- Backwards-compatible — every existing row stays NULL (inherits via
-- tenant). Adding the column doesn't break ANY existing query or
-- middleware. Re-runs are a no-op via ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE app_iam.users
  ADD COLUMN IF NOT EXISTS domain TEXT NULL;

-- CHECK can't use IF NOT EXISTS, so wrap in a DO block to make idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_iam_users_domain_check'
  ) THEN
    ALTER TABLE app_iam.users
      ADD CONSTRAINT app_iam_users_domain_check
      CHECK (domain IS NULL OR domain IN ('banking', 'insurance'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_app_iam_users_domain
  ON app_iam.users (domain)
  WHERE domain IS NOT NULL;

COMMENT ON COLUMN app_iam.users.domain
  IS 'DBAC: per-user domain pin (banking/insurance). NULL → inherits tenant.vertical.';

COMMIT;
