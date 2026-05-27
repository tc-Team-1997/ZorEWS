-- 038_iam_extensions.sql
--
-- ZorEWS Enterprise Auth — multi-country, multi-tenant, full RBAC.
--
-- Adds the 7 tables the EWS production spec requires on top of the
-- existing app_iam schema (T4.A + T4.14 already provisioned users,
-- sessions, password_history, audit_events).
--
-- Tables created:
--   countries          — 6 launch countries with locale + regulator
--                        defaults sourced from the SPA catalog.
--   domains            — banking | insurance closed list.
--   roles              — 11-role enterprise catalog with scope_level
--                        (platform / country / tenant / branch / dept).
--   permissions        — capability tokens used by the RBAC matrix.
--   role_permissions   — junction (role_id → permission_id).
--   user_roles         — multi-scope role assignment per user.
--                        (one user can hold multiple roles, each
--                         scoped to a different country / tenant /
--                         branch / department combination).
--   refresh_tokens     — rotating JWT refresh tokens with hash + IP
--                        + user-agent tracking; supersedes the
--                        in-memory denylist on auth-svc restart.
--
-- All ALTER + CREATE statements are guarded with IF NOT EXISTS or
-- DO $$ ... $$ blocks so a re-run is a no-op. No row in any existing
-- table is modified.

BEGIN;

-- ── countries ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.countries (
  code              TEXT        PRIMARY KEY,
  name              TEXT        NOT NULL,
  flag              TEXT        NOT NULL,
  currency_code     TEXT        NOT NULL,
  currency_symbol   TEXT        NOT NULL,
  locale            TEXT        NOT NULL,
  timezone_label    TEXT        NOT NULL,
  timezone_tz       TEXT        NOT NULL,
  date_format       TEXT        NOT NULL,
  regulators_banking   TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
  regulators_insurance TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
  high_risk_pd_pct  NUMERIC(4,2) NOT NULL DEFAULT 5.00,
  sma_dpd_days      INTEGER     NOT NULL DEFAULT 30,
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ NULL
);
COMMENT ON TABLE app_iam.countries IS 'Launch countries with locale + regulator defaults (SOR for /api/auth/countries)';

CREATE INDEX IF NOT EXISTS ix_app_iam_countries_active
  ON app_iam.countries (active)
  WHERE deleted_at IS NULL;

-- ── domains ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.domains (
  id              TEXT        PRIMARY KEY,
  label           TEXT        NOT NULL,
  description     TEXT        NOT NULL,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  CHECK (id IN ('banking', 'insurance'))
);
COMMENT ON TABLE app_iam.domains IS 'Closed-list domain enum used by tenant + role scoping';

-- ── roles ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.roles (
  id              TEXT        PRIMARY KEY,
  label           TEXT        NOT NULL,
  description     TEXT        NOT NULL,
  domain          TEXT        NOT NULL DEFAULT 'both',
  scope_level     TEXT        NOT NULL DEFAULT 'tenant',
  -- backend_role: maps the 11-role enterprise catalog onto the 5-role
  -- auth-svc Role enum (admin / risk_analyst / supervisor /
  -- collection_officer / field_officer) so /auth/register stays
  -- backward-compatible until auth-svc grows the enum natively.
  backend_role    TEXT        NOT NULL,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  CHECK (domain IN ('banking', 'insurance', 'both')),
  CHECK (scope_level IN ('platform', 'country', 'tenant', 'branch', 'department')),
  CHECK (backend_role IN ('admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer'))
);
COMMENT ON TABLE app_iam.roles IS '11-role enterprise RBAC catalog with multi-scope levels';

CREATE INDEX IF NOT EXISTS ix_app_iam_roles_scope
  ON app_iam.roles (scope_level, domain)
  WHERE deleted_at IS NULL;

-- ── permissions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.permissions (
  id              TEXT        PRIMARY KEY,
  resource        TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  description     TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  UNIQUE (resource, action)
);
COMMENT ON TABLE app_iam.permissions IS 'Atomic (resource, action) capability tokens';

-- ── role_permissions junction ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.role_permissions (
  role_id         TEXT        NOT NULL REFERENCES app_iam.roles(id) ON DELETE CASCADE,
  permission_id   TEXT        NOT NULL REFERENCES app_iam.permissions(id) ON DELETE CASCADE,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by      TEXT        NULL,
  PRIMARY KEY (role_id, permission_id)
);

