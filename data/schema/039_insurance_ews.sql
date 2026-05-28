-- 039_insurance_ews.sql
--
-- ZorEWS Insurance Early-Warning System — 7-module schema.
--
-- New `app_insurance` schema holding every table the Insurance EWS
-- modules read/write. The platform is multi-tenant (tenant_id FK →
-- app_iam.tenants) + audit-ready (every mutating table carries
-- tenant_id + created_at; AI prediction tables carry model_version +
-- scored_at so a regulator can reconstruct which model produced a
-- score on a given day).
--
-- Modules:
--   1. Policy Lapse Risk     — policy_lapse_predictions, customer_payment_history,
--                              retention_campaigns
--   2. Claims Anomaly        — claim_anomalies, siu_cases, fraud_scores
--   3. Fraud Detection       — fraud_networks, provider_links, fraud_cases,
--                              fraud_entities
--   4. Solvency Watch        — solvency_metrics, solvency_forecasts,
--                              compliance_alerts
--   5. Persistency Watch     — persistency_metrics, retention_analysis,
--                              persistency_alerts
--   6. Underwriting Deviation— underwriting_deviations, approval_exceptions,
--                              underwriter_scores
--   7. Channel Risk          — channel_risk_scores, agent_complaints,
--                              distribution_metrics
--
--   X. Cross-cutting         — insurance_alerts (unified EWS alert feed),
--                              insurance_audit_events (per-module action trail)
--
-- Every statement is guarded with IF NOT EXISTS / DO $$ ... $$ so a
-- re-run is a no-op. Additive only — no existing row is touched. The
-- bodies stay deliberately denormalised + index-light; the BFF layer
-- synthesises deterministic data today and swaps to these tables when
-- the insurer's real feeds land. FKs to app_iam.tenants use ON DELETE
-- CASCADE so deleting a tenant unwinds its insurance data cleanly.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app_insurance AUTHORIZATION CURRENT_USER;

-- ════════════════════════════════════════════════════════════════════
-- MODULE 1 — POLICY LAPSE RISK
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_insurance.policy_lapse_predictions (
  prediction_id        BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  policy_id            TEXT         NOT NULL,
  customer_id          TEXT         NOT NULL,
  product_code         TEXT         NOT NULL,
  channel              TEXT,                                  -- agent | broker | bancassurance | direct | online
  region               TEXT,
  gwp_kes              NUMERIC(16,2) NOT NULL DEFAULT 0,       -- gross written premium (high-GWP prioritisation)
  lapse_probability    NUMERIC(5,4) NOT NULL,                 -- 0.0000 .. 1.0000
  horizon_days         INT          NOT NULL DEFAULT 30,       -- 30 | 60 | 90
  renewal_probability  NUMERIC(5,4),                          -- complement-ish; modelled separately
  retention_risk_band  TEXT         NOT NULL DEFAULT 'low',    -- low | medium | high | critical
  top_drivers          JSONB        NOT NULL DEFAULT '[]'::jsonb,  -- SHAP-style [{feature, contribution}]
  recommended_action   TEXT,                                  -- retention play the AI suggests
  model_version        TEXT         NOT NULL DEFAULT 'lapse-stub-v1',
  scored_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT policy_lapse_band_ck CHECK (retention_risk_band IN ('low','medium','high','critical')),
  CONSTRAINT policy_lapse_horizon_ck CHECK (horizon_days IN (30,60,90))
);
CREATE INDEX IF NOT EXISTS policy_lapse_tenant_band_idx
  ON app_insurance.policy_lapse_predictions (tenant_id, retention_risk_band, lapse_probability DESC);
CREATE INDEX IF NOT EXISTS policy_lapse_tenant_policy_idx
  ON app_insurance.policy_lapse_predictions (tenant_id, policy_id);

