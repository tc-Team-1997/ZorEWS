-- 051_tenant_governance.sql
--
-- Enterprise Tenant Governance overlay (Country → Tenant → Branch).
--
-- LAYERS ON TOP of what already exists:
--   * app_iam.countries (038) — currency/timezone/date_format/risk thresholds/regulators
--   * app_iam.tenants (005) — id/name/vertical/channels (banking + insurance)
--   * app_iam.user_roles (038) — multi-scope (country/tenant/branch/department)
--   * DBAC layer (050) — banking/insurance domain pin
--
-- Adds the 5 genuine gaps (all idempotent + additive):
--   1. app_iam.branches  — first-class branch registry (today free-text)
--   2. app_iam.compliance_rules — first-class country regulator rules table
--   3. app_iam.tenants.country_code — FK so HDFC Bank ↔ IN, ICICI Lombard ↔ IN
--   4. app_iam.tenants.parent_organization — HDFC Bank ≠ HDFC Ergo but same parent
--   5. app_iam.users.branch_id — convenience FK for single-branch users
--
-- Plus seeds 7 real-world tenants (HDFC Bank / ICICI Bank / SBI / HDFC Ergo /
-- ICICI Lombard / BANK_DEMO / BIL) + sample branches + sample compliance rules.
--
-- Backwards-compatible — every existing row stays unchanged; every existing
-- query continues to work. Re-runs are no-ops via ADD COLUMN IF NOT EXISTS
-- + CREATE TABLE IF NOT EXISTS + INSERT … ON CONFLICT DO NOTHING.

BEGIN;

-- ── 1. branches ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.branches (
  branch_id        TEXT        PRIMARY KEY,
  tenant_id        TEXT        NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  country_code     TEXT        NOT NULL REFERENCES app_iam.countries(code) ON DELETE RESTRICT,
  code             TEXT        NOT NULL,
    -- Bank-internal code (HDFC's "HDFC001", SBI's "SBI-MUM-001"). Unique per tenant.
  name             TEXT        NOT NULL,
  city             TEXT        NULL,
  state            TEXT        NULL,
  address          TEXT        NULL,
  phone            TEXT        NULL,
  email            TEXT        NULL,
  manager_user     TEXT        NULL REFERENCES app_iam.users(user_id) ON DELETE SET NULL,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ NULL,
  UNIQUE (tenant_id, code)
);
COMMENT ON TABLE app_iam.branches IS
  'First-class branch registry (was free-text). Branch governance: users.branch_id + requireBranchAccess middleware key off this.';

CREATE INDEX IF NOT EXISTS ix_app_iam_branches_tenant
  ON app_iam.branches (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_app_iam_branches_country
  ON app_iam.branches (country_code) WHERE deleted_at IS NULL;

-- BEFORE-UPDATE trigger keeping updated_at fresh.
CREATE OR REPLACE FUNCTION app_iam.branches_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_iam_branches_touch ON app_iam.branches;
CREATE TRIGGER app_iam_branches_touch
  BEFORE UPDATE ON app_iam.branches
  FOR EACH ROW EXECUTE FUNCTION app_iam.branches_touch_updated_at();

-- ── 2. compliance_rules ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_iam.compliance_rules (
  rule_id          TEXT        PRIMARY KEY,
  country_code     TEXT        NOT NULL REFERENCES app_iam.countries(code) ON DELETE CASCADE,
  regulator        TEXT        NOT NULL,
    -- 'RBI' | 'IRDAI' | 'RMA' | 'CBK' | 'NRB' | 'CBSL' | 'FIU' etc. Open enum.
  domain           TEXT        NOT NULL,
    -- 'banking' | 'insurance' | 'both' — scopes rule to a vertical.
  rule_code        TEXT        NOT NULL,
    -- Public regulator identifier: 'RBI-MD-NPL', 'IRDAI-CG-2016' etc.
  title            TEXT        NOT NULL,
  description      TEXT        NOT NULL,
  requirement_kind TEXT        NOT NULL,
    -- 'reporting' | 'capital' | 'kyc' | 'sanctions' | 'governance' | 'data_residency' | 'audit'
  severity         TEXT        NOT NULL DEFAULT 'mandatory',
    -- 'mandatory' | 'recommended' | 'advisory'
  effective_from   DATE        NULL,
  effective_until  DATE        NULL,
  source_url       TEXT        NULL,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ NULL,
  CHECK (domain IN ('banking', 'insurance', 'both')),
  CHECK (severity IN ('mandatory', 'recommended', 'advisory')),
  CHECK (requirement_kind IN ('reporting', 'capital', 'kyc', 'sanctions', 'governance', 'data_residency', 'audit')),
  UNIQUE (country_code, regulator, rule_code)
);
COMMENT ON TABLE app_iam.compliance_rules IS
  'Per-country compliance rules table. Layers on top of app_iam.countries.regulators_* arrays.';

CREATE INDEX IF NOT EXISTS ix_app_iam_compliance_rules_country
  ON app_iam.compliance_rules (country_code) WHERE active = TRUE AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_app_iam_compliance_rules_regulator
  ON app_iam.compliance_rules (regulator) WHERE active = TRUE AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS app_iam_compliance_rules_touch ON app_iam.compliance_rules;
CREATE TRIGGER app_iam_compliance_rules_touch
  BEFORE UPDATE ON app_iam.compliance_rules
  FOR EACH ROW EXECUTE FUNCTION app_iam.branches_touch_updated_at();

-- ── 3. tenants.country_code + parent_organization ──────────────────
ALTER TABLE app_iam.tenants
  ADD COLUMN IF NOT EXISTS country_code TEXT NULL,
  ADD COLUMN IF NOT EXISTS parent_organization TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_iam_tenants_country_fk'
  ) THEN
    ALTER TABLE app_iam.tenants
      ADD CONSTRAINT app_iam_tenants_country_fk
      FOREIGN KEY (country_code) REFERENCES app_iam.countries(code) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_app_iam_tenants_country
  ON app_iam.tenants (country_code) WHERE country_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_app_iam_tenants_parent
  ON app_iam.tenants (parent_organization) WHERE parent_organization IS NOT NULL;

