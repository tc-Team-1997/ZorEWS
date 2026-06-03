-- data/schema/062_ai_decisioning_layer.sql
--
-- Advanced AI Decisioning Layer — additive schema (Phase 19 IA overlay).
-- 8 additive tables under app_iam for decision intelligence orchestration.
-- Idempotent: CREATE TABLE IF NOT EXISTS on every object.
-- Zero changes to any existing tables.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ai_decisions — core decision ledger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_decisions (
    decision_id        TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    decision_type      TEXT NOT NULL,
    domain             TEXT NOT NULL CHECK (domain IN ('banking','insurance','enterprise')),
    entity_id          TEXT NOT NULL,
    entity_name        TEXT NOT NULL,
    outcome            TEXT NOT NULL CHECK (outcome IN ('approve','reject','refer','review','escalate','flag','monitor')),
    risk_band          TEXT NOT NULL CHECK (risk_band IN ('low','medium','high','critical')),
    confidence_score   NUMERIC(4,3) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
    enterprise_score   INTEGER NOT NULL CHECK (enterprise_score BETWEEN 0 AND 100),
    amount_cr          NUMERIC(20,2),
    approval_state     TEXT NOT NULL DEFAULT 'draft'
                           CHECK (approval_state IN ('draft','submitted','under_review','approved','rejected','executed')),
    reasoning_chain    JSONB NOT NULL DEFAULT '[]'::jsonb,
    key_factors        JSONB NOT NULL DEFAULT '[]'::jsonb,
    sources_consulted  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    models_used        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    agents_consulted   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    compliance_flags   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    regulatory_impact  TEXT,
    business_impact    TEXT,
    risk_impact        TEXT,
    explanation        TEXT,
    recommendation     TEXT,
    transparency_score INTEGER CHECK (transparency_score BETWEEN 0 AND 100),
    traceability_score INTEGER CHECK (traceability_score BETWEEN 0 AND 100),
    decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_tenant_type
    ON app_iam.ai_decisions(tenant_id, decision_type, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_tenant_risk
    ON app_iam.ai_decisions(tenant_id, risk_band, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_approval_state
    ON app_iam.ai_decisions(tenant_id, approval_state);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ai_decision_approvals — Maker → Checker → Approver workflow
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_decision_approvals (
    approval_id            TEXT PRIMARY KEY,
    decision_id            TEXT NOT NULL
                               REFERENCES app_iam.ai_decisions(decision_id) ON DELETE CASCADE,
    tenant_id              TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    maker                  TEXT NOT NULL,
    maker_submitted_at     TIMESTAMPTZ,
    checker                TEXT,
    checker_reviewed_at    TIMESTAMPTZ,
    checker_comments       TEXT,
    approver               TEXT,
    approver_reviewed_at   TIMESTAMPTZ,
    approver_comments      TEXT,
    current_state          TEXT NOT NULL DEFAULT 'draft'
                               CHECK (current_state IN ('draft','submitted','under_review','approved','rejected','executed')),
    sla_hours              INTEGER NOT NULL DEFAULT 48,
    sla_breached           BOOLEAN NOT NULL DEFAULT false,
    justification          TEXT,
    priority               TEXT NOT NULL DEFAULT 'normal'
                               CHECK (priority IN ('critical','high','normal')),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_approvals_tenant_state
    ON app_iam.ai_decision_approvals(tenant_id, current_state, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ai_decision_recommendations — orchestrated recommendations
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_decision_recommendations (
    rec_id             TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    decision_id        TEXT REFERENCES app_iam.ai_decisions(decision_id) ON DELETE SET NULL,
    decision_type      TEXT NOT NULL,
    domain             TEXT NOT NULL CHECK (domain IN ('banking','insurance','enterprise')),
    action             TEXT NOT NULL,
    rationale          TEXT NOT NULL,
    confidence         NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    risk_score         NUMERIC(5,2) NOT NULL,
    expected_impact    TEXT,
    source_agent       TEXT,
    risk_band          TEXT NOT NULL CHECK (risk_band IN ('low','medium','high','critical')),
    urgency            TEXT NOT NULL DEFAULT 'routine'
                           CHECK (urgency IN ('immediate','within_24h','within_week','routine')),
    status             TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','actioned','dismissed')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_recs_tenant_urgency
    ON app_iam.ai_decision_recommendations(tenant_id, urgency, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ai_decision_audit — immutable SHA-256 hash-linked audit trail
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_decision_audit (
    event_id           TEXT PRIMARY KEY,
    decision_id        TEXT NOT NULL
                           REFERENCES app_iam.ai_decisions(decision_id) ON DELETE CASCADE,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    event_type         TEXT NOT NULL
                           CHECK (event_type IN ('created','modified','submitted','reviewed','approved','rejected','executed')),
    actor              TEXT NOT NULL,
    role               TEXT NOT NULL,
    timestamp          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    comments           TEXT,
    decision_version   INTEGER NOT NULL DEFAULT 1,
    sha256_hash        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_dec_audit_decision
    ON app_iam.ai_decision_audit(decision_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_ai_dec_audit_tenant
    ON app_iam.ai_decision_audit(tenant_id, timestamp DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ai_decision_graph_cache — decision lineage graph storage
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_decision_graph_cache (
    cache_id           TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    decision_id        TEXT REFERENCES app_iam.ai_decisions(decision_id) ON DELETE CASCADE,
    graph_nodes        JSONB NOT NULL DEFAULT '[]'::jsonb,
    graph_edges        JSONB NOT NULL DEFAULT '[]'::jsonb,
    overall_confidence NUMERIC(4,3) CHECK (overall_confidence BETWEEN 0 AND 1),
    critical_path      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_graph_tenant
    ON app_iam.ai_decision_graph_cache(tenant_id, generated_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ai_decision_effectiveness — outcomes and ROI tracking
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_decision_effectiveness (
    metric_id               BIGSERIAL PRIMARY KEY,
    tenant_id               TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    period_start            TIMESTAMPTZ NOT NULL,
    period_end              TIMESTAMPTZ NOT NULL,
    period_type             TEXT NOT NULL DEFAULT 'monthly'
                                CHECK (period_type IN ('daily','weekly','monthly')),
    decision_accuracy_pct   NUMERIC(6,3),
    false_positive_rate_pct NUMERIC(6,3),
    false_negative_rate_pct NUMERIC(6,3),
    recovery_value_cr       NUMERIC(20,2),
    loss_prevention_cr      NUMERIC(20,2),
    claim_savings_cr        NUMERIC(20,2),
    fraud_prevented_cr      NUMERIC(20,2),
    portfolio_improvement_pp NUMERIC(8,4),
    policy_retention_impact_pct NUMERIC(6,3),
    roi_per_100_decisions   NUMERIC(10,2),
    recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_effectiveness_tenant
    ON app_iam.ai_decision_effectiveness(tenant_id, period_type, period_end DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ai_enterprise_scores — composite 0-100 decision score
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_enterprise_scores (
    score_id                  TEXT PRIMARY KEY,
    tenant_id                 TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    decision_id               TEXT REFERENCES app_iam.ai_decisions(decision_id) ON DELETE SET NULL,
    overall_score             INTEGER NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
    grade                     TEXT NOT NULL CHECK (grade IN ('A+','A','B+','B','C','D')),
    risk_score                INTEGER CHECK (risk_score BETWEEN 0 AND 100),
    compliance_score          INTEGER CHECK (compliance_score BETWEEN 0 AND 100),
    ai_confidence             INTEGER CHECK (ai_confidence BETWEEN 0 AND 100),
    data_quality              INTEGER CHECK (data_quality BETWEEN 0 AND 100),
    investigation_confidence  INTEGER CHECK (investigation_confidence BETWEEN 0 AND 100),
    agent_consensus           INTEGER CHECK (agent_consensus BETWEEN 0 AND 100),
    approval_completeness     INTEGER CHECK (approval_completeness BETWEEN 0 AND 100),
    decision_ready            BOOLEAN NOT NULL DEFAULT false,
    blocking_factors          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    generated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_ent_scores_tenant
    ON app_iam.ai_enterprise_scores(tenant_id, generated_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ai_decision_knowledge_base — past decisions, patterns, lessons learned
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.ai_decision_knowledge_base (
    kb_id               TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    decision_type       TEXT NOT NULL,
    domain              TEXT NOT NULL CHECK (domain IN ('banking','insurance','enterprise')),
    title               TEXT NOT NULL,
    outcome             TEXT NOT NULL,
    lesson_learned      TEXT NOT NULL,
    best_practice       TEXT,
    pattern_tags        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    financial_impact_cr NUMERIC(20,2),
    confidence_score    NUMERIC(4,3) CHECK (confidence_score BETWEEN 0 AND 1),
    times_referenced    INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_kb_tenant_type
    ON app_iam.ai_decision_knowledge_base(tenant_id, decision_type, times_referenced DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: 5 knowledge base entries for BANK_DEMO
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO app_iam.ai_decision_knowledge_base
    (kb_id, tenant_id, decision_type, domain, title, outcome, lesson_learned,
     best_practice, pattern_tags, financial_impact_cr, confidence_score)
VALUES
    ('KB-BNK-001','BANK_DEMO','credit_approval','banking',
     'MSME Sector Credit — RBI Rate Hike Cycle',
     'reject',
     'During repo rate hike cycles, MSME borrowers in rate-sensitive sectors show 2.8× higher NPA migration within 90 days. Early restriction preserves portfolio quality.',
     'Apply sector-specific stress overlays when RBI signals rate tightening. Tighten MSME credit criteria by one notch during alert periods.',
     ARRAY['msme','rate_sensitivity','early_warning','sector_stress'], 45.2, 0.91),

    ('KB-BNK-002','BANK_DEMO','npa_classification','banking',
     'Stage 2 → Stage 3 Fast-Track Trigger Pattern',
     'escalate',
     'Accounts with simultaneous bureau enquiries (>3 in 30d) + utilisation spike (>85%) show 76% probability of Stage 3 migration within 60 days.',
     'Auto-escalate to Special Mention review when dual signal fires. Do not wait for DPD to cross 60d.',
     ARRAY['npa','stage_migration','bureau_signal','utilisation'], 128.5, 0.88),

    ('KB-INS-001','BANK_DEMO','claims_settlement','insurance',
     'Ghost Hospital Syndicate Detection Pattern',
     'flag',
     'Claims from providers with <6 month IRDAI registration + >40 claims in first month have 91% fraud confirmation rate when combined with beneficiary address clustering.',
     'Apply provider age + claim velocity + geography clustering as a composite trigger before settlement.',
     ARRAY['fraud','ghost_hospital','provider_risk','syndicate'], 22.8, 0.93),

    ('KB-INS-002','BANK_DEMO','policy_underwriting','insurance',
     'High-Value Term Insurance — Medical Waiver Risk',
     'refer',
     'Term policies >₹2Cr where medical examination was waived through digital declaration show 3.1× higher claim incidence in Year 1–3 compared to medically underwritten cases.',
     'Mandate medical underwriting for sum assured >₹1.5Cr regardless of digital declaration availability.',
     ARRAY['term_insurance','medical_waiver','underwriting','high_value'], 38.6, 0.86),

    ('KB-ENT-001','BANK_DEMO','aml_transaction','enterprise',
     'Structuring Pattern Below ₹10L Reporting Threshold',
     'flag',
     'Multiple transactions of ₹9.8–9.95L within 72-hour window from same originator across different beneficiaries is a proven structuring pattern for STR evasion.',
     'Apply rolling 72-hour aggregate monitoring with ₹9.5L floor trigger. File STR proactively.',
     ARRAY['aml','structuring','str','threshold_evasion'], 18.4, 0.95)
ON CONFLICT (kb_id) DO NOTHING;
