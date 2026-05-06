-- 012_ews_rules.sql
--
-- EWS rules engine — canonical schema (EWS-4).
--
-- Per the architecture mapping (docs/ews-rules-engine-mapping.md §4.4),
-- the prototype keeps the runtime store in-memory; this migration is a
-- forward-looking schema for the persistent layer that future production
-- deployment will swap in.
--
-- Two tables:
--   app.ews_rules            — rule definitions
--   app.ews_rule_executions  — per-evaluation telemetry (rule firings)
--
-- Schema mirrors the EwsRule + EwsRuleExecution interfaces in
-- services/bff/src/ews_rules.ts. Indexes are tuned for the two
-- read patterns the SPA needs:
--   1. List active rules for a tenant (filter by is_active+state)
--   2. Recent firings for a single rule (newest-first by sequence_no)

CREATE SCHEMA IF NOT EXISTS app;

-- ─── ews_rules ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app.ews_rules (
    rule_id            TEXT        NOT NULL,
    tenant_id          TEXT        NOT NULL,
    name               TEXT        NOT NULL,
    category           TEXT        NOT NULL,
        -- credit / lapse / fraud / kyc / transaction / agent / ops /
        -- concentration / behaviour / score
    description        TEXT        NOT NULL,
    conditions         JSONB       NOT NULL,
        -- the conditions[] array from the EwsRule shape
    logic              TEXT        NOT NULL,
        -- 'AND' | 'OR' (top-level for flat rules)
    action             JSONB       NOT NULL,
        -- {alert_severity, weight, recommended_action?}
    is_active          BOOLEAN     NOT NULL DEFAULT FALSE,
    state              TEXT        NOT NULL DEFAULT 'draft',
        -- draft / pending_review / active / deprecated
    version            INTEGER     NOT NULL DEFAULT 1,
    tags               TEXT[]      NOT NULL DEFAULT '{}',
    created_by         TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    deprecated_at      TIMESTAMPTZ,

    PRIMARY KEY (tenant_id, rule_id),
    CHECK (state IN ('draft','pending_review','active','deprecated')),
    CHECK (logic IN ('AND','OR')),
    CHECK (category IN ('credit','lapse','fraud','kyc','transaction',
                        'agent','ops','concentration','behaviour','score')),
    -- An ACTIVE rule must have is_active=true; a non-active rule must
    -- have is_active=false. Keeps the flag and state in lock-step.
    CHECK (
        (state = 'active'     AND is_active = TRUE)  OR
        (state <> 'active'    AND is_active = FALSE)
    )
);

CREATE INDEX IF NOT EXISTS ix_ews_rules_tenant_active
  ON app.ews_rules (tenant_id, state)
  WHERE state = 'active' AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS ix_ews_rules_category
  ON app.ews_rules (tenant_id, category, state);

CREATE INDEX IF NOT EXISTS ix_ews_rules_updated
  ON app.ews_rules (tenant_id, updated_at DESC);

COMMENT ON TABLE app.ews_rules IS
    'EWS rules engine — canonical rule definitions. Mirrors the in-memory EwsRule shape in services/bff/src/ews_rules.ts. See docs/ews-rules-engine-mapping.md for full design.';

-- ─── ews_rule_executions ──────────────────────────────────────────────
--
-- Append-only telemetry. One row per (rule, entity) evaluation that
-- the executor recorded a hit on. Production retention: configurable
-- per tenant; the prototype stores the last 5000 entries / tenant.

CREATE TABLE IF NOT EXISTS app.ews_rule_executions (
    execution_id       BIGSERIAL   PRIMARY KEY,
    sequence_no        BIGINT      NOT NULL,
        -- per-tenant monotonic; stable across FIFO retention
    tenant_id          TEXT        NOT NULL,
    rule_id            TEXT        NOT NULL,
    entity_type        TEXT        NOT NULL,
        -- 'customer' | 'policy' | 'claim'
    entity_id          TEXT        NOT NULL,
    matched            BOOLEAN     NOT NULL,
    matched_indicators TEXT[]      NOT NULL DEFAULT '{}',
    score_impact       NUMERIC(8,2) NOT NULL DEFAULT 0,
    alert_id           TEXT,
        -- NULL when no alert was emitted (e.g. test mode)
    evaluated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_us        INTEGER     NOT NULL,

    FOREIGN KEY (tenant_id, rule_id) REFERENCES app.ews_rules(tenant_id, rule_id)
        ON DELETE CASCADE,
    CHECK (entity_type IN ('customer','policy','claim'))
);

CREATE INDEX IF NOT EXISTS ix_ews_executions_rule_seq
  ON app.ews_rule_executions (tenant_id, rule_id, sequence_no DESC);

CREATE INDEX IF NOT EXISTS ix_ews_executions_entity
  ON app.ews_rule_executions (tenant_id, entity_type, entity_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS ix_ews_executions_matched
  ON app.ews_rule_executions (tenant_id, evaluated_at DESC) WHERE matched = TRUE;

COMMENT ON TABLE app.ews_rule_executions IS
    'EWS rules engine — per-evaluation telemetry. Powers /v1/ews/rules/:id/hits + the SPA''s rule-firing sparklines.';