-- ── user_roles (multi-scope grants) ───────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.user_roles (
  id              BIGSERIAL   PRIMARY KEY,
  user_id         TEXT        NOT NULL REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
  role_id         TEXT        NOT NULL REFERENCES app_iam.roles(id) ON DELETE CASCADE,
  country         TEXT        NULL REFERENCES app_iam.countries(code) ON DELETE SET NULL,
  tenant_id       TEXT        NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  branch          TEXT        NULL,
  department      TEXT        NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by      TEXT        NULL,
  expires_at      TIMESTAMPTZ NULL,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  deleted_at      TIMESTAMPTZ NULL,
  -- One row per (user, role, scope) — a user can hold the same role
  -- in multiple tenants/branches but not the same role twice at the
  -- same scope.
  UNIQUE (user_id, role_id, country, tenant_id, branch, department)
);
COMMENT ON TABLE app_iam.user_roles IS 'Multi-scope role grants (country, tenant, branch, department)';

CREATE INDEX IF NOT EXISTS ix_app_iam_user_roles_user
  ON app_iam.user_roles (user_id, active)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_app_iam_user_roles_tenant
  ON app_iam.user_roles (tenant_id, active)
  WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;

-- ── refresh_tokens ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.refresh_tokens (
  id              BIGSERIAL   PRIMARY KEY,
  token_hash      TEXT        NOT NULL UNIQUE,
  user_id         TEXT        NOT NULL REFERENCES app_iam.users(user_id) ON DELETE CASCADE,
  session_id      TEXT        NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ NULL,
  rotated_to      TEXT        NULL,
  ip              INET        NULL,
  user_agent      TEXT        NULL,
  -- Multi-tenant ready — every refresh token belongs to a tenant via
  -- the session it was issued under. Indexed for fast tenant-scoped
  -- audit queries.
  tenant_id       TEXT        NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE
);
COMMENT ON TABLE app_iam.refresh_tokens IS 'Rotating JWT refresh tokens (SHA-256 hash). Survives auth-svc restart.';

