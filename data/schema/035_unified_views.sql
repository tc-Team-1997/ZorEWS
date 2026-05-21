-- 035_unified_views.sql
-- Unified read-only view layer (T4.25 / spec: docs/unified-view-layer-design.md)
-- Owner: agent-data | Co-owner: agent-integration
--
-- Additive only. Rolls back via 035_unified_views_rollback.sql.
-- Apply via: cd data/schema && make migrate (or psql -f 035_unified_views.sql)
--
-- Sections:
--   1. unified schema
--   2. app_audit.approvals tenant_id column + supporting indexes (spec §6 precondition)
--   3. Supporting indexes on underlying tables (spec §10.5 audit)
--   4. unified.customer_360 view              (added in Task 4)
--   5. unified.alerts view                    (added in Task 5)
--   6. unified.cases view                     (added in Task 6)
--   7. unified.audit_activity view            (added in Task 7)
--   8. COMMENT ON VIEW + COMMENT ON COLUMN    (added in Task 8)
--   9. FUTURE: materialized-view promotion template (commented; added in Task 8)

BEGIN;

-- --------------------------------------------------------------------------
-- Section 1: schema
-- --------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS unified;
COMMENT ON SCHEMA unified IS
  'Read-only view layer flattening cross-schema joins for SPA + reporting + ad-hoc DBeaver. '
  'Underlying schemas (raw/staging/mart/audit/app_*) remain authoritative for writes. '
  'See docs/unified-view-layer-design.md';

-- --------------------------------------------------------------------------
-- Section 2: app_audit.approvals tenant_id (T4.20 shipped pre-T4.24 P3)
-- --------------------------------------------------------------------------
ALTER TABLE app_audit.approvals
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'
    REFERENCES app_iam.tenants(tenant_id);

CREATE INDEX IF NOT EXISTS approvals_tenant_idx
  ON app_audit.approvals(tenant_id);

CREATE INDEX IF NOT EXISTS approvals_correlation_status_idx
  ON app_audit.approvals(correlation_id, status);

-- --------------------------------------------------------------------------
-- Section 3: Supporting indexes on underlying tables (spec §10.5)
-- Only those marked ⚠️ verify in spec §10.5 + confirmed missing in pre-flight.
-- IF NOT EXISTS is idempotent — safe to re-apply.
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS alerts_tenant_customer_idx
  ON app_alerts.alerts(tenant_id, customer_id);

CREATE INDEX IF NOT EXISTS cases_tenant_customer_idx
  ON app_cases.cases(tenant_id, customer_id);

CREATE INDEX IF NOT EXISTS cas_records_case_review_idx
  ON app_cases.cas_records(case_id, review_status);

CREATE INDEX IF NOT EXISTS caps_case_status_idx
  ON app_cases.caps(case_id, status);

CREATE INDEX IF NOT EXISTS actions_case_id_idx
  ON app_cases.actions(case_id);

-- --------------------------------------------------------------------------
-- Section 4: unified.customer_360 (spec §5.1)
-- Identity: (tenant_id, customer_id). LATERAL aggregates over alerts +
-- cases + approvals; LEFT JOIN preserves customer rows that have no
-- alerts/cases/approvals yet. Reality-correction: mart projects
-- full_name / risk_rating / total_outstanding / as_of (NOT name /
-- risk_level / exposure_kes / last_updated_at) — view renames via AS.
-- pd_score omitted — mart doesn't project it yet (T2.1 feature-store).
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW unified.customer_360 AS
SELECT
    m.tenant_id,
    m.customer_id,
    m.full_name                                       AS name,
    m.risk_rating                                     AS risk_level,
    m.total_outstanding                               AS exposure_kes,
    m.worst_dpd                                       AS dpd,
    m.kyc_status,
    m.segment,
    m.onboarded_at,
    COALESCE(a.open_alerts_count, 0)                  AS open_alerts_count,
    a.max_criticality_score,
    a.latest_alert_at,
    COALESCE(c.open_cases_count, 0)                   AS open_cases_count,
    COALESCE(c.breached_sla_count, 0)                 AS breached_sla_count,
    COALESCE(ap.pending_approvals_count, 0)           AS pending_approvals_count,
    GREATEST(a.latest_alert_at, c.last_case_updated_at, m.as_of) AS last_activity_at
