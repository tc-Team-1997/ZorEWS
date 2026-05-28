-- 041_rbac_role_catalog.sql
--
-- Completes the enterprise RBAC role catalog with the 5 personas the EWS
-- spec enumerates beyond 038_iam_extensions. 100% additive: INSERT … ON
-- CONFLICT DO NOTHING into the existing app_iam.roles + role_permissions
-- (created + seeded by 038). No existing row is modified; re-runs are a
-- no-op. Each new enterprise role maps onto one of the 5 canonical
-- auth-svc backend roles (admin / risk_analyst / supervisor /
-- collection_officer / field_officer) via the `backend_role` column, so
-- runtime enforcement (matrix.json + requireRole) is unchanged.
--
-- New roles:
--   platform_auditor    — Platform Auditor (read-only across both domains)
--   claims_investigator — Insurance claim-fraud investigator
--   underwriting_officer— Insurance underwriting-deviation reviewer
--   persistency_manager — Insurance renewal-persistency / recovery driver
--   compliance_officer  — Insurance regulatory-compliance + audit reviewer

BEGIN;

INSERT INTO app_iam.roles (id, label, description, domain, scope_level, backend_role) VALUES
  ('platform_auditor',     'Platform Auditor',     'Read-only audit access across every country, tenant, and domain.', 'both',      'platform', 'field_officer'),
  ('claims_investigator',  'Claims Investigator',  'Investigates suspicious + anomalous insurance claims end to end.',  'insurance', 'tenant',   'risk_analyst'),
  ('underwriting_officer', 'Underwriting Officer', 'Reviews underwriting deviations + approves exceptions.',            'insurance', 'branch',   'supervisor'),
  ('persistency_manager',  'Persistency Manager',  'Drives renewal persistency + lapsed-premium recovery.',             'insurance', 'branch',   'collection_officer'),
  ('compliance_officer',   'Compliance Officer',   'Oversees regulatory compliance + reviews the audit trail.',         'insurance', 'tenant',   'supervisor')
ON CONFLICT (id) DO NOTHING;

-- role_permissions for the 5 new roles (mirrors the 038 DO-block pattern).
DO $$
DECLARE
  platform_auditor_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','cases:list','cases:read',
    'customers:read_risk_profile','reports:export','audit:read'
  ];
  claims_investigator_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','alerts:ack','cases:list','cases:read','cases:log_action','cases:close',
    'customers:read_risk_profile','reports:export','audit:read'
  ];
  underwriting_officer_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','alerts:ack','cases:list','cases:read','cases:log_action','cases:close',
    'customers:read_risk_profile','reports:export'
  ];
  persistency_manager_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','cases:list','cases:read','cases:log_action','cases:close',
    'customers:read_risk_profile','reports:export'
  ];
  compliance_officer_perms TEXT[] := ARRAY[
    'alerts:list','alerts:read','cases:list','cases:read',
    'customers:read_risk_profile','reports:export','reports:share','audit:read'
  ];
  role_record RECORD;
  perm TEXT;
BEGIN
  FOR role_record IN
    SELECT * FROM (VALUES
      ('platform_auditor',     platform_auditor_perms),
      ('claims_investigator',  claims_investigator_perms),
      ('underwriting_officer', underwriting_officer_perms),
      ('persistency_manager',  persistency_manager_perms),
      ('compliance_officer',   compliance_officer_perms)
    ) AS t(role_id, perms)
  LOOP
    FOREACH perm IN ARRAY role_record.perms
    LOOP
      INSERT INTO app_iam.role_permissions (role_id, permission_id, granted_by)
      VALUES (role_record.role_id, perm, 'migration:041')
      ON CONFLICT (role_id, permission_id) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
