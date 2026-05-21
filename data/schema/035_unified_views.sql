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

-- --------------------------------------------------------------------------
-- Section 7: unified.audit_activity (spec §5.4)
-- Identity: (source, event_id). UNION ALL across audit.event_log
-- (WORM hash chain), app_iam.audit_events (auth-svc local), and
-- app_audit.approvals (maker-checker). The Pg planner refuses INSERTs
-- on UNION views, preserving WORM semantics on audit.event_log even
-- by accident.
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW unified.audit_activity AS
SELECT
    'chain'              AS source,
    e.tenant_id,
    e.event_id::text     AS event_id,
    e.event_ts           AS ts,
    e.actor              AS actor,
    e.event_type         AS action,
    NULL::text           AS resource_type,
    e.subject_id         AS resource_id,
    NULL::text           AS outcome,
    NULL::text           AS severity,
    e.correlation_id     AS correlation_id,
    e.payload            AS metadata
FROM audit.event_log e
UNION ALL
SELECT
    'auth_local'         AS source,
    ae.tenant_id,
    ae.id::text          AS event_id,
    ae.occurred_at       AS ts,
    ae.actor_username    AS actor,
    ae.event_type        AS action,
    'user'::text         AS resource_type,
    ae.target_username   AS resource_id,
    NULL::text           AS outcome,
    NULL::text           AS severity,
    NULL::text           AS correlation_id,
    ae.detail            AS metadata
FROM app_iam.audit_events ae
UNION ALL
SELECT
    'approval'                            AS source,
    COALESCE(ap.tenant_id, 'BANK_DEMO')   AS tenant_id,
    ap.approval_id                        AS event_id,
    ap.proposed_at                        AS ts,
    ap.maker                              AS actor,
    ap.action                             AS action,
    ap.subject_type                       AS resource_type,
    ap.subject_id                         AS resource_id,
    ap.status                             AS outcome,
    NULL::text                            AS severity,
    ap.correlation_id                     AS correlation_id,
    ap.payload                            AS metadata
FROM app_audit.approvals ap;