CREATE INDEX IF NOT EXISTS ix_app_iam_refresh_tokens_session
  ON app_iam.refresh_tokens (session_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_app_iam_refresh_tokens_user
  ON app_iam.refresh_tokens (user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_iam_refresh_tokens_expires
  ON app_iam.refresh_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- ── seed: 6 countries ─────────────────────────────────────────────
INSERT INTO app_iam.countries (
  code, name, flag, currency_code, currency_symbol, locale,
  timezone_label, timezone_tz, date_format,
  regulators_banking, regulators_insurance, high_risk_pd_pct, sma_dpd_days
) VALUES
  ('IN', 'India',                 '🇮🇳', 'INR', '₹',   'en-IN', 'IST (UTC+5:30)', 'Asia/Kolkata',     'DD-MMM-YYYY', ARRAY['RBI','BAC-A 2024'],                ARRAY['IRDAI','IFRS 9'],            5.00, 30),
  ('AE', 'United Arab Emirates',  '🇦🇪', 'AED', 'د.إ', 'en-AE', 'GST (UTC+4)',     'Asia/Dubai',       'DD/MM/YYYY',  ARRAY['CBUAE','Basel III'],              ARRAY['CBUAE Insurance','IFRS 17'], 4.50, 30),
  ('SG', 'Singapore',             '🇸🇬', 'SGD', 'S$',  'en-SG', 'SGT (UTC+8)',     'Asia/Singapore',   'DD/MM/YYYY',  ARRAY['MAS Notice 612','Basel III'],     ARRAY['MAS Notice 133','RBC 2'],    3.50, 30),
  ('US', 'United States',         '🇺🇸', 'USD', '$',   'en-US', 'ET (UTC−5)',      'America/New_York', 'MM/DD/YYYY',  ARRAY['FRB SR 11-7','OCC 2011-12','CECL'], ARRAY['NAIC','ORSA'],             4.00, 30),
  ('GB', 'United Kingdom',        '🇬🇧', 'GBP', '£',   'en-GB', 'GMT (UTC+0)',     'Europe/London',    'DD/MM/YYYY',  ARRAY['PRA SS3/18','Basel III.1'],       ARRAY['PRA','Solvency II'],         4.00, 30),
  ('CA', 'Canada',                '🇨🇦', 'CAD', 'C$',  'en-CA', 'ET (UTC−5)',      'America/Toronto',  'YYYY-MM-DD',  ARRAY['OSFI E-23','Basel III'],          ARRAY['OSFI MCT','LICAT'],          4.00, 30)
ON CONFLICT (code) DO NOTHING;

-- ── seed: 2 domains ───────────────────────────────────────────────
INSERT INTO app_iam.domains (id, label, description) VALUES
  ('banking',   'Banking',   'Borrower stress, NPA risk, fraud signals, portfolio health.'),
  ('insurance', 'Insurance', 'Claim fraud, lapse, underwriting anomalies, premium-collection risk.')
ON CONFLICT (id) DO NOTHING;

-- ── seed: 11 enterprise roles ────────────────────────────────────
INSERT INTO app_iam.roles (id, label, description, domain, scope_level, backend_role) VALUES
  ('super_admin',        'Super Admin',        'Platform-wide control across countries, tenants, and domains.',           'both',      'platform',   'admin'),
  ('country_admin',      'Country Admin',      'Owns every tenant + branch within a single country.',                     'both',      'country',    'admin'),
  ('bank_admin',         'Bank Admin',         'Tenant-level administrator scoped to a single bank.',                     'banking',   'tenant',     'admin'),
  ('insurance_admin',    'Insurance Admin',    'Tenant-level administrator scoped to a single insurer.',                  'insurance', 'tenant',     'admin'),
  ('risk_analyst',       'Risk Analyst',       'Investigates indicators, runs scenarios, authors rules.',                 'both',      'tenant',     'risk_analyst'),
  ('credit_officer',     'Credit Officer',     'Reviews borrower behaviour, recommends action on cases.',                 'banking',   'branch',     'supervisor'),
  ('operations_user',    'Operations User',    'Handles day-to-day alerts + case routing.',                               'both',      'branch',     'supervisor'),
  ('fraud_analyst',      'Fraud Analyst',      'Pursues fraud signals across transactions + claims.',                     'both',      'tenant',     'risk_analyst'),
  ('collection_manager', 'Collection Manager', 'Drives recovery from SMA/NPA + lapsed-premium accounts.',                 'both',      'branch',     'collection_officer'),
  ('auditor',            'Auditor',            'Read-only access to the full evidence + audit trail.',                    'both',      'platform',   'field_officer'),
  ('read_only_user',     'Read-Only User',     'Dashboard + reports only. No mutations.',                                 'both',      'tenant',     'field_officer')
ON CONFLICT (id) DO NOTHING;

-- ── seed: 18 atomic permissions ──────────────────────────────────
INSERT INTO app_iam.permissions (id, resource, action, description) VALUES
  ('alerts:list',                 'alerts',        'list',           'View alert queue + filter by class/status'),
  ('alerts:read',                 'alerts',        'read',           'Open an alert detail card'),
  ('alerts:ack',                  'alerts',        'ack',            'Acknowledge an alert'),
  ('cases:list',                  'cases',         'list',           'List cases'),
  ('cases:read',                  'cases',         'read',           'View case detail + history'),
  ('cases:log_action',            'cases',         'log_action',     'Log an action against a case'),
  ('cases:close',                 'cases',         'close',          'Close a case (4-eyes for sensitive)'),
  ('rules:list',                  'rules',         'list',           'View rule templates'),
  ('rules:create',                'rules',         'create',         'Create + edit rules'),
  ('rules:simulate',              'rules',         'simulate',       'Backtest + simulate rules'),
  ('customers:read_risk_profile', 'customers',     'read_profile',   'Read per-customer risk profile + SHAP'),
  ('customers:read_pii',          'customers',     'read_pii',       'Reveal PII fields (DPA controlled)'),
  ('reports:export',              'reports',       'export',         'Export PDF / Excel / CSV reports'),
  ('reports:share',               'reports',       'share',          'Save reports with role-scoped visibility'),
  ('audit:read',                  'audit',         'read',           'Read audit trail + evidence packages'),
  ('admin:users',                 'admin',         'manage_users',   'Provision + revoke users'),
  ('admin:tenants',               'admin',         'manage_tenants', 'Manage tenant + branch registry'),
  ('admin:config',                'admin',         'edit_config',    'Override platform configuration')
ON CONFLICT (id) DO NOTHING;

-- ── seed: role_permissions (matches lib/enterpriseRoles.ts capabilities) ──
DO $$
DECLARE
  -- Map each role → granted permission id. Repeated DO-block + INSERT
  -- ON CONFLICT keeps the migration idempotent even if a permission
  -- has been added in a hot-patch and the role grant lags.
  super_admin_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','alerts:ack','cases:list','cases:read','cases:log_action','cases:close',
    'rules:list','rules:create','rules:simulate','customers:read_risk_profile','customers:read_pii',
    'reports:export','reports:share','audit:read','admin:users','admin:tenants','admin:config'
  ];
  country_admin_perms TEXT[] := super_admin_perms;
  bank_admin_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','alerts:ack','cases:list','cases:read','cases:log_action','cases:close',
    'rules:list','rules:create','rules:simulate','customers:read_risk_profile',
    'reports:export','reports:share','audit:read','admin:users','admin:config'
  ];
  insurance_admin_perms TEXT[] := bank_admin_perms;
  risk_analyst_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','cases:list','cases:read',
    'rules:list','rules:create','rules:simulate','customers:read_risk_profile',
    'reports:export','audit:read'
  ];
  credit_officer_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','alerts:ack','cases:list','cases:read','cases:log_action','cases:close',
    'customers:read_risk_profile','reports:export'
  ];
  operations_user_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','alerts:ack','cases:list','cases:read','cases:log_action','cases:close',
    'customers:read_risk_profile'
  ];
  fraud_analyst_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','alerts:ack','cases:list','cases:read','cases:log_action','cases:close',
    'rules:list','rules:create','rules:simulate','customers:read_risk_profile',
    'reports:export','audit:read'
  ];
  collection_manager_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','cases:list','cases:read','cases:log_action','cases:close',
    'customers:read_risk_profile','reports:export'
  ];
  auditor_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','cases:list','cases:read',
    'customers:read_risk_profile','reports:export','audit:read'
  ];
  read_only_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','cases:list','cases:read','customers:read_risk_profile'
  ];
  role_record RECORD;
  perm TEXT;
