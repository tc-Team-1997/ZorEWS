-- 049_rbac_permission_matrix.sql
--
-- Enterprise Permission Matrix overlay.
--
-- LAYERS ON TOP of the existing 038/041 RBAC (app_iam.roles +
-- app_iam.role_permissions) WITHOUT modifying or removing anything.
--
-- Existing app_iam.role_permissions stores OPERATION-string capability
-- tokens (e.g. 'alerts:list', 'cases:read') — used by requireRole()
-- middleware on /v1/* routes. That contract is untouched.
--
-- This migration adds a parallel MODULE × ACTION matrix:
--   - rbac.permission_action — closed 7-value enum table
--   - rbac.permission_module — UI-facing module catalogue
--   - rbac.role_permission — the (role × module × action) grant matrix
--
-- All tables idempotent via CREATE TABLE IF NOT EXISTS. Seeds use
-- INSERT … ON CONFLICT DO NOTHING. Re-runs are a no-op.
--
-- Existing /v1/* routes continue to enforce via the legacy
-- requireRole('op'). New routes can additionally enforce
-- requireModulePermission(module, action) — they compose. No breaking
-- change.
--
-- Each role_id FK references app_iam.roles(id), so the matrix only
-- grants permissions to roles that already exist in the canonical
-- catalog (super_admin / country_admin / bank_admin / insurance_admin /
-- risk_analyst / fraud_analyst / credit_officer / operations_user /
-- auditor / read_only_user — declared by 038 + 041).

BEGIN;

CREATE SCHEMA IF NOT EXISTS rbac;
COMMENT ON SCHEMA rbac IS 'Enterprise Permission Matrix overlay on top of app_iam (additive, 049+).';

-- ── permission_action ────────────────────────────────────────────────
-- Closed 7-value enum table. Storing as a table (not a CHECK enum)
-- lets the SPA matrix editor render labels + descriptions.
CREATE TABLE IF NOT EXISTS rbac.permission_action (
  id              TEXT        PRIMARY KEY,
  label           TEXT        NOT NULL,
  description     TEXT        NOT NULL,
  sort_order      INTEGER     NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id IN ('view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'))
);
COMMENT ON TABLE rbac.permission_action IS 'Closed 7-value permission-action catalog (view/create/edit/delete/approve/export/configure).';

INSERT INTO rbac.permission_action (id, label, description, sort_order) VALUES
  ('view',      'View',      'Read or list records in the module',                  1),
  ('create',    'Create',    'Create new records within the module',                2),
  ('edit',      'Edit',      'Modify existing records',                             3),
  ('delete',    'Delete',    'Soft-delete or hard-delete records',                  4),
  ('approve',   'Approve',   'Approve maker-checker workflows (4-eyes second step)', 5),
  ('export',    'Export',    'Export records to CSV / PDF / Excel',                  6),
  ('configure', 'Configure', 'Edit module configuration + thresholds (admin-level)', 7)
ON CONFLICT (id) DO NOTHING;

-- ── permission_module ────────────────────────────────────────────────
-- Open-ended catalog of UI-facing modules. Grouped by category for
-- SPA matrix editor rendering.
CREATE TABLE IF NOT EXISTS rbac.permission_module (
  id              TEXT        PRIMARY KEY,
  label           TEXT        NOT NULL,
  description     TEXT        NOT NULL,
  category        TEXT        NOT NULL,
  domain          TEXT        NOT NULL DEFAULT 'both',
  sort_order      INTEGER     NOT NULL,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (category IN ('dashboard', 'banking', 'insurance', 'workflow', 'reporting', 'ai', 'admin', 'data')),
  CHECK (domain IN ('banking', 'insurance', 'both'))
);
COMMENT ON TABLE rbac.permission_module IS 'UI-facing module catalog for the permission matrix (Borrower Watch, Claims Anomaly, etc.).';

CREATE INDEX IF NOT EXISTS ix_rbac_permission_module_cat
  ON rbac.permission_module (category, sort_order) WHERE active = TRUE;

INSERT INTO rbac.permission_module (id, label, description, category, domain, sort_order) VALUES
  -- Dashboard surface (universal)
  ('dashboard',           'Dashboard',              'Enterprise + per-role landing dashboards',                  'dashboard', 'both',      1),
  -- Banking surfaces
  ('borrower_watch',      'Borrower Watch',         'Per-borrower watchlist + drill-through',                    'banking',   'banking',  10),
  ('account_behaviour',   'Account Behaviour',      'Behavioural-signal monitoring on accounts',                 'banking',   'banking',  11),
  ('financial_ratios',    'Financial Ratios',       'DSCR / ICR / DE etc + CMA pack',                            'banking',   'banking',  12),
  ('sma_classification',  'SMA Classification',     'RBI SMA-0/1/2 movement + drill',                            'banking',   'banking',  13),
  ('npa_prediction',      'NPA Prediction',         'AI-driven NPA forecasting',                                  'banking',   'banking',  14),
  ('sector_watch',        'Sector Watch',           'Portfolio concentration × stress',                          'banking',   'banking',  15),
  ('fraud_detection',     'Fraud Detection',        'Fraud signals + investigation surface (banking-side)',      'banking',   'banking',  16),
  -- Insurance surfaces
  ('claims_anomaly',      'Claims Anomaly',         'Claim-fraud + anomalous-claim detection',                   'insurance', 'insurance',20),
  ('policy_lapse_risk',   'Policy Lapse Risk',      'Lapse-risk forecasting + persistency',                      'insurance', 'insurance',21),
  ('solvency_watch',      'Solvency Watch',         'IRDAI solvency margin + drivers',                            'insurance', 'insurance',22),
  ('underwriting',        'Underwriting Deviation', 'Underwriting deviation review + approval',                   'insurance', 'insurance',23),
  ('channel_risk',        'Channel Risk',           'Distribution-channel scorecards',                            'insurance', 'insurance',24),
  -- Workflow + AI surfaces
  ('alerts',              'Alerts',                 'Alert center: classify, route, acknowledge, escalate',      'workflow',  'both',     30),
  ('cases',               'Cases',                  'Case-management workflow incl. maker-checker',              'workflow',  'both',     31),
  ('rules_engine',        'Rules Engine',           'Rule authoring, simulation, versioning, approval',          'ai',        'both',     40),
  ('scenarios',           'Scenarios',              'Scenario library + stress-test simulation',                  'ai',        'both',     41),
  ('ai_models',           'AI Models',              'Model registry + promotion + drift monitoring',             'ai',        'both',     42),
  -- Reporting
  ('reports',             'Reports',                'Reports + report builder + scheduled jobs',                 'reporting', 'both',     50),
  -- Admin
  ('users',               'Users & RBAC',           'User lifecycle: create, edit, disable, force-logout',       'admin',     'both',     60),
  ('master_data',         'Master Data',            'Master entity CRUD (countries / currencies / case-types …)','admin',     'both',     61),
  ('audit_trail',         'Audit Trail',            'Hash-chained audit events + evidence packaging',            'admin',     'both',     62),
  ('configuration',       'Configuration',          'Platform configuration: alerts SLA / notification toggles', 'admin',     'both',     63),
  ('permission_matrix',   'Permission Matrix',      'This very surface — manage role × module × action grants',  'admin',     'both',     64),
  -- Data plane
  ('data_ingestion',      'Data Ingestion',         'Source connectors + schema + run history',                  'data',      'both',     70),
  ('data_quality',        'Data Quality',           'DQ rules + profiling + standardisation',                    'data',      'both',     71)
ON CONFLICT (id) DO NOTHING;

-- ── role_permission (the matrix) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS rbac.role_permission (
  role_id         TEXT        NOT NULL REFERENCES app_iam.roles(id) ON DELETE CASCADE,
  module_id       TEXT        NOT NULL REFERENCES rbac.permission_module(id) ON DELETE CASCADE,
  action_id       TEXT        NOT NULL REFERENCES rbac.permission_action(id) ON DELETE CASCADE,
  granted         BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_by      TEXT        NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, module_id, action_id)
);
COMMENT ON TABLE rbac.role_permission IS 'The (role × module × action) grant matrix. Missing row = denied.';

CREATE INDEX IF NOT EXISTS ix_rbac_role_permission_role
  ON rbac.role_permission (role_id) WHERE granted = TRUE;

-- Touch updated_at on grant changes.
CREATE OR REPLACE FUNCTION rbac.role_permission_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rbac_role_permission_touch ON rbac.role_permission;
CREATE TRIGGER rbac_role_permission_touch
  BEFORE UPDATE ON rbac.role_permission
  FOR EACH ROW EXECUTE FUNCTION rbac.role_permission_touch_updated_at();

-- ── seed default matrix for the 10 named roles ──────────────────────
-- Conservative defaults: super_admin gets EVERYTHING; auditor +
-- read_only_user get VIEW + EXPORT only; per-role explicit grants
-- below. Re-running is a no-op (PK conflict).

DO $$
DECLARE
  every_action  TEXT[] := ARRAY['view','create','edit','delete','approve','export','configure'];
  view_export   TEXT[] := ARRAY['view','export'];
  view_only     TEXT[] := ARRAY['view'];
  view_create_edit TEXT[] := ARRAY['view','create','edit'];
  view_edit_approve TEXT[] := ARRAY['view','edit','approve'];
  view_edit_export TEXT[] := ARRAY['view','edit','export'];
  view_edit_export_approve TEXT[] := ARRAY['view','edit','export','approve'];
  every_module  TEXT[];
  banking_mods  TEXT[] := ARRAY[
    'dashboard','borrower_watch','account_behaviour','financial_ratios',
    'sma_classification','npa_prediction','sector_watch','fraud_detection',
    'alerts','cases','rules_engine','scenarios','ai_models','reports','audit_trail'
  ];
  insurance_mods TEXT[] := ARRAY[
    'dashboard','claims_anomaly','policy_lapse_risk','solvency_watch',
    'underwriting','channel_risk','fraud_detection',
    'alerts','cases','rules_engine','scenarios','ai_models','reports','audit_trail'
  ];
  fraud_mods   TEXT[] := ARRAY[
    'dashboard','fraud_detection','claims_anomaly','alerts','cases','audit_trail','reports'
  ];
  credit_mods  TEXT[] := ARRAY[
    'dashboard','borrower_watch','account_behaviour','financial_ratios','sma_classification','npa_prediction','alerts','cases','reports'
  ];
  ops_mods     TEXT[] := ARRAY['dashboard','alerts','cases','reports'];
  audit_mods   TEXT[] := ARRAY['dashboard','audit_trail','reports','users','permission_matrix'];
  rdonly_mods  TEXT[] := ARRAY['dashboard','borrower_watch','alerts','cases','reports'];
  risk_mods    TEXT[] := ARRAY[
    'dashboard','borrower_watch','npa_prediction','sma_classification','alerts','cases','rules_engine','scenarios','reports'
  ];
  m TEXT;
  a TEXT;
BEGIN
  -- Snapshot of every module (used by super_admin only).
  SELECT array_agg(id ORDER BY id) INTO every_module FROM rbac.permission_module;

  -- super_admin → everything
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'super_admin') THEN
    FOREACH m IN ARRAY every_module LOOP
      FOREACH a IN ARRAY every_action LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('super_admin', m, a, TRUE, 'migration:049')
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END IF;

  -- country_admin → everything except permission_matrix configure (reserved for super_admin)
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'country_admin') THEN
    FOREACH m IN ARRAY every_module LOOP
      FOREACH a IN ARRAY every_action LOOP
        IF m = 'permission_matrix' AND a IN ('create','delete','configure') THEN
          CONTINUE;
        END IF;
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('country_admin', m, a, TRUE, 'migration:049')
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END IF;

  -- bank_admin → banking surfaces + admin (within bank tenant)
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'bank_admin') THEN
    FOREACH m IN ARRAY banking_mods LOOP
      FOREACH a IN ARRAY every_action LOOP
        IF m = 'rules_engine' AND a = 'delete' THEN CONTINUE; END IF; -- safety
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('bank_admin', m, a, TRUE, 'migration:049')
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
    -- Admin surfaces
    FOREACH m IN ARRAY ARRAY['users','master_data','configuration','audit_trail'] LOOP
      FOREACH a IN ARRAY view_edit_export_approve LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('bank_admin', m, a, TRUE, 'migration:049')
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END IF;

  -- insurance_admin → insurance surfaces + admin
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'insurance_admin') THEN
    FOREACH m IN ARRAY insurance_mods LOOP
      FOREACH a IN ARRAY every_action LOOP
        IF m = 'rules_engine' AND a = 'delete' THEN CONTINUE; END IF;
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('insurance_admin', m, a, TRUE, 'migration:049')
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
    FOREACH m IN ARRAY ARRAY['users','master_data','configuration','audit_trail'] LOOP
      FOREACH a IN ARRAY view_edit_export_approve LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('insurance_admin', m, a, TRUE, 'migration:049')
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END IF;

  -- risk_analyst → analyse + simulate, no destructive ops
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'risk_analyst') THEN
    FOREACH m IN ARRAY risk_mods LOOP
      FOREACH a IN ARRAY view_create_edit LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('risk_analyst', m, a, TRUE, 'migration:049')
        ON CONFLICT DO NOTHING;
      END LOOP;
      -- export on top
      INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
      VALUES ('risk_analyst', m, 'export', TRUE, 'migration:049') ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- fraud_analyst → fraud surfaces
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'fraud_analyst') THEN
    FOREACH m IN ARRAY fraud_mods LOOP
      FOREACH a IN ARRAY view_edit_export LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('fraud_analyst', m, a, TRUE, 'migration:049') ON CONFLICT DO NOTHING;
      END LOOP;
      INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
      VALUES ('fraud_analyst', m, 'approve', TRUE, 'migration:049') ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- credit_officer → credit surfaces (view + edit + export, approve on cases)
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'credit_officer') THEN
    FOREACH m IN ARRAY credit_mods LOOP
      FOREACH a IN ARRAY view_edit_export LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('credit_officer', m, a, TRUE, 'migration:049') ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
    INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
    VALUES ('credit_officer', 'cases', 'approve', TRUE, 'migration:049') ON CONFLICT DO NOTHING;
  END IF;

  -- operations_user → ops surfaces (view + edit only)
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'operations_user') THEN
    FOREACH m IN ARRAY ops_mods LOOP
      FOREACH a IN ARRAY ARRAY['view','edit'] LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('operations_user', m, a, TRUE, 'migration:049') ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
    INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
    VALUES ('operations_user', 'reports', 'export', TRUE, 'migration:049') ON CONFLICT DO NOTHING;
  END IF;

  -- auditor → view + export on audit-relevant surfaces, no edit anywhere
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'auditor') THEN
    FOREACH m IN ARRAY audit_mods LOOP
      FOREACH a IN ARRAY view_export LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('auditor', m, a, TRUE, 'migration:049') ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END IF;

  -- read_only_user → strictly view, no edit anywhere
  IF EXISTS (SELECT 1 FROM app_iam.roles WHERE id = 'read_only_user') THEN
    FOREACH m IN ARRAY rdonly_mods LOOP
      FOREACH a IN ARRAY view_only LOOP
        INSERT INTO rbac.role_permission (role_id, module_id, action_id, granted, granted_by)
        VALUES ('read_only_user', m, a, TRUE, 'migration:049') ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END IF;
END $$;

COMMIT;
