-- data/schema/056_regulatory_compliance.sql
--
-- Regulatory Compliance Center — additive schema (13th IA addition this session).
--
-- Seven tables backing the new /regulatory-compliance-center surface.
-- Idempotent: safe to re-run via `make migrate` against an already-applied DB.
-- Zero alterations to existing tables; only IF NOT EXISTS additions.
--
-- Tables (all under app_iam.*)
--   1. regulatory_frameworks       — closed-enum framework registry (RBI / Basel / IRDAI / Solvency / …)
--   2. compliance_obligations      — Obligation Registry per the brief
--   3. compliance_reviews          — review-cycle log per obligation
--   4. compliance_findings         — open findings + remediation lifecycle
--   5. regulatory_reports          — report registry (RBI / Basel / AML / KYC / IRDAI / Solvency / Fraud / Executive)
--   6. regulatory_calendar         — filing deadlines + review cycles + board reviews
--   7. compliance_actions          — workflow action log (assign / review / approve / reject / escalate / submit)
--
-- Backward compatibility — every existing table untouched. Migrations 001-055
-- continue to apply cleanly.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. regulatory_frameworks — closed-enum framework registry
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.regulatory_frameworks (
    framework             TEXT PRIMARY KEY,
    domain                TEXT NOT NULL,
    label                 TEXT NOT NULL,
    regulator             TEXT NOT NULL,
    description           TEXT,
    primary_geography     TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT regulatory_frameworks_domain_chk CHECK (domain IN ('banking', 'insurance'))
);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. compliance_obligations — Obligation Registry
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.compliance_obligations (
    obligation_id         TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    regulation            TEXT NOT NULL,
    framework             TEXT NOT NULL,
    domain                TEXT NOT NULL,
    clause                TEXT,
    category              TEXT NOT NULL,
    owner                 TEXT NOT NULL,
    review_frequency      TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'compliant',
    last_review_date      DATE,
    next_due_date         DATE NOT NULL,
    priority              TEXT NOT NULL DEFAULT 'moderate',
    description           TEXT,
    evidence_required     BOOLEAN NOT NULL DEFAULT FALSE,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT compliance_obligations_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT compliance_obligations_category_chk CHECK (
        category IN ('filing', 'review', 'audit', 'submission', 'board_review', 'monitoring')
    ),
    CONSTRAINT compliance_obligations_frequency_chk CHECK (
        review_frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'semi_annual', 'annual', 'ad_hoc')
    ),
    CONSTRAINT compliance_obligations_status_chk CHECK (
        status IN ('compliant', 'at_risk', 'overdue', 'in_review', 'closed')
    ),
    CONSTRAINT compliance_obligations_priority_chk CHECK (
        priority IN ('low', 'moderate', 'high', 'severe', 'critical')
    )
);

CREATE INDEX IF NOT EXISTS compliance_obligations_tenant_status_idx
    ON app_iam.compliance_obligations(tenant_id, status, next_due_date ASC);
CREATE INDEX IF NOT EXISTS compliance_obligations_framework_idx
    ON app_iam.compliance_obligations(tenant_id, framework);
CREATE INDEX IF NOT EXISTS compliance_obligations_overdue_idx
    ON app_iam.compliance_obligations(tenant_id, next_due_date ASC)
    WHERE status <> 'closed';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. compliance_reviews — review-cycle log
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.compliance_reviews (
    review_id             BIGSERIAL PRIMARY KEY,
    obligation_id         TEXT NOT NULL REFERENCES app_iam.compliance_obligations(obligation_id) ON DELETE CASCADE,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    reviewer_username     TEXT NOT NULL,
    reviewed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outcome               TEXT NOT NULL DEFAULT 'compliant',
    notes                 TEXT,
    evidence_link         TEXT,

    CONSTRAINT compliance_reviews_outcome_chk CHECK (
        outcome IN ('compliant', 'partial', 'non_compliant', 'deferred')
    )
);