CREATE TABLE IF NOT EXISTS app_insurance.customer_payment_history (
  payment_id           BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  customer_id          TEXT         NOT NULL,
  policy_id            TEXT         NOT NULL,
  due_date             DATE         NOT NULL,
  paid_date            DATE,                                  -- null = unpaid / lapsed instalment
  amount_kes           NUMERIC(16,2) NOT NULL DEFAULT 0,
  days_late            INT          NOT NULL DEFAULT 0,
  payment_mode         TEXT,                                  -- auto_debit | card | upi | cheque | cash
  status               TEXT         NOT NULL DEFAULT 'paid',  -- paid | late | missed | grace
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT cust_pay_status_ck CHECK (status IN ('paid','late','missed','grace'))
);
CREATE INDEX IF NOT EXISTS cust_pay_tenant_cust_idx
  ON app_insurance.customer_payment_history (tenant_id, customer_id, due_date DESC);

CREATE TABLE IF NOT EXISTS app_insurance.retention_campaigns (
  campaign_id          BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  name                 TEXT         NOT NULL,
  target_band          TEXT         NOT NULL DEFAULT 'high',  -- which lapse band the play targets
  channel              TEXT,
  play_type            TEXT         NOT NULL DEFAULT 'call',  -- call | sms | email | agent_visit | discount
  target_policy_count  INT          NOT NULL DEFAULT 0,
  expected_gwp_saved_kes NUMERIC(16,2) NOT NULL DEFAULT 0,
  status               TEXT         NOT NULL DEFAULT 'draft', -- draft | active | completed | cancelled
  created_by           TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT retention_status_ck CHECK (status IN ('draft','active','completed','cancelled'))
);
CREATE INDEX IF NOT EXISTS retention_tenant_status_idx
  ON app_insurance.retention_campaigns (tenant_id, status);

-- ════════════════════════════════════════════════════════════════════
-- MODULE 2 — CLAIMS ANOMALY
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_insurance.claim_anomalies (
  anomaly_id           BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  claim_id             TEXT         NOT NULL,
  policy_id            TEXT         NOT NULL,
  customer_id          TEXT         NOT NULL,
  claim_amount_kes     NUMERIC(16,2) NOT NULL DEFAULT 0,
  anomaly_score        NUMERIC(5,4) NOT NULL,                 -- 0.0000 .. 1.0000
  anomaly_reasons      JSONB        NOT NULL DEFAULT '[]'::jsonb,  -- [frequency_spike, amount_spike, duplicate, ...]
  cluster_id           TEXT,                                  -- claims clustering analysis bucket
  severity             TEXT         NOT NULL DEFAULT 'low',    -- low | medium | high | critical
  status               TEXT         NOT NULL DEFAULT 'open',   -- open | siu_queued | cleared | confirmed_fraud
  model_version        TEXT         NOT NULL DEFAULT 'claim-anomaly-stub-v1',
  scored_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT claim_anom_sev_ck CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT claim_anom_status_ck CHECK (status IN ('open','siu_queued','cleared','confirmed_fraud'))
);
CREATE INDEX IF NOT EXISTS claim_anom_tenant_score_idx
  ON app_insurance.claim_anomalies (tenant_id, anomaly_score DESC);

CREATE TABLE IF NOT EXISTS app_insurance.siu_cases (
  siu_case_id          BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  claim_id             TEXT         NOT NULL,
  anomaly_id           BIGINT       REFERENCES app_insurance.claim_anomalies(anomaly_id) ON DELETE SET NULL,
  priority             TEXT         NOT NULL DEFAULT 'medium', -- low | medium | high | critical
  state                TEXT         NOT NULL DEFAULT 'queued', -- queued | investigating | escalated | closed
  assigned_to          TEXT,
  fraud_probability    NUMERIC(5,4),
  resolution           TEXT,                                  -- fraud_confirmed | cleared | inconclusive
  opened_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  closed_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT siu_state_ck CHECK (state IN ('queued','investigating','escalated','closed'))
);
CREATE INDEX IF NOT EXISTS siu_tenant_state_idx
  ON app_insurance.siu_cases (tenant_id, state, priority);