COMMENT ON COLUMN app_iam.tenants.country_code IS 'FK to app_iam.countries.code (NULL = legacy, pre-051).';
COMMENT ON COLUMN app_iam.tenants.parent_organization IS 'Group label (e.g. "HDFC Group", "ICICI Group") so HDFC Bank + HDFC Ergo cluster.';

-- ── 4. users.branch_id convenience FK ──────────────────────────────
ALTER TABLE app_iam.users
  ADD COLUMN IF NOT EXISTS branch_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_iam_users_branch_fk'
  ) THEN
    ALTER TABLE app_iam.users
      ADD CONSTRAINT app_iam_users_branch_fk
      FOREIGN KEY (branch_id) REFERENCES app_iam.branches(branch_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_app_iam_users_branch
  ON app_iam.users (branch_id) WHERE branch_id IS NOT NULL;

COMMENT ON COLUMN app_iam.users.branch_id IS
  'Convenience per-user branch pin (NULL = no branch / inherits from user_roles). Composes with requireBranchAccess middleware.';

-- ── 5. seed real tenants per the user spec ──────────────────────────
-- Banking: HDFC Bank / ICICI Bank / SBI / BANK_DEMO (pre-existing)
-- Insurance: HDFC Ergo / ICICI Lombard / BIL (pre-existing)
INSERT INTO app_iam.tenants
  (tenant_id, name, vertical, channels_allowed, country_code, parent_organization)
VALUES
  ('HDFC_BANK',     'HDFC Bank Limited',              'banking',   ARRAY['LOS','MOBILE','BRANCH','API'],   'IN', 'HDFC Group'),
  ('ICICI_BANK',    'ICICI Bank Limited',             'banking',   ARRAY['LOS','MOBILE','BRANCH','API'],   'IN', 'ICICI Group'),
  ('SBI',           'State Bank of India',            'banking',   ARRAY['LOS','MOBILE','BRANCH','API'],   'IN', 'SBI Group'),
  ('HDFC_ERGO',     'HDFC ERGO General Insurance',    'insurance', ARRAY['BRANCH','AGENT_PORTAL','API'],   'IN', 'HDFC Group'),
  ('ICICI_LOMBARD', 'ICICI Lombard General Insurance','insurance', ARRAY['BRANCH','AGENT_PORTAL','API'],   'IN', 'ICICI Group')
ON CONFLICT (tenant_id) DO NOTHING;

-- Backfill country_code on the 2 pre-existing tenants (no-op if already set).
UPDATE app_iam.tenants SET country_code = 'IN'
  WHERE tenant_id = 'BANK_DEMO' AND country_code IS NULL;
UPDATE app_iam.tenants SET country_code = 'BT'
  WHERE tenant_id = 'BIL' AND country_code IS NULL;

-- ── 6. seed sample branches per real tenant ────────────────────────
INSERT INTO app_iam.branches
  (branch_id, tenant_id, country_code, code, name, city, state, active)
VALUES
  -- HDFC Bank
  ('br-hdfc-mumbai-fort',    'HDFC_BANK',     'IN', 'HDFC001', 'HDFC Bank Fort Branch',         'Mumbai',  'Maharashtra', TRUE),
  ('br-hdfc-delhi-cp',       'HDFC_BANK',     'IN', 'HDFC002', 'HDFC Bank Connaught Place',     'Delhi',   'Delhi',       TRUE),
  ('br-hdfc-bengaluru-mg',   'HDFC_BANK',     'IN', 'HDFC003', 'HDFC Bank MG Road',             'Bengaluru','Karnataka',  TRUE),
  -- ICICI Bank
  ('br-icici-mumbai-bkc',    'ICICI_BANK',    'IN', 'ICIC001', 'ICICI Bank BKC',                'Mumbai',  'Maharashtra', TRUE),
  ('br-icici-pune-baner',    'ICICI_BANK',    'IN', 'ICIC002', 'ICICI Bank Baner',              'Pune',    'Maharashtra', TRUE),
  -- SBI
  ('br-sbi-mumbai-main',     'SBI',           'IN', 'SBI001',  'State Bank of India Main',      'Mumbai',  'Maharashtra', TRUE),
  ('br-sbi-chennai-anna',    'SBI',           'IN', 'SBI002',  'SBI Anna Salai',                'Chennai', 'Tamil Nadu',  TRUE),
  -- Insurance
  ('br-hdfcergo-mumbai-hq',  'HDFC_ERGO',     'IN', 'HERGO01', 'HDFC ERGO Mumbai HQ',           'Mumbai',  'Maharashtra', TRUE),
  ('br-icicilom-mumbai-hq',  'ICICI_LOMBARD', 'IN', 'ILOM001', 'ICICI Lombard Mumbai HQ',       'Mumbai',  'Maharashtra', TRUE),
  -- BANK_DEMO + BIL legacy
  ('br-bank-demo-main',      'BANK_DEMO',     'IN', 'DEMO001', 'APEX Demo Bank — Main',         'Mumbai',  'Maharashtra', TRUE),
  ('br-bil-thimphu',         'BIL',           'BT', 'BIL001',  'BIL Thimphu Head Office',       'Thimphu', 'Thimphu',     TRUE)
ON CONFLICT (branch_id) DO NOTHING;

-- ── 7. seed sample compliance rules (RBI + IRDAI + RMA + CBK) ──────
INSERT INTO app_iam.compliance_rules
  (rule_id, country_code, regulator, domain, rule_code, title, description, requirement_kind, severity, effective_from, source_url)
VALUES
  ('cr-rbi-md-npa',   'IN', 'RBI',   'banking',  'RBI-MD-NPA-2024',   'IRACP — Income Recognition and Asset Classification',
   'Loans classified as NPA when DPD ≥ 90; SMA-0/1/2 tiers per DPD bracket. Quarterly reporting to RBI.',
   'reporting',     'mandatory',   '2024-04-01', 'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx'),
  ('cr-rbi-pmla',     'IN', 'RBI',   'banking',  'RBI-PMLA-2002',     'PMLA — Anti Money Laundering',
   'KYC + Sanctions screening + STR/CTR reporting to FIU-IND.',
   'kyc',           'mandatory',   '2002-07-01', 'https://www.fiuindia.gov.in/'),
  ('cr-rbi-basel3',   'IN', 'RBI',   'banking',  'RBI-BASEL-III',     'Basel III Capital Adequacy',
   'Min CET1 + Tier-1 + Total CRAR ratios with capital conservation buffer.',
   'capital',       'mandatory',   '2013-04-01', 'https://www.rbi.org.in/'),
  ('cr-irdai-cg',     'IN', 'IRDAI', 'insurance','IRDAI-CG-2016',     'Corporate Governance Guidelines',
   'Board composition + risk committees + investment committee + audit committee.',
   'governance',    'mandatory',   '2016-05-18', 'https://www.irdai.gov.in/'),
  ('cr-irdai-claims', 'IN', 'IRDAI', 'insurance','IRDAI-CLM-2024',    'Claim Settlement Turnaround Time',
   'Acknowledge claim within 24h; settle within 30 days of last document received.',
   'reporting',     'mandatory',   '2024-04-01', 'https://www.irdai.gov.in/'),
  ('cr-rma-bt-cap',   'BT', 'RMA',   'banking',  'RMA-CAP-2022',      'Capital Adequacy Framework',
   'Minimum CRAR 12.5% for Bhutan-registered banks.',
   'capital',       'mandatory',   '2022-01-01', 'https://www.rma.org.bt/'),
  ('cbk-fia-2009',    'KE', 'CBK',   'banking',  'CBK-FIA-2009',      'Banking Act CAP 488 Compliance',
   'Periodic returns + capital ratios per Banking Act of Kenya.',
   'reporting',     'mandatory',   '2009-01-01', 'https://www.centralbank.go.ke/'),
  ('cr-rbi-data-res', 'IN', 'RBI',   'both',     'RBI-DATA-RES-2018', 'Data Localisation for Payment Systems',
   'All payment-system data must be stored in India; cross-border processing allowed but original must reside in IN.',
   'data_residency','mandatory',   '2018-10-15', 'https://www.rbi.org.in/'),
  ('cr-fiu-str',      'IN', 'FIU',   'both',     'FIU-STR-2005',      'Suspicious Transaction Report filing',
   'STR within 7 working days of suspicion arising; record retention 5 years post-transaction.',
   'sanctions',     'mandatory',   '2005-07-01', 'https://www.fiuindia.gov.in/')
ON CONFLICT (country_code, regulator, rule_code) DO NOTHING;

COMMIT;