BEGIN
  FOR role_record IN
    SELECT * FROM (VALUES
      ('super_admin',        super_admin_perms),
      ('country_admin',      country_admin_perms),
      ('bank_admin',         bank_admin_perms),
      ('insurance_admin',    insurance_admin_perms),
      ('risk_analyst',       risk_analyst_perms),
      ('credit_officer',     credit_officer_perms),
      ('operations_user',    operations_user_perms),
      ('fraud_analyst',      fraud_analyst_perms),
      ('collection_manager', collection_manager_perms),
      ('auditor',            auditor_perms),
      ('read_only_user',     read_only_perms)
    ) AS t(role_id, perms)
  LOOP
    FOREACH perm IN ARRAY role_record.perms
    LOOP
      INSERT INTO app_iam.role_permissions (role_id, permission_id, granted_by)
      VALUES (role_record.role_id, perm, 'migration:038')
      ON CONFLICT (role_id, permission_id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- ── BEFORE-UPDATE trigger to keep updated_at fresh ────────────────
CREATE OR REPLACE FUNCTION app_iam.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS countries_touch_updated_at ON app_iam.countries;
CREATE TRIGGER countries_touch_updated_at BEFORE UPDATE ON app_iam.countries
  FOR EACH ROW EXECUTE FUNCTION app_iam.touch_updated_at();

DROP TRIGGER IF EXISTS domains_touch_updated_at ON app_iam.domains;
CREATE TRIGGER domains_touch_updated_at BEFORE UPDATE ON app_iam.domains
  FOR EACH ROW EXECUTE FUNCTION app_iam.touch_updated_at();

DROP TRIGGER IF EXISTS roles_touch_updated_at ON app_iam.roles;
CREATE TRIGGER roles_touch_updated_at BEFORE UPDATE ON app_iam.roles
  FOR EACH ROW EXECUTE FUNCTION app_iam.touch_updated_at();

COMMIT;
