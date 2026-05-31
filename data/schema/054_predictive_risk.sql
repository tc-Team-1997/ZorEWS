-- data/schema/054_predictive_risk.sql
--
-- Predictive Risk Center — additive schema (11th IA addition this session).
--
-- Five tables backing the new /predictive-risk-center surface. Idempotent:
-- safe to re-run via `make migrate` against an already-applied DB. Zero
-- alterations to existing tables; only IF NOT EXISTS additions.
--
-- Tables
--   1. predictive_models           — model registry (per-prediction algorithm + version)
--   2. predictive_forecasts        — point-in-time forecast outputs per (model, entity, horizon)
--   3. predictive_scores           — current-snapshot risk band + score per entity
--   4. predictive_signals          — active early-warning signal observations
--   5. predictive_recommendations  — issued prescriptive actions (maker-checker audit trail)
--
-- Backward compatibility — every existing table untouched. Migrations 001-053
-- continue to apply cleanly.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. predictive_models — algorithm registry
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.predictive_models (
    model_id              TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    domain                TEXT NOT NULL,
    prediction_kind       TEXT NOT NULL,
    label                 TEXT NOT NULL,
    algorithm             TEXT NOT NULL DEFAULT 'xgboost',
    version               TEXT NOT NULL DEFAULT '1.0.0',
    horizons_days         INTEGER[] NOT NULL DEFAULT ARRAY[30, 60, 90, 180]::INTEGER[],
    thresholds_json       JSONB NOT NULL DEFAULT '{"moderate":20,"high":40,"severe":65,"critical":85}'::jsonb,
    status                TEXT NOT NULL DEFAULT 'staging',
    promoted_to_prod_at   TIMESTAMPTZ,
    retired_at            TIMESTAMPTZ,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by            TEXT NOT NULL DEFAULT 'system',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT predictive_models_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT predictive_models_status_chk CHECK (status IN ('experimental', 'staging', 'shadow', 'production', 'retired')),
    CONSTRAINT predictive_models_kind_chk CHECK (
        prediction_kind IN (
            'npa_probability', 'sma_migration_risk', 'emi_default_risk',
            'collection_failure_risk', 'borrower_stress_index',
            'sector_deterioration_risk', 'portfolio_risk_forecast',
            'policy_lapse_probability', 'claim_fraud_probability',
            'persistency_decline_risk', 'solvency_pressure_risk',
            'premium_collection_risk', 'agent_risk_escalation',
            'customer_churn_probability'
        )
    )
);

CREATE INDEX IF NOT EXISTS predictive_models_tenant_status_idx
    ON app_iam.predictive_models(tenant_id, status);
CREATE INDEX IF NOT EXISTS predictive_models_kind_idx
    ON app_iam.predictive_models(prediction_kind);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. predictive_forecasts — point-in-time forecast outputs
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.predictive_forecasts (
    forecast_id           BIGSERIAL PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    model_id              TEXT NOT NULL,
    prediction_kind       TEXT NOT NULL,
    domain                TEXT NOT NULL,
    entity_kind           TEXT NOT NULL,
    entity_id             TEXT NOT NULL,
    horizon_days          INTEGER NOT NULL,
    generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_score         NUMERIC(5, 2) NOT NULL,
    current_band          TEXT NOT NULL,
    forecast_score        NUMERIC(5, 2) NOT NULL,
    forecast_band         TEXT NOT NULL,
    delta_pp              NUMERIC(6, 2) NOT NULL,
    trend                 TEXT NOT NULL,
    confidence            NUMERIC(4, 3) NOT NULL,
    series_json           JSONB NOT NULL DEFAULT '[]'::jsonb,

    CONSTRAINT predictive_forecasts_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT predictive_forecasts_horizon_chk CHECK (horizon_days IN (30, 60, 90, 180)),
    CONSTRAINT predictive_forecasts_trend_chk CHECK (trend IN ('rising', 'falling', 'flat')),
    CONSTRAINT predictive_forecasts_current_band_chk CHECK (current_band IN ('low', 'moderate', 'high', 'severe', 'critical')),
    CONSTRAINT predictive_forecasts_forecast_band_chk CHECK (forecast_band IN ('low', 'moderate', 'high', 'severe', 'critical')),
    CONSTRAINT predictive_forecasts_confidence_chk CHECK (confidence BETWEEN 0 AND 1),
    CONSTRAINT predictive_forecasts_entity_kind_chk CHECK (entity_kind IN ('customer', 'borrower', 'policy', 'agent', 'branch', 'sector', 'portfolio', 'tenant', 'country', 'enterprise'))
);

