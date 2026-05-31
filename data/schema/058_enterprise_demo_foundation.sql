-- data/schema/058_enterprise_demo_foundation.sql
--
-- Enterprise Demo Data Foundation — additive schema (15th IA overlay).
--
-- 15 additive tables backing the deterministic engines under
-- web/src/modules/enterpriseDemo/. Idempotent: safe to re-run via
-- `make migrate`. Zero alteration to existing tables — every CREATE TABLE
-- wraps in IF NOT EXISTS. Existing demo data (raw seeds, app_*, mart, etc.)
-- remain intact.
--
-- All tables live under `app_iam.*` (consistent with the prior 14 IA overlays).
-- The SPA reads from the deterministic engines today; this schema is the
-- forward-looking persistence target for when the BFF wires `/v1/enterprise-demo/*`
-- to a real Aurora-backed store.
--
-- Tables (15):
--   1.  demo_banks                       — 5 seed banks (HDFC, ICICI, SBI, Axis, Kotak)
--   2.  demo_bank_branches               — 50 branches across regions/states
--   3.  demo_bank_customers              — 10000 customers (paginated read)
--   4.  demo_bank_accounts               — 50000 accounts
--   5.  demo_bank_loans                  — 20000 loans with DPD + SMA + NPA
--   6.  demo_insurers                    — 3 insurers (ICICI Lombard, HDFC Ergo, SBI General)
--   7.  demo_insurance_customers         — 20000 customers
--   8.  demo_insurance_policies          — 5000 policies
--   9.  demo_insurance_claims            — 3000 claims
--   10. demo_insurance_fraud_cases       — 500 fraud cases
--   11. demo_insurance_agents            — 200 agents
--   12. demo_enterprise_alerts           — 2000 alerts (1200 banking + 800 insurance)
--   13. demo_enterprise_cases            — 800 investigation cases
--   14. demo_enterprise_forecasts        — 24 forecasts (6 kinds × 4 horizons)
--   15. demo_compliance_obligations      — 40 obligations across 7 frameworks
--
-- Backward compatibility: every existing table (Master Setup, app_alerts, app_cases,
-- app_bff, app_scenario, app_iam.tenants, mart.*, raw.*, audit.*) untouched.
-- Existing demo seed data (014 + 015 + 057_data_fabric + others) remain intact.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. demo_banks
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_banks (
    bank_id        TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name           TEXT NOT NULL,
    code           TEXT NOT NULL,
    hq_city        TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS demo_banks_tenant_idx ON app_iam.demo_banks(tenant_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. demo_bank_branches
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_bank_branches (
    branch_id      TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    bank_id        TEXT NOT NULL REFERENCES app_iam.demo_banks(bank_id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    region         TEXT NOT NULL,
    state          TEXT NOT NULL,
    city           TEXT NOT NULL,
    ifsc_prefix    TEXT NOT NULL,
    opened_at      DATE NOT NULL,

    CONSTRAINT demo_bank_branches_region_chk CHECK (
        region IN ('north', 'south', 'east', 'west', 'central')
    )
);

CREATE INDEX IF NOT EXISTS demo_bank_branches_bank_idx ON app_iam.demo_bank_branches(bank_id);
CREATE INDEX IF NOT EXISTS demo_bank_branches_tenant_region_idx
    ON app_iam.demo_bank_branches(tenant_id, region);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. demo_bank_customers
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_bank_customers (
    customer_id    TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    bank_id        TEXT NOT NULL REFERENCES app_iam.demo_banks(bank_id) ON DELETE CASCADE,
    pan            TEXT NOT NULL,
    full_name      TEXT NOT NULL,
    gender         TEXT NOT NULL,
    dob            DATE NOT NULL,
    city           TEXT NOT NULL,
    state          TEXT NOT NULL,
    phone          TEXT NOT NULL,
    email          TEXT NOT NULL,
    segment        TEXT NOT NULL,
    metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT demo_bank_customers_segment_chk CHECK (
        segment IN ('retail', 'sme', 'corporate')
    ),
    CONSTRAINT demo_bank_customers_gender_chk CHECK (
        gender IN ('male', 'female', 'other')
    )
);

CREATE INDEX IF NOT EXISTS demo_bank_customers_tenant_bank_idx
    ON app_iam.demo_bank_customers(tenant_id, bank_id);
CREATE INDEX IF NOT EXISTS demo_bank_customers_segment_idx
    ON app_iam.demo_bank_customers(tenant_id, segment);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. demo_bank_accounts
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_bank_accounts (
    account_id     TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    customer_id    TEXT NOT NULL REFERENCES app_iam.demo_bank_customers(customer_id) ON DELETE CASCADE,
    bank_id        TEXT NOT NULL REFERENCES app_iam.demo_banks(bank_id) ON DELETE CASCADE,
    branch_id      TEXT NOT NULL REFERENCES app_iam.demo_bank_branches(branch_id) ON DELETE CASCADE,
    account_type   TEXT NOT NULL,
    balance_inr    NUMERIC(18, 2) NOT NULL DEFAULT 0,
    opened_at      DATE NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT demo_bank_accounts_type_chk CHECK (
        account_type IN ('savings', 'current', 'overdraft')
    ),
    CONSTRAINT demo_bank_accounts_status_chk CHECK (
        status IN ('active', 'dormant', 'frozen')
    )
);

CREATE INDEX IF NOT EXISTS demo_bank_accounts_customer_idx
    ON app_iam.demo_bank_accounts(customer_id);
CREATE INDEX IF NOT EXISTS demo_bank_accounts_branch_idx
    ON app_iam.demo_bank_accounts(branch_id);
CREATE INDEX IF NOT EXISTS demo_bank_accounts_tenant_status_idx
    ON app_iam.demo_bank_accounts(tenant_id, status);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. demo_bank_loans
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_bank_loans (
    loan_id              TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    customer_id          TEXT NOT NULL REFERENCES app_iam.demo_bank_customers(customer_id) ON DELETE CASCADE,
    bank_id              TEXT NOT NULL REFERENCES app_iam.demo_banks(bank_id) ON DELETE CASCADE,
    branch_id            TEXT NOT NULL REFERENCES app_iam.demo_bank_branches(branch_id) ON DELETE CASCADE,
    loan_type            TEXT NOT NULL,
    sector               TEXT NOT NULL,
    principal_inr        NUMERIC(18, 2) NOT NULL,
    outstanding_inr      NUMERIC(18, 2) NOT NULL,
    emi_inr              NUMERIC(14, 2) NOT NULL,
    dpd_days             INTEGER NOT NULL DEFAULT 0,
    dpd_bucket           TEXT NOT NULL,
    status               TEXT NOT NULL,
    sanctioned_at        DATE NOT NULL,
    tenure_months        INTEGER NOT NULL,
    credit_utilization_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    sector_exposure_inr  NUMERIC(18, 2) NOT NULL DEFAULT 0,
    missed_emi_count     INTEGER NOT NULL DEFAULT 0,
    metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT demo_bank_loans_type_chk CHECK (
        loan_type IN ('home', 'personal', 'vehicle', 'education', 'business')
    ),
    CONSTRAINT demo_bank_loans_status_chk CHECK (
        status IN ('active', 'watchlist', 'sma0', 'sma1', 'sma2', 'npa')
    ),
    CONSTRAINT demo_bank_loans_dpd_bucket_chk CHECK (
        dpd_bucket IN ('0', '1-30', '31-60', '61-90', '91-180', '180_plus')
    ),
    CONSTRAINT demo_bank_loans_sector_chk CHECK (
        sector IN ('agriculture', 'msme', 'corporate', 'retail',
                   'infrastructure', 'services', 'manufacturing')
    )
);

CREATE INDEX IF NOT EXISTS demo_bank_loans_tenant_status_idx
    ON app_iam.demo_bank_loans(tenant_id, status);
CREATE INDEX IF NOT EXISTS demo_bank_loans_customer_idx
    ON app_iam.demo_bank_loans(customer_id);
CREATE INDEX IF NOT EXISTS demo_bank_loans_sector_idx
    ON app_iam.demo_bank_loans(tenant_id, sector);
CREATE INDEX IF NOT EXISTS demo_bank_loans_npa_idx
    ON app_iam.demo_bank_loans(tenant_id) WHERE status = 'npa';

-- ───────────────────────────────────────────────────────────────────────────
-- 6. demo_insurers
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_insurers (
    insurer_id     TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    name           TEXT NOT NULL,
    code           TEXT NOT NULL,
    hq_city        TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS demo_insurers_tenant_idx ON app_iam.demo_insurers(tenant_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. demo_insurance_customers
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_insurance_customers (
    customer_id    TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    insurer_id     TEXT NOT NULL REFERENCES app_iam.demo_insurers(insurer_id) ON DELETE CASCADE,
    pan            TEXT NOT NULL,
    full_name      TEXT NOT NULL,
    dob            DATE NOT NULL,
    city           TEXT NOT NULL,
    state          TEXT NOT NULL,
    phone          TEXT NOT NULL,
    email          TEXT NOT NULL,
    segment        TEXT NOT NULL,

    CONSTRAINT demo_insurance_customers_segment_chk CHECK (
        segment IN ('retail', 'sme', 'corporate')
    )
);

CREATE INDEX IF NOT EXISTS demo_insurance_customers_insurer_idx
    ON app_iam.demo_insurance_customers(insurer_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. demo_insurance_policies
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_insurance_policies (
    policy_id              TEXT PRIMARY KEY,
    tenant_id              TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    customer_id            TEXT NOT NULL REFERENCES app_iam.demo_insurance_customers(customer_id) ON DELETE CASCADE,
    insurer_id             TEXT NOT NULL REFERENCES app_iam.demo_insurers(insurer_id) ON DELETE CASCADE,
    policy_type            TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'active',
    sum_assured_inr        NUMERIC(18, 2) NOT NULL,
    annual_premium_inr     NUMERIC(14, 2) NOT NULL,
    tenure_years           INTEGER NOT NULL,
    issued_at              DATE NOT NULL,
    expires_at             DATE NOT NULL,
    agent_id               TEXT,
    underwriting_score     NUMERIC(5, 2) NOT NULL DEFAULT 50,
    persistency_pct        NUMERIC(5, 2) NOT NULL DEFAULT 100,
    missed_premiums_count  INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT demo_insurance_policies_type_chk CHECK (
        policy_type IN ('health', 'motor', 'life', 'travel', 'commercial')
    ),
    CONSTRAINT demo_insurance_policies_status_chk CHECK (
        status IN ('active', 'high_risk', 'lapse_risk', 'lapsed')
    ),
    CONSTRAINT demo_insurance_policies_uw_chk CHECK (
        underwriting_score BETWEEN 0 AND 100
    ),
    CONSTRAINT demo_insurance_policies_persistency_chk CHECK (
        persistency_pct BETWEEN 0 AND 100
    )
);

CREATE INDEX IF NOT EXISTS demo_insurance_policies_tenant_status_idx
    ON app_iam.demo_insurance_policies(tenant_id, status);
CREATE INDEX IF NOT EXISTS demo_insurance_policies_customer_idx
    ON app_iam.demo_insurance_policies(customer_id);
CREATE INDEX IF NOT EXISTS demo_insurance_policies_type_idx
    ON app_iam.demo_insurance_policies(tenant_id, policy_type);

-- ───────────────────────────────────────────────────────────────────────────
-- 9. demo_insurance_claims
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_insurance_claims (
    claim_id                TEXT PRIMARY KEY,
    tenant_id               TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    policy_id               TEXT NOT NULL REFERENCES app_iam.demo_insurance_policies(policy_id) ON DELETE CASCADE,
    customer_id             TEXT NOT NULL REFERENCES app_iam.demo_insurance_customers(customer_id) ON DELETE CASCADE,
    insurer_id              TEXT NOT NULL REFERENCES app_iam.demo_insurers(insurer_id) ON DELETE CASCADE,
    status                  TEXT NOT NULL,
    claim_amount_inr        NUMERIC(18, 2) NOT NULL,
    approved_amount_inr     NUMERIC(18, 2) NOT NULL DEFAULT 0,
    filed_at                TIMESTAMPTZ NOT NULL,
    closed_at               TIMESTAMPTZ,
    reason_code             TEXT,
    investigator_username   TEXT,
    fraud_score             NUMERIC(5, 2) NOT NULL DEFAULT 0,
    is_fraud_flagged        BOOLEAN NOT NULL DEFAULT FALSE,

    CONSTRAINT demo_insurance_claims_status_chk CHECK (
        status IN ('submitted', 'investigating', 'approved', 'rejected', 'paid')
    ),
    CONSTRAINT demo_insurance_claims_fraud_chk CHECK (fraud_score BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS demo_insurance_claims_tenant_status_idx
    ON app_iam.demo_insurance_claims(tenant_id, status);
CREATE INDEX IF NOT EXISTS demo_insurance_claims_policy_idx
    ON app_iam.demo_insurance_claims(policy_id);
CREATE INDEX IF NOT EXISTS demo_insurance_claims_fraud_idx
    ON app_iam.demo_insurance_claims(tenant_id) WHERE is_fraud_flagged = TRUE;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. demo_insurance_fraud_cases
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_insurance_fraud_cases (
    fraud_id              TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    claim_id              TEXT NOT NULL REFERENCES app_iam.demo_insurance_claims(claim_id) ON DELETE CASCADE,
    policy_id             TEXT NOT NULL REFERENCES app_iam.demo_insurance_policies(policy_id) ON DELETE CASCADE,
    customer_id           TEXT NOT NULL REFERENCES app_iam.demo_insurance_customers(customer_id) ON DELETE CASCADE,
    insurer_id            TEXT NOT NULL REFERENCES app_iam.demo_insurers(insurer_id) ON DELETE CASCADE,
    fraud_type            TEXT NOT NULL,
    evidence_score        NUMERIC(5, 2) NOT NULL DEFAULT 0,
    investigator_username TEXT NOT NULL,
    reported_at           TIMESTAMPTZ NOT NULL,
    status                TEXT NOT NULL DEFAULT 'open',
    estimated_loss_inr    NUMERIC(18, 2) NOT NULL DEFAULT 0,

    CONSTRAINT demo_fraud_type_chk CHECK (
        fraud_type IN ('staged_accident', 'inflated_billing', 'identity_fraud',
                       'fake_documents', 'collusion')
    ),
    CONSTRAINT demo_fraud_status_chk CHECK (
        status IN ('open', 'investigating', 'confirmed', 'cleared')
    )
);

CREATE INDEX IF NOT EXISTS demo_insurance_fraud_tenant_status_idx
    ON app_iam.demo_insurance_fraud_cases(tenant_id, status);

-- ───────────────────────────────────────────────────────────────────────────
-- 11. demo_insurance_agents
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_insurance_agents (
    agent_id              TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    insurer_id            TEXT NOT NULL REFERENCES app_iam.demo_insurers(insurer_id) ON DELETE CASCADE,
    full_name             TEXT NOT NULL,
    branch_city           TEXT NOT NULL,
    joined_at             DATE NOT NULL,
    policies_sold         INTEGER NOT NULL DEFAULT 0,
    persistency_pct       NUMERIC(5, 2) NOT NULL DEFAULT 0,
    complaints_count      INTEGER NOT NULL DEFAULT 0,
    performance_score     NUMERIC(5, 2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS demo_insurance_agents_insurer_idx
    ON app_iam.demo_insurance_agents(insurer_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 12. demo_enterprise_alerts
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_enterprise_alerts (
    alert_id              TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    domain                TEXT NOT NULL,
    kind                  TEXT NOT NULL,
    subject_id            TEXT NOT NULL,
    subject_kind          TEXT NOT NULL,
    severity              TEXT NOT NULL,
    risk_score            NUMERIC(5, 2) NOT NULL,
    trigger_source        TEXT NOT NULL,
    raised_at             TIMESTAMPTZ NOT NULL,
    owner_username        TEXT NOT NULL,
    assigned_team         TEXT NOT NULL,
    escalation_status     TEXT NOT NULL DEFAULT 'none',
    status                TEXT NOT NULL DEFAULT 'open',
    sla_due_at            TIMESTAMPTZ NOT NULL,
    tags                  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    description           TEXT NOT NULL,

    CONSTRAINT demo_alerts_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT demo_alerts_severity_chk CHECK (
        severity IN ('low', 'medium', 'high', 'critical')
    ),
    CONSTRAINT demo_alerts_subject_kind_chk CHECK (
        subject_kind IN ('loan', 'policy', 'claim', 'customer')
    ),
    CONSTRAINT demo_alerts_status_chk CHECK (
        status IN ('open', 'acknowledged', 'in_investigation', 'closed')
    ),
    CONSTRAINT demo_alerts_escalation_chk CHECK (
        escalation_status IN ('none', 'sla_warning', 'sla_breached',
                              'escalated_l1', 'escalated_l2', 'escalated_exec')
    )
);

CREATE INDEX IF NOT EXISTS demo_alerts_tenant_domain_severity_idx
    ON app_iam.demo_enterprise_alerts(tenant_id, domain, severity, raised_at DESC);
CREATE INDEX IF NOT EXISTS demo_alerts_open_idx
    ON app_iam.demo_enterprise_alerts(tenant_id, raised_at DESC)
    WHERE status = 'open';

-- ───────────────────────────────────────────────────────────────────────────
-- 13. demo_enterprise_cases
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_enterprise_cases (
    case_id               TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    alert_id              TEXT NOT NULL REFERENCES app_iam.demo_enterprise_alerts(alert_id) ON DELETE CASCADE,
    domain                TEXT NOT NULL,
    case_type             TEXT NOT NULL,
    subject_id            TEXT NOT NULL,
    subject_kind          TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'open',
    severity              TEXT NOT NULL,
    opened_at             TIMESTAMPTZ NOT NULL,
    closed_at             TIMESTAMPTZ,
    assigned_investigator TEXT NOT NULL,
    closure_reason        TEXT,
    total_evidence_count  INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT demo_cases_status_chk CHECK (
        status IN ('open', 'in_progress', 'escalated', 'closed')
    ),
    CONSTRAINT demo_cases_severity_chk CHECK (
        severity IN ('low', 'medium', 'high', 'critical')
    ),
    CONSTRAINT demo_cases_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT demo_cases_case_type_chk CHECK (
        case_type IN ('credit_risk', 'fraud_investigation', 'collections_review',
                      'claim_fraud', 'policy_review', 'underwriting_investigation')
    ),
    CONSTRAINT demo_cases_closure_chk CHECK (
        closure_reason IS NULL OR closure_reason IN (
            'fraud_confirmed', 'risk_remediated', 'false_positive', 'no_action_needed'
        )
    )
);

CREATE INDEX IF NOT EXISTS demo_cases_tenant_status_idx
    ON app_iam.demo_enterprise_cases(tenant_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS demo_cases_alert_idx
    ON app_iam.demo_enterprise_cases(alert_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 14. demo_enterprise_forecasts
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_enterprise_forecasts (
    forecast_id           TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    domain                TEXT NOT NULL,
    kind                  TEXT NOT NULL,
    horizon               TEXT NOT NULL,
    generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    baseline_value        NUMERIC(18, 4) NOT NULL,
    forecast_value        NUMERIC(18, 4) NOT NULL,
    delta_pct             NUMERIC(8, 4) NOT NULL,
    confidence_score      NUMERIC(4, 3) NOT NULL,
    risk_drivers          JSONB NOT NULL DEFAULT '[]'::jsonb,
    recommended_actions   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT demo_forecasts_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT demo_forecasts_horizon_chk CHECK (
        horizon IN ('30d', '60d', '90d', '180d')
    ),
    CONSTRAINT demo_forecasts_confidence_chk CHECK (confidence_score BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS demo_forecasts_tenant_horizon_idx
    ON app_iam.demo_enterprise_forecasts(tenant_id, horizon);

-- ───────────────────────────────────────────────────────────────────────────
-- 15. demo_compliance_obligations
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.demo_compliance_obligations (
    obligation_id         TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    framework             TEXT NOT NULL,
    domain                TEXT NOT NULL,
    title                 TEXT NOT NULL,
    description           TEXT,
    due_date              DATE NOT NULL,
    owner_username        TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'compliant',
    severity              TEXT NOT NULL DEFAULT 'medium',
    days_to_due           INTEGER NOT NULL,

    CONSTRAINT demo_obligations_framework_chk CHECK (
        framework IN ('rbi', 'basel', 'aml', 'kyc',
                      'irdai', 'solvency', 'claims_compliance')
    ),
    CONSTRAINT demo_obligations_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT demo_obligations_status_chk CHECK (
        status IN ('compliant', 'due_soon', 'overdue', 'breach', 'remediation')
    ),
    CONSTRAINT demo_obligations_severity_chk CHECK (
        severity IN ('low', 'medium', 'high', 'critical')
    )
);

CREATE INDEX IF NOT EXISTS demo_obligations_tenant_status_idx
    ON app_iam.demo_compliance_obligations(tenant_id, status, due_date);
CREATE INDEX IF NOT EXISTS demo_obligations_framework_idx
    ON app_iam.demo_compliance_obligations(tenant_id, framework);

-- ───────────────────────────────────────────────────────────────────────────
-- Seed the 5 banks + 3 insurers per BANK_DEMO so the page shows non-empty
-- inventory on a fresh apply. Engines synthesise everything else on demand.
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO app_iam.demo_banks (bank_id, tenant_id, name, code, hq_city) VALUES
    ('BANK-HDFC',  'BANK_DEMO', 'HDFC Bank',       'HDFC', 'Mumbai'),
    ('BANK-ICICI', 'BANK_DEMO', 'ICICI Bank',      'ICIC', 'Mumbai'),
    ('BANK-SBI',   'BANK_DEMO', 'SBI',             'SBIN', 'Mumbai'),
    ('BANK-AXIS',  'BANK_DEMO', 'Axis Bank',       'UTIB', 'Mumbai'),
    ('BANK-KOTAK', 'BANK_DEMO', 'Kotak Mahindra',  'KKBK', 'Mumbai')
ON CONFLICT (bank_id) DO NOTHING;

INSERT INTO app_iam.demo_insurers (insurer_id, tenant_id, name, code, hq_city) VALUES
    ('INS-ICICI-LOMBARD', 'BANK_DEMO', 'ICICI Lombard', 'ICILO', 'Mumbai'),
    ('INS-HDFC-ERGO',     'BANK_DEMO', 'HDFC Ergo',     'HDFCE', 'Mumbai'),
    ('INS-SBI-GENERAL',   'BANK_DEMO', 'SBI General',   'SBIGN', 'Mumbai')
ON CONFLICT (insurer_id) DO NOTHING;