FROM mart.customer_360 m
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) FILTER (WHERE status = 'open')                          AS open_alerts_count,
        MAX(criticality_score) FILTER (WHERE status = 'open')            AS max_criticality_score,
        MAX(created_at)                                                  AS latest_alert_at
    FROM app_alerts.alerts
    WHERE tenant_id = m.tenant_id AND customer_id = m.customer_id
) a ON true
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) FILTER (WHERE state <> 'closed')                        AS open_cases_count,
        COUNT(*) FILTER (WHERE sla_status IN ('approaching','breached')) AS breached_sla_count,
        MAX(updated_at)                                                  AS last_case_updated_at
    FROM app_cases.cases
    WHERE tenant_id = m.tenant_id AND customer_id = m.customer_id
) c ON true
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS pending_approvals_count
    FROM app_audit.approvals
    WHERE correlation_id IN (
        SELECT case_id FROM app_cases.cases
        WHERE tenant_id = m.tenant_id AND customer_id = m.customer_id
    )
    AND status = 'pending'
) ap ON true;

-- --------------------------------------------------------------------------
-- Section 5: unified.alerts (spec §5.2)
-- Identity: alert_id (globally unique). customer_name + rule_name are
-- denormalised on the alert row at write time. LEFT JOIN to mart.customer_360
-- for risk overlay; orphan alerts keep visible with NULL customer_* columns.
-- customer_pd_score overlay omitted — mart doesn't project pd_score yet.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW unified.alerts AS
SELECT
    a.tenant_id,
    a.alert_id,
    a.customer_id,
    a.customer_name,
    a.rule_id,
    a.rule_name,
    a.severity,
    a.criticality_score,
    a.confidence,
    a.customer_exposure_kes,
    a.indicators,
    a.status,
    a.assignee,
    a.created_at,
    a.acked_at,
    a.closed_at,
    EXTRACT(EPOCH FROM (now() - a.created_at)) / 60   AS age_minutes,
    m.risk_rating                                      AS customer_risk_level,
    m.total_outstanding                                AS customer_total_exposure_kes
FROM app_alerts.alerts a
LEFT JOIN mart.customer_360 m
    ON m.tenant_id = a.tenant_id
   AND m.customer_id = a.customer_id;

-- --------------------------------------------------------------------------
-- Section 6: unified.cases (spec §5.3)
-- Identity: case_id. has_blocking_caps surfaces the T4.19 "case can't
-- close while any CAP is open" gate as a query-time column so the SPA
-- doesn't need a separate /cases/:id/caps call to render the tooltip.
-- customer_pd_score overlay omitted — mart doesn't project pd_score.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW unified.cases AS
SELECT
    c.tenant_id,
    c.case_id,
    c.alert_id,
    c.customer_id,
    c.customer_name,
    c.severity,
    c.rule_id,
    c.rule_name,
    c.state,
    c.assignee,
    c.loan_id,
    c.reason_summary,
    c.outcome,
    c.sla_status,
    c.created_at,
    c.updated_at,
    c.closed_at,
    COALESCE(act.action_count, 0)                      AS action_count,
    act.last_action_at,
    COALESCE(cas.open_cas_count, 0)                    AS open_cas_count,
    COALESCE(cap.open_cap_count, 0)                    AS open_cap_count,
    COALESCE(cap.has_blocking_caps, false)             AS has_blocking_caps,
    m.risk_rating                                       AS customer_risk_level
FROM app_cases.cases c
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS action_count, MAX(occurred_at) AS last_action_at
    FROM app_cases.actions
    WHERE case_id = c.case_id
) act ON true
LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE review_status = 'pending') AS open_cas_count
    FROM app_cases.cas_records
    WHERE case_id = c.case_id
) cas ON true
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) FILTER (WHERE status IN ('open','in_progress','overdue')) AS open_cap_count,
        bool_or(status IN ('open','in_progress','overdue'))                 AS has_blocking_caps
    FROM app_cases.caps
    WHERE case_id = c.case_id
) cap ON true
LEFT JOIN mart.customer_360 m
    ON m.tenant_id = c.tenant_id
   AND m.customer_id = c.customer_id;

COMMIT;