CREATE TABLE IF NOT EXISTS app_insurance.fraud_scores (
  score_id             BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  subject_type         TEXT         NOT NULL DEFAULT 'claim',  -- claim | customer | provider | agent
  subject_id           TEXT         NOT NULL,
  fraud_probability    NUMERIC(5,4) NOT NULL,
  contributing_signals JSONB        NOT NULL DEFAULT '[]'::jsonb,
  model_version        TEXT         NOT NULL DEFAULT 'fraud-stub-v1',
  scored_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fraud_scores_tenant_subj_idx
  ON app_insurance.fraud_scores (tenant_id, subject_type, fraud_probability DESC);

-- ════════════════════════════════════════════════════════════════════
-- MODULE 3 — FRAUD DETECTION (network / ring)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_insurance.fraud_entities (
  entity_id            TEXT         NOT NULL,                  -- stable id within tenant
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  entity_type          TEXT         NOT NULL,                  -- customer | provider | agent | garage | hospital | bank_account
  display_name         TEXT,
  risk_score           NUMERIC(5,4) NOT NULL DEFAULT 0,
  flagged              BOOLEAN      NOT NULL DEFAULT false,
  attributes           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_id),
  CONSTRAINT fraud_entity_type_ck CHECK (entity_type IN ('customer','provider','agent','garage','hospital','bank_account'))
);