CREATE INDEX IF NOT EXISTS compliance_reviews_obligation_idx
    ON app_iam.compliance_reviews(obligation_id, reviewed_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. compliance_findings — open findings + remediation
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.compliance_findings (
    finding_id            TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    obligation_id         TEXT REFERENCES app_iam.compliance_obligations(obligation_id) ON DELETE SET NULL,
    regulation            TEXT NOT NULL,
    framework             TEXT NOT NULL,
    domain                TEXT NOT NULL,
    title                 TEXT NOT NULL,
    description           TEXT,
    severity              TEXT NOT NULL DEFAULT 'moderate',
    status                TEXT NOT NULL DEFAULT 'open',
    owner                 TEXT NOT NULL,
    identified_at         DATE NOT NULL,
    due_date              DATE NOT NULL,
    remediated_at         DATE,
    evidence_link         TEXT,
    root_cause            TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT compliance_findings_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT compliance_findings_severity_chk CHECK (
        severity IN ('low', 'moderate', 'high', 'severe', 'critical')
    ),
    CONSTRAINT compliance_findings_status_chk CHECK (
        status IN ('open', 'in_progress', 'remediated', 'accepted_risk', 'closed')
    ),
    CONSTRAINT compliance_findings_remediated_chk CHECK (
        remediated_at IS NULL OR remediated_at >= identified_at
    )
);

CREATE INDEX IF NOT EXISTS compliance_findings_tenant_severity_idx
    ON app_iam.compliance_findings(tenant_id, severity, identified_at ASC);
CREATE INDEX IF NOT EXISTS compliance_findings_open_idx
    ON app_iam.compliance_findings(tenant_id, identified_at DESC)
    WHERE status IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS compliance_findings_framework_idx
    ON app_iam.compliance_findings(tenant_id, framework);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. regulatory_reports — report registry
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.regulatory_reports (
    report_id             TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    kind                  TEXT NOT NULL,
    label                 TEXT NOT NULL,
    framework             TEXT NOT NULL,
    domain                TEXT NOT NULL,
    regulator             TEXT NOT NULL,
    description           TEXT,
    default_format        TEXT NOT NULL DEFAULT 'pdf',
    supported_formats     TEXT[] NOT NULL DEFAULT ARRAY['pdf', 'excel', 'csv']::TEXT[],
    frequency             TEXT NOT NULL DEFAULT 'monthly',
    last_generated_at     TIMESTAMPTZ,
    next_due_at           DATE NOT NULL,
    owner                 TEXT NOT NULL,
    page_count            INTEGER NOT NULL DEFAULT 1,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT regulatory_reports_kind_chk CHECK (
        kind IN ('rbi', 'basel', 'aml', 'kyc', 'irdai', 'solvency', 'fraud', 'executive_compliance')
    ),
    CONSTRAINT regulatory_reports_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT regulatory_reports_default_format_chk CHECK (default_format IN ('pdf', 'excel', 'csv')),
    CONSTRAINT regulatory_reports_frequency_chk CHECK (
        frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'semi_annual', 'annual', 'ad_hoc')
    ),
    CONSTRAINT regulatory_reports_page_count_chk CHECK (page_count >= 1)
);

CREATE INDEX IF NOT EXISTS regulatory_reports_tenant_kind_idx
    ON app_iam.regulatory_reports(tenant_id, kind);
CREATE INDEX IF NOT EXISTS regulatory_reports_due_idx
    ON app_iam.regulatory_reports(tenant_id, next_due_at ASC);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. regulatory_calendar — filing deadlines + review cycles
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.regulatory_calendar (
    calendar_entry_id     BIGSERIAL PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    title                 TEXT NOT NULL,
    entry_kind            TEXT NOT NULL,
    framework             TEXT,
    domain                TEXT,
    due_date              DATE NOT NULL,
    owner                 TEXT NOT NULL,
    linked_report_id      TEXT REFERENCES app_iam.regulatory_reports(report_id) ON DELETE SET NULL,
    linked_obligation_id  TEXT REFERENCES app_iam.compliance_obligations(obligation_id) ON DELETE SET NULL,
    notes                 TEXT,
    completed_at          TIMESTAMPTZ,
    completed_by          TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT regulatory_calendar_entry_kind_chk CHECK (
        entry_kind IN ('filing_deadline', 'review_cycle', 'audit_cycle', 'regulatory_submission', 'board_review')
    ),
    CONSTRAINT regulatory_calendar_domain_chk CHECK (
        domain IS NULL OR domain IN ('banking', 'insurance')
    )
);

CREATE INDEX IF NOT EXISTS regulatory_calendar_tenant_due_idx
    ON app_iam.regulatory_calendar(tenant_id, due_date ASC);