CREATE INDEX IF NOT EXISTS predictive_forecasts_tenant_kind_horizon_idx
    ON app_iam.predictive_forecasts(tenant_id, prediction_kind, horizon_days, generated_at DESC);
CREATE INDEX IF NOT EXISTS predictive_forecasts_entity_idx
    ON app_iam.predictive_forecasts(tenant_id, entity_kind, entity_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS predictive_forecasts_band_idx
    ON app_iam.predictive_forecasts(tenant_id, forecast_band)
    WHERE forecast_band IN ('severe', 'critical');

-- ───────────────────────────────────────────────────────────────────────────
-- 3. predictive_scores — latest snapshot per (tenant, entity, prediction)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.predictive_scores (
    score_id              BIGSERIAL PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    prediction_kind       TEXT NOT NULL,
    domain                TEXT NOT NULL,
    entity_kind           TEXT NOT NULL,
    entity_id             TEXT NOT NULL,
    score                 NUMERIC(5, 2) NOT NULL,
    band                  TEXT NOT NULL,
    horizon_days          INTEGER NOT NULL,
    snapshot_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    model_id              TEXT,
    confidence            NUMERIC(4, 3),

    CONSTRAINT predictive_scores_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT predictive_scores_horizon_chk CHECK (horizon_days IN (30, 60, 90, 180)),
    CONSTRAINT predictive_scores_band_chk CHECK (band IN ('low', 'moderate', 'high', 'severe', 'critical')),
    CONSTRAINT predictive_scores_unique UNIQUE (tenant_id, entity_kind, entity_id, prediction_kind, horizon_days)
);

CREATE INDEX IF NOT EXISTS predictive_scores_band_idx
    ON app_iam.predictive_scores(tenant_id, band, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS predictive_scores_horizon_idx
    ON app_iam.predictive_scores(tenant_id, prediction_kind, horizon_days);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. predictive_signals — early-warning signal observations
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.predictive_signals (
    observation_id        BIGSERIAL PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    signal_id             TEXT NOT NULL,
    label                 TEXT NOT NULL,
    domain                TEXT NOT NULL,
    severity              TEXT NOT NULL,
    entity_kind           TEXT NOT NULL,
    entity_id             TEXT NOT NULL,
    description           TEXT,
    feeds_predictions     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active_until          TIMESTAMPTZ,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved_at           TIMESTAMPTZ,
    resolved_by           TEXT,
    resolution_note       TEXT,

    CONSTRAINT predictive_signals_domain_chk CHECK (domain IN ('banking', 'insurance')),
    CONSTRAINT predictive_signals_severity_chk CHECK (severity IN ('low', 'moderate', 'high', 'severe', 'critical')),
    CONSTRAINT predictive_signals_resolved_chk CHECK (
        (resolved_at IS NULL AND resolved_by IS NULL) OR
        (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS predictive_signals_active_idx
    ON app_iam.predictive_signals(tenant_id, observed_at DESC)
    WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS predictive_signals_severity_idx
    ON app_iam.predictive_signals(tenant_id, severity)
    WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS predictive_signals_signal_id_idx
    ON app_iam.predictive_signals(tenant_id, signal_id, observed_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. predictive_recommendations — issued prescriptive actions
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_iam.predictive_recommendations (
    recommendation_id     BIGSERIAL PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES app_iam.tenants(tenant_id),
    action_id             TEXT NOT NULL,
    prediction_kind       TEXT NOT NULL,
    entity_kind           TEXT NOT NULL,
    entity_id             TEXT NOT NULL,
    score_at_issuance     NUMERIC(5, 2),
    band_at_issuance      TEXT,
    requires_maker_checker BOOLEAN NOT NULL DEFAULT FALSE,
    status                TEXT NOT NULL DEFAULT 'pending',
    issued_by             TEXT NOT NULL,
    issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approver_username     TEXT,
    approved_at           TIMESTAMPTZ,
    decision_notes        TEXT,
    completed_at          TIMESTAMPTZ,
    cancelled_at          TIMESTAMPTZ,
    metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
    correlation_id        UUID,

    CONSTRAINT predictive_recs_action_chk CHECK (
        action_id IN (
            'contact_borrower', 'increase_monitoring', 'launch_investigation',
            'escalate_review', 'freeze_exposure', 'trigger_retention_campaign'
        )
    ),
    CONSTRAINT predictive_recs_status_chk CHECK (
        status IN ('pending', 'approved', 'rejected', 'completed', 'cancelled')
    ),
    CONSTRAINT predictive_recs_band_chk CHECK (
        band_at_issuance IS NULL OR band_at_issuance IN ('low', 'moderate', 'high', 'severe', 'critical')
    ),
    -- maker-checker: when required, approver must differ from issuer at row level
    CONSTRAINT predictive_recs_maker_checker_chk CHECK (
        NOT requires_maker_checker
        OR approver_username IS NULL
        OR approver_username <> issued_by
    )
);

CREATE INDEX IF NOT EXISTS predictive_recs_tenant_status_idx
    ON app_iam.predictive_recommendations(tenant_id, status, issued_at DESC);
CREATE INDEX IF NOT EXISTS predictive_recs_entity_idx
    ON app_iam.predictive_recommendations(tenant_id, entity_kind, entity_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS predictive_recs_correlation_idx
    ON app_iam.predictive_recommendations(correlation_id)
    WHERE correlation_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- Touch updated_at trigger (mirrors pattern from earlier migrations)
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_iam.predictive_models_touch()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'predictive_models_touch_updated_at'
    ) THEN
        CREATE TRIGGER predictive_models_touch_updated_at
        BEFORE UPDATE ON app_iam.predictive_models
        FOR EACH ROW EXECUTE FUNCTION app_iam.predictive_models_touch();
    END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Seed: 14 default models (7 banking + 7 insurance) for BANK_DEMO tenant
-- INSERT … ON CONFLICT DO NOTHING — safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO app_iam.predictive_models (model_id, tenant_id, domain, prediction_kind, label, status)
VALUES
    ('predictive-npa_probability',            'BANK_DEMO', 'banking',   'npa_probability',            'NPA Probability',            'production'),
    ('predictive-sma_migration_risk',         'BANK_DEMO', 'banking',   'sma_migration_risk',         'SMA Migration Risk',         'production'),
    ('predictive-emi_default_risk',           'BANK_DEMO', 'banking',   'emi_default_risk',           'EMI Default Risk',           'production'),
    ('predictive-collection_failure_risk',    'BANK_DEMO', 'banking',   'collection_failure_risk',    'Collection Failure Risk',    'production'),
    ('predictive-borrower_stress_index',      'BANK_DEMO', 'banking',   'borrower_stress_index',      'Borrower Stress Index',      'production'),
    ('predictive-sector_deterioration_risk',  'BANK_DEMO', 'banking',   'sector_deterioration_risk',  'Sector Deterioration Risk',  'staging'),
    ('predictive-portfolio_risk_forecast',    'BANK_DEMO', 'banking',   'portfolio_risk_forecast',    'Portfolio Risk Forecast',    'production'),
    ('predictive-policy_lapse_probability',   'BANK_DEMO', 'insurance', 'policy_lapse_probability',   'Policy Lapse Probability',   'production'),
    ('predictive-claim_fraud_probability',    'BANK_DEMO', 'insurance', 'claim_fraud_probability',    'Claim Fraud Probability',    'production'),
    ('predictive-persistency_decline_risk',   'BANK_DEMO', 'insurance', 'persistency_decline_risk',   'Persistency Decline Risk',   'staging'),
    ('predictive-solvency_pressure_risk',     'BANK_DEMO', 'insurance', 'solvency_pressure_risk',     'Solvency Pressure Risk',     'production'),
    ('predictive-premium_collection_risk',    'BANK_DEMO', 'insurance', 'premium_collection_risk',    'Premium Collection Risk',    'production'),
    ('predictive-agent_risk_escalation',      'BANK_DEMO', 'insurance', 'agent_risk_escalation',      'Agent Risk Escalation',      'staging'),
    ('predictive-customer_churn_probability', 'BANK_DEMO', 'insurance', 'customer_churn_probability', 'Customer Churn Probability', 'production')
ON CONFLICT (model_id) DO NOTHING;

-- BIL tenant mirrors (same 14 model contracts)
INSERT INTO app_iam.predictive_models (model_id, tenant_id, domain, prediction_kind, label, status)
SELECT 'predictive-bil-' || prediction_kind, 'BIL', domain, prediction_kind, label, status
FROM app_iam.predictive_models
WHERE tenant_id = 'BANK_DEMO'
ON CONFLICT (model_id) DO NOTHING;