CREATE TABLE IF NOT EXISTS app_insurance.provider_links (
  link_id              BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  source_entity_id     TEXT         NOT NULL,
  target_entity_id     TEXT         NOT NULL,
  link_type            TEXT         NOT NULL,                  -- shared_account | co_claim | referral | address | phone
  weight               NUMERIC(6,4) NOT NULL DEFAULT 0,        -- edge strength for graph engine
  shared_claim_count   INT          NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_links_tenant_src_idx
  ON app_insurance.provider_links (tenant_id, source_entity_id);

CREATE TABLE IF NOT EXISTS app_insurance.fraud_networks (
  network_id           BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  label                TEXT         NOT NULL,                  -- e.g. "Ring #4 — Nairobi staged-accident cluster"
  entity_count         INT          NOT NULL DEFAULT 0,
  edge_count           INT          NOT NULL DEFAULT 0,
  ring_risk_score      NUMERIC(5,4) NOT NULL DEFAULT 0,
  estimated_exposure_kes NUMERIC(16,2) NOT NULL DEFAULT 0,
  detection_method     TEXT         NOT NULL DEFAULT 'community_detection',
  status               TEXT         NOT NULL DEFAULT 'detected', -- detected | investigating | confirmed | dismissed
  detected_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fraud_network_status_ck CHECK (status IN ('detected','investigating','confirmed','dismissed'))
);
CREATE INDEX IF NOT EXISTS fraud_networks_tenant_risk_idx
  ON app_insurance.fraud_networks (tenant_id, ring_risk_score DESC);

CREATE TABLE IF NOT EXISTS app_insurance.fraud_cases (
  fraud_case_id        BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  network_id           BIGINT       REFERENCES app_insurance.fraud_networks(network_id) ON DELETE SET NULL,
  fraud_type           TEXT         NOT NULL,                  -- staged_accident | provider_collusion | identity | claim_padding | ring
  primary_entity_id    TEXT,
  exposure_kes         NUMERIC(16,2) NOT NULL DEFAULT 0,
  state                TEXT         NOT NULL DEFAULT 'open',    -- open | investigating | escalated | closed
  assigned_to          TEXT,
  resolution           TEXT,
  opened_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  closed_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fraud_case_state_ck CHECK (state IN ('open','investigating','escalated','closed'))
);
CREATE INDEX IF NOT EXISTS fraud_cases_tenant_state_idx
  ON app_insurance.fraud_cases (tenant_id, state);

-- ════════════════════════════════════════════════════════════════════
-- MODULE 4 — SOLVENCY WATCH (IRDAI)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_insurance.solvency_metrics (
  metric_id            BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  as_of                DATE         NOT NULL,
  available_solvency_margin_kes NUMERIC(18,2) NOT NULL DEFAULT 0,  -- ASM
  required_solvency_margin_kes  NUMERIC(18,2) NOT NULL DEFAULT 0,  -- RSM
  solvency_ratio       NUMERIC(7,4) NOT NULL DEFAULT 0,            -- ASM / RSM (IRDAI floor 1.50)
  control_level        NUMERIC(7,4) NOT NULL DEFAULT 1.50,         -- regulatory floor
  capital_adequacy_pct NUMERIC(7,4),
  status               TEXT         NOT NULL DEFAULT 'compliant',  -- compliant | watch | breach
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT solvency_status_ck CHECK (status IN ('compliant','watch','breach'))
);
CREATE INDEX IF NOT EXISTS solvency_metrics_tenant_asof_idx
  ON app_insurance.solvency_metrics (tenant_id, as_of DESC);

CREATE TABLE IF NOT EXISTS app_insurance.solvency_forecasts (
  forecast_id          BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  generated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  horizon_days         INT          NOT NULL DEFAULT 30,           -- 30 | 60 | 90
  projected_ratio      NUMERIC(7,4) NOT NULL,
  claims_growth_pct    NUMERIC(7,4) NOT NULL DEFAULT 0,            -- simulation input
  scenario             TEXT         NOT NULL DEFAULT 'baseline',   -- baseline | adverse | severe
  breach_probability   NUMERIC(5,4) NOT NULL DEFAULT 0,
  model_version        TEXT         NOT NULL DEFAULT 'solvency-stub-v1',
  CONSTRAINT solvency_fc_horizon_ck CHECK (horizon_days IN (30,60,90))
);
CREATE INDEX IF NOT EXISTS solvency_fc_tenant_idx
  ON app_insurance.solvency_forecasts (tenant_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS app_insurance.compliance_alerts (
  alert_id             BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  regulator            TEXT         NOT NULL DEFAULT 'IRDAI',
  rule_code            TEXT         NOT NULL,                       -- e.g. SOLVENCY_RATIO_FLOOR
  severity             TEXT         NOT NULL DEFAULT 'warning',     -- info | warning | critical
  message              TEXT         NOT NULL,
  metric_value         NUMERIC(12,4),
  threshold_value      NUMERIC(12,4),
  status               TEXT         NOT NULL DEFAULT 'open',        -- open | acknowledged | resolved
  raised_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT compliance_sev_ck CHECK (severity IN ('info','warning','critical')),
  CONSTRAINT compliance_status_ck CHECK (status IN ('open','acknowledged','resolved'))
);
CREATE INDEX IF NOT EXISTS compliance_alerts_tenant_status_idx
  ON app_insurance.compliance_alerts (tenant_id, status, severity);

-- ════════════════════════════════════════════════════════════════════
-- MODULE 5 — PERSISTENCY WATCH
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_insurance.persistency_metrics (
  metric_id            BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  as_of                DATE         NOT NULL,
  period_month         INT          NOT NULL,                       -- 13 | 25 | 37 | 49 | 61
  product_code         TEXT,
  channel              TEXT,
  region               TEXT,
  persistency_pct      NUMERIC(6,4) NOT NULL,                       -- 0..1
  policies_in_force    INT          NOT NULL DEFAULT 0,
  policies_expected    INT          NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT persistency_period_ck CHECK (period_month IN (13,25,37,49,61))
);
CREATE INDEX IF NOT EXISTS persistency_tenant_period_idx
  ON app_insurance.persistency_metrics (tenant_id, period_month, as_of DESC);

CREATE TABLE IF NOT EXISTS app_insurance.retention_analysis (
  analysis_id          BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  dimension            TEXT         NOT NULL,                       -- product | channel | region
  dimension_value      TEXT         NOT NULL,
  period_month         INT          NOT NULL,
  persistency_pct      NUMERIC(6,4) NOT NULL,
  root_causes          JSONB        NOT NULL DEFAULT '[]'::jsonb,   -- AI root-cause [{cause, weight}]
  recommendation       TEXT,
  generated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retention_analysis_tenant_dim_idx
  ON app_insurance.retention_analysis (tenant_id, dimension, period_month);

CREATE TABLE IF NOT EXISTS app_insurance.persistency_alerts (
  alert_id             BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  dimension            TEXT         NOT NULL,
  dimension_value      TEXT         NOT NULL,
  period_month         INT          NOT NULL,
  persistency_pct      NUMERIC(6,4) NOT NULL,
  threshold_pct        NUMERIC(6,4) NOT NULL,
  severity             TEXT         NOT NULL DEFAULT 'warning',
  status               TEXT         NOT NULL DEFAULT 'open',
  raised_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT persistency_alert_sev_ck CHECK (severity IN ('info','warning','critical')),
  CONSTRAINT persistency_alert_status_ck CHECK (status IN ('open','acknowledged','resolved'))
);
CREATE INDEX IF NOT EXISTS persistency_alerts_tenant_status_idx
  ON app_insurance.persistency_alerts (tenant_id, status);

-- ════════════════════════════════════════════════════════════════════
-- MODULE 6 — UNDERWRITING DEVIATION
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_insurance.underwriting_deviations (
  deviation_id         BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  policy_id            TEXT         NOT NULL,
  underwriter_id       TEXT         NOT NULL,
  channel              TEXT,
  deviation_type       TEXT         NOT NULL,                       -- premium | medical_waiver | sum_assured | rule_violation
  rule_code            TEXT,
  expected_value       NUMERIC(16,4),
  actual_value         NUMERIC(16,4),
  deviation_pct        NUMERIC(8,4),
  severity             TEXT         NOT NULL DEFAULT 'medium',
  status               TEXT         NOT NULL DEFAULT 'open',        -- open | reviewed | accepted | reversed
  detected_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uw_dev_sev_ck CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT uw_dev_status_ck CHECK (status IN ('open','reviewed','accepted','reversed'))
);
CREATE INDEX IF NOT EXISTS uw_dev_tenant_uw_idx
  ON app_insurance.underwriting_deviations (tenant_id, underwriter_id);

CREATE TABLE IF NOT EXISTS app_insurance.approval_exceptions (
  exception_id         BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  policy_id            TEXT         NOT NULL,
  underwriter_id       TEXT         NOT NULL,
  exception_reason     TEXT         NOT NULL,
  approved_by          TEXT,
  requires_review      BOOLEAN      NOT NULL DEFAULT true,
  status               TEXT         NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT approval_exc_status_ck CHECK (status IN ('pending','approved','rejected'))
);
CREATE INDEX IF NOT EXISTS approval_exc_tenant_status_idx
  ON app_insurance.approval_exceptions (tenant_id, status);

CREATE TABLE IF NOT EXISTS app_insurance.underwriter_scores (
  score_id             BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  underwriter_id       TEXT         NOT NULL,
  underwriter_name     TEXT,
  as_of                DATE         NOT NULL,
  deviation_count_90d  INT          NOT NULL DEFAULT 0,
  risk_score           NUMERIC(5,4) NOT NULL DEFAULT 0,             -- 0..1 higher = riskier UW
  policies_underwritten INT         NOT NULL DEFAULT 0,
  rank                 INT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uw_scores_tenant_risk_idx
  ON app_insurance.underwriter_scores (tenant_id, risk_score DESC);

-- ════════════════════════════════════════════════════════════════════
-- MODULE 7 — CHANNEL RISK
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_insurance.channel_risk_scores (
  score_id             BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  channel_type         TEXT         NOT NULL,                       -- agent | broker | bancassurance | direct | online
  channel_id           TEXT         NOT NULL,                       -- agent/broker id
  channel_name         TEXT,
  as_of                DATE         NOT NULL,
  persistency_score    NUMERIC(5,4) NOT NULL DEFAULT 0,
  fraud_score          NUMERIC(5,4) NOT NULL DEFAULT 0,
  complaint_score      NUMERIC(5,4) NOT NULL DEFAULT 0,
  mis_selling_score    NUMERIC(5,4) NOT NULL DEFAULT 0,
  composite_risk_score NUMERIC(5,4) NOT NULL DEFAULT 0,             -- weighted blend
  risk_band            TEXT         NOT NULL DEFAULT 'low',
  rank                 INT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT channel_band_ck CHECK (risk_band IN ('low','medium','high','critical'))
);
CREATE INDEX IF NOT EXISTS channel_risk_tenant_idx
  ON app_insurance.channel_risk_scores (tenant_id, composite_risk_score DESC);

CREATE TABLE IF NOT EXISTS app_insurance.agent_complaints (
  complaint_id         BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  channel_id           TEXT         NOT NULL,
  customer_id          TEXT,
  category             TEXT         NOT NULL,                       -- mis_selling | service | claim_delay | premium_dispute
  severity             TEXT         NOT NULL DEFAULT 'medium',
  description          TEXT,
  status               TEXT         NOT NULL DEFAULT 'open',
  raised_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT agent_complaint_status_ck CHECK (status IN ('open','investigating','resolved','dismissed'))
);
CREATE INDEX IF NOT EXISTS agent_complaints_tenant_chan_idx
  ON app_insurance.agent_complaints (tenant_id, channel_id);

CREATE TABLE IF NOT EXISTS app_insurance.distribution_metrics (
  metric_id            BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  channel_type         TEXT         NOT NULL,
  as_of                DATE         NOT NULL,
  active_count         INT          NOT NULL DEFAULT 0,
  gwp_kes              NUMERIC(18,2) NOT NULL DEFAULT 0,
  avg_persistency_pct  NUMERIC(6,4) NOT NULL DEFAULT 0,
  complaint_rate       NUMERIC(6,4) NOT NULL DEFAULT 0,
  health_score         NUMERIC(5,4) NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS distribution_metrics_tenant_idx
  ON app_insurance.distribution_metrics (tenant_id, channel_type, as_of DESC);

-- ════════════════════════════════════════════════════════════════════
-- CROSS-CUTTING — unified alert feed + per-module audit trail
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_insurance.insurance_alerts (
  alert_id             BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  module               TEXT         NOT NULL,                       -- policy_lapse | claims_anomaly | fraud | solvency | persistency | underwriting | channel
  subject_type         TEXT         NOT NULL,                       -- policy | claim | provider | channel | metric
  subject_id           TEXT         NOT NULL,
  severity             TEXT         NOT NULL DEFAULT 'medium',       -- low | medium | high | critical
  title                TEXT         NOT NULL,
  detail               TEXT,
  risk_score           NUMERIC(5,4),
  status               TEXT         NOT NULL DEFAULT 'open',         -- open | acknowledged | closed
  assignee             TEXT,
  raised_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ins_alert_sev_ck CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT ins_alert_status_ck CHECK (status IN ('open','acknowledged','closed'))
);
CREATE INDEX IF NOT EXISTS insurance_alerts_tenant_module_idx
  ON app_insurance.insurance_alerts (tenant_id, module, severity, status);

CREATE TABLE IF NOT EXISTS app_insurance.insurance_audit_events (
  event_id             BIGSERIAL    PRIMARY KEY,
  tenant_id            TEXT         NOT NULL REFERENCES app_iam.tenants(tenant_id) ON DELETE CASCADE,
  module               TEXT         NOT NULL,
  action               TEXT         NOT NULL,                       -- e.g. policy_lapse.predict, claims_anomaly.analyze
  actor_username       TEXT,
  resource_type        TEXT,
  resource_id          TEXT,
  outcome              TEXT         NOT NULL DEFAULT 'success',      -- success | failure | denied
  metadata             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  ts                   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ins_audit_outcome_ck CHECK (outcome IN ('success','failure','denied'))
);
CREATE INDEX IF NOT EXISTS insurance_audit_tenant_module_idx
  ON app_insurance.insurance_audit_events (tenant_id, module, ts DESC);

COMMIT;