CREATE INDEX IF NOT EXISTS regulatory_calendar_pending_idx
    ON app_iam.regulatory_calendar(tenant_id, due_date ASC)
    WHERE completed_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. compliance_actions — workflow action log
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.compliance_actions (
    action_id             BIGSERIAL PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    item_id               TEXT NOT NULL,
    obligation_id         TEXT REFERENCES app_iam.compliance_obligations(obligation_id) ON DELETE SET NULL,
    action                TEXT NOT NULL,
    actor_username        TEXT NOT NULL,
    from_status           TEXT,
    to_status             TEXT,
    note                  TEXT,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT compliance_actions_action_chk CHECK (
        action IN ('assign', 'review', 'approve', 'reject', 'escalate', 'submit')
    ),
    CONSTRAINT compliance_actions_from_status_chk CHECK (
        from_status IS NULL OR from_status IN ('draft', 'under_review', 'approved', 'submitted', 'closed')
    ),
    CONSTRAINT compliance_actions_to_status_chk CHECK (
        to_status IS NULL OR to_status IN ('draft', 'under_review', 'approved', 'submitted', 'closed')
    )
);

CREATE INDEX IF NOT EXISTS compliance_actions_item_idx
    ON app_iam.compliance_actions(item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS compliance_actions_actor_idx
    ON app_iam.compliance_actions(tenant_id, actor_username, occurred_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Touch trigger for compliance_obligations.updated_at
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_iam.compliance_obligations_touch()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'compliance_obligations_touch_updated_at'
    ) THEN
        CREATE TRIGGER compliance_obligations_touch_updated_at
        BEFORE UPDATE ON app_iam.compliance_obligations
        FOR EACH ROW EXECUTE FUNCTION app_iam.compliance_obligations_touch();
    END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Seed: 16 regulatory frameworks (8 banking + 8 insurance)
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO app_iam.regulatory_frameworks (framework, domain, label, regulator, description, primary_geography)
VALUES
    ('rbi',                          'banking',   'RBI Master Circulars',           'Reserve Bank of India', 'Asset classification, provisioning, capital adequacy', 'IN'),
    ('basel_iii',                    'banking',   'Basel III — Pillar I/II/III',    'Basel Committee',       'Capital, liquidity, leverage frameworks',              'global'),
    ('basel_iv',                     'banking',   'Basel IV — Final Output Floor',  'Basel Committee',       'Standardised approach + output floor',                 'global'),
    ('aml',                          'banking',   'AML Compliance',                 'FIU-IND / Internal',    'Suspicious transaction monitoring + reporting',        'IN'),
    ('kyc',                          'banking',   'KYC Compliance',                 'RBI KYC Directions',    'Customer identification + periodic refresh',           'IN'),
    ('credit_risk',                  'banking',   'Credit Risk Management',         'RBI Internal Guidelines','PD / LGD / EAD computation + monitoring',             'IN'),
    ('operational_risk',             'banking',   'Operational Risk Framework',     'Basel + RBI',           'Loss event tracking + RCSA',                           'global'),
    ('regulatory_filings',           'banking',   'RBI Regulatory Filings',         'Reserve Bank of India', 'DSB / SAR / ALM / OSMOS returns',                      'IN'),
    ('irdai',                        'insurance', 'IRDAI Compliance',               'IRDAI',                 'IRDAI master regulations + circulars',                 'IN'),
    ('solvency',                     'insurance', 'Solvency II-aligned',            'IRDAI + Internal',      'Solvency ratio + reserve adequacy',                    'IN'),
    ('claims_governance',            'insurance', 'Claims Governance Framework',    'IRDAI',                 'Claims TAT, repudiation review, fraud screening',      'IN'),
    ('policy_governance',            'insurance', 'Policy Governance Framework',    'IRDAI',                 'Policy issuance, endorsements, cancellations',         'IN'),
    ('persistency',                  'insurance', 'Persistency Compliance',         'IRDAI Form-K',          '13th / 25th / 37th / 49th / 61st month persistency',   'IN'),
    ('fraud_compliance',             'insurance', 'Insurance Fraud Compliance',     'IRDAI Anti-Fraud',      'Anti-fraud framework + watchlist screening',           'IN'),
    ('underwriting_compliance',      'insurance', 'Underwriting Compliance',        'IRDAI',                 'UW guidelines, risk-rating, declination tracking',     'IN'),
    ('regulatory_filings_insurance', 'insurance', 'IRDAI Regulatory Filings',       'IRDAI',                 'Form K / L / IRDAI quarterly returns',                 'IN')
ON CONFLICT (framework) DO NOTHING;