-- --------------------------------------------------------------------------
-- Section 8: COMMENT ON VIEW + COMMENT ON COLUMN (spec §8.5 ORM contract)
-- View comment starts with "IDENTITY: (...)" so the test (§10 item #13)
-- can recover the identity tuple from the catalog.
-- --------------------------------------------------------------------------

COMMENT ON VIEW unified.customer_360 IS
  'IDENTITY: (tenant_id, customer_id) — Customer 360 dashboard row. '
  'LATERAL aggregates over alerts + cases + approvals. Read-only. See spec §5.1.';

COMMENT ON COLUMN unified.customer_360.tenant_id IS 'BIL multi-tenant key (T4.24).';
COMMENT ON COLUMN unified.customer_360.customer_id IS 'Business customer identifier (denormalised from mart.customer_360).';
COMMENT ON COLUMN unified.customer_360.name IS 'Customer display name (mart.customer_360.full_name AS name).';
COMMENT ON COLUMN unified.customer_360.risk_level IS 'Low/Medium/High text bucket (mart.customer_360.risk_rating AS risk_level).';
COMMENT ON COLUMN unified.customer_360.exposure_kes IS 'Total outstanding exposure in Kenyan Shillings (mart.customer_360.total_outstanding AS exposure_kes).';
COMMENT ON COLUMN unified.customer_360.dpd IS 'Worst days-past-due across customer loans (mart.customer_360.worst_dpd AS dpd).';
COMMENT ON COLUMN unified.customer_360.kyc_status IS 'KYC verification status from mart.';
COMMENT ON COLUMN unified.customer_360.segment IS 'Customer segment classification.';
COMMENT ON COLUMN unified.customer_360.onboarded_at IS 'When the customer was first onboarded.';
COMMENT ON COLUMN unified.customer_360.open_alerts_count IS 'Count of app_alerts.alerts rows with status=open for this customer.';
COMMENT ON COLUMN unified.customer_360.max_criticality_score IS 'Maximum criticality_score across the open alerts (NULL when no open alerts).';
COMMENT ON COLUMN unified.customer_360.latest_alert_at IS 'Most recent app_alerts.alerts.created_at for this customer (NULL when none).';
COMMENT ON COLUMN unified.customer_360.open_cases_count IS 'Count of app_cases.cases rows with state<>closed for this customer.';
COMMENT ON COLUMN unified.customer_360.breached_sla_count IS 'Count of cases with sla_status in (approaching, breached).';
COMMENT ON COLUMN unified.customer_360.pending_approvals_count IS 'Count of app_audit.approvals with status=pending tied to this customer''s cases.';
COMMENT ON COLUMN unified.customer_360.last_activity_at IS 'GREATEST(latest_alert_at, last_case_updated_at, mart.as_of) for sort-by-recency.';

COMMENT ON VIEW unified.alerts IS
  'IDENTITY: (alert_id) — Alert list-row view. LEFT JOIN to mart.customer_360 '
  'for risk overlay. Read-only. See spec §5.2.';

COMMENT ON COLUMN unified.alerts.tenant_id IS 'BIL multi-tenant key (T4.24).';
COMMENT ON COLUMN unified.alerts.alert_id IS 'Globally unique deterministic alert id.';
COMMENT ON COLUMN unified.alerts.customer_id IS 'Customer this alert pertains to.';
COMMENT ON COLUMN unified.alerts.customer_name IS 'Customer display name, denormalised on the alert at write time.';
COMMENT ON COLUMN unified.alerts.rule_id IS 'Triggering rule identifier.';
COMMENT ON COLUMN unified.alerts.rule_name IS 'Rule display name, denormalised on the alert at write time.';
COMMENT ON COLUMN unified.alerts.severity IS 'critical / high / medium / low.';
COMMENT ON COLUMN unified.alerts.criticality_score IS 'AI-computed criticality score (see services/bff/src/criticality.ts).';
COMMENT ON COLUMN unified.alerts.confidence IS 'Model confidence 0..1 in the alert.';
COMMENT ON COLUMN unified.alerts.customer_exposure_kes IS 'Customer exposure (KES) at alert creation.';
COMMENT ON COLUMN unified.alerts.indicators IS 'Indicator codes that fired (IND_TXN_*, IND_BEH_*, etc).';
COMMENT ON COLUMN unified.alerts.status IS 'open / acked / closed.';
COMMENT ON COLUMN unified.alerts.assignee IS 'Assigned user or role (NULL when unassigned).';
COMMENT ON COLUMN unified.alerts.created_at IS 'When the alert was created.';
COMMENT ON COLUMN unified.alerts.acked_at IS 'When the alert was acknowledged (NULL while open).';
COMMENT ON COLUMN unified.alerts.closed_at IS 'When the alert was closed (NULL while open or acked).';
COMMENT ON COLUMN unified.alerts.age_minutes IS 'Computed: (now - created_at) in minutes.';
COMMENT ON COLUMN unified.alerts.customer_risk_level IS 'Customer risk_level from mart.risk_rating (NULL on orphan alerts).';
COMMENT ON COLUMN unified.alerts.customer_total_exposure_kes IS 'Customer total outstanding from mart (NULL on orphan alerts).';

COMMENT ON VIEW unified.cases IS
  'IDENTITY: (case_id) — Case list-row view with CAS+CAP rollups (T4.19) and '
  'has_blocking_caps gate. LEFT JOIN to mart.customer_360 for risk overlay. '
  'Read-only. See spec §5.3.';

COMMENT ON COLUMN unified.cases.tenant_id IS 'BIL multi-tenant key (T4.24).';
COMMENT ON COLUMN unified.cases.case_id IS 'Deterministic case id (hash of alert_id + customer_id).';
COMMENT ON COLUMN unified.cases.alert_id IS 'Originating alert id (orphan possible in synthetic seed — see spec §11).';
COMMENT ON COLUMN unified.cases.customer_id IS 'Customer this case pertains to.';
COMMENT ON COLUMN unified.cases.customer_name IS 'Customer display name, denormalised at case write time.';
COMMENT ON COLUMN unified.cases.severity IS 'low / medium / high / critical.';
COMMENT ON COLUMN unified.cases.rule_id IS 'Triggering rule id.';
COMMENT ON COLUMN unified.cases.rule_name IS 'Rule display name, denormalised at case write time.';
COMMENT ON COLUMN unified.cases.state IS 'open / assigned / in_action / monitored / closed.';
COMMENT ON COLUMN unified.cases.assignee IS 'Case officer username.';
COMMENT ON COLUMN unified.cases.loan_id IS 'Loan tied to the alert (NULL when not loan-related).';
COMMENT ON COLUMN unified.cases.reason_summary IS 'Short human-readable case reason.';
COMMENT ON COLUMN unified.cases.outcome IS 'cured / cured_temp / defaulted (NULL until close).';
COMMENT ON COLUMN unified.cases.sla_status IS 'on_track / approaching / breached / closed.';
COMMENT ON COLUMN unified.cases.created_at IS 'When the case was opened.';
COMMENT ON COLUMN unified.cases.updated_at IS 'Most recent case update.';
COMMENT ON COLUMN unified.cases.closed_at IS 'When the case was closed (NULL until closed).';
COMMENT ON COLUMN unified.cases.action_count IS 'Total action rows logged on this case.';
COMMENT ON COLUMN unified.cases.last_action_at IS 'Most recent action timestamp (NULL when no actions).';
COMMENT ON COLUMN unified.cases.open_cas_count IS 'Count of cas_records with review_status=pending.';
COMMENT ON COLUMN unified.cases.open_cap_count IS 'Count of caps with status in (open, in_progress, overdue).';
COMMENT ON COLUMN unified.cases.has_blocking_caps IS 'TRUE iff at least one CAP blocks case close (T4.19 gate).';
COMMENT ON COLUMN unified.cases.customer_risk_level IS 'Customer risk_level from mart.risk_rating (NULL on orphan cases).';

COMMENT ON VIEW unified.audit_activity IS
  'IDENTITY: (source, event_id) — UNION ALL across audit.event_log (WORM), '
  'app_iam.audit_events (auth-svc local), app_audit.approvals (maker-checker). '
  'Pg planner refuses INSERTs on UNION views, preserving WORM on '
  'audit.event_log. Read-only. See spec §5.4.';

COMMENT ON COLUMN unified.audit_activity.source IS 'chain | auth_local | approval discriminator.';
COMMENT ON COLUMN unified.audit_activity.tenant_id IS 'BIL multi-tenant key (T4.24).';
COMMENT ON COLUMN unified.audit_activity.event_id IS 'Source-specific id, cast to TEXT for UNION compatibility.';
COMMENT ON COLUMN unified.audit_activity.ts IS 'Event timestamp (event_ts / occurred_at / proposed_at normalised).';
COMMENT ON COLUMN unified.audit_activity.actor IS 'Actor that performed the event (actor / actor_username / maker normalised).';
COMMENT ON COLUMN unified.audit_activity.action IS 'Action verb (event_type / action normalised).';
COMMENT ON COLUMN unified.audit_activity.resource_type IS 'Resource type acted on; NULL for chain rows, ''user'' for auth_local, subject_type for approval.';
COMMENT ON COLUMN unified.audit_activity.resource_id IS 'Resource id acted on; subject_id for chain/approval, target_username for auth_local.';
COMMENT ON COLUMN unified.audit_activity.outcome IS 'Outcome (currently approval status only; NULL for other sources).';
COMMENT ON COLUMN unified.audit_activity.severity IS 'Reserved for future severity classification (NULL today).';
COMMENT ON COLUMN unified.audit_activity.correlation_id IS 'Correlation id (chain.correlation_id / approval.correlation_id; NULL for auth_local).';
COMMENT ON COLUMN unified.audit_activity.metadata IS 'Source-specific JSONB payload (payload / detail / payload).';

-- --------------------------------------------------------------------------
-- Section 9: FUTURE — materialized-view promotion template (spec §6.5)
-- This block is COMMENTED OUT — copy-paste into a future migration when
-- empirical p95 exceeds the §10.5 target for any view.
-- --------------------------------------------------------------------------
/*
-- FUTURE: promote unified.customer_360 to MATERIALIZED VIEW
-- Pre-conditions: spec §6.5 promotion criterion met.
-- Schema name / view name / columns MUST remain identical.
BEGIN;
    DROP VIEW unified.customer_360 CASCADE;
    CREATE MATERIALIZED VIEW unified.customer_360 AS
        <same SELECT body as the original VIEW above>;
    CREATE UNIQUE INDEX unified_customer_360_pkey
        ON unified.customer_360 (tenant_id, customer_id);
    REFRESH MATERIALIZED VIEW unified.customer_360;
COMMIT;
-- Refresh strategy options (pick one):
--   (a) cron'd REFRESH MATERIALIZED VIEW CONCURRENTLY unified.customer_360;
--   (b) trigger on app_alerts.alerts INSERT/UPDATE/DELETE that refreshes
--   (c) BFF pg_notify listener that schedules a refresh
*/

COMMIT;
