-- 018_sla_config.sql
--
-- Per-tenant SLA config (BAC §3.1.6 / §3.1.9.1.4 dashboard widget).
-- Tenant-scoped, admin-editable SLA targets keyed by
-- (case_category, priority, business_unit?).
--
-- Status flow:
--   ACTIVE → SUPERSEDED  (on edit; new ACTIVE row replaces old; old keeps audit trail)
--   ACTIVE → ARCHIVED    (on retire; no replacement)
-- Rows never DELETE — always status-forward for compliance audit.

BEGIN;

CREATE TABLE IF NOT EXISTS app_admin.sla_config (
    sla_config_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            TEXT         NOT NULL,
    case_category        TEXT         NOT NULL,
    priority             TEXT         NOT NULL,
    business_unit        TEXT,
    sla_target_days      NUMERIC(5,2) NOT NULL,
    status               TEXT         NOT NULL DEFAULT 'ACTIVE',
    effective_from       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    effective_till       TIMESTAMPTZ,
    notes                TEXT,
    created_by           TEXT         NOT NULL,
    updated_by           TEXT,
    superseded_by        UUID,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT sla_config_priority_check
        CHECK (priority IN ('P1','P2','P3','P4')),
    CONSTRAINT sla_config_status_check
        CHECK (status IN ('ACTIVE','SUPERSEDED','ARCHIVED')),
    CONSTRAINT sla_config_target_positive_check
        CHECK (sla_target_days > 0 AND sla_target_days <= 365),
    CONSTRAINT sla_config_temporal_check
        CHECK (effective_till IS NULL OR effective_till > effective_from),
    CONSTRAINT sla_config_superseded_self_check
        CHECK (superseded_by IS NULL OR superseded_by <> sla_config_id),
    CONSTRAINT sla_config_status_actor_check
        CHECK (
            (status = 'ACTIVE'     AND superseded_by IS NULL) OR
            (status = 'SUPERSEDED' AND superseded_by IS NOT NULL) OR
            (status = 'ARCHIVED')
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_config_active
    ON app_admin.sla_config
       (tenant_id, case_category, priority, COALESCE(business_unit, ''))
    WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS ix_sla_config_tenant_category
    ON app_admin.sla_config (tenant_id, case_category, priority)
    WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_sla_config_tenant_status
    ON app_admin.sla_config (tenant_id, status, updated_at DESC);

COMMENT ON TABLE app_admin.sla_config IS
  'Per-tenant SLA targets keyed by (case_category, priority, business_unit?). Edit → SUPERSEDE pattern keeps the audit trail intact. The dashboard SLA breach matrix joins this against open cases at query time, so edits move the breach line live.';

DROP TRIGGER IF EXISTS trg_sla_config_updated_at
    ON app_admin.sla_config;
CREATE TRIGGER trg_sla_config_updated_at
    BEFORE UPDATE ON app_admin.sla_config
    FOR EACH ROW
    EXECUTE FUNCTION app_admin.set_updated_at();

-- Seed: 5 categories × 4 priorities × 2 tenants + 1 BU-specific row.

INSERT INTO app_admin.sla_config
    (tenant_id, case_category, priority, business_unit, sla_target_days, notes, created_by)
VALUES
    ('BANK_DEMO', 'credit_risk', 'P1', NULL, 1.0,  'Critical credit incident — collections within 24h',     'system:seed'),
    ('BANK_DEMO', 'credit_risk', 'P2', NULL, 3.0,  'High credit risk — RM follow-up by EOD+3',              'system:seed'),
    ('BANK_DEMO', 'credit_risk', 'P3', NULL, 7.0,  'Routine credit triage',                                 'system:seed'),
    ('BANK_DEMO', 'credit_risk', 'P4', NULL, 14.0, 'Low-priority credit hygiene',                           'system:seed'),
    ('BANK_DEMO', 'fraud',       'P1', NULL, 0.5,  'Active fraud — 12h cutoff per RBI fraud master circular', 'system:seed'),
    ('BANK_DEMO', 'fraud',       'P2', NULL, 1.0,  'Suspicious pattern — investigate within 24h',           'system:seed'),
    ('BANK_DEMO', 'fraud',       'P3', NULL, 3.0,  'Anomaly review',                                        'system:seed'),
    ('BANK_DEMO', 'fraud',       'P4', NULL, 7.0,  'Low-confidence flag',                                   'system:seed'),
    ('BANK_DEMO', 'kyc',         'P1', NULL, 2.0,  'Expired-doc + active loan — 48h to re-verify',          'system:seed'),
    ('BANK_DEMO', 'kyc',         'P2', NULL, 5.0,  'KYC refresh due',                                       'system:seed'),
    ('BANK_DEMO', 'kyc',         'P3', NULL, 10.0, 'Address mismatch (low-risk)',                           'system:seed'),
    ('BANK_DEMO', 'kyc',         'P4', NULL, 15.0, 'Doc-quality review',                                    'system:seed'),
    ('BANK_DEMO', 'lapse',       'P1', NULL, 1.0,  'Imminent lapse — agent contact same day',               'system:seed'),
    ('BANK_DEMO', 'lapse',       'P2', NULL, 2.0,  'Premium overdue 15+ days',                              'system:seed'),
    ('BANK_DEMO', 'lapse',       'P3', NULL, 5.0,  'Grace-period reminder',                                 'system:seed'),
    ('BANK_DEMO', 'lapse',       'P4', NULL, 10.0, 'Routine lapse follow-up',                               'system:seed'),
    ('BANK_DEMO', 'compliance',  'P1', NULL, 1.0,  'Regulator-driven escalation',                           'system:seed'),
    ('BANK_DEMO', 'compliance',  'P2', NULL, 3.0,  'Internal compliance breach',                            'system:seed'),
    ('BANK_DEMO', 'compliance',  'P3', NULL, 7.0,  'Routine compliance review',                             'system:seed'),
    ('BANK_DEMO', 'compliance',  'P4', NULL, 14.0, 'Process audit follow-up',                               'system:seed'),
    ('BANK_DEMO', 'default_fallback', 'P1', NULL, 2.0,  'Fallback when no category-specific row matches',   'system:seed'),
    ('BANK_DEMO', 'default_fallback', 'P2', NULL, 5.0,  'Fallback when no category-specific row matches',   'system:seed'),
    ('BANK_DEMO', 'default_fallback', 'P3', NULL, 10.0, 'Fallback when no category-specific row matches',   'system:seed'),
    ('BANK_DEMO', 'default_fallback', 'P4', NULL, 20.0, 'Fallback when no category-specific row matches',   'system:seed'),
    ('BIL', 'lapse',      'P1', NULL, 1.0,  'BIL: Imminent lapse — agent contact same day',                 'system:seed'),
    ('BIL', 'lapse',      'P2', NULL, 2.0,  'BIL: Premium overdue 15+ days',                                'system:seed'),
    ('BIL', 'lapse',      'P3', NULL, 5.0,  'BIL: Grace-period reminder',                                   'system:seed'),
    ('BIL', 'lapse',      'P4', NULL, 10.0, 'BIL: Routine lapse follow-up',                                 'system:seed'),
    ('BIL', 'fraud',      'P1', NULL, 0.5,  'BIL: Active claim-fraud — 12h',                                'system:seed'),
    ('BIL', 'fraud',      'P2', NULL, 1.0,  'BIL: Suspicious claim',                                        'system:seed'),
    ('BIL', 'fraud',      'P3', NULL, 3.0,  'BIL: Claim anomaly review',                                    'system:seed'),
    ('BIL', 'fraud',      'P4', NULL, 7.0,  'BIL: Low-confidence claim flag',                               'system:seed'),
    ('BIL', 'compliance', 'P1', NULL, 1.0,  'BIL: IRDAI escalation',                                        'system:seed'),
    ('BIL', 'compliance', 'P2', NULL, 3.0,  'BIL: Internal compliance breach',                              'system:seed'),
    ('BIL', 'compliance', 'P3', NULL, 7.0,  'BIL: Routine compliance review',                               'system:seed'),
    ('BIL', 'compliance', 'P4', NULL, 14.0, 'BIL: Process audit follow-up',                                 'system:seed'),
    ('BIL', 'default_fallback', 'P1', NULL, 2.0,  'BIL: Fallback',                                          'system:seed'),
    ('BIL', 'default_fallback', 'P2', NULL, 5.0,  'BIL: Fallback',                                          'system:seed'),
    ('BIL', 'default_fallback', 'P3', NULL, 10.0, 'BIL: Fallback',                                          'system:seed'),
    ('BIL', 'default_fallback', 'P4', NULL, 20.0, 'BIL: Fallback',                                          'system:seed'),
    ('BANK_DEMO', 'credit_risk', 'P1', 'CORPORATE', 0.5,
     'Corporate banking: tighter than retail because exposures are larger', 'system:seed')
ON CONFLICT DO NOTHING;

COMMIT;
